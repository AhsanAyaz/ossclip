#!/usr/bin/env tsx
/**
 * Pixel-kernel benchmark — the "before" numbers for the WASM SIMD work.
 *
 * This repo had no perf instrumentation of any kind before this file: no
 * `performance.now`, no `*.bench.ts`, no vitest benchmark config. That absence
 * is exactly how the SIMD project started from a false premise — a video script
 * asserted OSSClip spends 4.8s in a per-sample audio loop, when in fact every
 * amplitude measurement is delegated to ffmpeg (`astats`, `silencedetect`) and
 * the only per-element loops in the codebase are over GRAYSCALE PIXELS.
 *
 * So the point of this harness is not to make a kernel look fast. It is to
 * establish what fraction of real wall clock these kernels are, before anyone
 * writes a line of SIMD. It reports three layers and refuses to publish a
 * number when they disagree:
 *
 *   L1  kernel only, buffer already in RAM
 *   L2  kernel + readFile + allocation (the per-frame cost SIMD cannot touch)
 *   L3  the whole stage, decomposed into ffmpeg / readFile / kernel — measured
 *       two independent ways, which must agree within CONSISTENCY_TOLERANCE
 *
 * Deliberately NOT a `vitest bench`. tinybench's warmup/iteration model fights
 * a benchmark whose dominant term is spawning ffmpeg a dozen times, and
 * `packages/core/test/` is uniformly correctness tests. It lives in `scripts/`
 * beside `make-fixture.mjs`, which is the same class of thing, and it is `.ts`
 * rather than `.mjs` so it can import the real kernels — a benchmark that
 * duplicates the code it measures is a benchmark that will eventually lie.
 *
 * Run: pnpm bench:pixels [--json] [--quick]
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { run } from "../packages/core/src/exec";
import { COVER_CROP_VF, laplacianVariance, pickCoverFrame } from "../packages/core/src/cover";
import { createFaceDetector, measureFaceInWindows, rotateGray } from "../packages/core/src/face";
import { bandScores, scanSourceText } from "../packages/core/src/source-text";

const execFileAsync = promisify(execFile);

// ---- configuration ---------------------------------------------------------

const FFMPEG = process.env.OSSCLIP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.OSSCLIP_FFPROBE ?? "ffprobe";

const ROOT = new URL("..", import.meta.url).pathname;
const FIXTURES = join(ROOT, "fixtures");
/** Derived and regenerable by construction — `fixtures/work/` is gitignored. */
const CACHE = join(FIXTURES, "work", "bench");

/** Geometry constants, mirrored from the modules under test. */
const COVER_W = 360;
const COVER_H = 640;
const TEXT_W = 240; // source-text.ts DET_W
const FACE_W = 360; // face.ts DET_W

/**
 * L3 is measured twice — once by re-implementing the sample loop with the
 * production ffmpeg argv and timing each phase, once by wall-clocking the real
 * exported function. If those disagree by more than this, the attribution is
 * wrong and no number from that stage is trustworthy. Publishing anyway is how
 * a benchmark ships a plausible lie.
 */
const CONSISTENCY_TOLERANCE = 0.1;

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
/** Fewer iterations and fewer ffmpeg spawns, for iterating on the harness. */
const quick = args.has("--quick");

/** stdout is the JSON channel under --json, so prose goes to stderr. */
const say = (s = "") => process.stderr.write(`${s}\n`);

// ---- timing ----------------------------------------------------------------

interface Timing {
  meanMs: number;
  p50Ms: number;
  minMs: number;
  iters: number;
}

/**
 * Adaptive iteration count: cheap kernels get hundreds of runs, the face
 * cascade (tens of ms) gets a handful. A fixed count would either take minutes
 * on the cascade or fail to warm the JIT on the 0.5ms kernels.
 */
