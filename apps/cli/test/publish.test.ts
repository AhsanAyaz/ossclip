import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidArgumentError } from "commander";
import type {
  OssclipConfig,
  Probe,
  PublishProvider,
  PublishReceipt,
  PublishRequest,
  PublishTarget,
  YoutubePack,
} from "@ossclip/core";
import {
  POSTIZ_API_KEY_ENV,
  PUBLISH_RECEIPT_BASENAME,
  accountsFlag,
  atFlag,
  attachDeliveryMedia,
  buildPublishPosts,
  deliveryFlag,
  describeUpload,
  durationCapMessages,
  encodeProgressLine,
  formatMinSec,
  loadPublishPack,
  masterOverCapWarning,
  platformsFlag,
  publishConfigured,
  runPublish,
  selectTargets,
  sizeCapGroups,
  sizeCapUnattainableMessages,
  summarizePosts,
} from "../src/publish";

const NOW = Date.parse("2026-08-26T12:00:00.000Z");

describe("atFlag", () => {
  it("normalizes a future time to ISO", () => {
    expect(atFlag("2026-09-01T08:00:00.000Z", () => NOW)).toBe("2026-09-01T08:00:00.000Z");
  });

  it.each(["tomorrow", "2026-13-45", ""])('rejects garbage "%s" — reject, never coerce', (v) => {
    expect(() => atFlag(v, () => NOW)).toThrow(InvalidArgumentError);
  });

  it("rejects a time already passed — a typo'd year must not fire immediately", () => {
    expect(() => atFlag("2020-01-01T00:00:00Z", () => NOW)).toThrow(/future/);
  });
});

describe("platformsFlag / accountsFlag", () => {
  it("splits, trims, lowercases and dedupes", () => {
    expect(platformsFlag("LinkedIn, instagram,linkedin")).toEqual(["linkedin", "instagram"]);
  });

  it("rejects an empty list", () => {
    expect(() => platformsFlag(" , ")).toThrow(InvalidArgumentError);
    expect(() => accountsFlag(",")).toThrow(InvalidArgumentError);
  });
});

describe("deliveryFlag", () => {
  it("accepts the two modes, trimmed", () => {
    expect(deliveryFlag("auto")).toBe("auto");
    expect(deliveryFlag(" master ")).toBe("master");
  });

  it.each(["masterr", "AUTO", "original", ""])(
    'rejects "%s" — a typo must not silently re-encode (or skip the encode)',
    (v) => {
      expect(() => deliveryFlag(v)).toThrow(InvalidArgumentError);
    },
  );
});

describe("formatMinSec / durationCapMessages / describeUpload", () => {
  it("formats seconds as M:SS", () => {
    expect(formatMinSec(320)).toBe("5:20");
    expect(formatMinSec(300)).toBe("5:00");
    expect(formatMinSec(59.6)).toBe("1:00");
  });

  it("names the platform, its cap and the video's length per dropped target", () => {
    const lines = durationCapMessages(
      [{ target: { id: "t", provider: "threads", name: "Ahsan" }, capSec: 300 }],
      320,
    );
    expect(lines).toEqual(["▸ threads capped at 5:00, video is 5:20 — skipping Ahsan"]);
  });

  it("says which file uploads: the planned delivery name, or master with the reason", () => {
    expect(describeUpload("master", null)).toBe("master (--delivery master)");
    expect(describeUpload("auto", null)).toBe("master (already within delivery limits)");
    expect(
      describeUpload("auto", {
        width: 1920,
        height: 1080,
        videoBitrateKbps: 10000,
        fileName: "delivery-1920x1080@10000k.mp4",
      }),
    ).toBe("delivery-1920x1080@10000k.mp4 (delivery encode, cached in workdir)");
  });
});

describe("encodeProgressLine", () => {
  it("percent, ETA and speed when ffmpeg has said all three", () => {
    // 300s master, 126s encoded at 1.6x → 42%, (300-126)/1.6 ≈ 109s left.
    expect(encodeProgressLine(300, { outTimeSec: 126, speed: 1.6 })).toBe(
      "▸ encoding delivery … 42% · ~1:49 left (1.6x)",
    );
  });

  it("drops ETA/speed rather than print garbage while ffmpeg warms up", () => {
    // The first -progress block is all N/A → the parser yields nothing.
    expect(encodeProgressLine(300, {})).toBe("▸ encoding delivery … 0%");
    // out_time without speed: percent only.
    expect(encodeProgressLine(300, { outTimeSec: 30 })).toBe("▸ encoding delivery … 10%");
    // speed=0x would make the ETA Infinity — encodeEta refuses, so no tail.
    expect(encodeProgressLine(300, { outTimeSec: 30, speed: 0 })).toBe(
      "▸ encoding delivery … 10%",
    );
  });

  it("caps at 100% — out_time can overshoot the probed duration at the tail", () => {
    expect(encodeProgressLine(300, { outTimeSec: 301, speed: 2 })).toBe(
      "▸ encoding delivery … 100% · ~0:00 left (2.0x)",
    );
  });
});

