import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "commander";
import type { PublishTarget, YoutubePack } from "@ossclip/core";
import {
  POSTIZ_API_KEY_ENV,
  PUBLISH_RECEIPT_BASENAME,
  accountsFlag,
  atFlag,
  buildPublishPosts,
  loadPublishPack,
  platformsFlag,
  publishConfigured,
  selectTargets,
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
