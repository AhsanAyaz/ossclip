import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
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
    expect(body.placements).toEqual([
      { id: "delta@3", entryId: "delta", word: 3, source: "match" },
      { id: "echo@4", entryId: "echo", word: 4, source: "match" },
    ]);
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["delta", "echo"]);
    expect(body.skipped).toBe(3);
    // The new matches' files are staged; the skipped ones are not touched.
    expect(existsSync(join(work, "library", "delta.png"))).toBe(true);
    expect(existsSync(join(work, "library", "echo.png"))).toBe(true);
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

  it("match without a transcript → 400", async () => {
    const { url } = await boot();
    const res = await post(`${url}/api/overlays/match`, {});
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
  });
});
