import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { saveConfigPatch } from "@ossclip/core";
import {
  COVER_IN_VIDEO_SUBDIR,
  coverInVideoCandidates,
  coverInVideoFileName,
  produce,
  resolveCoverInVideo,
} from "../src/produce";

/**
 * The opt-in cover overlay's wiring. The matrix is the watermark's contract
 * verbatim — default OFF, config supplies a once-set default, a TYPED flag
 * always wins — because a config you cannot escape per run is a trap, and
 * this one paints over the first frames of the hook.
 */
describe("resolveCoverInVideo", () => {
  it("defaults off with no flag and no config", () => {
    expect(resolveCoverInVideo(undefined, undefined)).toBe(false);
  });

  it("the config turns it on when the flag is not typed", () => {
    expect(resolveCoverInVideo(undefined, true)).toBe(true);
    expect(resolveCoverInVideo(undefined, false)).toBe(false);
  });

  it("a typed flag beats the config in both directions", () => {
    expect(resolveCoverInVideo(false, true)).toBe(false); // --no-cover-in-video vs config-on
    expect(resolveCoverInVideo(true, false)).toBe(true);
    expect(resolveCoverInVideo(true, undefined)).toBe(true);
    expect(resolveCoverInVideo(false, undefined)).toBe(false);
  });

  // config.json is hand-editable and loadConfig doesn't zod-parse it — a
  // malformed value must stay OFF, never be coerced on by truthiness.
  it("a non-boolean config value stays off", () => {
    expect(resolveCoverInVideo(undefined, "yes" as unknown as boolean)).toBe(false);
    expect(resolveCoverInVideo(undefined, 1 as unknown as boolean)).toBe(false);
  });
});

describe("coverInVideoCandidates", () => {
  // The editor panel's ladder (`currentCoverImage` in edit.ts): the last
  // cover render's own destination first, then the run's `<out>.cover.jpg`.
  // Two surfaces disagreeing about which file IS the cover is how the overlay
  // would show an image the panel says was replaced.
  it("prefers the destination the last cover render used", () => {
    expect(
      coverInVideoCandidates({ provenanceOut: "/elsewhere/short.cover.jpg", outPath: "/o/short.mp4" }),
    ).toEqual(["/elsewhere/short.cover.jpg", "/o/short.cover.jpg"]);
  });

  it("falls back to the run's own artifact path with no provenance", () => {
    expect(coverInVideoCandidates({ provenanceOut: null, outPath: "/o/short.mp4" })).toEqual([
      "/o/short.cover.jpg",
    ]);
    expect(coverInVideoCandidates({ outPath: "/o/short.mp4" })).toEqual(["/o/short.cover.jpg"]);
  });
});

describe("coverInVideoFileName", () => {
  // Namespaced into a fixed subfolder, never the public dir's root: the
  // public dir can BE the user's input folder, and a root-level name could
  // overwrite a file of theirs (SIDE_IMAGE_SUBDIR's lesson).
  it("stages under the fixed subfolder", () => {
    expect(coverInVideoFileName("/o/short.cover.jpg")).toBe(`${COVER_IN_VIDEO_SUBDIR}/cover.jpg`);
  });

  it("keeps the source's extension, lowercased", () => {
    expect(coverInVideoFileName("/o/art.PNG")).toBe(`${COVER_IN_VIDEO_SUBDIR}/cover.png`);
    expect(coverInVideoFileName("/o/art.jpeg")).toBe(`${COVER_IN_VIDEO_SUBDIR}/cover.jpeg`);
  });

  // A SERVED URL, read back by staticFile() and the editor's /media/ mount —
  // both split on `/` only, so a Windows separator here would 404 the overlay
  // on exactly one platform (sideImageDestRel's lesson).
  it("is POSIX-literal", () => {
    expect(coverInVideoFileName("C:\\out\\short.cover.jpg")).not.toContain("\\");
  });
});

describe("the coverInVideo preference round-trips through config.json", () => {
  it("writes and reads back without touching a real home", () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-cover-in-video-"));
    const path = saveConfigPatch({ coverInVideo: true }, dir);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ coverInVideo: true });
  });
});

/**
 * The flag pair against the REAL program (produce-argv-roundtrip's harness,
 * trimmed to one command): the tri-state is a commander subtlety — the
 * positive has to be declared FIRST for the default to stay undefined — and
 * this pair also sits next to `--cover`/`--no-cover`, whose spelling it very
 * nearly shares. Both facts are invisible in the source and load-bearing:
 * without them a flagless run would read as a typed one and silence the
 * config, or `--no-cover-in-video` would fold onto the wrong key.
 */
