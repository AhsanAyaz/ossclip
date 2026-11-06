import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryAddError, LogoSuggestionSchema, type LogoFlag } from "@ossclip/core";
import { findLogoCandidates, homepageNote } from "../src/logo-finder";

const tmpWork = (): string => mkdtempSync(join(tmpdir(), "ossclip-logo-finder-"));

/**
 * A PNG signature plus an IHDR chunk: enough for `sniffImageFormat` and
 * `imageSize`. `salt` varies the bytes so dedupe-by-hash sees distinct files.
 */
const png = (w: number, h: number, salt = 0): Uint8Array => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b.writeUInt32BE(salt, 29);
  return new Uint8Array(b);
};
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');

type Route = Uint8Array | string | number | (() => Promise<Response>);

/** A `fetch` over a URL → body map; a number is a bare status. Unknown URLs 404. */
function fakeFetch(routes: Record<string, Route>, onCall?: (url: string) => void): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    onCall?.(url);
    const r = routes[url];
    if (r === undefined) return new Response("not found", { status: 404 });
    if (typeof r === "function") return r();
    if (typeof r === "number") return new Response("err", { status: r });
    return new Response(r);
  }) as typeof fetch;
}

const flag = (id: string, name: string, domain?: string): LogoFlag =>
  domain === undefined ? { id, name, word: 0 } : { id, name, word: 0, domain };

const FIREBASE = flag("firebase", "Firebase", "firebase.google.com");
const HOME = "https://firebase.google.com/";
const at = (path: string): string => new URL(path, HOME).href;

