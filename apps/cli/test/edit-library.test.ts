import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditServer } from "../src/edit";

/**
 * The library + overlay endpoints (overlay-library spec §Server endpoints).
 * Every server here gets a tmp `libraryDir` AND a tmp `recentDir`: the suite
 * must never read or grow the runner's real ~/.ossclip (plan Global
 * Constraints, "Test isolation").
 */
let close: (() => void) | undefined;
afterEach(() => close?.());

const SHARED_RECENTS = join(tmpdir(), "ossclip-test-recents");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1");
const SVG = Buffer.from(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);

async function fixtureWorkdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ossclip-edit-lib-"));
  await writeFile(
    join(dir, "render-props.json"),
    JSON.stringify({ videoFileName: "clip.mp4", sceneCues: [], captionLines: [], spans: [] }),
  );
  await writeFile(join(dir, "clip.mp4"), "not-a-real-video");
  return dir;
}

async function boot(opts: { work?: string; lib?: string } = {}): Promise<{ url: string; work: string; lib: string }> {
  const work = opts.work ?? (await fixtureWorkdir());
  const lib = opts.lib ?? (await mkdtemp(join(tmpdir(), "ossclip-lib-")));
  const server = await startEditServer(work, {
    port: 0,
    recentDir: SHARED_RECENTS,
    loadCfg: () => ({}),
    libraryDir: lib,
  });
  close = server.close;
  return { url: server.url, work, lib };
}

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A hand-written library: one png per entry, indexed in library.json. */
async function writeLibrary(
  lib: string,
  entries: { id: string; names: string[]; bytes?: Buffer; ext?: string }[],
): Promise<void> {
  for (const e of entries) await writeFile(join(lib, `${e.id}.${e.ext ?? "png"}`), e.bytes ?? PNG);
  await writeFile(
    join(lib, "library.json"),
    JSON.stringify({
      entries: entries.map((e) => ({ id: e.id, file: `${e.id}.${e.ext ?? "png"}`, names: e.names, kind: "logo" })),
    }),
  );
}