const parseProduce = async (argv: string[]): Promise<Record<string, unknown>> => {
  const { buildProgram } = await import("../src/program");
  const program = buildProgram();
  for (const cmd of [program, ...program.commands]) {
    cmd.exitOverride();
    cmd.configureOutput({ writeErr() {} });
  }
  let captured: Record<string, unknown> = {};
  const produceCmd = program.commands.find((c) => c.name() === "produce");
  if (produceCmd === undefined) throw new Error("the real program has no `produce` command");
  produceCmd.action((_input: string | undefined, opts: Record<string, unknown>) => {
    captured = opts;
  });
  await program.parseAsync(["node", "ossclip", ...argv]);
  return captured;
};

describe("--cover-in-video on the real produce command", () => {
  it("stays undefined when not typed, so the config can supply the default", async () => {
    expect(await parseProduce(["produce", "./take.mp4"])).not.toHaveProperty("coverInVideo");
  });

  it("reads both spellings onto one tri-state key", async () => {
    expect((await parseProduce(["produce", "./take.mp4", "--cover-in-video"])).coverInVideo).toBe(
      true,
    );
    expect((await parseProduce(["produce", "./take.mp4", "--no-cover-in-video"])).coverInVideo).toBe(
      false,
    );
  });

  // The neighbour it nearly shares a spelling with: `--cover`/`--no-cover` is
  // about WRITING the cover file, and neither flag may touch the other's key.
  it("does not collide with --cover / --no-cover", async () => {
    const noCover = await parseProduce(["produce", "./take.mp4", "--no-cover"]);
    expect(noCover.cover).toBe(false);
    expect(noCover).not.toHaveProperty("coverInVideo");
    const overlay = await parseProduce(["produce", "./take.mp4", "--cover-in-video"]);
    expect(overlay.cover).not.toBe(false);
  });
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * The render-props end of the wiring, `--no-zoom`'s test shape: what a real
 * produce run writes, on and off. The OFF case is the load-bearing one — an
 * absent key is what keeps every pre-feature render byte-identical, and it is
 * only a contract if something fails when the key appears anyway.
 */
describe.skipIf(!hasFfmpeg)("--cover-in-video in render-props", () => {
  let dir: string;
  let realHome: string | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ossclip-cover-in-video-props-"));
    // HERMETIC HOME (2026-08-31): produce() reads ~/.ossclip/config.json via
    // loadConfig, so the machine's own `coverInVideo: true` flipped the
    // "default writes NO key" assertion below. os.homedir() honours $HOME on
    // posix; pointing it at the temp dir gives this suite an empty config.
    realHome = process.env.HOME;
    process.env.HOME = dir;
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
      "-shortest", "-y", join(dir, "take.mp4"),
    ]);
    writeFileSync(
      join(dir, "transcript.json"),
      JSON.stringify({
        language: "en",
        words: [
          // First word at 0.3s: between the floor and the cap, so the window
          // is the word's own start rather than either bound.
          { text: "hello", start: 0.3, end: 0.7 },
          { text: "there", start: 2.5, end: 3.0 },
        ],
      }),
    );
    // The project's CURRENT cover, as a prior run (or `ossclip cover`) would
    // have left it beside the output — this run's own cover is written after
    // the render, so this is the only image the overlay can use.
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "color=c=red:size=320x240:duration=1",
      "-frames:v", "1", "-y", join(dir, "short.cover.jpg"),
    ]);
  });

  afterAll(() => {
    if (realHome !== undefined) process.env.HOME = realHome;
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (coverInVideo: boolean | undefined, workdir: string) => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await produce(join(dir, "take.mp4"), {
        cleanup: "standard",
        render: false,
        mezzanine: false,
        transcript: join(dir, "transcript.json"),
        out: join(dir, "short.mp4"),
        workdir: join(dir, workdir),
        coverInVideo,
      });
      return {
        work: result.workdir,
        props: JSON.parse(readFileSync(join(result.workdir, "render-props.json"), "utf8")) as {
          coverInVideo?: { fileName: string; durationSec: number };
        },
      };
    } finally {
      spy.mockRestore();
    }
  };

  it(
    "on: the window ends at the first word and the image is staged where both mounts look",
    async () => {
      const { work, props } = await run(true, "work-on");
      expect(props.coverInVideo).toEqual({
        fileName: `${COVER_IN_VIDEO_SUBDIR}/cover.jpg`,
        durationSec: 0.3,
      });
      // Staged into the WORKDIR too, not just the render's public dir: the
      // editor serves this exact name at `/media/` for the live preview.
      expect(existsSync(join(work, `${COVER_IN_VIDEO_SUBDIR}/cover.jpg`))).toBe(true);
    },
    120_000,
  );

  it(
    "default writes NO coverInVideo key — absent means off, byte-compatible with pre-flag props",
    async () => {
      const { props } = await run(undefined, "work-off");
      expect("coverInVideo" in props).toBe(false);
    },
    120_000,
  );
});
