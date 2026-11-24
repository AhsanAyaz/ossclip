import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRAW_EXAMPLE_CHARACTER, clipKey, defaultTheme, type ShotHistory } from "@ossclip/core";
import { makeCancelSignal, type DrawnRenderProps } from "@ossclip/renderer";
import { DRAW_KIT_VERSION } from "@ossclip/scenes/draw/reference";
import { approvedClipPath, saveShot, versionPaths } from "../src/draw/shot-store";
import { ApproveError, approveShot, type ApproveArgs, type ApproveDeps } from "../src/storyboard/approve";

/**
 * Approving a drawn shot (storyboard design §8; plan B2a Task 2; §169) with
 * the bundler, the browser and the clip import faked. The shot's files are
 * real, in a temp workdir: what Approve leaves beside approved.mov when a
 * render fails is the point of half of these tests.
 */

const SHOT = "s1";
const CODE = DRAW_EXAMPLE_CHARACTER;
const sha1 = (t: string): string => createHash("sha1").update(t).digest("hex");
const project = { width: 1080, height: 1920, fps: 30, theme: { ...defaultTheme, accent: "#ff00aa" } };

interface World {
  deps: ApproveDeps;
  stills: { outDir: string; props: DrawnRenderProps }[];
  clips: { outPath: string; props: DrawnRenderProps; cancelSignal: unknown }[];
  imports: { srcAbs: string; publicDir: string; bytes: string }[];
  staged: { publicDir: string; assetsDir: string | undefined }[];
  dirs: string[];
  clipError: Error | null;
  importError: Error | null;
}

function makeWorld(): World {
  const w: World = {
    stills: [],
    clips: [],
    imports: [],
    staged: [],
    dirs: [],
    clipError: null,
    importError: null,
    deps: undefined as unknown as ApproveDeps,
  };
  const tempDir = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    w.dirs.push(d);
    return d;
  };
  w.deps = {
    readTextFile: (p) => readFileSync(p, "utf8"),
    hashHex: sha1,
    bundle: async () => tempDir("ossclip-approve-test-bundle-"),
    renderStills: async (a) => {
      w.stills.push({ outDir: a.outDir, props: a.props });
      mkdirSync(a.outDir, { recursive: true });
      return [1, 2, 3].map((i) => {
        const p = join(a.outDir, `still-${i}.png`);
        writeFileSync(p, `png at ${a.props.durationSec}`);
        return p;
      });
    },
    renderClip: async (a) => {
      w.clips.push({ outPath: a.outPath, props: a.props, cancelSignal: a.cancelSignal });
      if (w.clipError) {
        // A real render can fail after it started writing (renderer drawn/render.ts).
        writeFileSync(a.outPath, "half a clip");
        throw w.clipError;
      }
      writeFileSync(a.outPath, "new clip");
    },
    importClip: async (srcAbs, publicDir) => {
      w.imports.push({ srcAbs, publicDir, bytes: readFileSync(srcAbs, "utf8") });
      if (w.importError) throw w.importError;
      return { src: "clips/abc123def456.webm", durationSec: 5.53 };
    },
    stage: async (_project, publicDir, assetsDir) => {
      w.staged.push({ publicDir, assetsDir });
      return {};
    },
    makeRenderDir: () => tempDir("ossclip-approve-test-public-"),
    removeDir: (p) => rmSync(p, { recursive: true, force: true }),
    log: () => {},
  };
  return w;
}

let work: string;
let world: World;

/** A shot with two ok versions, the draft on v2. */
function writeShot(over: Partial<ShotHistory> = {}): void {
  const h: ShotHistory = {
    id: SHOT,
    idea: "a goldfish swims in",
    spokenLine: "and here is the goldfish",
    durationSec: 4,
    versions: [
      { n: 1, result: "ok", kitVersion: DRAW_KIT_VERSION, promptVersion: 1 },
      { n: 2, result: "ok", kitVersion: DRAW_KIT_VERSION, promptVersion: 1 },
    ],
    draft: 2,
    nextVersion: 3,
    notes: [{ onVersion: 1, text: "orange" }],
    runs: [],
    ...over,
  };
  saveShot(work, h);
  writeFileSync(versionPaths(work, SHOT, 1).code, "// v1");
  writeFileSync(versionPaths(work, SHOT, 2).code, CODE);
}

const args = (over: Partial<ApproveArgs> = {}): ApproveArgs => ({ workdir: work, shotId: SHOT, durationSec: 5.5, project, ...over });

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ossclip-approve-"));
  world = makeWorld();
});
afterEach(() => {
  // Every bundle and render dir Approve made is gone again.
  for (const d of world.dirs) expect(existsSync(d), d).toBe(false);
  rmSync(work, { recursive: true, force: true });
});

