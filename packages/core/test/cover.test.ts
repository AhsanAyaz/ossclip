import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COVER_CROP_VF,
  COVER_MAX_WORDS,
  COVER_PROVENANCE_BASENAME,
  CoverProvenanceSchema,
  coverDecision,
  coverHeadline,
  laplacianVariance,
  measureCoverFrame,
  readCoverProvenance,
  scoreCandidate,
  writeCoverProvenance,
  type CoverProvenance,
} from "../src/cover";

/** A flat grey frame — no edges at all. */
const flat = (w: number, h: number) => new Uint8Array(w * h).fill(128);
/** Hard vertical stripes — maximum edge energy. */
const stripes = (w: number, h: number) =>
  Uint8Array.from({ length: w * h }, (_, i) => ((i % w) % 2 === 0 ? 0 : 255));
/** The same stripes blurred — what a frame caught mid-motion looks like. */
const blurred = (w: number, h: number) =>
  Uint8Array.from({ length: w * h }, (_, i) => 128 + 40 * Math.sin(((i % w) / w) * Math.PI * 4));

describe("cover frame scoring (FINDINGS §31)", () => {
  it("ranks sharp frames above blurred ones, and blurred above flat", () => {
    const sharp = laplacianVariance(stripes(64, 64), 64, 64);
    const soft = laplacianVariance(blurred(64, 64), 64, 64);
    const none = laplacianVariance(flat(64, 64), 64, 64);
    expect(sharp).toBeGreaterThan(soft);
    expect(soft).toBeGreaterThan(none);
    expect(none).toBeCloseTo(0, 6);
  });

  it("a face outranks sharpness — a cover without the speaker is the wrong cover", () => {
    const withFace = scoreCandidate({
      timeSec: 5, durationSec: 10, sharpness: 10, hasFace: true, maxSharpness: 100,
    });
    const sharperNoFace = scoreCandidate({
      timeSec: 5, durationSec: 10, sharpness: 100, hasFace: false, maxSharpness: 100,
    });
    expect(withFace).toBeGreaterThan(sharperNoFace);
  });

  it("among faces, the sharper frame wins", () => {
    const base = { timeSec: 5, durationSec: 10, hasFace: true, maxSharpness: 100 };
    expect(scoreCandidate({ ...base, sharpness: 90 })).toBeGreaterThan(
      scoreCandidate({ ...base, sharpness: 20 }),
    );
  });

  it("earlier frames break ties, so the cover matches the opening", () => {
    const base = { durationSec: 10, sharpness: 50, hasFace: true, maxSharpness: 100 };
    expect(scoreCandidate({ ...base, timeSec: 1 })).toBeGreaterThan(
      scoreCandidate({ ...base, timeSec: 9 }),
    );
  });
});

describe("cover subject gate (2026-08-16 — the Facebook-reel stranger's face)", () => {
  // A face×2 score hunts ANY face: on a 21-minute screen recording a reel
  // playing inside the recorded screen won the cover. On a screen-subject
  // take a face in frame is content, not the speaker.
  const blurryFace = { timeSec: 5, durationSec: 10, sharpness: 10, hasFace: true, maxSharpness: 100 };
  const sharpNoFace = { timeSec: 5, durationSec: 10, sharpness: 100, hasFace: false, maxSharpness: 100 };

  it('under "face" the face still wins — talking-head runs are unchanged', () => {
    expect(scoreCandidate({ ...blurryFace, subject: "face" })).toBeGreaterThan(
      scoreCandidate({ ...sharpNoFace, subject: "face" }),
    );
    // …and an omitted subject means "face": the pre-fix default, verbatim.
    expect(scoreCandidate(blurryFace)).toBe(scoreCandidate({ ...blurryFace, subject: "face" }));
  });

  it('under "screen" the face carries NO weight — the sharpest frame wins', () => {
    expect(scoreCandidate({ ...sharpNoFace, subject: "screen" })).toBeGreaterThan(
      scoreCandidate({ ...blurryFace, subject: "screen" }),
    );
    // A face is not a penalty either: equally sharp frames tie.
    expect(scoreCandidate({ ...sharpNoFace, subject: "screen" })).toBe(
      scoreCandidate({ ...sharpNoFace, hasFace: true, subject: "screen" }),
    );
  });

  it('under "screen" earliness still breaks sharpness ties', () => {
    const base = { durationSec: 10, sharpness: 50, hasFace: true, maxSharpness: 100, subject: "screen" as const };
    expect(scoreCandidate({ ...base, timeSec: 1 })).toBeGreaterThan(
      scoreCandidate({ ...base, timeSec: 9 }),
    );
  });
});

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