describe("publishConfigured", () => {
  it("resolves url from config and key from env — never the other way", () => {
    const r = publishConfigured({ postizUrl: "https://p.example.com" }, {
      [POSTIZ_API_KEY_ENV]: "k",
    } as NodeJS.ProcessEnv);
    expect(r).toEqual({ ok: true, baseUrl: "https://p.example.com", apiKey: "k" });
  });

  it("names exactly what's missing and where it goes", () => {
    const r = publishConfigured({}, {} as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("postizUrl");
      expect(r.message).toContain(POSTIZ_API_KEY_ENV);
    }
  });
});

const targets: PublishTarget[] = [
  { id: "a", provider: "linkedin", name: "Ahsan" },
  { id: "b", provider: "instagram", name: "codewithahsan" },
  { id: "c", provider: "linkedin", name: "VisionWise" },
];

describe("selectTargets", () => {
  it("--platforms filters by provider", () => {
    expect(selectTargets(targets, { platforms: ["linkedin"] }).map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("a platform with no connected account is an error naming what IS connected", () => {
    expect(() => selectTargets(targets, { platforms: ["tiktok"] })).toThrow(/no connected tiktok/);
  });

  it("--accounts picks by id, unknown id errors", () => {
    expect(selectTargets(targets, { accounts: ["b"] })).toEqual([targets[1]]);
    expect(() => selectTargets(targets, { accounts: ["zzz"] })).toThrow(/no integration with id "zzz"/);
  });

  it("--all with nothing connected is an error, not an empty publish", () => {
    expect(() => selectTargets([], { all: true })).toThrow(/no connected accounts/);
  });
});

const pack: YoutubePack = {
  titles: ["The title", "Alt", "Third"],
  description: "d",
  hashtags: ["#a"],
  tags: [],
  linkedinPost: "authored linkedin",
  platformCaptions: { instagram: "authored insta" },
} as unknown as YoutubePack;

describe("buildPublishPosts", () => {
  it("captions per provider from the pack; YouTube carries the first title", () => {
    const yt: PublishTarget = { id: "y", provider: "youtube", name: "Chan" };
    const posts = buildPublishPosts(pack, [targets[0]!, targets[1]!, yt]);
    expect(posts[0]!.caption).toBe("authored linkedin");
    expect(posts[1]!.caption).toBe("authored insta");
    expect(posts[2]!.title).toBe("The title");
    expect(posts[0]!.title).toBeUndefined();
  });
});

describe("loadPublishPack", () => {
  it("prefers the approved file over a provider-keyed cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ossclip-pub-"));
    await writeFile(
      join(dir, "youtube-abcd1234.json"),
      JSON.stringify({ ...pack, titles: ["cached title", "x", "y"] }),
    );
    await writeFile(
      join(dir, "youtube-pack-approved.json"),
      JSON.stringify({ ...pack, titles: ["approved title", "x", "y"] }),
    );
    const loaded = await loadPublishPack(dir);
    expect(loaded?.titles[0]).toBe("approved title");
  });

  it("falls back to the cache when nothing was approved, null when nothing exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ossclip-pub-"));
    expect(await loadPublishPack(dir)).toBeNull();
    await writeFile(join(dir, "youtube-abcd1234.json"), JSON.stringify(pack));
    expect((await loadPublishPack(dir))?.titles[0]).toBe("The title");
  });

  it("skips a corrupt candidate instead of dying on it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ossclip-pub-"));
    await writeFile(join(dir, "youtube-pack-approved.json"), "{not json");
    await writeFile(join(dir, "youtube-abcd1234.json"), JSON.stringify(pack));
    expect((await loadPublishPack(dir))?.titles[0]).toBe("The title");
  });
});

