import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { KitReportSchema, defaultTheme, type KitReport, type SceneCue } from "@ossclip/core";
import type { SceneClipProps } from "@ossclip/renderer";
import {
  KIT_MAX_CONCURRENCY,
  KitExitError,
  defaultKitDir,
  kitConcurrency,
  kitReplayArgs,
  parseKitFlags,
  runKit,
  unrenderableReason,
  type KitFlags,
  type KitSeams,
} from "../src/kit";

/**
 * `ossclip kit` (§162) with every side effect faked: an in-memory file
 * system (so a project can live on `/mnt/c` for the WSL case), a renderer
 * that writes a placeholder, and a replay that rewrites render-props.json
 * the way produce would. No Remotion, no ffmpeg, no TTY — the
 * cover-command.test.ts posture.
 */

// ---- The fake world ----------------------------------------------------------

interface World {
  seams: KitSeams;
  files: Map<string, { text: string; mtimeMs: number }>;
  rendered: string[];
  replays: { args: string[]; workdir: string }[];
  logs: string[];
  /** What the next replay exits with, and what it does to the project first. */
  replay: { code: number; tail?: string[]; effect?: () => void };
  /** Files `probe` refuses. */
  unreadable: Set<string>;
  /** Symlink path → its target, for `realpath`. */
  symlinks: Map<string, string>;
}

function makeWorld(opts: { wsl?: boolean } = {}): World {
  const files = new Map<string, { text: string; mtimeMs: number }>();
  const dirs = new Set<string>(["/"]);
  let clock = 1_000;
  const addDir = (p: string): void => {
    for (let d = p; !dirs.has(d); d = dirname(d)) dirs.add(d);
  };
  const write = (p: string, text: string): void => {
    addDir(dirname(p));
    files.set(p, { text, mtimeMs: clock++ });
  };
  const world: World = {
    files,
    rendered: [],
    replays: [],
    logs: [],
    replay: { code: 0 },
    unreadable: new Set(),
    symlinks: new Map(),
    seams: {
      readFile: async (p) => {
        const f = files.get(p);
        if (f === undefined) throw new Error(`ENOENT: ${p}`);
        return f.text;
      },
      writeFile: async (p, text) => write(p, text),
      exists: (p) => files.has(p) || dirs.has(p),
      stat: (p) => {
        const f = files.get(p);
        if (f !== undefined) return { mtimeMs: f.mtimeMs, isDirectory: false };
        return dirs.has(p) ? { mtimeMs: 0, isDirectory: true } : null;
      },
      realpath: (p) => {
        const target = world.symlinks.get(p);
        if (target !== undefined) return target;
        if (files.has(p) || dirs.has(p)) return p;
        throw new Error(`ENOENT: ${p}`);
      },
      mkdir: async (p) => addDir(p),
      readdir: async (p) =>
        [...files.keys(), ...dirs].filter((x) => x !== p && dirname(x) === p).map((x) => x.slice(p.length + 1)),
      remove: async (p) => {
        files.delete(p);
      },
      probe: async (p) => {
        if (world.unreadable.has(p)) throw new Error("moov atom not found");
        return { duration: 3, width: 1920, height: 1080, fps: 30, hasAudio: true };
      },
      stageFonts: () => {},
      bundle: async () => "http://bundle",
      renderClip: async (_props: SceneClipProps, o) => {
        world.rendered.push(o.outPath.slice(o.outPath.lastIndexOf("/") + 1));
        o.onProgress(0.5);
        o.onProgress(1);
        write(o.outPath, "MOV");
      },
      replayProduce: async (req) => {
        world.replays.push({ args: req.args, workdir: req.workdir });
        world.replay.effect?.();
        return { code: world.replay.code, tail: world.replay.tail ?? [] };
      },
      now: () => new Date(Date.UTC(2026, 10, 17, 12, 0, clock++ % 60)),
      log: (line) => world.logs.push(line),
      platform: "linux",
      env: opts.wsl ? { WSL_DISTRO_NAME: "Ubuntu" } : {},
      procVersion: null,
      cwd: "/home/me",
    },
  };
  return world;
}

const cue = (c: Partial<SceneCue> & Pick<SceneCue, "id" | "startSec" | "endSec">): SceneCue => ({
  layout: "full-bleed",
  ...c,
});

