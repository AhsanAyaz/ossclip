import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PostizHttpError,
  buildPostsPayload,
  createPostizProvider,
  extractPostIds,
  parseIntegrations,
  postizApiBase,
} from "../src/publish/postiz";
import type { PublishTarget } from "../src/publish/provider";

const li: PublishTarget = { id: "int-1", provider: "linkedin", name: "Ahsan" };
const ig: PublishTarget = { id: "int-2", provider: "instagram", name: "codewithahsan" };
const media = { id: "m-1", path: "/uploads/x.mp4" };

describe("postizApiBase", () => {
  it("appends /api/public/v1 and strips trailing slashes", () => {
    expect(postizApiBase("https://p.example.com/")).toBe("https://p.example.com/api/public/v1");
  });

  it("leaves a URL that already names the API base alone", () => {
    expect(postizApiBase("https://p.example.com/api/public/v1")).toBe(
      "https://p.example.com/api/public/v1",
    );
  });
});

describe("parseIntegrations", () => {
  it("maps id/identifier/name and drops disabled integrations", () => {
    const targets = parseIntegrations([
      { id: "a", name: "Ahsan", identifier: "linkedin", extra: "ignored" },
      { id: "b", name: "Dead", identifier: "x", disabled: true },
    ]);
    expect(targets).toEqual([{ id: "a", provider: "linkedin", name: "Ahsan" }]);
  });

  it("rejects garbage — external data parses at the boundary", () => {
    expect(() => parseIntegrations({ nope: true })).toThrow();
    expect(() => parseIntegrations([{ id: 1 }])).toThrow();
  });
});