describe("size-cap grouping and messages", () => {
  const li = targets[0]!;
  const insta = targets[1]!;

  it("groups only capped providers, by their byte ceiling — uncapped ride the default", () => {
    const groups = sizeCapGroups([li, insta]);
    expect([...groups.keys()]).toEqual([95_000_000]);
    expect(groups.get(95_000_000)!.map((t) => t.id)).toEqual(["b"]);
  });

  it("two capped accounts on one platform share a group — one encode, not two", () => {
    const insta2: PublishTarget = { id: "b2", provider: "instagram", name: "second" };
    expect(sizeCapGroups([insta, insta2]).get(95_000_000)).toHaveLength(2);
  });

  it("the unattainable line names the cap, the length and the doomed bitrate per channel", () => {
    expect(sizeCapUnattainableMessages([insta], 95_000_000, 730, 800)).toEqual([
      "▸ instagram needs ≤95MB but a 13:20 video fits only ~730 kbps — " +
        "skipping codewithahsan; publish it manually or shorten the cut",
    ]);
  });

  it("attachDeliveryMedia sets videoPath only on capped posts, never a redundant default", () => {
    const posts = buildPublishPosts(pack, [li, insta]);
    const withMedia = attachDeliveryMedia(
      posts,
      "/w/delivery-1920x1080@10000k.mp4",
      new Map([[95_000_000, "/w/delivery-1920x1080@2113k.mp4"]]),
    );
    expect(withMedia[0]!.videoPath).toBeUndefined();
    expect(withMedia[1]!.videoPath).toBe("/w/delivery-1920x1080@2113k.mp4");
    // The capped plan can land on the default file's name (fitted ≥ target
    // bitrate) — same file means no override, not a redundant one.
    const same = attachDeliveryMedia(posts, "/w/d.mp4", new Map([[95_000_000, "/w/d.mp4"]]));
    expect(same[1]!.videoPath).toBeUndefined();
  });

  it("the master-mode warning names both sizes and that the choice was explicit", () => {
    expect(masterOverCapWarning([insta], 95_000_000, 409_000_000)).toBe(
      "▸ WARNING: the master is 409MB, over the 95MB instagram cap — " +
        "uploading it anyway (--delivery master)",
    );
  });
});

describe("summarizePosts", () => {
  it("says NOW or the scheduled time, one row per target with char counts", () => {
    const posts = buildPublishPosts(pack, [targets[0]!]);
    const now = summarizePosts(posts, { kind: "now" });
    expect(now).toContain("publish NOW");
    expect(now).toContain("linkedin");
    expect(now).toContain(`${posts[0]!.caption.length} chars`);
    const later = summarizePosts(posts, { kind: "at", iso: "2026-09-01T08:00:00.000Z" });
    expect(later).toContain("schedule for 2026-09-01T08:00:00.000Z");
  });
});