function timeIt(fn: () => void, opts: { minIters?: number; minMs?: number } = {}): Timing {
  const minIters = opts.minIters ?? (quick ? 5 : 30);
  const minMs = opts.minMs ?? (quick ? 100 : 400);

  // Warmup. V8 needs to see the loop hot before the numbers mean anything, and
  // for the cascade this also settles the early-exit branch predictor.
  const warmup = Math.max(3, Math.min(50, minIters));
  for (let i = 0; i < warmup; i++) fn();

  const samples: number[] = [];
  const deadline = process.hrtime.bigint() + BigInt(Math.round(minMs * 1e6));
  let i = 0;
  while (i < minIters || process.hrtime.bigint() < deadline) {
    const t0 = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    i++;
    if (i > 100_000) break;
  }
  samples.sort((a, b) => a - b);
  return {
    meanMs: samples.reduce((s, v) => s + v, 0) / samples.length,
    p50Ms: samples[Math.floor(samples.length / 2)]!,
    minMs: samples[0]!,
    iters: samples.length,
  };
}

async function timeAsync(fn: () => Promise<void>): Promise<number> {
  const t0 = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

// ---- frame sources ---------------------------------------------------------

interface Frame {
  id: string;
  /** "real" frames come from ffmpeg; "synthetic" ones are declared BOUNDS. */
  kind: "real" | "synthetic";
  note: string;
  w: number;
  h: number;
  pixels: Uint8Array;
  /** Present for real frames — L2 needs a file to read. */
  path?: string;
}

/**
 * Deterministic LCG (Numerical Recipes). `Math.random()` would make every run
 * incomparable to the last, which is useless for a before/after benchmark.
 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24; // high byte — the low bits of an LCG are famously poor
  };
}

function synth(kindId: string, w: number, h: number, fill: (x: number, y: number, rnd: () => number) => number): Frame {
  const rnd = lcg(0x5eed);
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = fill(x, y, rnd) & 0xff;
  return { id: kindId, kind: "synthetic", note: SYNTH_NOTES[kindId] ?? "", w, h, pixels: px };
}

const SYNTH_NOTES: Record<string, string> = {
  noise: "uniform random — NEAR-WORST case for bandScores (edge predicate fires on most pixels)",
  zeros: "all 0 — no edges at all",
  ones: "all 255 — no edges, but every pixel 'extreme'",
  flat: "constant 128 — no edges, no extremes",
  stripes8: "hard vertical stripes, period 8 — dense short runs, text-like structure",
  stripes64: "hard vertical stripes, period 64 — few wide runs, colour-bar-like",
  gradient: "soft horizontal gradient — NEAR-BEST case, almost no edges",
};

function syntheticFrames(w: number, h: number, suffix: string): Frame[] {
  const mk = (id: string, fill: Parameters<typeof synth>[3]) => {
    const f = synth(id, w, h, fill);
    f.id = `${id}@${suffix}`;
    f.note = SYNTH_NOTES[id] ?? "";
    return f;
  };
  return [
    mk("noise", (_x, _y, rnd) => rnd()),
    mk("zeros", () => 0),
    mk("ones", () => 255),
    mk("flat", () => 128),
    mk("stripes8", (x) => (Math.floor(x / 8) % 2 ? 255 : 0)),
    mk("stripes64", (x) => (Math.floor(x / 64) % 2 ? 255 : 0)),
    mk("gradient", (x) => Math.floor((x / Math.max(1, w - 1)) * 255)),
  ];
}

/** The production argv, verbatim, so the pixel statistics are the real ones. */
function frameArgv(videoPath: string, tSec: number, vf: string, outPath: string): string[] {
  return [
    "-v", "error",
    "-ss", tSec.toFixed(3),
    "-i", videoPath,
    "-frames:v", "1",
    "-vf", vf,
    "-pix_fmt", "gray",
    "-f", "rawvideo",
    "-y", outPath,
  ];
}

async function realFrame(
  id: string,
  videoPath: string,
  tSec: number,
  vf: string,
  w: number,
  fixedH: number | null,
  note: string,
): Promise<Frame | null> {
  if (!existsSync(videoPath)) return null;
  const path = join(CACHE, `${id}.gray`);
  if (!existsSync(path)) {
    await run(FFMPEG, frameArgv(videoPath, tSec, vf, path));
  }
  const pixels = new Uint8Array(await readFile(path));
  const h = fixedH ?? Math.floor(pixels.length / w);
  if (h < 3) return null;
  return { id, kind: "real", note, w, h, pixels, path };
}

async function probeDuration(videoPath: string): Promise<number> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath,
  ]);
  return Number(stdout.trim());
}