describe("buildPostsPayload", () => {
  it("one request carries every integration, each with __type from its provider", () => {
    const payload = buildPostsPayload({
      posts: [
        { target: li, caption: "linkedin text" },
        { target: ig, caption: "insta text" },
      ],
      when: { kind: "now" },
      dateIso: "2026-08-26T10:00:00.000Z",
      media,
    }) as { type: string; date: string; posts: Array<Record<string, unknown>> };
    expect(payload.type).toBe("now");
    expect(payload.date).toBe("2026-08-26T10:00:00.000Z");
    expect(payload.posts).toHaveLength(2);
    expect(payload.posts[0]).toEqual({
      integration: { id: "int-1" },
      value: [{ content: "linkedin text", image: [{ id: "m-1", path: "/uploads/x.mp4" }] }],
      settings: { __type: "linkedin" },
    });
    expect((payload.posts[1] as { settings: { __type: string } }).settings.__type).toBe(
      "instagram",
    );
  });

  it("carries a top-level tags array — Postiz 400s without it", () => {
    // The 2026-08-27 live E2E's catch: /posts validates `tags` as a required
    // top-level array ("tags should not be null or undefined"), and the very
    // first real request against a live instance bounced on it. Always [] —
    // calendar tags are a Postiz-UI concept ossclip has no gesture for.
    const payload = buildPostsPayload({
      posts: [{ target: li, caption: "c" }],
      when: { kind: "now" },
      dateIso: "2026-08-26T10:00:00.000Z",
      media,
    }) as { tags: unknown };
    expect(payload.tags).toEqual([]);
  });

  it("a YouTube post carries a privacy status — Postiz REQUIRES it", () => {
    // 2026-08-28: Postiz's YoutubeSettingsDto marks `type` @IsDefined(), so a
    // payload with only {__type, title} is rejected at validation and the
    // whole /posts call fails — ossclip could not publish to YouTube at all.
    // Defaulted to `private` deliberately: every other platform posts
    // publicly, but an accidental --all run must not push to a subscriber
    // list, and flipping a private video public in YouTube Studio is one
    // click while un-publishing is not.
    const yt: PublishTarget = { id: "int-3", provider: "youtube", name: "Channel" };
    const payload = buildPostsPayload({
      posts: [{ target: yt, caption: "desc", title: "The title" }],
      when: { kind: "now" },
      dateIso: "2026-08-26T10:00:00.000Z",
      media,
    }) as { posts: Array<{ settings: Record<string, unknown> }> };
    expect(payload.posts[0]!.settings).toEqual({
      __type: "youtube",
      title: "The title",
      type: "private",
    });
  });

  it("an explicit YouTube privacy wins over the safe default", () => {
    const yt: PublishTarget = { id: "int-3", provider: "youtube", name: "Channel" };
    const payload = buildPostsPayload({
      posts: [{ target: yt, caption: "desc", title: "T", youtubePrivacy: "public" }],
      when: { kind: "now" },
      dateIso: "2026-08-26T10:00:00.000Z",
      media,
    }) as { posts: Array<{ settings: Record<string, unknown> }> };
    expect(payload.posts[0]!.settings.type).toBe("public");
  });

  it("an Instagram post carries post_type — Postiz REQUIRES it too", () => {
    // The second required per-provider setting, found the same way as
    // YouTube's `type`: a real publish 400'd with "posts.0.settings.post_type
    // should not be null or undefined ... must be one of: post, story"
    // (2026-08-28), AFTER the 171MB upload had been paid for. Always `post`:
    // ossclip renders a finished short, and a story expires in 24 hours —
    // nobody publishes a produced video expecting it to vanish.
    const payload = buildPostsPayload({
      posts: [{ target: ig, caption: "c" }],
      when: { kind: "now" },
      dateIso: "2026-08-26T10:00:00.000Z",
      media,
    }) as { posts: Array<{ settings: Record<string, unknown> }> };
    expect(payload.posts[0]!.settings).toEqual({ __type: "instagram", post_type: "post" });
  });

  it("a NON-youtube post carries no privacy key — the settings stay per-provider", () => {
    const payload = buildPostsPayload({
      posts: [{ target: li, caption: "c" }],
      when: { kind: "now" },
      dateIso: "2026-08-26T10:00:00.000Z",
      media,
    }) as { posts: Array<{ settings: Record<string, unknown> }> };
    expect(payload.posts[0]!.settings).toEqual({ __type: "linkedin" });
  });

  it("the map form routes each post to ITS media — size-capped platforms carry a different file (2026-08-29)", () => {
    // The field case behind per-post media: Instagram bounced the 409MB
    // delivery file (2207077) but published the 88MB re-encode, while
    // LinkedIn took the big file fine — so the posts in ONE request point at
    // two different uploads.
    const igUpload = { id: "m-ig", path: "/uploads/ig.mp4" };
    const payload = buildPostsPayload({
      posts: [
        { target: li, caption: "linkedin text" },
        { target: ig, caption: "insta text", videoPath: "/work/delivery-ig.mp4" },
      ],
      when: { kind: "now" },
      dateIso: "2026-08-29T10:00:00.000Z",
      media: new Map([
        ["/work/delivery.mp4", media],
        ["/work/delivery-ig.mp4", igUpload],
      ]),
      defaultVideoPath: "/work/delivery.mp4",
    }) as { posts: Array<{ value: Array<{ image: Array<{ id: string }> }> }> };
    expect(payload.posts[0]!.value[0]!.image).toEqual([{ id: "m-1", path: "/uploads/x.mp4" }]);
    expect(payload.posts[1]!.value[0]!.image).toEqual([{ id: "m-ig", path: "/uploads/ig.mp4" }]);
  });

  it("a per-post videoPath against the single-upload form throws — the wrong video is worse than no post", () => {
    expect(() =>
      buildPostsPayload({
        posts: [{ target: ig, caption: "c", videoPath: "/work/delivery-ig.mp4" }],
        when: { kind: "now" },
        dateIso: "2026-08-29T10:00:00.000Z",
        media,
      }),
    ).toThrow(/media map/);
  });

  it("a path with no upload in the map throws with the path — never a silent wrong mapping", () => {
    expect(() =>
      buildPostsPayload({
        posts: [{ target: ig, caption: "c", videoPath: "/work/missing.mp4" }],
        when: { kind: "now" },
        dateIso: "2026-08-29T10:00:00.000Z",
        media: new Map([["/work/delivery.mp4", media]]),
        defaultVideoPath: "/work/delivery.mp4",
      }),
    ).toThrow(/\/work\/missing\.mp4/);
  });

  it("schedule uses the requested time, not the caller's clock", () => {
    const payload = buildPostsPayload({
      posts: [{ target: li, caption: "c" }],
      when: { kind: "at", iso: "2026-09-01T08:00:00.000Z" },
      dateIso: "2026-08-26T10:00:00.000Z",
      media,
    }) as { type: string; date: string };
    expect(payload.type).toBe("schedule");
    expect(payload.date).toBe("2026-09-01T08:00:00.000Z");
  });

  it("a post's title passes into settings (YouTube's required field)", () => {
    const yt: PublishTarget = { id: "int-3", provider: "youtube", name: "Channel" };
    const payload = buildPostsPayload({
      posts: [{ target: yt, caption: "desc", title: "The title" }],
      when: { kind: "now" },
      dateIso: "2026-08-26T10:00:00.000Z",
      media,
    }) as { posts: Array<{ settings: Record<string, unknown> }> };
    // `type` rides along since 2026-08-28 — Postiz requires it (see the
    // privacy-status case below for the why).
    expect(payload.posts[0]!.settings).toEqual({
      __type: "youtube",
      title: "The title",
      type: "private",
    });
  });
});