const files = (work: string, id: string): string[] => {
  const dir = join(work, "logo-candidates", id);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

describe("findLogoCandidates", () => {
  it("writes the header logo as 0.png and lists it first, with its size", async () => {
    const work = tmpWork();
    const html = `<header><img class="logo" src="/logo.png"></header>
      <link rel="apple-touch-icon" sizes="180x180" href="/touch.png">`;
    const [s] = await findLogoCandidates([FIREBASE], {
      work,
      fetch: fakeFetch({ [HOME]: html, [at("/logo.png")]: png(200, 100, 1), [at("/touch.png")]: png(180, 180, 2) }),
    });
    expect(LogoSuggestionSchema.parse(s)).toEqual(s);
    expect(s).toEqual({
      id: "firebase",
      name: "Firebase",
      word: 0,
      domain: "firebase.google.com",
      candidates: [
        { file: "logo-candidates/firebase/0.png", source: "header", width: 200, height: 100 },
        { file: "logo-candidates/firebase/1.png", source: "icon", width: 180, height: 180 },
      ],
    });
    expect(new Uint8Array(readFileSync(join(work, "logo-candidates/firebase/0.png")))).toEqual(png(200, 100, 1));
  });

  it("drops an HTML body served at an image URL, and a 32×32 png", async () => {
    const work = tmpWork();
    const html = `<link rel="icon" sizes="512x512" href="/fake.png"><link rel="icon" sizes="32x32" href="/tiny.png">
      <link rel="icon" sizes="16x16" href="/ok.png">`;
    const [s] = await findLogoCandidates([FIREBASE], {
      work,
      fetch: fakeFetch({
        [HOME]: html,
        [at("/fake.png")]: "<html><body>Not found</body></html>",
        [at("/tiny.png")]: png(32, 32),
        // The declared size is a hint; the bytes decide. 64 is the floor, inclusive.
        [at("/ok.png")]: png(64, 300),
      }),
    });
    expect(s!.candidates).toEqual([{ file: "logo-candidates/firebase/0.png", source: "icon", width: 64, height: 300 }]);
    expect(files(work, "firebase")).toEqual(["0.png"]);
  });

  it("dedupes identical bytes behind different URLs", async () => {
    const work = tmpWork();
    const html = `<link rel="icon" sizes="192x192" href="/a.png"><link rel="icon" sizes="96x96" href="/b.png">`;
    const [s] = await findLogoCandidates([FIREBASE], {
      work,
      fetch: fakeFetch({ [HOME]: html, [at("/a.png")]: png(192, 192), [at("/b.png")]: png(192, 192) }),
    });
    expect(s!.candidates.map((c) => c.file)).toEqual(["logo-candidates/firebase/0.png"]);
  });

  it("keeps at most 4, and stops downloading once it has them", async () => {
    const work = tmpWork();
    const routes: Record<string, Route> = {};
    let html = "";
    for (let i = 0; i < 6; i++) {
      html += `<link rel="icon" sizes="${600 - i}x${600 - i}" href="/i${i}.png">`;
      routes[at(`/i${i}.png`)] = png(100, 100, i);
    }
    const asked: string[] = [];
    const [s] = await findLogoCandidates([FIREBASE], {
      work,
      fetch: fakeFetch({ [HOME]: html, ...routes }, (u) => asked.push(u)),
    });
    expect(s!.candidates.map((c) => c.file)).toEqual([0, 1, 2, 3].map((n) => `logo-candidates/firebase/${n}.png`));
    expect(files(work, "firebase")).toEqual(["0.png", "1.png", "2.png", "3.png"]);
    expect(asked).not.toContain(at("/i4.png"));
  });

  it("writes an svg with no width or height", async () => {
    const work = tmpWork();
    const [s] = await findLogoCandidates([FIREBASE], {
      work,
      fetch: fakeFetch({ [HOME]: `<nav><img src="/firebase.svg"></nav>`, [at("/firebase.svg")]: SVG }),
    });
    expect(s!.candidates).toEqual([{ file: "logo-candidates/firebase/0.svg", source: "header" }]);
  });

  it("uses the manifest's icons, before og:image", async () => {
    const work = tmpWork();
    const html = `<link rel="manifest" href="/app.webmanifest"><meta property="og:image" content="/og.png">`;
    const manifest = JSON.stringify({ icons: [{ src: "/m-512.png", sizes: "512x512" }] });
    const [s] = await findLogoCandidates([FIREBASE], {
      work,
      fetch: fakeFetch({
        [HOME]: html,
        [at("/app.webmanifest")]: manifest,
        [at("/m-512.png")]: png(512, 512),
        [at("/og.png")]: png(1200, 630),
      }),
    });
    expect(s!.candidates.map((c) => c.source)).toEqual(["manifest", "og"]);
  });

  it("a broken manifest costs only the manifest", async () => {
    const work = tmpWork();
    const html = `<link rel="manifest" href="/app.webmanifest"><meta property="og:image" content="/og.png">`;
    const [s] = await findLogoCandidates([FIREBASE], {
      work,
      fetch: fakeFetch({ [HOME]: html, [at("/app.webmanifest")]: "{not json", [at("/og.png")]: png(1200, 630) }),
    });
    expect(s!.candidates.map((c) => c.source)).toEqual(["og"]);
  });

  it("a flag with no domain gets no fetch and `no official site`", async () => {
    const work = tmpWork();
    const asked: string[] = [];
    const [s] = await findLogoCandidates([flag("kimi", "Kimi")], { work, fetch: fakeFetch({}, (u) => asked.push(u)) });
    expect(s).toEqual({ id: "kimi", name: "Kimi", word: 0, candidates: [], note: "no official site" });
    expect(asked).toEqual([]);
  });

  it("a homepage 500 is `<domain> answered 500`", async () => {
    const work = tmpWork();
    const [s] = await findLogoCandidates([FIREBASE], { work, fetch: fakeFetch({ [HOME]: 500 }) });
    expect(s!.candidates).toEqual([]);
    expect(s!.note).toBe("firebase.google.com answered 500");
  });

  it("names the domain it asked for even when a redirect led elsewhere", async () => {
    const work = tmpWork();
    const [s] = await findLogoCandidates([FIREBASE], {
      work,
      fetch: fakeFetch({
        [HOME]: async () => new Response(null, { status: 301, headers: { location: "https://www.firebase.example/" } }),
        "https://www.firebase.example/": 503,
      }),
    });
    expect(s!.note).toBe("firebase.google.com answered 503");
  });

  it("a page with no usable image is `no logo found`", async () => {
    const work = tmpWork();
    const [s] = await findLogoCandidates([FIREBASE], {
      work,
      fetch: fakeFetch({ [HOME]: `<link rel="icon" href="/x.png" sizes="99x99">`, [at("/x.png")]: 404 }),
    });
    expect(s).toMatchObject({ candidates: [], note: "no logo found" });
    expect(files(work, "firebase")).toEqual([]);
  });

  it("a homepage that hangs past the per-request limit is `site timed out`", async () => {
    const work = tmpWork();
    const [s] = await findLogoCandidates([FIREBASE], {
      work,
      perRequestMs: 20,
      fetch: fakeFetch({ [HOME]: () => new Promise<Response>(() => {}) }),
    });
    expect(s!.note).toBe("site timed out");
  });

  it("with `now` past the budget, the rest get `site timed out` and nothing is written for them", async () => {
    const work = tmpWork();
    let clock = 0;
    const page = (img: string): string => `<link rel="icon" sizes="128x128" href="${img}">`;
    const flags = [
      FIREBASE,
      flag("claude", "Claude", "claude.ai"),
      flag("gemini", "Gemini", "gemini.google.com"),
    ];
    const out = await findLogoCandidates(flags, {
      work,
      concurrency: 1,
      budgetMs: 30_000,
      now: () => clock,
      fetch: fakeFetch({
        [HOME]: page("/f.png"),
        [at("/f.png")]: png(128, 128, 1),
        // Claude's homepage answers, but only after the budget has run out.
        "https://claude.ai/": async () => {
          clock = 30_001;
          return new Response(page("/c.png"));
        },
        "https://claude.ai/c.png": png(128, 128, 2),
        "https://gemini.google.com/": page("/g.png"),
        "https://gemini.google.com/g.png": png(128, 128, 3),
      }),
    });
    expect(out.map((s) => [s.id, s.candidates.length, s.note])).toEqual([
      ["firebase", 1, undefined],
      ["claude", 0, "site timed out"],
      ["gemini", 0, "site timed out"],
    ]);
    expect(files(work, "firebase")).toEqual(["0.png"]);
    expect(files(work, "claude")).toEqual([]);
    expect(files(work, "gemini")).toEqual([]);
    for (const s of out) LogoSuggestionSchema.parse(s);
  });

  it("the budget is a wall clock: a name still in flight when it fires is abandoned", async () => {
    const work = tmpWork();
    // A stale dir from an older run must not survive as unlisted candidates.
    mkdirSync(join(work, "logo-candidates", "firebase"), { recursive: true });
    writeFileSync(join(work, "logo-candidates", "firebase", "0.png"), png(100, 100));
    const started = Date.now();
    const [s] = await findLogoCandidates([FIREBASE], {
      work,
      budgetMs: 50,
      perRequestMs: 5_000,
      fetch: fakeFetch({ [HOME]: () => new Promise<Response>(() => {}) }),
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(s).toMatchObject({ candidates: [], note: "site timed out" });
    expect(files(work, "firebase")).toEqual([]);
  });

  it("replaces a stale dir for its own id and never touches another id's", async () => {
    const work = tmpWork();
    for (const id of ["firebase", "other"]) {
      mkdirSync(join(work, "logo-candidates", id), { recursive: true });
      writeFileSync(join(work, "logo-candidates", id, "3.gif"), "old");
    }
    await findLogoCandidates([FIREBASE], {
      work,
      fetch: fakeFetch({ [HOME]: `<link rel="icon" sizes="99x99" href="/x.png">`, [at("/x.png")]: png(99, 99) }),
    });
    expect(files(work, "firebase")).toEqual(["0.png"]);
    expect(files(work, "other")).toEqual(["3.gif"]);
  });

  it("runs at most `concurrency` sites at once and keeps flag order in its answer", async () => {
    const work = tmpWork();
    let live = 0;
    let peak = 0;
    const slow = (body: string) => async (): Promise<Response> => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 10));
      live--;
      return new Response(body);
    };
    const flags = ["a", "b", "c", "d", "e", "f"].map((id) => flag(id, id.toUpperCase(), `${id}.example`));
    const routes = Object.fromEntries(flags.map((f) => [`https://${f.domain}/`, slow("<p>none</p>")]));
    const out = await findLogoCandidates(flags, { work, concurrency: 2, fetch: fakeFetch(routes) });
    expect(peak).toBe(2);
    expect(out.map((s) => s.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("a homepage that cannot be reached is `could not reach <domain>`, never the raw error (ruling R15)", async () => {
    const refused = (async () => {
      throw new Error("refused: firebase.google.com resolves to a private address");
    }) as typeof fetch;
    const loop = fakeFetch({ [HOME]: async () => new Response(null, { status: 302, headers: { location: HOME } }) });
    for (const fetch of [refused, loop]) {
      const [s] = await findLogoCandidates([FIREBASE], { work: tmpWork(), fetch });
      expect(s!.note).toBe("could not reach firebase.google.com");
    }
  });

  it("an unwritable workdir is `could not save the logos` for that name, and the step still resolves", async () => {
    const work = tmpWork();
    // `logo-candidates` is a FILE, so every mkdir under it fails.
    writeFileSync(join(work, "logo-candidates"), "not a dir");
    const html = `<link rel="icon" sizes="99x99" href="/x.png">`;
    const out = await findLogoCandidates([FIREBASE, flag("claude", "Claude", "claude.ai"), flag("kimi", "Kimi")], {
      work,
      fetch: fakeFetch({
        [HOME]: html,
        [at("/x.png")]: png(99, 99, 1),
        "https://claude.ai/": html,
        "https://claude.ai/x.png": png(99, 99, 2),
      }),
    });
    expect(out.map((s) => [s.id, s.candidates.length, s.note])).toEqual([
      ["firebase", 0, "could not save the logos"],
      ["claude", 0, "could not save the logos"],
      ["kimi", 0, "no official site"],
    ]);
    for (const s of out) LogoSuggestionSchema.parse(s);
  });

  it("reads the first 2 MB of a longer homepage instead of refusing it (ruling R16)", async () => {
    const work = tmpWork();
    const html = `<header><img class="logo" src="/logo.png"></header>` + "<p>filler</p>".repeat(250_000);
    expect(html.length).toBeGreaterThan(2 * 1024 * 1024);
    const [s] = await findLogoCandidates([FIREBASE], {
      work,
      fetch: fakeFetch({ [HOME]: html, [at("/logo.png")]: png(200, 200) }),
    });
    expect(s!.candidates.map((c) => c.source)).toEqual(["header"]);
  });

  it("resolves relative URLs against the homepage's final URL after redirects (ruling R14)", async () => {
    const work = tmpWork();
    const asked: string[] = [];
    const [s] = await findLogoCandidates([flag("a", "A", "a.test")], {
      work,
      fetch: fakeFetch(
        {
          "https://a.test/": async () =>
            new Response(null, { status: 301, headers: { location: "https://www.a.test/en/" } }),
          "https://www.a.test/en/": `<nav><img class="logo" src="logo.png"></nav>`,
          "https://www.a.test/en/logo.png": png(100, 100),
        },
        (u) => asked.push(u),
      ),
    });
    expect(asked).toContain("https://www.a.test/en/logo.png");
    expect(s).toMatchObject({ domain: "a.test", candidates: [{ source: "header" }] });
  });
});

describe("homepageNote (ruling R15)", () => {
  it.each([
    [new LibraryAddError("x answered 500", { kind: "status", status: 500 }), "a.test answered 500"],
    [new LibraryAddError("x answered 302 with no Location", { kind: "status", status: 302 }), "a.test answered 302"],
    [new LibraryAddError("the download timed out after 8s", { kind: "timeout" }), "site timed out"],
    [new LibraryAddError("could not download x: ENOTFOUND", { kind: "unreachable" }), "could not reach a.test"],
    [new LibraryAddError("too many redirects (more than 3)", { kind: "unreachable" }), "could not reach a.test"],
    [new LibraryAddError("only http(s) URLs can be added", { kind: "invalid" }), "could not reach a.test"],
    [new LibraryAddError("the download is over the limit", { kind: "over-cap" }), "could not reach a.test"],
    [new LibraryAddError("timed out, says the message, but no kind"), "could not reach a.test"],
    [new Error("answered 500"), "could not reach a.test"],
    ["a string", "could not reach a.test"],
  ] as const)("%s → %s", (e, note) => {
    expect(homepageNote("a.test", e)).toBe(note);
  });
});