// ---- reporting -------------------------------------------------------------

function fmt(n: number, digits = 3): string {
  return n.toFixed(digits);
}

function table(rows: string[][], headers: string[]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, c) => Math.max(...all.map((r) => (r[c] ?? "").length)));
  const line = (r: string[]) => r.map((cell, c) => (cell ?? "").padEnd(widths[c]!)).join("  ");
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

// ---- main ------------------------------------------------------------------

interface Report {
  meta: { node: string; platform: string; arch: string; ffmpeg: string; quick: boolean };
  l1: Array<{ kernel: string; frame: string; kind: string; w: number; h: number; note: string } & Timing & {
    nsPerPixel: number;
    mbPerSec: number;
  }>;
  l2: Array<{ kernel: string; frame: string; kernelMs: number; readMs: number; totalMs: number }>;
  l3: Array<{
    stage: string;
    samples: number;
    decomposed: { ffmpegMs: number; readMs: number; kernelMs: number; otherMs: number; totalMs: number };
    wallClockMs: number;
    discrepancy: number;
    withinTolerance: boolean;
    kernelSharePct: number;
  }>;
  notes: string[];
}

async function main(): Promise<void> {
  await mkdir(CACHE, { recursive: true });

  const notes: string[] = [];
  const report: Report = {
    meta: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      ffmpeg: (await execFileAsync(FFMPEG, ["-version"])).stdout.split("\n")[0] ?? "unknown",
      quick,
    },
    l1: [],
    l2: [],
    l3: [],
    notes,
  };

  const fixture = join(FIXTURES, "fixture.mp4");
  const landscape = join(FIXTURES, "landscape.mp4");
  const reel = join(FIXTURES, "edited-reel.mp4");

  if (!existsSync(fixture)) {
    say("fixtures/fixture.mp4 is missing. Run `pnpm fixture` first.");
    process.exit(1);
  }

  /**
   * The burned-in-title reel is the single most representative bandScores
   * input that exists — it is the footage the detector was built for. Several
   * common ffmpeg builds omit `drawtext` (it needs libfreetype), and
   * make-fixture.mjs skips the reel rather than failing. Say so loudly: a
   * bandScores number measured only on colour bars and synthetic noise is a
   * bound, not a measurement.
   */
  if (!existsSync(reel)) {
    notes.push(
      "fixtures/edited-reel.mp4 is ABSENT (this ffmpeg has no drawtext filter). " +
        "bandScores was therefore never measured on real burned-in text — its numbers " +
        "here are bounds from colour bars and synthetic frames only.",
    );
  }

  // ---- gather frames -------------------------------------------------------

  const coverFrames = (
    await Promise.all([
      realFrame("cover-fixture", fixture, 1.5, COVER_CROP_VF, COVER_W, COVER_H, "testsrc2 colour bars, cover centre-crop"),
      realFrame("cover-landscape", landscape, 1.5, COVER_CROP_VF, COVER_W, COVER_H, "16:9 source, cover centre-crop"),
      realFrame("cover-reel", reel, 1.5, COVER_CROP_VF, COVER_W, COVER_H, "burned-in title, cover centre-crop"),
    ])
  ).filter((f): f is Frame => f !== null);

  const textFrames = (
    await Promise.all([
      realFrame("text-fixture", fixture, 1.5, `scale=${TEXT_W}:-2`, TEXT_W, null, "testsrc2 colour bars — the historical false positive"),
      realFrame("text-landscape", landscape, 1.5, `scale=${TEXT_W}:-2`, TEXT_W, null, "16:9 source"),
      realFrame("text-reel", reel, 1.5, `scale=${TEXT_W}:-2`, TEXT_W, null, "burned-in title — the input the detector exists for"),
    ])
  ).filter((f): f is Frame => f !== null);

  const faceFrames = (
    await Promise.all([
      realFrame("face-fixture", fixture, 1.5, `scale=${FACE_W}:-2`, FACE_W, null, "testsrc2 — no face, so the cascade early-exits hard"),
    ])
  ).filter((f): f is Frame => f !== null);

  const synthCover = syntheticFrames(COVER_W, COVER_H, "360x640");
  const synthText = syntheticFrames(TEXT_W, 426, "240x426");

  // ---- L1: kernel only -----------------------------------------------------

  const detectFace = await createFaceDetector();

  const l1rows: string[][] = [];
  const pushL1 = (kernel: string, f: Frame, t: Timing) => {
    const bytes = f.w * f.h;
    const nsPerPixel = (t.p50Ms * 1e6) / bytes;
    const mbPerSec = bytes / 1e6 / (t.p50Ms / 1e3);
    report.l1.push({ kernel, frame: f.id, kind: f.kind, w: f.w, h: f.h, note: f.note, ...t, nsPerPixel, mbPerSec });
    l1rows.push([
      kernel,
      f.id,
      f.kind,
      `${f.w}x${f.h}`,
      fmt(t.p50Ms),
      fmt(t.meanMs),
      fmt(nsPerPixel, 2),
      fmt(mbPerSec, 0),
      String(t.iters),
    ]);
  };

  for (const f of [...coverFrames, ...synthCover]) {
    pushL1("laplacianVariance", f, timeIt(() => void laplacianVariance(f.pixels, f.w, f.h)));
  }
  for (const f of [...textFrames, ...synthText]) {
    pushL1("bandScores", f, timeIt(() => void bandScores(f.pixels, f.w, f.h)));
  }
  for (const f of faceFrames) {
    // The full production closure: upright pass plus, on a miss, the 4-angle
    // ROTATION_SWEEP_DEG rerun. That sweep is why a frame with no face costs
    // MORE than one with a face, which is the opposite of the intuition.
    pushL1("faceDetect(sweep)", f, timeIt(() => void detectFace(f.pixels, f.w, f.h), { minIters: 5, minMs: 800 }));
    pushL1("rotateGray(20deg)", f, timeIt(() => void rotateGray(f.pixels, f.w, f.h, 20)));
  }

  // ---- L2: kernel + readFile + allocation ----------------------------------

  const l2rows: string[][] = [];
  const pushL2 = async (kernel: string, f: Frame, kernelFn: (px: Uint8Array) => void) => {
    if (!f.path) return;
    const path = f.path;
    const kernelMs = timeIt(() => kernelFn(f.pixels)).p50Ms;
    const readMs =
      (await timeAsync(async () => {
        for (let i = 0; i < 20; i++) void new Uint8Array(await readFile(path));
      })) / 20;
    report.l2.push({ kernel, frame: f.id, kernelMs, readMs, totalMs: kernelMs + readMs });
    l2rows.push([kernel, f.id, fmt(kernelMs), fmt(readMs), fmt(kernelMs + readMs)]);
  };

  for (const f of coverFrames) await pushL2("laplacianVariance", f, (px) => void laplacianVariance(px, f.w, f.h));
  for (const f of textFrames) await pushL2("bandScores", f, (px) => void bandScores(px, f.w, f.h));

  // ---- L3: whole stage, two independent measurements -----------------------

  const duration = await probeDuration(fixture);
  const l3samples = quick ? 4 : 12;

  /**
   * (i) Re-implement the sample loop with the production argv, timing each
   * phase. `run()` from exec.ts is imported directly by cover.ts/source-text.ts
   * and there is no vi.mock outside vitest, so intercepting it is not an
   * option — re-implementing ~20 lines is the only way to attribute the split.
   * (ii) then wall-clocks the real exported function, and the two must agree.
   */
  async function decomposeSampleLoop(
    videoPath: string,
    times: number[],
    vf: string,
    w: number,
    fixedH: number | null,
    kernel: (px: Uint8Array, w: number, h: number) => void,
  ): Promise<{ ffmpegMs: number; readMs: number; kernelMs: number; otherMs: number; totalMs: number }> {
    let ffmpegMs = 0;
    let readMs = 0;
    let kernelMs = 0;
    const t0 = process.hrtime.bigint();
    for (const [i, t] of times.entries()) {
      const framePath = join(CACHE, `decompose-${i}.gray`);
      ffmpegMs += await timeAsync(async () => {
        await run(FFMPEG, frameArgv(videoPath, t, vf, framePath));
      });
      let pixels = new Uint8Array(0);
      readMs += await timeAsync(async () => {
        pixels = new Uint8Array(await readFile(framePath));
      });
      await unlink(framePath).catch(() => {});
      const h = fixedH ?? Math.floor(pixels.length / w);
      if (h < 3) continue;
      const k0 = process.hrtime.bigint();
      kernel(pixels, w, h);
      kernelMs += Number(process.hrtime.bigint() - k0) / 1e6;
    }
    const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ffmpegMs, readMs, kernelMs, otherMs: totalMs - ffmpegMs - readMs - kernelMs, totalMs };
  }

  const l3rows: string[][] = [];
  const pushL3 = (
    stage: string,
    samples: number,
    decomposed: { ffmpegMs: number; readMs: number; kernelMs: number; otherMs: number; totalMs: number },
    wallClockMs: number,
  ) => {
    const discrepancy = Math.abs(decomposed.totalMs - wallClockMs) / Math.max(decomposed.totalMs, wallClockMs);
    const kernelSharePct = (decomposed.kernelMs / wallClockMs) * 100;
    report.l3.push({
      stage,
      samples,
      decomposed,
      wallClockMs,
      discrepancy,
      withinTolerance: discrepancy <= CONSISTENCY_TOLERANCE,
      kernelSharePct,
    });
    l3rows.push([
      stage,
      String(samples),
      fmt(decomposed.ffmpegMs, 0),
      fmt(decomposed.readMs, 1),
      fmt(decomposed.kernelMs, 1),
      fmt(decomposed.otherMs, 1),
      fmt(decomposed.totalMs, 0),
      fmt(wallClockMs, 0),
      `${fmt(discrepancy * 100, 1)}%`,
      `${fmt(kernelSharePct, 3)}%`,
    ]);
  };

  // --- cover selection ---
  // detectFace is deliberately NOT passed: it would add the cascade's cost to
  // BOTH sides and swamp the very kernel share this is measuring. The face
  // cost is reported on its own line below, which is the honest split.
  {
    const window = Math.max(1, duration * 0.2);
    const times = Array.from({ length: l3samples }, (_, i) => (window * (i + 0.5)) / l3samples);
    const decomposed = await decomposeSampleLoop(fixture, times, COVER_CROP_VF, COVER_W, COVER_H, (px, w, h) =>
      void laplacianVariance(px, w, h),
    );
    const dir = join(CACHE, "cover-run");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const wall = await timeAsync(async () => {
      await pickCoverFrame({ ffmpegPath: FFMPEG }, fixture, duration, { samples: l3samples, cacheDir: dir });
    });
    pushL3("pickCoverFrame", l3samples, decomposed, wall);
  }

  // --- burned-in-text scan ---
  // assumeEdited is deliberately UNSET so the detection path actually runs.
  // In production it never does: produce.ts:1474 is the only caller and it
  // always passes assumeEdited:true, which returns before a frame is decoded.
  {
    const samples = Math.min(40, Math.max(12, Math.round(duration / 1.5)));
    const step = duration / samples;
    const times = Array.from({ length: samples }, (_, i) => step * (i + 0.5));
    const decomposed = await decomposeSampleLoop(fixture, times, `scale=${TEXT_W}:-2`, TEXT_W, null, (px, w, h) =>
      void bandScores(px, w, h),
    );
    const dir = join(CACHE, "scan-run");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const wall = await timeAsync(async () => {
      await scanSourceText({ ffmpegPath: FFMPEG }, fixture, duration, { cacheDir: dir });
    });
    pushL3("scanSourceText (DEAD in prod)", samples, decomposed, wall);
  }

  // --- face measurement ---
  {
    const samples = quick ? 3 : 12;
    const times = Array.from({ length: samples }, (_, i) => (duration * (i + 1)) / (samples + 1));
    const decomposed = await decomposeSampleLoop(fixture, times, `scale=${FACE_W}:-2`, FACE_W, null, (px, w, h) =>
      void detectFace(px, w, h),
    );
    const dir = join(CACHE, "face-run");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const wall = await timeAsync(async () => {
      await measureFaceInWindows({ ffmpegPath: FFMPEG }, fixture, [{ startSec: 0, endSec: duration, cropVf: "" }], {
        samplesPerWindow: samples,
        workDir: dir,
      });
    });
    pushL3("measureFaceInWindows", samples, decomposed, wall);
  }

  // ---- output --------------------------------------------------------------

  say();
  say("=== L1  kernel only (buffer already in RAM) ===");
  say(table(l1rows, ["kernel", "frame", "kind", "size", "p50 ms", "mean ms", "ns/px", "MB/s", "n"]));
  say();
  say("  SYNTHETIC ROWS ARE BOUNDS, NOT MEASUREMENTS. bandScores' cost is");
  say("  dominated by a data-dependent branch, so uniform noise is near its");
  say("  WORST case and a gradient near its best. Only the 'real' rows describe");
  say("  footage.");

  say();
  say("=== L2  kernel + readFile + allocation (per-frame JS cost) ===");
  say(table(l2rows, ["kernel", "frame", "kernel ms", "read ms", "total ms"]));

  say();
  say("=== L3  whole stage, decomposed vs wall clock ===");
  say(
    table(l3rows, [
      "stage", "n", "ffmpeg", "read", "kernel", "other", "sum", "wall", "delta", "kernel share",
    ]),
  );

  const failed = report.l3.filter((r) => !r.withinTolerance);
  say();
  if (failed.length > 0) {
    say(`!! ATTRIBUTION GATE FAILED for ${failed.length} stage(s):`);
    for (const r of failed) {
      say(`   ${r.stage}: decomposed ${fmt(r.decomposed.totalMs, 0)}ms vs wall ${fmt(r.wallClockMs, 0)}ms ` +
        `(${fmt(r.discrepancy * 100, 1)}% > ${CONSISTENCY_TOLERANCE * 100}%)`);
    }
    say("   Do NOT publish these stages' kernel-share figures until this is resolved.");
    notes.push(`Attribution gate failed for: ${failed.map((r) => r.stage).join(", ")}`);
  } else {
    say(`Attribution gate PASSED for all ${report.l3.length} stages (<= ${CONSISTENCY_TOLERANCE * 100}%).`);
  }

  say();
  say("=== headline ===");
  for (const r of report.l3) {
    say(`  ${r.stage}: kernel is ${fmt(r.kernelSharePct, 3)}% of that stage's wall clock`);
  }
  say();
  say("  SECOND DENOMINATOR: `ossclip produce` wall clock is dominated by whisper");
  say("  transcription and the Remotion render, both measured in minutes. Against");
  say("  that, every figure above is smaller again. Two denominators, both stated —");
  say("  one denominator is how benchmarks lie.");

  for (const n of notes) {
    say();
    say(`  NOTE: ${n}`);
  }
  say();

  if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(CACHE, "last-run.json"), JSON.stringify(report, null, 2));
}

main().catch((err) => {
  say(String(err?.stack ?? err));
  process.exit(1);
});