const CUES: SceneCue[] = [
  // A plain filler cue: never a clip.
  cue({ id: "plain-0", kind: "plain", startSec: 0, endSec: 10 }),
  cue({ id: "scene-0", component: "CardRow", props: { cards: [{ text: "A" }] }, startSec: 0.5, endSec: 2.5 }),
  cue({ id: "scene-1", layout: "video-top", component: "StatCard", props: { value: "+100%" }, startSec: 3, endSec: 5 }),
  cue({ id: "scene-2", component: "ClipScene", props: { src: "clips/abc123.webm" }, startSec: 6, endSec: 7 }),
];

interface ProjectOpts {
  root?: string;
  cues?: SceneCue[];
  folder?: boolean;
  command?: boolean;
  clipOriginal?: boolean;
}

/** A produced project: render-props, production, the source, the script and its clip. */
function project(world: World, o: ProjectOpts = {}): { work: string; root: string; source: string } {
  const root = o.root ?? "/videos";
  const work = join(root, ".ossclip", "take-1a2b3c4d");
  const source = o.folder ? join(root, "takes") : join(root, "take.mp4");
  const w = (p: string, v: unknown): void => {
    void world.seams.writeFile(p, typeof v === "string" ? v : JSON.stringify(v));
  };
  if (o.folder) {
    void world.seams.mkdir(source);
    w(join(work, "source-concat.mp4"), "MP4");
  } else {
    w(source, "MP4");
  }
  w(join(work, "production.json"), {
    version: 1,
    source: { path: source, probe: { duration: 20, width: 1920, height: 1080, fps: 60, hasAudio: true } },
    scenes: [{ id: "scene-0" }],
    script: {
      text: "# script",
      sourcePath: join(root, "script.md"),
      clips: [{ path: "clips/steps.mov", src: "clips/abc123.webm", durationSec: 3 }],
    },
  });
  w(join(work, "render-props.json"), renderProps(o.cues ?? CUES));
  if (o.command !== false) {
    w(join(work, "command.json"), {
      execPath: "/usr/bin/node",
      execArgv: [],
      script: "/ossclip/index.ts",
      args: ["take.mp4", "--produce", "--llm", "mock", "--open-editor"],
      cwd: root,
    });
  }
  if (o.clipOriginal !== false) w(join(root, "clips", "steps.mov"), "MOV");
  return { work, root, source };
}

function renderProps(cues: SceneCue[]): unknown {
  return {
    sceneCues: cues,
    spans: [
      { srcIn: 1, srcOut: 5, outIn: 0, outOut: 4 },
      { srcIn: 6, srcOut: 12, outIn: 4, outOut: 10 },
    ],
    theme: defaultTheme,
    settings: { width: 1920, height: 1080, fps: 30 },
    outputDurationSec: 10,
    // Everything else render-props carries is ignored.
    captionLines: [],
  };
}

const FLAGS: KitFlags = { out: "/kits/take-kit", clipsOnly: false, force: false, refresh: true };

function report(world: World, kitDir = "/kits/take-kit"): KitReport {
  return KitReportSchema.parse(JSON.parse(world.files.get(join(kitDir, "kit-report.json"))!.text));
}

function timeline(world: World, kitDir = "/kits/take-kit"): Document {
  const xml = world.files.get(join(kitDir, "timeline.fcpxml"))!.text;
  const doc = new JSDOM(xml, { contentType: "text/xml" }).window.document;
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
}

// ---- Pure pieces ---------------------------------------------------------------

describe("parseKitFlags", () => {
  it("defaults: no --out, timeline on, reuse on, refresh on", () => {
    expect(parseKitFlags({})).toEqual({ out: undefined, clipsOnly: false, force: false, refresh: true });
  });

  it("commander's shapes pass through", () => {
    expect(parseKitFlags({ out: "~/kit", clipsOnly: true, force: true, refresh: false })).toEqual({
      out: "~/kit",
      clipsOnly: true,
      force: true,
      refresh: false,
    });
  });

  it("an empty --out is an error naming the flag, never the current directory", () => {
    expect(() => parseKitFlags({ out: "" })).toThrow(/--out/);
    expect(() => parseKitFlags({ out: "   " })).toThrow(/--out/);
  });

  it("a value on a switch is an error naming it", () => {
    expect(() => parseKitFlags({ force: "yes" })).toThrow(/--force/);
    expect(() => parseKitFlags({ clipsOnly: "1" })).toThrow(/--clips-only/);
    expect(() => parseKitFlags({ refresh: "no" })).toThrow(/--no-refresh/);
  });
});