describe("runPublish delivery flow (via the deps seam — no ffmpeg, no Postiz)", () => {
  afterEach(() => vi.restoreAllMocks());

  const masterProbe: Probe = {
    duration: 320,
    width: 3840,
    height: 2160,
    fps: 30,
    hasAudio: true,
  };
  const receipt: PublishReceipt = {
    backend: "postiz",
    postIds: ["post-1"],
    publishedAt: "2026-08-29T12:00:00.000Z",
    when: { kind: "now" },
    targets: [],
  } as unknown as PublishReceipt;

  /** A workdir with the recorded out, the final mp4 and a pack on disk. */
  async function workdirWithRender(): Promise<{ dir: string; out: string }> {
    const dir = await mkdtemp(join(tmpdir(), "ossclip-pub-run-"));
    const out = join(dir, "final.mp4");
    await writeFile(out, "rendered");
    await writeFile(join(dir, "youtube-aaaaaaaa.json"), JSON.stringify(pack));
    await writeFile(
      join(dir, "command.json"),
      JSON.stringify({
        execPath: process.execPath,
        execArgv: [],
        script: join(dir, "recorded.cjs"),
        args: ["produce", "in.mp4"],
        cwd: dir,
        out,
      }),
    );
    return { dir, out };
  }

  function fakes(overrides: { targets?: PublishTarget[]; probe?: Probe } = {}) {
    const published: PublishRequest[] = [];
    const provider: PublishProvider = {
      name: "fake",
      listTargets: async () => overrides.targets ?? targets,
      publish: async (req) => {
        published.push(req);
        return receipt;
      },
    };
    const ensureCalls: Array<{ masterPath: string; sizeCapBytes: number | undefined }> = [];
    const deps = {
      provider,
      config: {
        postizUrl: "https://p.example.com",
        ffmpegPath: "ffmpeg-not-run",
        ffprobePath: "ffprobe-not-run",
      } as OssclipConfig,
      env: { [POSTIZ_API_KEY_ENV]: "k" } as NodeJS.ProcessEnv,
      probeVideo: async () => overrides.probe ?? masterProbe,
      ensureDelivery: async (
        _tools: unknown,
        workdir: string,
        masterPath: string,
        opts: { onStart?: (name: string) => void; sizeCapBytes?: number } = {},
      ) => {
        ensureCalls.push({ masterPath, sizeCapBytes: opts.sizeCapBytes });
        // The 3840×2160 320s master's two real plans: 10 Mbps default, and
        // 2113 kbps fitted under instagram's 95MB (fitBitrateKbps arithmetic).
        const name =
          opts.sizeCapBytes !== undefined
            ? "delivery-1920x1080@2113k.mp4"
            : "delivery-1920x1080@10000k.mp4";
        opts.onStart?.(name);
        return {
          path: join(workdir, name),
          encoded: true,
          probe: overrides.probe ?? masterProbe,
        };
      },
    };
    return { published, ensureCalls, deps };
  }

  it("the provider receives the DELIVERY path, and the encode announces itself", async () => {
    const { dir } = await workdirWithRender();
    // LinkedIn only — no size-capped platform, so exactly one encode runs.
    const { published, ensureCalls, deps } = fakes({ targets: [targets[0]!, targets[2]!] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPublish(dir, { all: true, yes: true }, deps);
    expect(ensureCalls).toHaveLength(1);
    expect(published[0]!.videoPath).toBe(join(dir, "delivery-1920x1080@10000k.mp4"));
    const output = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("▸ encoding delivery file delivery-1920x1080@10000k.mp4 (cached in workdir)");
  });

  it("a size-capped platform gets its own encode and carries it per post; the rest keep the default", async () => {
    const { dir } = await workdirWithRender();
    // Default targets include instagram (id "b") — its 95MB cap forms one
    // group beside the uncapped default encode.
    const { published, ensureCalls, deps } = fakes();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPublish(dir, { all: true, yes: true }, deps);
    expect(ensureCalls.map((c) => c.sizeCapBytes)).toEqual([undefined, 95_000_000]);
    expect(published[0]!.videoPath).toBe(join(dir, "delivery-1920x1080@10000k.mp4"));
    const mediaById = Object.fromEntries(
      published[0]!.posts.map((p) => [p.target.id, p.videoPath]),
    );
    expect(mediaById["b"]).toBe(join(dir, "delivery-1920x1080@2113k.mp4"));
    expect(mediaById["a"]).toBeUndefined();
    expect(mediaById["c"]).toBeUndefined();
    // The confirm summary named BOTH files before the "yes".
    const output = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("▸ upload: delivery-1920x1080@10000k.mp4 (delivery encode, cached in workdir)");
    expect(output).toContain(
      "▸ upload (instagram): delivery-1920x1080@2113k.mp4 (delivery encode, cached in workdir)",
    );
  });

  it("an unattainable size cap drops the channel loudly before the confirm; the rest publish", async () => {
    const { dir } = await workdirWithRender();
    // 800s is under instagram's 900s duration cap, but its 95MB size cap
    // fits only ~730 kbps — below the 1000 kbps quality floor.
    const { published, ensureCalls, deps } = fakes({
      targets: [targets[0]!, targets[1]!],
      probe: { ...masterProbe, duration: 800 },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPublish(dir, { all: true, yes: true }, deps);
    const output = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain(
      "▸ instagram needs ≤95MB but a 13:20 video fits only ~730 kbps — " +
        "skipping codewithahsan; publish it manually or shorten the cut",
    );
    expect(published[0]!.posts.map((p) => p.target.provider)).toEqual(["linkedin"]);
    // The dropped group never bought an encode — only the default ran.
    expect(ensureCalls.map((c) => c.sizeCapBytes)).toEqual([undefined]);
  });

  it("every channel size-unattainable aborts with a clear error — no encode, no upload", async () => {
    const { dir } = await workdirWithRender();
    const { published, ensureCalls, deps } = fakes({
      targets: [targets[1]!],
      probe: { ...masterProbe, duration: 800 },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runPublish(dir, { all: true, yes: true }, deps)).rejects.toThrow(
      /size cap is unattainable/,
    );
    expect(published).toHaveLength(0);
    expect(ensureCalls).toHaveLength(0);
  });

  it("--delivery master with an over-cap master WARNS and proceeds — the user chose master", async () => {
    const { dir, out } = await workdirWithRender();
    // 96MB master vs instagram's 95MB cap — master mode skips the capped
    // encode by definition, so the only honest move is a loud warning.
    await writeFile(out, Buffer.alloc(96_000_000));
    const { published, ensureCalls, deps } = fakes({ targets: [targets[1]!] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPublish(dir, { all: true, yes: true, delivery: "master" }, deps);
    const output = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain(
      "▸ WARNING: the master is 96MB, over the 95MB instagram cap — " +
        "uploading it anyway (--delivery master)",
    );
    expect(ensureCalls).toHaveLength(0);
    expect(published[0]!.videoPath).toBe(out);
    expect(published[0]!.posts[0]!.videoPath).toBeUndefined();
  });

  it("--delivery master bypasses the encode and uploads the untouched render, saying so", async () => {
    const { dir, out } = await workdirWithRender();
    const { published, ensureCalls, deps } = fakes();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPublish(dir, { all: true, yes: true, delivery: "master" }, deps);
    expect(ensureCalls).toHaveLength(0);
    expect(published[0]!.videoPath).toBe(out);
    const output = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("▸ upload: master (--delivery master)");
  });

  it("over-cap targets are dropped loudly BEFORE upload; the rest still publish", async () => {
    const { dir } = await workdirWithRender();
    const mixed: PublishTarget[] = [
      { id: "t", provider: "threads", name: "Ahsan" },
      { id: "a", provider: "linkedin", name: "Ahsan" },
    ];
    // 320s vs Threads' 300s cap — the 2026-08-29 handoff's exact failure.
    const { published, deps } = fakes({ targets: mixed });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPublish(dir, { all: true, yes: true }, deps);
    const output = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("▸ threads capped at 5:00, video is 5:20 — skipping Ahsan");
    expect(published).toHaveLength(1);
    expect(published[0]!.posts.map((p) => p.target.provider)).toEqual(["linkedin"]);
  });

  it("every target over its cap aborts with a clear error — no encode, no upload", async () => {
    const { dir } = await workdirWithRender();
    const only: PublishTarget[] = [{ id: "t", provider: "threads", name: "Ahsan" }];
    const { published, ensureCalls, deps } = fakes({ targets: only });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runPublish(dir, { all: true, yes: true }, deps)).rejects.toThrow(
      /every selected channel refuses a 5:20 video/,
    );
    expect(published).toHaveLength(0);
    expect(ensureCalls).toHaveLength(0);
  });

  it("--delivery master still enforces the duration caps — the probe serves both", async () => {
    const { dir } = await workdirWithRender();
    const only: PublishTarget[] = [{ id: "t", provider: "threads", name: "Ahsan" }];
    const { published, deps } = fakes({ targets: only });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(
      runPublish(dir, { all: true, yes: true, delivery: "master" }, deps),
    ).rejects.toThrow(/every selected channel refuses/);
    expect(published).toHaveLength(0);
  });
});

describe("publish argv (the real program)", () => {
  const parse = async (argv: string[]): Promise<{ workdir?: string; opts: Record<string, unknown> }> => {
    const { buildProgram } = await import("../src/program");
    const program = buildProgram();
    for (const cmd of [program, ...program.commands]) {
      cmd.exitOverride();
      cmd.configureOutput({ writeErr() {} });
    }
    const publish = program.commands.find((c) => c.name() === "publish");
    if (publish === undefined) throw new Error("the real program has no `publish` command");
    let captured: { workdir?: string; opts: Record<string, unknown> } = { opts: {} };
    publish.action((workdir: string | undefined, opts: Record<string, unknown>) => {
      captured = { workdir, opts };
    });
    await program.parseAsync(["node", "ossclip", ...argv]);
    return captured;
  };

  it("parses the full flag set against the shipped definitions", async () => {
    const { workdir, opts } = await parse([
      "publish",
      "./work",
      "--at",
      "2999-01-01T00:00:00Z",
      "--platforms",
      "linkedin,x",
      "--dry-run",
      "-y",
    ]);
    expect(workdir).toBe("./work");
    expect(opts.at).toBe("2999-01-01T00:00:00.000Z");
    expect(opts.platforms).toEqual(["linkedin", "x"]);
    expect(opts.dryRun).toBe(true);
    expect(opts.yes).toBe(true);
    expect(opts.force).toBe(false);
    // The delivery encode is the default — uploading the master is the
    // explicit escape hatch, never the accident.
    expect(opts.delivery).toBe("auto");
  });

  it("--delivery master parses; garbage fails at parse", async () => {
    const { opts } = await parse(["publish", "--delivery", "master", "-y"]);
    expect(opts.delivery).toBe("master");
    await expect(parse(["publish", "--delivery", "masterr"])).rejects.toThrow();
  });

  it("a garbage --at fails at parse, before any action runs", async () => {
    await expect(parse(["publish", "--at", "whenever"])).rejects.toThrow();
  });
});

describe("PUBLISH_RECEIPT_BASENAME", () => {
  it("is pinned — the double-post guard and the editor both read this literal", () => {
    expect(PUBLISH_RECEIPT_BASENAME).toBe("publish-receipt.json");
  });
});
