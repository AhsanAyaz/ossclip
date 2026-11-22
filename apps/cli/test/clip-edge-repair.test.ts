import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { produce, type ProduceOptions } from "../src/produce";
import { startEditServer } from "../src/edit";

/**
 * A repair that straddles a `--clip` edge (graphic-editor-modal Task 4,
 * 2026-11-22). A 1→2 split ("agents" → "AI agents") with the window starting
 * on its second half: the raw slice (sliced by TIME) and produce's
 * `transcript.words` (the repaired list sliced by INDEX) then agree in count
 * and text but not in timing, so the text-only `captionWordsDiffer` left
 * `captionWords` unrecorded, and the editor server's repair replay rebuilt a
 * list with "AI" in front — every word index one off, for the sound-effect
 * lane and the item-timing block window alike. The probe that found it is
 * the first test here.
 *
 * The harness is replay-keeps-repairs': 11 synthetic words at 0.3 + 0.6 i,
 * the mock provider, never rendered.
 */

// The unit job has no ffmpeg (ci.yml): a produce-driving test skips there.
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const GOLDEN = new URL("./fixtures/caption-words/", import.meta.url).pathname;
// Opening a workdir records it as a recent project (R17 §83): aimed at tmp.
const SHARED_RECENTS = join(tmpdir(), "ossclip-test-recents");

type Repair = { startWord: number; endWord: number; heard: string; correction: string };
type W = { text: string; start: number; end: number };

describe.skipIf(!hasFfmpeg)("produce: the editor's word list on a --clip project with repairs", () => {
  let dir: string;
  let libraryDir: string;
  let close: (() => void) | undefined;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-clip-edge-"));
    libraryDir = mkdtempSync(join(tmpdir(), "ossclip-empty-library-"));
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=8",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-shortest", "-y", join(dir, "take.mp4"),
    ]);
    const texts = ["use", "Versal", "or", "Etan", "to", "build", "agents", "today", "with", "no", "code"];
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify({
        language: "en",
        words: texts.map((text, i) => ({ text, start: 0.3 + i * 0.6, end: 0.7 + i * 0.6, confidence: 0.99 })),
      }),
    );
  });
  afterEach(() => {
    close?.();
    close = undefined;
    vi.restoreAllMocks();
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(libraryDir, { recursive: true, force: true });
  });

  const run = (workdir: string, extra: Partial<ProduceOptions> = {}) =>
    produce(join(dir, "take.mp4"), {
      cleanup: "standard",
      libraryDir,
      render: false,
      mezzanine: false,
      youtube: false,
      confirmRepairs: false,
      transcript: join(dir, "transcript.json"),
      workdir,
      produce: true,
      provider: "mock",
      ...extra,
    });
  const production = (work: string) =>
    JSON.parse(readFileSync(join(work, "production.json"), "utf8")) as {
      captionWords?: W[];
      clip?: { startWord: number; endWord: number; startSec: number };
    };
  /** What a real provider proposing `repairs` and the user keeping each at
   * the CLI picker leave behind: the repair cache and the decisions file. */
  const seedRepairs = (work: string, repairs: Repair[]) => {
    const cacheFile = readdirSync(work).find((f) => /^repairs-[0-9a-f]{8}\.json$/.test(f));
    expect(cacheFile).toBeDefined();
    writeFileSync(join(work, cacheFile!), JSON.stringify(repairs.map((r) => ({ ...r, applied: true }))));
    writeFileSync(
      join(work, "repair-decisions.json"),
      JSON.stringify({ decisions: repairs.map((r) => ({ ...r, keep: true })), addedTerms: [] }),
    );
  };
  /** The editor's word space: the sound-effect lane's `words`, which the
   * graphic editor's block windows read as well. */
  const serverWords = async (work: string): Promise<W[] | null> => {
    const server = await startEditServer(work, { port: 0, recentDir: SHARED_RECENTS, loadCfg: () => ({}) });
    close = server.close;
    const body = (await (await fetch(`${server.url}/api/sfx/plan`)).json()) as { words: W[] | null };
    return body.words;
  };
  /** production.json with the run's tmp paths and the planning timestamp
   * taken out — every other byte is deterministic on the mock provider. */
  const normalized = (work: string) =>
    readFileSync(join(work, "production.json"), "utf8")
      .split(libraryDir)
      .join("<LIB>")
      .split(dir)
      .join("<DIR>")
      .replace(/"at": "[^"]+"/, '"at": "<AT>"');

  const SPLIT: Repair = { startWord: 6, endWord: 6, heard: "agents", correction: "AI agents" };

  it("a repair straddling the window's start: produce's words and the server's are one list", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const first = await run(join(dir, "wd-straddle"), { clip: 3, clipWindow: "5:9" });
    seedRepairs(first.workdir, [SPLIT]);
    // Repaired: use Versal or Etan to build AI agents today with no code.
    // Words 7-10 start on the split's SECOND half, mid raw "agents".
    await run(join(dir, "wd-straddle"), { clip: 3, clipWindow: "7:10" });
    const p = production(first.workdir);
    expect(p.clip).toMatchObject({ startWord: 7, endWord: 10 });
    // Produce's own `transcript.words`, recorded verbatim (produce.ts writes
    // `captionWords: transcript.words`): the window's four words, the first
    // starting where the window does.
    expect(p.captionWords?.map((w) => w.text)).toEqual(["agents", "today", "with", "no"]);
    expect(p.captionWords![0]!.start).toBe(p.clip!.startSec);
    const words = await serverWords(first.workdir);
    // Equal length and source starts: an index means the same word in the
    // render and in the editor (the sound-effect lane's placements, the
    // graphic editor's anchor words). Before the fix: 5 words, "AI" first.
    expect(words?.length).toBe(p.captionWords!.length);
    expect(words?.map((w) => w.start)).toEqual(p.captionWords!.map((w) => w.start));
  }, 240_000);

  // Byte-equal to production.json as the text-only rule wrote it: the
  // fixtures were captured on the build before the fix (2026-11-22, e3927a6)
  // with this same harness. An ordinary repair keeps or re-derives timing
  // together with a changed text or count, so the rule's answer, and the
  // file, are the same. If an unrelated change (theme defaults, the mock
  // plan) moves other bytes, re-capture — but `captionWords` (present or
  // absent, and its content) must come out as it is here.
  it("an ordinary repaired project writes production.json byte-equal to before the fix", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const first = await run(join(dir, "wd-ordinary"));
    seedRepairs(first.workdir, [
      { startWord: 1, endWord: 1, heard: "Versal", correction: "Vercel" },
      { startWord: 3, endWord: 3, heard: "Etan", correction: "n8n" },
    ]);
    await run(join(dir, "wd-ordinary"));
    expect(normalized(first.workdir)).toBe(readFileSync(join(GOLDEN, "repaired.production.json"), "utf8"));
  }, 240_000);

  it("a --clip project whose repair lies inside the window writes production.json byte-equal to before the fix", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const first = await run(join(dir, "wd-inside"), { clip: 3, clipWindow: "5:9" });
    seedRepairs(first.workdir, [SPLIT]);
    // Repaired words 5-9: build AI agents today with — the whole split inside.
    await run(join(dir, "wd-inside"), { clip: 3, clipWindow: "5:9" });
    expect(normalized(first.workdir)).toBe(readFileSync(join(GOLDEN, "clip-inside.production.json"), "utf8"));
    const p = production(first.workdir);
    expect((await serverWords(first.workdir))?.map((w) => w.start)).toEqual(p.captionWords!.map((w) => w.start));
  }, 240_000);
});