describe("extractPostIds", () => {
  it("reads ids from an array answer", () => {
    expect(extractPostIds([{ id: "p1" }, { id: "p2" }])).toEqual(["p1", "p2"]);
  });

  it("reads ids from a {posts: [...]} envelope", () => {
    expect(extractPostIds({ posts: [{ id: "p1" }] })).toEqual(["p1"]);
  });

  it("an unknown envelope yields [] — never a throw after posts went out", () => {
    expect(extractPostIds("ok")).toEqual([]);
    expect(extractPostIds(null)).toEqual([]);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createPostizProvider", () => {
  it("sends the API key verbatim in Authorization — Postiz takes no Bearer prefix", async () => {
    let auth: string | undefined;
    const provider = createPostizProvider({
      baseUrl: "https://p.example.com",
      apiKey: "sekret",
      fetchImpl: async (_url, init) => {
        auth = new Headers(init?.headers).get("authorization") ?? undefined;
        return jsonResponse(200, []);
      },
    });
    await provider.listTargets();
    expect(auth).toBe("sekret");
  });

  it("listTargets GETs /integrations on the normalized base", async () => {
    let url = "";
    const provider = createPostizProvider({
      baseUrl: "https://p.example.com/",
      apiKey: "k",
      fetchImpl: async (u) => {
        url = String(u);
        return jsonResponse(200, [{ id: "a", name: "N", identifier: "x" }]);
      },
    });
    const targets = await provider.listTargets();
    expect(url).toBe("https://p.example.com/api/public/v1/integrations");
    expect(targets).toEqual([{ id: "a", provider: "x", name: "N" }]);
  });

  it.each([
    [401, "rejected the API key"],
    [413, "refused as too large"],
    [429, "90 posts/hour"],
    [500, "failed: 500"],
  ])("a %i answer throws loudly with the hint", async (status, needle) => {
    const provider = createPostizProvider({
      baseUrl: "https://p.example.com",
      apiKey: "k",
      fetchImpl: async () => new Response("boom", { status }),
    });
    await expect(provider.listTargets()).rejects.toThrow(needle);
  });

  it("413 names the PROXY as the likely culprit, with the fix", () => {
    // The 2026-08-27 live E2E hit this for real: a 171MB render through a
    // Cloudflare Tunnel bounced 413 with Cloudflare's own HTML error page,
    // while Postiz itself would have taken the file happily. Blaming "the
    // Postiz instance's size limit" sends the user to tune the wrong box —
    // the proxy in front is what refused, and pointing `postizUrl` at the
    // instance directly (LAN/VPN address) is the one-line way through.
    const msg = new PostizHttpError("POST", "/upload", 413, "").message;
    expect(msg).toMatch(/proxy/i);
    expect(msg).toMatch(/postizUrl/);
  });

  it("an unreachable instance names the base URL, not a bare ECONNREFUSED", async () => {
    const provider = createPostizProvider({
      baseUrl: "https://p.example.com",
      apiKey: "k",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(provider.listTargets()).rejects.toThrow(
      /unreachable at https:\/\/p\.example\.com\/api\/public\/v1/,
    );
  });

  it("publish uploads the file multipart, then posts once, and returns the receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ossclip-publish-"));
    const videoPath = join(dir, "short.mp4");
    await writeFile(videoPath, "not really mp4");
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const provider = createPostizProvider({
      baseUrl: "https://p.example.com",
      apiKey: "k",
      fetchImpl: async (u, init) => {
        calls.push({ url: String(u), method: init?.method ?? "GET", body: init?.body });
        if (String(u).endsWith("/upload")) return jsonResponse(200, { id: "m-9", path: "/up/s.mp4" });
        return jsonResponse(200, [{ id: "post-1" }]);
      },
    });
    const receipt = await provider.publish({
      videoPath,
      posts: [{ target: li, caption: "hello" }],
      when: { kind: "now" },
    });
    expect(calls.map((c) => c.url)).toEqual([
      "https://p.example.com/api/public/v1/upload",
      "https://p.example.com/api/public/v1/posts",
    ]);
    expect(calls[0]!.body).toBeInstanceOf(FormData);
    const posted = JSON.parse(calls[1]!.body as string) as {
      posts: Array<{ value: Array<{ image: Array<{ id: string }> }> }>;
    };
    expect(posted.posts[0]!.value[0]!.image[0]!.id).toBe("m-9");
    expect(receipt).toMatchObject({ backend: "postiz", postIds: ["post-1"], targets: [li] });
  });

  it("per-post media: each DISTINCT file uploads once and its posts point at it", async () => {
    // The 2026-08-29 field shape: LinkedIn keeps the default 10 Mbps file,
    // Instagram gets its size-capped encode — two uploads, one /posts call.
    const dir = await mkdtemp(join(tmpdir(), "ossclip-publish-"));
    const defaultPath = join(dir, "delivery.mp4");
    const igPath = join(dir, "delivery-ig.mp4");
    await writeFile(defaultPath, "big");
    await writeFile(igPath, "small");
    const uploadedNames: string[] = [];
    const provider = createPostizProvider({
      baseUrl: "https://p.example.com",
      apiKey: "k",
      fetchImpl: async (u, init) => {
        if (String(u).endsWith("/upload")) {
          const file = (init?.body as FormData).get("file") as File;
          uploadedNames.push(file.name);
          return jsonResponse(200, { id: `m-${uploadedNames.length}`, path: `/up/${file.name}` });
        }
        return jsonResponse(200, [{ id: "post-1" }]);
      },
    });
    await provider.publish({
      videoPath: defaultPath,
      posts: [
        { target: li, caption: "li" },
        { target: ig, caption: "ig", videoPath: igPath },
      ],
      when: { kind: "now" },
    });
    expect(uploadedNames).toEqual(["delivery.mp4", "delivery-ig.mp4"]);
  });

  it("posts sharing the default file share ONE upload — no re-upload per post", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ossclip-publish-"));
    const videoPath = join(dir, "short.mp4");
    await writeFile(videoPath, "x");
    let uploadCalls = 0;
    let posted: { posts: Array<{ value: Array<{ image: Array<{ id: string }> }> }> } | undefined;
    const provider = createPostizProvider({
      baseUrl: "https://p.example.com",
      apiKey: "k",
      fetchImpl: async (u, init) => {
        if (String(u).endsWith("/upload")) {
          uploadCalls += 1;
          return jsonResponse(200, { id: "m-1", path: "/up/s.mp4" });
        }
        posted = JSON.parse(init?.body as string);
        return jsonResponse(200, [{ id: "post-1" }]);
      },
    });
    await provider.publish({
      videoPath,
      posts: [
        { target: li, caption: "li" },
        { target: ig, caption: "ig" },
      ],
      when: { kind: "now" },
    });
    expect(uploadCalls).toBe(1);
    expect(posted!.posts.map((p) => p.value[0]!.image[0]!.id)).toEqual(["m-1", "m-1"]);
  });

  it("an upload failure names WHICH file — several can be in flight now", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ossclip-publish-"));
    const videoPath = join(dir, "short.mp4");
    await writeFile(videoPath, "x");
    const provider = createPostizProvider({
      baseUrl: "https://p.example.com",
      apiKey: "k",
      fetchImpl: async () => new Response("boom", { status: 500 }),
    });
    await expect(
      provider.publish({ videoPath, posts: [{ target: li, caption: "c" }], when: { kind: "now" } }),
    ).rejects.toThrow(/while uploading .*short\.mp4/);
  });

  it("a /posts failure after a good upload names the media id so a retry is cheap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ossclip-publish-"));
    const videoPath = join(dir, "short.mp4");
    await writeFile(videoPath, "x");
    const provider = createPostizProvider({
      baseUrl: "https://p.example.com",
      apiKey: "k",
      fetchImpl: async (u) =>
        String(u).endsWith("/upload")
          ? jsonResponse(200, { id: "m-2", path: "/up/s.mp4" })
          : new Response("bad settings", { status: 400 }),
    });
    await expect(
      provider.publish({ videoPath, posts: [{ target: li, caption: "c" }], when: { kind: "now" } }),
    ).rejects.toThrow(/media id m-2/);
  });

  it("PostizHttpError carries method/path/status", () => {
    const err = new PostizHttpError("POST", "/posts", 429, "");
    expect(err.status).toBe(429);
    expect(err.message).toContain("POST /posts");
  });
});