describe("cover headline cap (FINDINGS §35)", () => {
  it("leaves a headline that is already short alone", () => {
    expect(coverHeadline("SIX MONTHS OF MAX, FREE")).toBe("SIX MONTHS OF MAX, FREE");
  });

  it("caps the real §35 case — the full hook reused verbatim", () => {
    // 13 words across five lines in the shipped cover; the reference grid
    // runs 4-9 words over 1-3 lines.
    const out = coverHeadline(
      "CLAUDE GAVE ME SIX MONTHS OF MAX PLAN FOR FREE — AND NOT FOR THE REASON YOU THINK",
    );
    expect(words(out)).toBeLessThanOrEqual(COVER_MAX_WORDS);
    expect(out).not.toContain("REASON");
  });

  it("prefers the clause before the dash when it fits", () => {
    expect(coverHeadline("I QUIT MY JOB — HERE IS WHAT HAPPENED NEXT TO ME")).toBe(
      "I QUIT MY JOB",
    );
  });

  it("never stops on a preposition or article", () => {
    // "…OF" reads as a truncation bug; "…MONTHS" reads as an edit.
    const out = coverHeadline("THE ONE THING NOBODY TELLS YOU ABOUT THE FUTURE OF WORK");
    expect(out.toLowerCase()).not.toMatch(/\b(of|the|and|to|for|a|an)$/);
    expect(words(out)).toBeLessThanOrEqual(COVER_MAX_WORDS);
  });

  it("never crosses the dash while truncating", () => {
    // Cutting into the elaboration produces a sentence fragment, which is
    // worse than a short headline.
    const out = coverHeadline(
      "SIX THINGS I LEARNED SHIPPING AN OPEN SOURCE VIDEO TOOL — NUMBER FOUR SURPRISED ME",
    );
    expect(out).not.toContain("NUMBER");
  });

  it("does not turn a two-word opener into the whole headline", () => {
    // "FREE MONEY" alone is not the claim; the sentence is.
    const out = coverHeadline("FREE MONEY: HOW I GOT SIX MONTHS OF CLAUDE MAX AT NO COST");
    expect(words(out)).toBeGreaterThan(2);
  });

  it("an empty headline stays empty — the caller decides what that means", () => {
    expect(coverHeadline("")).toBe("");
    expect(coverHeadline("   ")).toBe("");
  });
});

describe("cover decision (Urdu field run 2026-08-05)", () => {
  it("hook text present → banner cover, unchanged from before", () => {
    expect(coverDecision(true, "SIX MONTHS OF MAX, FREE")).toBe("banner");
  });

  it("no hook text → textless cover, not a skip — the face frame needs no text", () => {
    expect(coverDecision(true, "")).toBe("textless");
    // Whitespace is what an empty beat-sheet field can round-trip to.
    expect(coverDecision(true, "   ")).toBe("textless");
  });

  it("--no-cover wins over everything, text or not", () => {
    expect(coverDecision(false, "SIX MONTHS OF MAX, FREE")).toBe("none");
    expect(coverDecision(false, "")).toBe("none");
  });
});

