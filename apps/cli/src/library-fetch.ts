/**
 * The one network read the overlay library ever makes (overlay-library spec
 * §Server endpoints, `POST /api/library` `{url}`): a pasted URL is fetched
 * ONCE, on add, into the library — never at render time (spec anti-goals).
 *
 * Its own module so the caps are testable without a server or a network:
 * `fetch` is injectable (the edit server's `publishFetch` seam pattern).
 *
 * What it does NOT do is decide whether the bytes are an image. The
 * `content-type` header is whatever the remote said — an HTML error page
 * answers `200 text/html` as happily as a CDN answers `image/png` for one —
 * so the bytes go to `addLibraryEntry`, which sniffs them (plan review focus
 * 4, "URL that redirects to HTML").
 */
import { LibraryAddError } from "@ossclip/core";

const isHttp = (u: URL): boolean => u.protocol === "http:" || u.protocol === "https:";

function parseHttpUrl(raw: string, base?: URL): URL {
  let u: URL;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new LibraryAddError(`"${raw}" is not a valid URL`);
  }
  // `file:` would read the server's own disk through the URL box and `data:`
  // would skip the size cap's streaming path; only the web is a URL here.
  if (!isHttp(u)) throw new LibraryAddError(`only http(s) URLs can be added (got ${u.protocol})`);
  return u;
}

const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
const overCap = (maxBytes: number): LibraryAddError =>
  new LibraryAddError(`the download is over the limit of ${mb(maxBytes)} MB`);

/**
 * GET `url` and return its body, enforcing every cap the spec names:
 *
 * - **http(s) only, on EVERY hop.** Redirects are followed by hand
 *   (`redirect: "manual"`) precisely so each `Location` is re-checked: an
 *   https URL that 302s to `file:` must not be followed by a fetch that
 *   would have re-checked nothing.
 * - **At most `maxRedirects` redirects.** The `maxRedirects + 1`-th is an error.
 * - **`maxBytes` while streaming**, not only from `content-length`: the
 *   header is optional and can lie, and the whole body is held in memory.
 * - **One `timeoutMs` for the whole exchange**, body included. It is a race,
 *   not only an abort signal, so a `fetch` that ignores its signal still
 *   cannot hang the request handler.
 *
 * Every failure is a `LibraryAddError` whose message the server returns as
 * its 400 body.
 */
export async function fetchLibraryBytes(
  url: string,
  o: { fetch?: typeof fetch; maxBytes: number; timeoutMs: number; maxRedirects: number },
): Promise<Uint8Array> {
  const doFetch = o.fetch ?? fetch;
  let current = parseHttpUrl(url);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LibraryAddError(`the download timed out after ${Math.round(o.timeoutMs / 1000)}s`));
    }, o.timeoutMs);
  });

  const run = async (): Promise<Uint8Array> => {
    for (let hop = 0; ; hop++) {
      let res: Response;
      try {
        res = await doFetch(current, { redirect: "manual", signal: controller.signal });
      } catch (e) {
        if (controller.signal.aborted) throw new LibraryAddError("the download was aborted");
        throw new LibraryAddError(`could not download ${current.host}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (location === null) throw new LibraryAddError(`${current.host} answered ${res.status} with no Location`);
        if (hop >= o.maxRedirects) throw new LibraryAddError(`too many redirects (more than ${o.maxRedirects})`);
        current = parseHttpUrl(location, current);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new LibraryAddError(`${current.host} answered ${res.status}`);
      }
      return readCapped(res, o.maxBytes);
    }
  };

  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
    // Cancels a still-streaming body after a timeout won the race.
    controller.abort();
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw overCap(maxBytes);
  }
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw overCap(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