describe("POST /api/library + GET /api/library", () => {
  it("POST base64 png → 201, file in library dir, GET /api/library lists it without paths", async () => {
    const { url, lib } = await boot();
    const res = await post(`${url}/api/library`, {
      name: "Google Developers Expert",
      aliases: ["GDE"],
      source: { data: PNG.toString("base64"), mimeType: "image/png" },
    });
    expect(res.status).toBe(201);
    const { entry } = await res.json();
    expect(entry).toEqual({
      id: "google-developers-expert",
      names: ["Google Developers Expert", "GDE"],
      kind: "logo",
      format: "png",
    });
    expect(readFileSync(join(lib, "google-developers-expert.png"))).toEqual(PNG);

    const listRes = await fetch(`${url}/api/library`);
    const text = await listRes.text();
    expect(JSON.parse(text).entries).toEqual([entry]);
    // Neither the library dir nor any absolute path rides along.
    expect(text).not.toContain(lib);
    expect(text).not.toMatch(/absPath|"file"/);
  });

  it("POST path to a local png → 201 (copied, never moved)", async () => {
    const { url, lib } = await boot();
    const src = join(await mkdtemp(join(tmpdir(), "ossclip-src-")), "logo.png");
    await writeFile(src, PNG);
    const res = await post(`${url}/api/library`, { name: "Clean Edit", source: { path: src } });
    expect(res.status).toBe(201);
    expect((await res.json()).entry.id).toBe("clean-edit");
    expect(existsSync(src)).toBe(true);
    expect(readFileSync(join(lib, "clean-edit.png"))).toEqual(PNG);
  });

  it("POST path to a text file → 400", async () => {
    const { url, lib } = await boot();
    const src = join(await mkdtemp(join(tmpdir(), "ossclip-src-")), "notes.png");
    await writeFile(src, "just some text, named like an image");
    const res = await post(`${url}/api/library`, { name: "Notes", source: { path: src } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not a supported image/);
    expect(readdirSync(lib)).toEqual([]);
  });

  it("POST a relative path or a directory → 400", async () => {
    const { url } = await boot();
    const rel = await post(`${url}/api/library`, { name: "X", source: { path: "logo.png" } });
    expect(rel.status).toBe(400);
    expect((await rel.json()).error).toMatch(/absolute/);
    const dir = await post(`${url}/api/library`, { name: "X", source: { path: tmpdir() } });
    expect(dir.status).toBe(400);
    expect((await dir.json()).error).toMatch(/not a file/);
  });

  it('POST name "../../x" → file stays inside the library dir', async () => {
    const { url, lib } = await boot();
    const res = await post(`${url}/api/library`, {
      name: "../../x",
      source: { data: PNG.toString("base64"), mimeType: "image/png" },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).entry.id).toBe("x");
    expect(readdirSync(lib).sort()).toEqual(["library.json", "x.png"]);
    expect(existsSync(join(lib, "..", "..", "x.png"))).toBe(false);
  });

  it("POST 21MB → 400", async () => {
    const { url, lib } = await boot();
    const big = Buffer.alloc(21 * 1024 * 1024);
    PNG.copy(big);
    const res = await post(`${url}/api/library`, {
      name: "Huge",
      source: { data: big.toString("base64"), mimeType: "image/png" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/20\.0 MB/);
    expect(readdirSync(lib)).toEqual([]);
  });

  it("POST path to a 21MB file → 400 before reading it", async () => {
    const { url } = await boot();
    const src = join(await mkdtemp(join(tmpdir(), "ossclip-src-")), "huge.png");
    await writeFile(src, Buffer.alloc(21 * 1024 * 1024));
    const res = await post(`${url}/api/library`, { name: "Huge", source: { path: src } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/20\.0 MB/);
  });

  it("POST svg → 201 format svg", async () => {
    const { url } = await boot();
    const res = await post(`${url}/api/library`, {
      name: "Firebase",
      source: { data: SVG.toString("base64"), mimeType: "image/svg+xml" },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).entry).toMatchObject({ id: "firebase", format: "svg", kind: "logo" });
  });

  it("POST a gif guesses kind gif", async () => {
    const { url } = await boot();
    const res = await post(`${url}/api/library`, {
      name: "Party",
      source: { data: GIF.toString("base64"), mimeType: "image/gif" },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).entry).toMatchObject({ format: "gif", kind: "gif" });
  });

  it("POST url: a non-http(s) url → 400", async () => {
    const { url } = await boot();
    const res = await post(`${url}/api/library`, { name: "X", source: { url: "file:///etc/passwd" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/http/);
  });

  it("POST url: fetched once into the library through the injected fetch", async () => {
    const work = await fixtureWorkdir();
    const lib = await mkdtemp(join(tmpdir(), "ossclip-lib-"));
    const seen: string[] = [];
    const server = await startEditServer(work, {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: () => ({}),
      libraryDir: lib,
      libraryFetch: (async (input: RequestInfo | URL) => {
        seen.push(String(input));
        return new Response(PNG);
      }) as typeof fetch,
    });
    close = server.close;
    const res = await post(`${server.url}/api/library`, {
      name: "Remote",
      source: { url: "https://example.com/logo.png" },
    });
    expect(res.status).toBe(201);
    expect(seen).toEqual(["https://example.com/logo.png"]);
    expect(readFileSync(join(lib, "remote.png"))).toEqual(PNG);
  });

  it("POST with a bad body → 400 with a readable message", async () => {
    const { url } = await boot();
    for (const body of [{}, { name: "", source: { path: "/x.png" } }, { name: "x".repeat(81), source: { path: "/x" } }]) {
      const res = await post(`${url}/api/library`, body);
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
  });

  it("errors never echo the library dir's absolute path", async () => {
    const { url, lib } = await boot();
    await writeFile(join(lib, "library.json"), "{ not json");
    const res = await post(`${url}/api/library`, {
      name: "X",
      source: { data: PNG.toString("base64"), mimeType: "image/png" },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(lib);
  });
});

describe("content-type gate (ruling R14)", () => {
  /** A cross-site page's "simple" POST: text/plain, so no CORS preflight. */
  const simplePost = (url: string, body: unknown): Promise<Response> =>
    fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) });

  it("text/plain → 415 on the three POSTs, and nothing is written", async () => {
    const { url, work, lib } = await boot();
    await writeLibrary(lib, [{ id: "alpha", names: ["alpha"] }]);
    const before = readdirSync(lib).sort();
    const src = join(await mkdtemp(join(tmpdir(), "ossclip-src-")), "logo.png");
    await writeFile(src, PNG);
    const add = await simplePost(`${url}/api/library`, { name: "Stolen", source: { path: src } });
    expect(add.status).toBe(415);
    expect(typeof (await add.json()).error).toBe("string");
    expect((await simplePost(`${url}/api/overlays/stage`, { entryId: "alpha" })).status).toBe(415);
    expect((await simplePost(`${url}/api/overlays/match`, {})).status).toBe(415);
    expect(readdirSync(lib).sort()).toEqual(before);
    expect(existsSync(join(work, "library"))).toBe(false);
  });

  it("application/json with a charset parameter is accepted", async () => {
    const { url, lib } = await boot();
    const res = await fetch(`${url}/api/library`, {
      method: "POST",
      headers: { "content-type": "Application/JSON; charset=utf-8" },
      body: JSON.stringify({ name: "Ok", source: { data: PNG.toString("base64"), mimeType: "image/png" } }),
    });
    expect(res.status).toBe(201);
    expect(existsSync(join(lib, "ok.png"))).toBe(true);
  });
});

describe("GET /api/library/file", () => {
  it("GET /api/library/file?id=unknown → 404", async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/api/library/file?id=unknown`);
    expect(res.status).toBe(404);
    expect(await fetch(`${url}/api/library/file?id=..%2F..%2Fetc%2Fpasswd`).then((r) => r.status)).toBe(404);
  });

  it(".gif served as image/gif", async () => {
    const { url, lib } = await boot();
    await writeLibrary(lib, [{ id: "party", names: ["party"], bytes: GIF, ext: "gif" }]);
    const res = await fetch(`${url}/api/library/file?id=party`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(GIF);
  });

  it("an svg is served as image/svg+xml under a sandbox CSP", async () => {
    const { url, lib } = await boot();
    await writeLibrary(lib, [{ id: "firebase", names: ["Firebase"], bytes: SVG, ext: "svg" }]);
    const res = await fetch(`${url}/api/library/file?id=firebase`);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("the MIME type follows the sniffed format, not the extension", async () => {
    const { url, lib } = await boot();
    // A jpeg-extension file that is really a png: the bytes decide.
    await writeLibrary(lib, [{ id: "odd", names: ["odd"], bytes: PNG, ext: "jpg" }]);
    const res = await fetch(`${url}/api/library/file?id=odd`);
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});

/** Five words, one name per word, each 2s apart so no overlap drop fires. */
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo"].map((text, i) => ({
  text,
  start: i * 2,
  end: i * 2 + 0.5,
}));
const snap = (id: string, name: string) => ({ id, name, names: [name], kind: "logo", ext: "png" });

describe("overlay endpoints", () => {
  it("GET /api/overlays/plan serves the plan and the repaired word space", async () => {
    const work = await fixtureWorkdir();
    const overlays = { entries: [snap("alpha", "alpha")], placements: [{ id: "alpha@0", entryId: "alpha", word: 0, source: "match" }] };
    await writeFile(join(work, "production.json"), JSON.stringify({ transcript: { language: "en", words: WORDS }, overlays }));
    const { url } = await boot({ work });
    const body = await (await fetch(`${url}/api/overlays/plan`)).json();
    expect(body).toEqual({ overlays, words: WORDS });
  });

  it("GET /api/overlays/plan answers null overlays for a pre-overlay production", async () => {
    const work = await fixtureWorkdir();
    await writeFile(join(work, "production.json"), JSON.stringify({ transcript: { language: "en", words: WORDS } }));
    const { url } = await boot({ work });
    expect(await (await fetch(`${url}/api/overlays/plan`)).json()).toEqual({ overlays: null, words: WORDS });
  });

  it("stage copies into <workdir>/library/<id>.<ext>", async () => {
    const { url, work, lib } = await boot();
    await writeLibrary(lib, [{ id: "party", names: ["Party"], bytes: GIF, ext: "gif" }]);
    const res = await post(`${url}/api/overlays/stage`, { entryId: "party" });
    expect(res.status).toBe(200);
    expect((await res.json()).entry).toEqual({ id: "party", name: "Party", names: ["Party"], kind: "logo", ext: "gif" });
    expect(readFileSync(join(work, "library", "party.gif"))).toEqual(GIF);
    // ... and the workdir serves it over /media/ for the preview.
    const media = await fetch(`${url}/media/library/party.gif`);
    expect(media.headers.get("content-type")).toBe("image/gif");
  });

  it("stage re-copies over a stale workdir copy (a tray swap brings new art)", async () => {
    const { url, work, lib } = await boot();
    await writeLibrary(lib, [{ id: "alpha", names: ["alpha"] }]);
    expect((await post(`${url}/api/overlays/stage`, { entryId: "alpha" })).status).toBe(200);
    const fresh = Buffer.concat([PNG, Buffer.from([9, 9, 9])]);
    await writeFile(join(lib, "alpha.png"), fresh);
    expect((await post(`${url}/api/overlays/stage`, { entryId: "alpha" })).status).toBe(200);
    expect(readFileSync(join(work, "library", "alpha.png"))).toEqual(fresh);
  });

  it("a failed re-copy leaves the existing workdir copy in place", async () => {
    const { url, work, lib } = await boot();
    await writeLibrary(lib, [{ id: "alpha", names: ["alpha"] }]);
    expect((await post(`${url}/api/overlays/stage`, { entryId: "alpha" })).status).toBe(200);
    // Read-only library/ folder: the temp copy beside the old one cannot be
    // created, so the swap fails — and must not have deleted the old art first.
    const dir = join(work, "library");
    await chmod(dir, 0o555);
    try {
      const res = await post(`${url}/api/overlays/stage`, { entryId: "alpha" });
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain(lib);
    } finally {
      await chmod(dir, 0o755);
    }
    expect(readFileSync(join(dir, "alpha.png"))).toEqual(PNG);
    expect(readdirSync(dir)).toEqual(["alpha.png"]);
  });

  it("stage of an unknown entry → 404", async () => {
    const { url } = await boot();
    expect((await post(`${url}/api/overlays/stage`, { entryId: "nope" })).status).toBe(404);
    expect((await post(`${url}/api/overlays/stage`, {})).status).toBe(400);
  });

  it("match skips placed/removed entries", async () => {
    const work = await fixtureWorkdir();
    // alpha is in the plan; bravo is in the plan and the user removed it;
    // charlie the user placed by hand; delta and echo are new.
    await writeFile(
      join(work, "production.json"),
      JSON.stringify({
        transcript: { language: "en", words: WORDS },
        overlays: {
          entries: [snap("alpha", "alpha"), snap("bravo", "bravo")],
          placements: [
            { id: "alpha@0", entryId: "alpha", word: 0, source: "match" },
            { id: "bravo@1", entryId: "bravo", word: 1, source: "match" },
          ],
        },
      }),
    );
    const { url, lib } = await boot({ work });
    await writeLibrary(
      lib,
      ["alpha", "bravo", "charlie", "delta", "echo"].map((n) => ({ id: n, names: [n] })),
    );
    const res = await post(`${url}/api/overlays/match`, {
      overlays: {
        edits: { "bravo@1": { removed: true } },
        added: [{ id: "u1", entryId: "charlie", word: 4, source: "user" }],
        entries: [snap("charlie", "charlie")],
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // echo's first mention is word 4 — where the user's own charlie already
    // sits — so it is dropped as an overlap, not stacked onto it. delta (6s)
    // is 2s from charlie (8s) and survives; the removed bravo occupies nothing.
    expect(body.placements).toEqual([{ id: "delta@3", entryId: "delta", word: 3, source: "match" }]);
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["delta"]);
    expect(body.skipped).toBe(3);
    expect(body.dropped).toEqual([{ entryId: "echo", word: 4, reason: "too close to another overlay" }]);
    // The new match's file is staged; the skipped and dropped ones are not.
    expect(existsSync(join(work, "library", "delta.png"))).toBe(true);
    expect(existsSync(join(work, "library", "echo.png"))).toBe(false);
    expect(existsSync(join(work, "library", "charlie.png"))).toBe(false);
  });

  it("match only hears KEPT words (ruling R6)", async () => {
    const work = await fixtureWorkdir();
    // The last render kept 0–5s and 7–10s: "delta" (6–6.5s) was cut.
    await writeFile(
      join(work, "render-props.json"),
      JSON.stringify({
        videoFileName: "clip.mp4",
        sceneCues: [],
        captionLines: [],
        spans: [
          { srcIn: 0, srcOut: 5, outIn: 0, outOut: 5 },
          { srcIn: 7, srcOut: 10, outIn: 5, outOut: 8 },
        ],
      }),
    );
    await writeFile(join(work, "production.json"), JSON.stringify({ transcript: { language: "en", words: WORDS } }));
    const { url, lib } = await boot({ work });
    await writeLibrary(lib, [
      { id: "delta", names: ["delta"] },
      { id: "echo", names: ["echo"] },
    ]);
    const body = await (await post(`${url}/api/overlays/match`, {})).json();
    expect(body.placements).toEqual([{ id: "echo@4", entryId: "echo", word: 4, source: "match" }]);
    expect(body.skipped).toBe(0);
  });

  it("match spaces new matches against existing overlays on the OUTPUT clock", async () => {
    const work = await fixtureWorkdir();
    // The render cut 2.6–5.8s, so "delta" (source 6s) plays at 2.8s — 0.8s
    // after the user's overlay on "bravo" (source 2s → output 2s), and
    // "charlie" (source 4s) is gone. On the source clock delta is 4s clear.
    await writeFile(
      join(work, "render-props.json"),
      JSON.stringify({
        videoFileName: "clip.mp4",
        sceneCues: [],
        captionLines: [],
        spans: [
          { srcIn: 0, srcOut: 2.6, outIn: 0, outOut: 2.6 },
          { srcIn: 5.8, srcOut: 10, outIn: 2.6, outOut: 6.8 },
        ],
      }),
    );
    await writeFile(join(work, "production.json"), JSON.stringify({ transcript: { language: "en", words: WORDS } }));
    const { url, lib } = await boot({ work });
    await writeLibrary(lib, [
      { id: "bravo", names: ["bravo"] },
      { id: "delta", names: ["delta"] },
    ]);
    const body = await (
      await post(`${url}/api/overlays/match`, {
        overlays: {
          added: [{ id: "u1", entryId: "bravo", word: 1, source: "user" }],
          entries: [snap("bravo", "bravo")],
        },
      })
    ).json();
    expect(body.placements).toEqual([]);
    expect(body.dropped).toEqual([{ entryId: "delta", word: 3, reason: "too close to another overlay" }]);
  });

  it("match reports an entry whose file could not be staged instead of dropping it silently", async () => {
    const work = await fixtureWorkdir();
    await writeFile(join(work, "production.json"), JSON.stringify({ transcript: { language: "en", words: WORDS } }));
    // A FILE where the workdir's library/ folder should be: staging cannot mkdir.
    await writeFile(join(work, "library"), "in the way");
    const { url, lib } = await boot({ work });
    await writeLibrary(lib, [{ id: "delta", names: ["Delta"] }]);
    const body = await (await post(`${url}/api/overlays/match`, {})).json();
    expect(body.placements).toEqual([]);
    expect(body.entries).toEqual([]);
    expect(body.dropped).toHaveLength(1);
    expect(body.dropped[0]).toMatchObject({ entryId: "delta", word: 3 });
    expect(body.dropped[0].reason).toMatch(/could not stage/);
    expect(body.dropped[0].reason).not.toContain(lib);
  });

  it("match without a transcript → 400", async () => {
    const { url } = await boot();
    const res = await post(`${url}/api/overlays/match`, {});
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
  });
});

/**
 * Logo candidates (logo-finder Task 6): produce writes the files under
 * `<workdir>/logo-candidates/<id>/`, and the page names one by
 * `(suggestion, n)` only, never by path.
 */
async function candidateWorkdir(): Promise<string> {
  const work = await fixtureWorkdir();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(work, "logo-candidates", "firebase"), { recursive: true });
  await writeFile(join(work, "logo-candidates", "firebase", "0.svg"), SVG);
  await writeFile(join(work, "logo-candidates", "firebase", "1.png"), PNG);
  const overlays = {
    entries: [],
    placements: [],
    suggestions: [
      {
        id: "firebase",
        name: "Firebase",
        word: 2,
        domain: "firebase.google.com",
        candidates: [
          { file: "logo-candidates/firebase/0.svg", source: "header" },
          { file: "logo-candidates/firebase/1.png", source: "icon", width: 64, height: 64 },
        ],
      },
      // Filed under ANOTHER suggestion's directory: a hand edit the server refuses.
      { id: "stray", name: "Stray", word: 3, candidates: [{ file: "logo-candidates/firebase/1.png", source: "og" }] },
    ],
  };
  await writeFile(join(work, "production.json"), JSON.stringify({ transcript: { language: "en", words: WORDS }, overlays }));
  return work;
}

describe("logo candidates", () => {
  it("GET /api/overlays/plan carries the suggestions", async () => {
    const work = await candidateWorkdir();
    const { url } = await boot({ work });
    const body = await (await fetch(`${url}/api/overlays/plan`)).json();
    expect(body.overlays.suggestions.map((s: { id: string }) => s.id)).toEqual(["firebase", "stray"]);
    expect(body.overlays.suggestions[0].candidates[1]).toEqual({
      file: "logo-candidates/firebase/1.png",
      source: "icon",
      width: 64,
      height: 64,
    });
  });

  it("GET /api/logo-candidates/file serves the bytes with the sandbox headers", async () => {
    const { url } = await boot({ work: await candidateWorkdir() });
    const svg = await fetch(`${url}/api/logo-candidates/file?suggestion=firebase&n=0`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await svg.arrayBuffer())).toEqual(SVG);
    const png = await fetch(`${url}/api/logo-candidates/file?suggestion=firebase&n=1`);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await png.arrayBuffer())).toEqual(PNG);
  });

  it("GET /api/logo-candidates/file refuses traversal, unknowns and cross-suggestion files with 404", async () => {
    const { url } = await boot({ work: await candidateWorkdir() });
    for (const q of [
      "suggestion=..%2Fx&n=0",
      "suggestion=../x&n=0",
      "suggestion=nope&n=0",
      "suggestion=firebase&n=2",
      "suggestion=firebase&n=-1",
      "suggestion=firebase&n=0.5",
      "suggestion=firebase",
      "suggestion=stray&n=0",
    ]) {
      const res = await fetch(`${url}/api/logo-candidates/file?${q}`);
      expect(res.status, q).toBe(404);
      expect(await res.json(), q).toEqual({ error: "no such logo candidate" });
    }
  });

  it("GET /api/logo-candidates/file on a workdir without production.json → 404", async () => {
    const { url } = await boot();
    expect((await fetch(`${url}/api/logo-candidates/file?suggestion=firebase&n=0`)).status).toBe(404);
  });

  it("no workdir open: the file route is 409, a candidate add is 400", async () => {
    const lib = await mkdtemp(join(tmpdir(), "ossclip-lib-"));
    const server = await startEditServer(undefined, { port: 0, recentDir: SHARED_RECENTS, loadCfg: () => ({}), libraryDir: lib });
    close = server.close;
    expect((await fetch(`${server.url}/api/logo-candidates/file?suggestion=firebase&n=0`)).status).toBe(409);
    const res = await post(`${server.url}/api/library`, { name: "X", source: { candidate: { suggestion: "firebase", n: 0 } } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no such logo candidate" });
  });

  it("POST /api/library with a candidate source adds it under the given name", async () => {
    const { url, lib } = await boot({ work: await candidateWorkdir() });
    const res = await post(`${url}/api/library`, { name: "Firebase", source: { candidate: { suggestion: "firebase", n: 1 } } });
    expect(res.status).toBe(201);
    expect((await res.json()).entry).toEqual({ id: "firebase", names: ["Firebase"], kind: "logo", format: "png" });
    expect(readFileSync(join(lib, "firebase.png"))).toEqual(PNG);
  });

  it("the same candidate twice gives one entry (content-hash reuse, 200)", async () => {
    const { url, lib } = await boot({ work: await candidateWorkdir() });
    const body = { name: "Firebase", source: { candidate: { suggestion: "firebase", n: 0 } } };
    const first = await post(`${url}/api/library`, body);
    expect(first.status).toBe(201);
    const second = await post(`${url}/api/library`, { ...body, name: "Firebase again" });
    expect(second.status).toBe(200);
    expect((await second.json()).entry).toEqual((await first.json()).entry);
    expect((await (await fetch(`${url}/api/library`)).json()).entries).toHaveLength(1);
    expect(readdirSync(lib).sort()).toEqual(["firebase.svg", "library.json"]);
  });

  it("content-hash reuse applies to every source kind", async () => {
    const { url, lib } = await boot();
    await writeLibrary(lib, [{ id: "alpha", names: ["alpha"] }]);
    const before = readFileSync(join(lib, "library.json"), "utf8");
    const src = join(await mkdtemp(join(tmpdir(), "ossclip-src-")), "same.png");
    await writeFile(src, PNG);
    for (const source of [{ path: src }, { data: PNG.toString("base64"), mimeType: "image/png" }]) {
      const res = await post(`${url}/api/library`, { name: "Duplicate", source });
      expect(res.status).toBe(200);
      expect((await res.json()).entry).toEqual({ id: "alpha", names: ["alpha"], kind: "logo", format: "png" });
    }
    expect(readFileSync(join(lib, "library.json"), "utf8")).toBe(before);
    expect(readdirSync(lib).sort()).toEqual(["alpha.png", "library.json"]);
    // Different bytes are still a fresh add.
    const other = await post(`${url}/api/library`, { name: "Party", source: { data: GIF.toString("base64"), mimeType: "image/gif" } });
    expect(other.status).toBe(201);
  });

  /**
   * Final review Minor 2: the candidate passed `existsSync`, then stat or
   * read threw (deleted mid-request, made unreadable), and the fs error fell
   * through as a 500 carrying `<workdir>/logo-candidates/...`. Stand-ins
   * that need no timing race: a directory where the file was (exists, is
   * not a file), and a file with no read permission (stat passes, read throws).
   */
  it("a candidate that is no longer a readable file → 400 no such logo candidate, no workdir path", async () => {
    const work = await candidateWorkdir();
    const { url, lib } = await boot({ work });
    const { mkdir, rm } = await import("node:fs/promises");
    const png = join(work, "logo-candidates", "firebase", "1.png");
    await rm(png);
    await mkdir(png);
    const svg = join(work, "logo-candidates", "firebase", "0.svg");
    await chmod(svg, 0o000);
    try {
      for (const n of [0, 1]) {
        const res = await post(`${url}/api/library`, { name: "X", source: { candidate: { suggestion: "firebase", n } } });
        const text = await res.text();
        expect(res.status, `n=${n}`).toBe(400);
        expect(JSON.parse(text), `n=${n}`).toEqual({ error: "no such logo candidate" });
        expect(text).not.toContain(work);
      }
      // The preview route's matching guard: a directory is not a candidate.
      const res = await fetch(`${url}/api/logo-candidates/file?suggestion=firebase&n=1`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "no such logo candidate" });
    } finally {
      await chmod(svg, 0o644);
    }
    expect(readdirSync(lib)).toEqual([]);
  });

  it("POST /api/library with an unknown or cross-suggestion candidate → 400", async () => {
    const { url, lib } = await boot({ work: await candidateWorkdir() });
    for (const candidate of [
      { suggestion: "nope", n: 0 },
      { suggestion: "../x", n: 0 },
      { suggestion: "firebase", n: 3 },
      { suggestion: "stray", n: 0 },
    ]) {
      const res = await post(`${url}/api/library`, { name: "X", source: { candidate } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "no such logo candidate" });
    }
    // n outside 0–3 and a client-sent path are refused by the schema.
    for (const candidate of [{ suggestion: "firebase", n: 4 }, { suggestion: "firebase", n: 0, file: "/etc/passwd" }]) {
      expect((await post(`${url}/api/library`, { name: "X", source: { candidate } })).status).toBe(400);
    }
    expect(readdirSync(lib)).toEqual([]);
  });
});

describe("POST /api/library/preview (tray preview before Add)", () => {
  /** A server whose URL fetches answer from `answer`, and record what was asked. */
  async function bootFetching(answer: (url: string) => Response): Promise<{ url: string; lib: string }> {
    const lib = await mkdtemp(join(tmpdir(), "ossclip-lib-"));
    const server = await startEditServer(await fixtureWorkdir(), {
      port: 0,
      recentDir: SHARED_RECENTS,
      loadCfg: () => ({}),
      libraryDir: lib,
      libraryFetch: (async (input: RequestInfo | URL) => answer(String(input))) as typeof fetch,
    });
    close = server.close;
    return { url: server.url, lib };
  }

  it("a URL answers the exact bytes, their format and size, and writes nothing to the library", async () => {
    const { url, lib } = await bootFetching(() => new Response(PNG));
    const res = await post(`${url}/api/library/preview`, { source: { url: "https://example.com/logo.png" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ format: "png", mimeType: "image/png", bytes: PNG.length });
    expect(Buffer.from(body.data, "base64")).toEqual(PNG);
    expect(readdirSync(lib)).toEqual([]);
  });

  it("a URL that answers a web page is refused in words that say so", async () => {
    const { url } = await bootFetching(() => new Response("<!DOCTYPE html><html><body>File:N8n.png</body></html>"));
    const res = await post(`${url}/api/library/preview`, { source: { url: "https://commons.wikimedia.org/x" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("that URL returned a web page, not an image");
  });

  it("an HTTP error from the URL is refused with the status, not as a 500", async () => {
    const { url } = await bootFetching(() => new Response("nope", { status: 404 }));
    const res = await post(`${url}/api/library/preview`, { source: { url: "https://example.com/gone.png" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("404");
  });

  it("a path to a file that is not an image is refused", async () => {
    const { url, work } = await boot();
    const res = await post(`${url}/api/library/preview`, { source: { path: join(work, "render-props.json") } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not a supported image");
  });

  it("a relative path is refused exactly as Add refuses it", async () => {
    const { url } = await boot();
    const res = await post(`${url}/api/library/preview`, { source: { path: "logo.png" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("absolute");
  });

  it("a dropped file's bytes are sniffed, not its claimed type: an SVG comes back as image/svg+xml", async () => {
    const { url } = await boot();
    const res = await post(`${url}/api/library/preview`, {
      source: { data: SVG.toString("base64"), mimeType: "image/png" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ format: "svg", mimeType: "image/svg+xml", bytes: SVG.length });
  });

  it("refuses a candidate source: the logo popover already shows its own thumbnails", async () => {
    const { url } = await boot();
    const res = await post(`${url}/api/library/preview`, { source: { candidate: { suggestion: "x", n: 0 } } });
    expect(res.status).toBe(400);
  });
});