describe("approveShot", () => {
  it("renders the draft at the given length, imports the clip and returns the approval", async () => {
    writeShot();
    const approval = await approveShot(args(), world.deps);

    expect(world.clips).toHaveLength(1);
    expect(world.clips[0]!.props.durationSec).toBe(5.5);
    expect(world.clips[0]!.outPath.endsWith("approved.next.mov")).toBe(true);
    expect(world.clips[0]!.props).toMatchObject({ width: 1080, height: 1920, fps: 30 });
    expect(world.clips[0]!.props.theme.accent).toBe("#ff00aa");

    expect(approval).toEqual({
      version: 2,
      durationSec: 5.5,
      clipKey: expect.any(String),
      clip: `storyboard/${SHOT}/approved.mov`,
      src: "clips/abc123def456.webm",
    });
    expect(approval.clipKey.length).toBeGreaterThan(0);
    // The key is the core rule's, over the draft's code at the rendered length (design §8).
    expect(approval.clipKey).toBe(
      clipKey({ code: CODE, kitVersion: DRAW_KIT_VERSION, theme: project.theme, width: 1080, height: 1920, fps: 30, durationSec: 5.5 }, sha1),
    );

    // The clip is imported from the new render, into the workdir, then takes approved.mov's name.
    expect(world.imports).toEqual([{ srcAbs: world.clips[0]!.outPath, publicDir: work, bytes: "new clip" }]);
    expect(readFileSync(approvedClipPath(work, SHOT), "utf8")).toBe("new clip");
    expect(existsSync(world.clips[0]!.outPath)).toBe(false);
  });

  it("renders the three stills at the approved length into the draft's own stills dir", async () => {
    writeShot();
    await approveShot(args(), world.deps);
    const v2 = versionPaths(work, SHOT, 2);
    expect(world.stills).toEqual([{ outDir: v2.stillsDir, props: expect.objectContaining({ durationSec: 5.5 }) }]);
    expect(readdirSync(v2.stillsDir).sort()).toEqual(["still-1.png", "still-2.png", "still-3.png"]);
    expect(readFileSync(join(v2.stillsDir, "still-1.png"), "utf8")).toBe("png at 5.5");
  });

  it("stages the assets folder it is given, and hands the cancel signal to the clip render", async () => {
    writeShot();
    const { cancelSignal } = makeCancelSignal();
    await approveShot(args({ assetsDir: "/assets/here", cancelSignal }), world.deps);
    expect(world.staged).toEqual([{ publicDir: expect.any(String), assetsDir: "/assets/here" }]);
    expect(world.clips[0]!.cancelSignal).toBe(cancelSignal);
  });

  it("a clip render that fails leaves the previous approved.mov byte for byte and no approved.next.mov", async () => {
    writeShot();
    writeFileSync(approvedClipPath(work, SHOT), "the clip already in the video");
    world.clipError = new Error("renderMedia: cancelled");
    await expect(approveShot(args(), world.deps)).rejects.toThrow(/cancelled/);
    expect(readFileSync(approvedClipPath(work, SHOT), "utf8")).toBe("the clip already in the video");
    expect(existsSync(world.clips[0]!.outPath)).toBe(false);
    expect(world.imports).toEqual([]);
  });

  it("an import that fails leaves the previous approved.mov as it was and no approved.next.mov", async () => {
    writeShot();
    writeFileSync(approvedClipPath(work, SHOT), "the clip already in the video");
    world.importError = new Error("could not transcode the clip");
    await expect(approveShot(args(), world.deps)).rejects.toThrow(/could not transcode/);
    expect(readFileSync(approvedClipPath(work, SHOT), "utf8")).toBe("the clip already in the video");
    expect(existsSync(world.clips[0]!.outPath)).toBe(false);
  });

  it("refuses a shot with no draft, a shot never drawn, a missing code file and an old kit version, before any render", async () => {
    await expect(approveShot(args(), world.deps)).rejects.toBeInstanceOf(ApproveError);

    writeShot({ versions: [{ n: 1, result: { failed: "x" }, kitVersion: DRAW_KIT_VERSION }], draft: null, nextVersion: 2 });
    await expect(approveShot(args(), world.deps)).rejects.toBeInstanceOf(ApproveError);

    writeShot();
    rmSync(versionPaths(work, SHOT, 2).code);
    await expect(approveShot(args(), world.deps)).rejects.toBeInstanceOf(ApproveError);

    writeShot({
      versions: [
        { n: 1, result: "ok", kitVersion: DRAW_KIT_VERSION },
        { n: 2, result: "ok", kitVersion: DRAW_KIT_VERSION + 1 },
      ],
    });
    await expect(approveShot(args(), world.deps)).rejects.toThrow(/kit/);
    await expect(approveShot(args(), world.deps)).rejects.toBeInstanceOf(ApproveError);

    expect(world.clips).toEqual([]);
    expect(world.stills).toEqual([]);
  });

  it("refuses a length that is not a positive number before any render", async () => {
    writeShot();
    for (const durationSec of [0, -1, Number.NaN]) {
      await expect(approveShot(args({ durationSec }), world.deps)).rejects.toBeInstanceOf(ApproveError);
    }
    expect(world.clips).toEqual([]);
  });

  it("rejects a shot id with path characters (Review Focus 4 of Phase A)", async () => {
    await expect(approveShot(args({ shotId: "../x" }), world.deps)).rejects.toThrow(/shot id/);
    expect(existsSync(join(work, "storyboard"))).toBe(false);
  });
});

describe("approvedClipPath", () => {
  it("is approved.mov in the shot's folder, and refuses an id that fails its schema", () => {
    expect(approvedClipPath("/w", "s1")).toBe(join("/w", "storyboard", "s1", "approved.mov"));
    expect(() => approvedClipPath("/w", "../x")).toThrow(/shot id/);
  });
});