describe("measureCoverFrame — one implementation of the cover crop", () => {
  /**
   * A stub ffmpeg that records its argv and writes `bytes` of noise to the
   * `-y` output. The crop math is the whole point of this function, and the
   * only place it is observable is the filter string ffmpeg is handed — so
   * the test reads that, exactly as the platform matrix reads
   * `openCommand()`'s pair rather than launching a browser.
   */
  const stubFfmpeg = (bytes: number): { bin: string; args: () => string[]; dir: string } => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-measure-"));
    const log = join(dir, "argv");
    const bin = join(dir, "ffmpeg");
    writeFileSync(
      bin,
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$@" > "${log}"`,
        'out="${@: -1}"',
        `head -c ${bytes} /dev/urandom > "$out"`,
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    return {
      bin,
      args: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
      dir,
    };
  };
  const DET_BYTES = 360 * 640;
  const face = { centerXFrac: 0.5, centerYFrac: 0.4, sizeFrac: 0.25 };

  it("extracts at the timestamp through cropVf THEN the cover's own centre crop", async () => {
    const ff = stubFfmpeg(DET_BYTES);
    const out = await measureCoverFrame(
      { ffmpegPath: ff.bin },
      "/take.mp4",
      12.4,
      { cacheDir: ff.dir, cropVf: "crop=1080:1440:0:120", detectFace: () => face },
    );
    const args = ff.args();
    expect(args[args.indexOf("-ss") + 1]).toBe("12.400");
    // Order matters: the letterbox trim runs BEFORE the cover crop, or the
    // cover frames two-thirds baked-in black bar (PLAN Task 7).
    expect(args[args.indexOf("-vf") + 1]).toBe(`crop=1080:1440:0:120,${COVER_CROP_VF}`);
    expect(out).toMatchObject({ timeSec: 12.4, hasFace: true, face });
    expect(out!.sharpness).toBeGreaterThan(0);
  });

  it("without a cropVf the filter is the cover crop alone — no stray comma", async () => {
    const ff = stubFfmpeg(DET_BYTES);
    await measureCoverFrame({ ffmpegPath: ff.bin }, "/take.mp4", 1, { cacheDir: ff.dir });
    const args = ff.args();
    expect(args[args.indexOf("-vf") + 1]).toBe(COVER_CROP_VF);
  });

  it("cleans up its scratch frame, and names it as asked", async () => {
    const ff = stubFfmpeg(DET_BYTES);
    await measureCoverFrame({ ffmpegPath: ff.bin }, "/take.mp4", 1, {
      cacheDir: ff.dir,
      frameName: "cover-frame-3.gray",
    });
    const args = ff.args();
    expect(args[args.length - 1]).toBe(join(ff.dir, "cover-frame-3.gray"));
    // A sampler leaving twelve raw frames behind fills a workdir with garbage.
    expect(existsSync(join(ff.dir, "cover-frame-3.gray"))).toBe(false);
  });

  it("returns null on a short read rather than measuring padding", async () => {
    // ffmpeg seeking past the end writes fewer bytes than the detection frame;
    // the sampler skips those, and the single-timestamp caller must be told.
    const ff = stubFfmpeg(DET_BYTES - 1);
    const out = await measureCoverFrame({ ffmpegPath: ff.bin }, "/take.mp4", 99, {
      cacheDir: ff.dir,
      detectFace: () => face,
    });
    expect(out).toBeNull();
  });

  it("no detector means no face — the pick still scores on sharpness", async () => {
    const ff = stubFfmpeg(DET_BYTES);
    const out = await measureCoverFrame({ ffmpegPath: ff.bin }, "/take.mp4", 2, {
      cacheDir: ff.dir,
    });
    expect(out).toMatchObject({ hasFace: false, face: undefined });
  });
});