describe("kitReplayArgs (the refresh's argv)", () => {
  it("is the editor's Render replay plus --no-render, with the editor kept shut", () => {
    expect(kitReplayArgs(["take.mp4", "--produce", "--llm", "mock", "--open-editor"], "/w/scenes-reviewed.json")).toEqual([
      // §129 heal: a legacy wizard record had no `produce` literal.
      "produce",
      "take.mp4",
      "--llm",
      "mock",
      "--scenes",
      "/w/scenes-reviewed.json",
      "--no-render",
      "--no-open-editor",
    ]);
  });

  it("never doubles a flag the record already had, and drops --review", () => {
    const args = kitReplayArgs(["produce", "t.mp4", "--no-open-editor", "--review", "--no-render"], undefined);
    expect(args).toEqual(["produce", "t.mp4", "--no-render", "--no-open-editor"]);
  });

  it("drops --script with its value, as the editor's pinned replay does", () => {
    const args = kitReplayArgs(["produce", "t.mp4", "--script", "/s.md"], "/w/s.json");
    expect(args).not.toContain("--script");
    expect(args).not.toContain("/s.md");
  });
});

describe("defaultKitDir", () => {
  it("a file: <name>-kit beside it", () => {
    expect(defaultKitDir("/v/My Take.final.mp4", false)).toBe("/v/My Take.final-kit");
  });
  it("a folder of takes: <folder>-kit beside the folder, never inside it", () => {
    expect(defaultKitDir("/v/takes", true)).toBe("/v/takes-kit");
    expect(defaultKitDir("/v/takes/", true)).toBe("/v/takes-kit");
  });
});

describe("kitConcurrency", () => {
  it("at most two tabs by default, whatever the cores", () => {
    expect(kitConcurrency(undefined, 16)).toEqual({ concurrency: KIT_MAX_CONCURRENCY });
    expect(kitConcurrency(undefined, 2).concurrency).toBe(2);
  });
  it("a config asking for fewer wins; one asking for more does not", () => {
    expect(kitConcurrency(1, 16).concurrency).toBe(1);
    expect(kitConcurrency(8, 16).concurrency).toBe(2);
  });
  it("a malformed config warns and keeps the cap", () => {
    const r = kitConcurrency("lots", 16);
    expect(r.concurrency).toBe(2);
    expect(r.warning).toMatch(/renderConcurrency/);
  });
});

describe("unrenderableReason", () => {
  const plan = (props: Record<string, unknown>) =>
    ({ component: "ScreenshotFrame", cue: { props } }) as unknown as Parameters<typeof unrenderableReason>[0];
  it("a side image missing from the work folder", () => {
    expect(unrenderableReason(plan({ src: "side-images/x.png" }), () => false)).toBe(
      "side image side-images/x.png is not in the work folder",
    );
    expect(unrenderableReason(plan({ src: "side-images/x.png" }), () => true)).toBeNull();
  });
  it("no src (the placeholder frame) and a remote src render as they do in the full render", () => {
    expect(unrenderableReason(plan({}), () => false)).toBeNull();
    expect(unrenderableReason(plan({ src: "https://x/y.png" }), () => false)).toBeNull();
  });
  it("any other component is never refused here", () => {
    const other = { component: "CardRow", cue: { props: { src: "nope.png" } } } as unknown as Parameters<
      typeof unrenderableReason
    >[0];
    expect(unrenderableReason(other, () => false)).toBeNull();
  });
});

// ---- The command ----------------------------------------------------------------

