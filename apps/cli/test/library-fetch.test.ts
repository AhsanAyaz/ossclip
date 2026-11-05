import { describe, expect, it } from "vitest";
import { LibraryAddError } from "@ossclip/core";
import { fetchLibraryBytes } from "../src/library-fetch";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const CAPS = { maxBytes: 1024, timeoutMs: 15000, maxRedirects: 5 };

const redirect = (to: string): Response => new Response(null, { status: 302, headers: { location: to } });

describe("fetchLibraryBytes", () => {
  it("rejects non-http(s) schemes without fetching", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response(PNG);
    }) as typeof globalThis.fetch;
    for (const url of ["file:///etc/passwd", "data:image/png;base64,iVBORw0KGgo=", "ftp://x/y.png", "not a url"]) {
      await expect(fetchLibraryBytes(url, { ...CAPS, fetch })).rejects.toBeInstanceOf(LibraryAddError);
    }
    expect(calls).toBe(0);
  });

  it("returns the body of a plain 200", async () => {
    const fetch = (async () => new Response(PNG)) as typeof globalThis.fetch;
    expect(await fetchLibraryBytes("https://example.com/a.png", { ...CAPS, fetch })).toEqual(PNG);
  });

  it("follows ≤5 redirects, rejects the 6th", async () => {
    const hops = (n: number): typeof globalThis.fetch =>
      (async (input: RequestInfo | URL) => {
        const at = Number(new URL(String(input)).searchParams.get("hop") ?? "0");
        return at < n ? redirect(`/next?hop=${at + 1}`) : new Response(PNG);
      }) as typeof globalThis.fetch;
    expect(await fetchLibraryBytes("https://example.com/start", { ...CAPS, fetch: hops(5) })).toEqual(PNG);
    await expect(
      fetchLibraryBytes("https://example.com/start", { ...CAPS, fetch: hops(6) }),
    ).rejects.toThrow(/redirect/);
  });

  it("re-checks the scheme on every redirect hop", async () => {
    const fetch = (async () => redirect("file:///etc/passwd")) as typeof globalThis.fetch;
    await expect(fetchLibraryBytes("https://example.com/a.png", { ...CAPS, fetch })).rejects.toThrow(/http/);
  });

  it("rejects a non-2xx answer with its status", async () => {
    const fetch = (async () => new Response("nope", { status: 404 })) as typeof globalThis.fetch;
    await expect(fetchLibraryBytes("https://example.com/a.png", { ...CAPS, fetch })).rejects.toThrow(/404/);
  });

  it("aborts over maxBytes while streaming", async () => {
    let pulled = 0;
    let cancelled = false;
    // No content-length: the cap must hold on the stream itself, not on a
    // header a server can omit or lie in.
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(400));
        if (pulled > 100) c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetch = (async () => new Response(body)) as typeof globalThis.fetch;
    await expect(fetchLibraryBytes("https://example.com/big.gif", { ...CAPS, fetch })).rejects.toThrow(/limit/);
    expect(pulled).toBeLessThan(10);
    expect(cancelled).toBe(true);
  });

  it("rejects up front when content-length is over the cap", async () => {
    const fetch = (async () =>
      new Response(PNG, { headers: { "content-length": "999999" } })) as typeof globalThis.fetch;
    await expect(fetchLibraryBytes("https://example.com/a.png", { ...CAPS, fetch })).rejects.toThrow(/limit/);
  });

  it("timeout → LibraryAddError", async () => {
    // A fetch that never settles and ignores its signal: the timeout must
    // still win, not hang the request handler.
    const fetch = (() => new Promise<Response>(() => {})) as typeof globalThis.fetch;
    const err = await fetchLibraryBytes("https://example.com/slow.png", { ...CAPS, timeoutMs: 20, fetch }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LibraryAddError);
    expect(String(err)).toMatch(/timed out/);
  });

  it("a network failure is a LibraryAddError, not a raw TypeError", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    await expect(fetchLibraryBytes("https://example.com/a.png", { ...CAPS, fetch })).rejects.toBeInstanceOf(
      LibraryAddError,
    );
  });
});