describe("cover provenance (<workdir>/cover.json)", () => {
  const workdir = (): string => mkdtempSync(join(tmpdir(), "ossclip-cover-"));
  const record: CoverProvenance = {
    version: 1,
    text: "SIX MONTHS OF MAX, FREE",
    textSource: "beatsheet",
    frame: {
      source: "source",
      timeSec: 12.4,
      face: { centerXFrac: 0.5, centerYFrac: 0.38, sizeFrac: 0.22 },
      hasFace: true,
      sharpness: 812.3,
      fileName: "cover-frame.png",
      sourceVideo: "mezzanine.mp4",
      cropVf: "crop=1080:1440:0:120",
    },
    size: { width: 1080, height: 1920 },
    out: "/abs/path/Foo.ossclip.cover.jpg",
  };

  it("round-trips every field — the cover-crop face and cropVf above all", async () => {
    const dir = workdir();
    await writeCoverProvenance(dir, record);
    // Those two are the fields nothing else on disk carries: without them a
    // rebuild cannot place the banner or re-pick a frame from the source.
    expect(await readCoverProvenance(dir)).toEqual(record);
  });

  it("rejects a frame source that is not one of the two videos", () => {
    const bad = { ...record, frame: { ...record.frame, source: "sourcee" } };
    expect(CoverProvenanceSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a face missing a fraction — a partial box mis-places the banner", () => {
    const { centerXFrac: _dropped, ...partial } = record.frame.face!;
    const bad = { ...record, frame: { ...record.frame, face: partial } };
    expect(CoverProvenanceSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a version that is not the literal 1", () => {
    expect(CoverProvenanceSchema.safeParse({ ...record, version: 1.5 }).success).toBe(false);
    expect(CoverProvenanceSchema.safeParse({ ...record, version: 2 }).success).toBe(false);
  });

  /**
   * A cover first built from the FINAL video on a workdir with no provenance:
   * nothing knows which original take it was cut from, and null says so. The
   * field used to be a required string, which is why a regeneration wrote the
   * finished render's path into it and `--from source` started re-cutting
   * from the burned-in video (see `sourceVideo`'s comment in src/cover.ts).
   */
  it("a null sourceVideo round-trips — the original take is unknown, not the final render", async () => {
    const dir = workdir();
    const unknown: CoverProvenance = {
      ...record,
      frame: { ...record.frame, source: "final", sourceVideo: null, cropVf: null },
    };
    await writeCoverProvenance(dir, unknown);
    expect(await readCoverProvenance(dir)).toEqual(unknown);
  });

  it("a v1 file already on disk with a string sourceVideo still parses", async () => {
    // Backward compatibility: every workdir produced before the field went
    // nullable carries a string here, and those must keep loading.
    const dir = workdir();
    writeFileSync(join(dir, COVER_PROVENANCE_BASENAME), JSON.stringify(record));
    expect(await readCoverProvenance(dir)).toEqual(record);
    expect(record.frame.sourceVideo).toBe("mezzanine.mp4");
  });

  it("rejects a sourceVideo that is neither a path nor null", () => {
    const bad = { ...record, frame: { ...record.frame, sourceVideo: 3 } };
    expect(CoverProvenanceSchema.safeParse(bad).success).toBe(false);
  });

  it("a null face and a null cropVf are legal — an uncropped source with no face", async () => {
    const dir = workdir();
    const bare: CoverProvenance = {
      ...record,
      frame: { ...record.frame, face: null, hasFace: false, cropVf: null },
    };
    await writeCoverProvenance(dir, bare);
    expect(await readCoverProvenance(dir)).toEqual(bare);
  });

  it("returns null, never throws, for absent / corrupt / schema-invalid files", async () => {
    // Absent: a pre-feature workdir. The caller re-picks and says so.
    const absent = workdir();
    await expect(readCoverProvenance(absent)).resolves.toBeNull();

    // Corrupt: a half-written file must degrade, not brick the command.
    const corrupt = workdir();
    writeFileSync(join(corrupt, COVER_PROVENANCE_BASENAME), '{"version": 1, "text":');
    await expect(readCoverProvenance(corrupt)).resolves.toBeNull();

    // Schema-invalid: valid JSON that is not a provenance record.
    const invalid = workdir();
    writeFileSync(
      join(invalid, COVER_PROVENANCE_BASENAME),
      JSON.stringify({ ...record, frame: { ...record.frame, timeSec: "12.4" } }),
    );
    await expect(readCoverProvenance(invalid)).resolves.toBeNull();
  });
});