describe("runKit", () => {
  it("a fresh run renders every render plan once, in order, and writes the report and the timeline", async () => {
    const world = makeWorld();
    const { work } = project(world);
    const result = await runKit(work, FLAGS, world.seams);

    expect(world.rendered).toEqual(["scene-0-CardRow.mov", "scene-1-StatCard.mov"]);
    expect(result).toMatchObject({ clips: 3, rendered: 2, reused: 1, skipped: 0, timeline: true, removed: [] });

    const r = report(world);
    expect(r.timeline).toBe("timeline.fcpxml");
    expect(r.clips.map((c) => [c.sceneId, c.kind, c.status, c.file])).toEqual([
      ["scene-0", "render", "rendered", "clips/scene-0-CardRow.mov"],
      ["scene-1", "render", "rendered", "clips/scene-1-StatCard.mov"],
      // The author's own file, by its real path; never re-rendered.
      ["scene-2", "source", "reused", "/videos/clips/steps.mov"],
    ]);
    expect(r.clips[2]!.reuseKey).toBeNull();
    // Frame-aligned: frameWindow(0.5, 2.5, 30) starts on frame 15, 60 long.
    expect(r.clips[0]).toMatchObject({ startSec: 15 / 30, lengthSec: 60 / 30 });
    expect(r.clips[1]!.notes).toEqual(["speaker not reframed (video-top)"]);

    const doc = timeline(world);
    const spine = Array.from(doc.querySelectorAll("spine > asset-clip"));
    expect(spine).toHaveLength(2);
    const lane = Array.from(doc.querySelectorAll("spine > asset-clip > asset-clip"));
    expect(lane.map((c) => c.getAttribute("name"))).toEqual(["scene-0-CardRow", "scene-1-StatCard", "steps"]);
    // The sequence: the output's size at the SOURCE's 60 fps (plan decision 4).
    const seq = doc.querySelector("sequence")!;
    const seqFormat = Array.from(doc.querySelectorAll("format")).find((f) => f.getAttribute("id") === seq.getAttribute("format"))!;
    expect(seqFormat.getAttribute("frameDuration")).toBe("1/60s");
    expect(seqFormat.getAttribute("width")).toBe("1920");
    expect(doc.querySelector("project")!.getAttribute("name")).toBe("take kit");
    const srcs = Array.from(doc.querySelectorAll("media-rep")).map((m) => m.getAttribute("src"));
    expect(srcs).toContain("file:///videos/take.mp4");
    expect(srcs).toContain("file:///kits/take-kit/clips/scene-0-CardRow.mov");

    expect(world.logs).toContain("✓ kit: 3 clips — 2 rendered, 1 reused, 0 skipped");
    expect(world.logs).toContain("  In Resolve: File → Import → Timeline…, then pick timeline.fcpxml");
    expect(world.logs.some((l) => /^▸ \[1\/3\] scene-0-CardRow\.mov {2}2\.0s$/.test(l))).toBe(true);
  });

  it("a second run with the same inputs renders nothing (Review Focus 3)", async () => {
    const world = makeWorld();
    const { work } = project(world);
    await runKit(work, FLAGS, world.seams);
    world.rendered.length = 0;
    const again = await runKit(work, FLAGS, world.seams);
    expect(world.rendered).toEqual([]);
    expect(again).toMatchObject({ rendered: 0, reused: 3 });
    expect(world.logs).toContain("▸ [1/3] scene-0-CardRow.mov  2.0s  reused");
  });

  it("after one scene's prop changes, exactly that clip renders (Review Focus 3)", async () => {
    const world = makeWorld();
    const { work } = project(world);
    await runKit(work, FLAGS, world.seams);
    world.rendered.length = 0;
    const edited = CUES.map((c) => (c.id === "scene-1" ? { ...c, props: { value: "+200%" } } : c));
    await world.seams.writeFile(join(work, "render-props.json"), JSON.stringify(renderProps(edited)));
    await runKit(work, FLAGS, world.seams);
    expect(world.rendered).toEqual(["scene-1-StatCard.mov"]);
  });

  it("a scene that only moved on the timeline keeps its clip", async () => {
    const world = makeWorld();
    const { work } = project(world);
    await runKit(work, FLAGS, world.seams);
    world.rendered.length = 0;
    const moved = CUES.map((c) => (c.id === "scene-0" ? { ...c, startSec: 1, endSec: 3 } : c));
    await world.seams.writeFile(join(work, "render-props.json"), JSON.stringify(renderProps(moved)));
    await runKit(work, FLAGS, world.seams);
    expect(world.rendered).toEqual([]);
    expect(report(world).clips[0]!.startSec).toBe(1);
  });

  it("a clip whose file was deleted renders again (Review Focus 3)", async () => {
    const world = makeWorld();
    const { work } = project(world);
    await runKit(work, FLAGS, world.seams);
    world.rendered.length = 0;
    world.files.delete("/kits/take-kit/clips/scene-0-CardRow.mov");
    await runKit(work, FLAGS, world.seams);
    expect(world.rendered).toEqual(["scene-0-CardRow.mov"]);
  });

  it("a report that does not parse counts as none: everything renders", async () => {
    const world = makeWorld();
    const { work } = project(world);
    await runKit(work, FLAGS, world.seams);
    world.rendered.length = 0;
    await world.seams.writeFile("/kits/take-kit/kit-report.json", '{"version": 1, "clips": "renderd"}');
    await runKit(work, FLAGS, world.seams);
    expect(world.rendered).toEqual(["scene-0-CardRow.mov", "scene-1-StatCard.mov"]);
  });

  it("--force renders every clip; --clips-only writes no timeline", async () => {
    const world = makeWorld();
    const { work } = project(world);
    await runKit(work, FLAGS, world.seams);
    world.rendered.length = 0;
    await runKit(work, { ...FLAGS, force: true }, world.seams);
    expect(world.rendered).toEqual(["scene-0-CardRow.mov", "scene-1-StatCard.mov"]);

    const other = makeWorld();
    const p = project(other);
    const result = await runKit(p.work, { ...FLAGS, clipsOnly: true }, other.seams);
    expect(result.timeline).toBe(false);
    expect(other.files.has("/kits/take-kit/timeline.fcpxml")).toBe(false);
    expect(report(other).timeline).toBeNull();
    expect(other.logs.some((l) => l.includes("In Resolve"))).toBe(false);
  });

  it("without --out the kit lands beside the source; --out resolves against the current directory", async () => {
    const world = makeWorld();
    const { work } = project(world);
    const beside = await runKit(work, { ...FLAGS, out: undefined }, world.seams);
    expect(beside.kitDir).toBe("/videos/take-kit");
    const relative = await runKit(work, { ...FLAGS, out: "exports/k" }, world.seams);
    expect(relative.kitDir).toBe("/home/me/exports/k");
  });

  it("stale props trigger exactly one replay with --no-render, then the kit reads the refreshed props", async () => {
    const world = makeWorld();
    const { work } = project(world);
    // An editor save after the last produce: overrides.json is newer.
    await world.seams.writeFile(join(work, "overrides.json"), "{}");
    const hidden = CUES.filter((c) => c.id !== "scene-1");
    world.replay.effect = () => {
      void world.seams.writeFile(join(work, "render-props.json"), JSON.stringify(renderProps(hidden)));
    };
    await runKit(work, FLAGS, world.seams);
    expect(world.replays).toHaveLength(1);
    expect(world.replays[0]!.workdir).toBe(work);
    expect(world.replays[0]!.args).toContain("--no-render");
    expect(world.replays[0]!.args).toContain("--no-open-editor");
    expect(world.replays[0]!.args).not.toContain("--open-editor");
    // The plan on screen is pinned, as the editor's Render pins it.
    const at = world.replays[0]!.args.indexOf("--scenes");
    expect(world.replays[0]!.args[at + 1]).toBe(join(work, "scenes-reviewed.json"));
    expect(JSON.parse(world.files.get(join(work, "scenes-reviewed.json"))!.text)).toEqual([{ id: "scene-0" }]);
    expect(world.logs[0]).toBe("▸ the project changed since it was last produced; refreshing…");
    // The hidden scene is gone from the kit.
    expect(world.rendered).toEqual(["scene-0-CardRow.mov"]);

    // Fresh now: the next run replays nothing.
    world.replays.length = 0;
    await runKit(work, FLAGS, world.seams);
    expect(world.replays).toHaveLength(0);
  });

  it("--no-refresh exports the stale props as they are, with no replay", async () => {
    const world = makeWorld();
    const { work } = project(world);
    await world.seams.writeFile(join(work, "overrides.json"), "{}");
    await runKit(work, { ...FLAGS, refresh: false }, world.seams);
    expect(world.replays).toHaveLength(0);
    expect(world.rendered).toHaveLength(2);
  });

  it("an overrides.json OLDER than the props is not stale", async () => {
    const world = makeWorld();
    const { work } = project(world);
    await world.seams.writeFile(join(work, "overrides.json"), "{}");
    await world.seams.writeFile(join(work, "render-props.json"), JSON.stringify(renderProps(CUES)));
    await runKit(work, FLAGS, world.seams);
    expect(world.replays).toHaveLength(0);
  });

  it("stale with no command.json: an error naming ossclip produce", async () => {
    const world = makeWorld();
    const { work } = project(world, { command: false });
    await world.seams.writeFile(join(work, "overrides.json"), "{}");
    await expect(runKit(work, FLAGS, world.seams)).rejects.toThrow(/ossclip produce/);
    expect(world.rendered).toEqual([]);
  });

  it("a failed replay stops the kit with its exit code and last lines", async () => {
    const world = makeWorld();
    const { work } = project(world);
    await world.seams.writeFile(join(work, "overrides.json"), "{}");
    world.replay = { code: 3, tail: ["✗ whisper model missing"] };
    const err = await runKit(work, FLAGS, world.seams).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KitExitError);
    expect((err as KitExitError).exitCode).toBe(3);
    expect((err as KitExitError).message).toMatch(/whisper model missing/);
    expect(world.rendered).toEqual([]);
    expect(world.files.has("/kits/take-kit/kit-report.json")).toBe(false);
  });

  it("no planned project: an error naming the produce command", async () => {
    const world = makeWorld();
    await world.seams.mkdir("/empty");
    await expect(runKit("/empty", FLAGS, world.seams)).rejects.toThrow(/ossclip produce/);
  });

  it("a clip: scene whose original moved is skipped with a note, and the run succeeds (Review Focus 5)", async () => {
    const world = makeWorld();
    const { work } = project(world, { clipOriginal: false });
    const result = await runKit(work, FLAGS, world.seams);
    expect(result).toMatchObject({ rendered: 2, skipped: 1 });
    const clip = report(world).clips.find((c) => c.sceneId === "scene-2")!;
    expect(clip).toMatchObject({ status: "skipped", file: null, reuseKey: null });
    expect(clip.notes).toEqual(["the original clip /videos/clips/steps.mov is not there"]);
    const lane = Array.from(timeline(world).querySelectorAll("spine > asset-clip > asset-clip"));
    expect(lane.map((c) => c.getAttribute("name"))).toEqual(["scene-0-CardRow", "scene-1-StatCard"]);
    expect(world.logs).toContain("✓ kit: 3 clips — 2 rendered, 0 reused, 1 skipped");
  });

  it("a clip: original that cannot be probed is skipped the same way", async () => {
    const world = makeWorld();
    const { work } = project(world);
    world.unreadable.add("/videos/clips/steps.mov");
    const result = await runKit(work, FLAGS, world.seams);
    expect(result.skipped).toBe(1);
    expect(report(world).clips[2]!.notes[0]).toMatch(/could not read \/videos\/clips\/steps\.mov: moov atom/);
  });

  it("a clip: scene with no record in production.json is skipped", async () => {
    const world = makeWorld();
    const cues = CUES.map((c) => (c.id === "scene-2" ? { ...c, props: { src: "clips/other.webm" } } : c));
    const { work } = project(world, { cues });
    const result = await runKit(work, FLAGS, world.seams);
    expect(result.skipped).toBe(1);
    expect(report(world).clips[2]!.notes).toEqual(["no record of this clip's original file in production.json"]);
  });

  it("a clip: scene is trimmed to the shorter of the scene and the file", async () => {
    // The scene is 1 s (30 frames) and the probed file 3 s: 1 s on the timeline.
    const world = makeWorld();
    const { work } = project(world);
    await runKit(work, FLAGS, world.seams);
    expect(report(world).clips[2]!.lengthSec).toBe(1);
    const long = CUES.map((c) => (c.id === "scene-2" ? { ...c, startSec: 5, endSec: 9.5 } : c));
    await world.seams.writeFile(join(work, "render-props.json"), JSON.stringify(renderProps(long)));
    await runKit(work, FLAGS, world.seams);
    expect(report(world).clips[2]!.lengthSec).toBe(3);
  });

  it("a ScreenshotFrame whose side image is not in the work folder is skipped with a note", async () => {
    const world = makeWorld();
    const cues: SceneCue[] = [
      ...CUES,
      cue({ id: "scene-3", component: "ScreenshotFrame", props: { src: "side-images/shot.png" }, startSec: 8, endSec: 9 }),
    ];
    const { work } = project(world, { cues });
    const result = await runKit(work, FLAGS, world.seams);
    expect(result.skipped).toBe(1);
    expect(world.rendered).not.toContain("scene-3-ScreenshotFrame.mov");
    expect(report(world).clips[3]).toMatchObject({
      status: "skipped",
      notes: ["side image side-images/shot.png is not in the work folder"],
    });

    // Once the image is there, it renders.
    await world.seams.writeFile(join(work, "side-images", "shot.png"), "PNG");
    world.rendered.length = 0;
    await runKit(work, FLAGS, world.seams);
    expect(world.rendered).toEqual(["scene-3-ScreenshotFrame.mov"]);
  });

  it("a folder source points track 1 at source-concat.mp4, and says so", async () => {
    const world = makeWorld();
    const { work } = project(world, { folder: true });
    const result = await runKit(work, { ...FLAGS, out: undefined }, world.seams);
    expect(result.kitDir).toBe("/videos/takes-kit");
    const doc = timeline(world, "/videos/takes-kit");
    const source = Array.from(doc.querySelectorAll("asset"))[0]!;
    expect(source.getAttribute("name")).toBe("source-concat.mp4");
    expect(source.querySelector("media-rep")!.getAttribute("src")).toBe(`file://${work}/source-concat.mp4`);
    expect(report(world, "/videos/takes-kit").warnings.some((w) => w.includes("re-encoded join"))).toBe(true);
  });

  it("under WSL every src of a /mnt/c project is a file:///C:/ URL (Review Focus 4)", async () => {
    const world = makeWorld({ wsl: true });
    const { work } = project(world, { root: "/mnt/c/Users/me/My Videos" });
    await runKit(work, { ...FLAGS, out: "/mnt/c/Users/me/My Videos/kit" }, world.seams);
    const doc = timeline(world, "/mnt/c/Users/me/My Videos/kit");
    const srcs = Array.from(doc.querySelectorAll("media-rep")).map((m) => m.getAttribute("src")!);
    expect(srcs).toHaveLength(4);
    for (const src of srcs) expect(src.startsWith("file:///C:/Users/me/My%20Videos/")).toBe(true);
    expect(report(world, "/mnt/c/Users/me/My Videos/kit").warnings).toEqual([]);
  });

  it("under WSL a kit in the Linux filesystem: every path in the report, one printed line", async () => {
    const world = makeWorld({ wsl: true });
    const { work } = project(world);
    await runKit(work, FLAGS, world.seams);
    const r = report(world);
    // The two rendered clips, the clip: original and the source.
    const linux = r.warnings.filter((w) => w.includes("inside the Linux filesystem"));
    expect(linux).toHaveLength(4);
    expect(r.warnings).toContain("/videos/take.mp4 is inside the Linux filesystem; Resolve may ask you to relink it");
    const printed = world.logs.filter((l) => l.includes("Linux filesystem"));
    expect(printed).toEqual([
      "⚠ 4 files are inside the Linux filesystem (first: /kits/take-kit/clips/scene-0-CardRow.mov); " +
        "Resolve may ask you to relink them — every path is in kit-report.json",
    ]);
  });

  it("a single Linux-side path prints its own warning unchanged; none on /mnt/c prints nothing", async () => {
    const world = makeWorld({ wsl: true });
    const { work } = project(world, { root: "/mnt/c/v" });
    await runKit(work, { ...FLAGS, out: "/mnt/c/v/kit" }, world.seams);
    expect(world.logs.filter((l) => l.includes("Linux filesystem"))).toEqual([]);

    // One rendered clip, written to a Linux-side kit folder: one path to warn about.
    const other = makeWorld({ wsl: true });
    const cues = CUES.filter((c) => c.id !== "scene-1");
    const p = project(other, { root: "/mnt/c/v", cues });
    await runKit(p.work, { ...FLAGS, out: "/home/me/kit" }, other.seams);
    expect(other.logs.filter((l) => l.includes("Linux filesystem"))).toEqual([
      "⚠ /home/me/kit/clips/scene-0-CardRow.mov is inside the Linux filesystem; Resolve may ask you to relink it",
    ]);
  });

  it("a clip: original that is a symlink to /mnt/c is linked by its target (no warning)", async () => {
    const world = makeWorld({ wsl: true });
    const { work } = project(world, { root: "/mnt/c/Users/x/proj" });
    // The script's clip lives in a Linux folder as a symlink onto the Windows drive.
    const production = JSON.parse(world.files.get(join(work, "production.json"))!.text);
    production.script.sourcePath = "/home/x/scripts/script.md";
    await world.seams.writeFile(join(work, "production.json"), JSON.stringify(production));
    await world.seams.writeFile("/home/x/scripts/clips/steps.mov", "LINK");
    await world.seams.writeFile("/mnt/c/Users/x/EGM/a.mov", "MOV");
    world.symlinks.set("/home/x/scripts/clips/steps.mov", "/mnt/c/Users/x/EGM/a.mov");
    await runKit(work, { ...FLAGS, out: "/mnt/c/Users/x/proj/kit" }, world.seams);

    const doc = timeline(world, "/mnt/c/Users/x/proj/kit");
    const srcs = Array.from(doc.querySelectorAll("media-rep")).map((m) => m.getAttribute("src"));
    expect(srcs).toContain("file:///C:/Users/x/EGM/a.mov");
    expect(srcs.some((s) => s!.includes("wsl.localhost"))).toBe(false);
    const r = report(world, "/mnt/c/Users/x/proj/kit");
    expect(r.warnings).toEqual([]);
    expect(r.clips.find((c) => c.sceneId === "scene-2")!.file).toBe("/mnt/c/Users/x/EGM/a.mov");
  });

  it("a path whose realpath fails keeps its unresolved form", async () => {
    const world = makeWorld();
    const { work } = project(world);
    world.seams.realpath = () => {
      throw new Error("EACCES");
    };
    await runKit(work, FLAGS, world.seams);
    const srcs = Array.from(timeline(world).querySelectorAll("media-rep")).map((m) => m.getAttribute("src"));
    expect(srcs).toContain("file:///videos/take.mp4");
    expect(srcs).toContain("file:///videos/clips/steps.mov");
  });

  it("a stray .mov in clips/ is removed; other files are left alone", async () => {
    const world = makeWorld();
    const { work } = project(world);
    await world.seams.writeFile("/kits/take-kit/clips/scene-9-CardRow.mov", "OLD");
    await world.seams.writeFile("/kits/take-kit/clips/scene-0-CardRow.partial.mov", "HALF");
    await world.seams.writeFile("/kits/take-kit/clips/notes.txt", "mine");
    const result = await runKit(work, FLAGS, world.seams);
    expect(result.removed).toEqual(["scene-0-CardRow.partial.mov", "scene-9-CardRow.mov"]);
    expect(world.files.has("/kits/take-kit/clips/scene-9-CardRow.mov")).toBe(false);
    expect(world.files.has("/kits/take-kit/clips/notes.txt")).toBe(true);
    expect(world.files.has("/kits/take-kit/clips/scene-0-CardRow.mov")).toBe(true);
    expect(world.logs).toContain("▸ removed clips/scene-9-CardRow.mov — no scene in the project names it any more");
  });

  it("a failed render writes no report, so the next run trusts nothing it did not finish", async () => {
    const world = makeWorld();
    const { work } = project(world);
    world.seams.renderClip = async () => {
      throw new Error("browser crashed");
    };
    await expect(runKit(work, FLAGS, world.seams)).rejects.toThrow(/browser crashed/);
    expect(world.files.has("/kits/take-kit/kit-report.json")).toBe(false);
  });

  it("bundles once per run, and not at all when every clip is reused", async () => {
    const world = makeWorld();
    const { work } = project(world);
    let bundles = 0;
    world.seams.bundle = async () => {
      bundles++;
      return "http://bundle";
    };
    await runKit(work, FLAGS, world.seams);
    expect(bundles).toBe(1);
    await runKit(work, FLAGS, world.seams);
    expect(bundles).toBe(1);
  });
});

describe("the kit command is registered", () => {
  it("in program.commands, with its four flags", async () => {
    const { buildProgram } = await import("../src/program");
    const kit = buildProgram().commands.find((c) => c.name() === "kit");
    expect(kit).toBeDefined();
    expect(kit!.options.map((o) => o.long)).toEqual(["--out", "--clips-only", "--force", "--no-refresh"]);
  });
});
