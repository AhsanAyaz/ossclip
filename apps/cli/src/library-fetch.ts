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
    throw new LibraryAddError(`"${raw}" is not a valid URL`, { kind: "invalid" });
  }
  // `file:` would read the server's own disk through the URL box and `data:`
  // would skip the size cap's streaming path; only the web is a URL here.
  if (!isHttp(u)) throw new LibraryAddError(`only http(s) URLs can be added (got ${u.protocol})`, { kind: "invalid" });
  return u;
}

const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
const overCap = (maxBytes: number): LibraryAddError =>
  new LibraryAddError(`the download is over the limit of ${mb(maxBytes)} MB`, { kind: "over-cap" });

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
 * its 400 body, and whose `kind` (plus `status`) says why without the
 * message, for the logo finder's fixed notes (ruling R15).
 *
 * Two options exist for the logo finder only; the tray uses neither:
 *
 * - `overflow: "truncate"` (ruling R16) stops reading at `maxBytes` and
 *   returns what was read, instead of failing. A homepage's logo is in its
 *   `<head>` and header, so a 3 MB page is still worth its first 2 MB. The
 *   content-length pre-check is skipped too, for the same reason.
 * - `onFinalUrl` (ruling R14) is called with the URL that returned the body,
 *   after every redirect, so a page's relative URLs resolve against where it
 *   actually lives, not where the request started.
 */
export async function fetchLibraryBytes(
  url: string,
  o: {
    fetch?: typeof fetch;
    maxBytes: number;
    timeoutMs: number;
    maxRedirects: number;
    overflow?: "error" | "truncate";
    onFinalUrl?: (u: URL) => void;
  },
): Promise<Uint8Array> {
  const doFetch = o.fetch ?? fetch;
  let current = parseHttpUrl(url);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new LibraryAddError(`the download timed out after ${Math.round(o.timeoutMs / 1000)}s`, { kind: "timeout" }),
      );
    }, o.timeoutMs);
  });

  const run = async (): Promise<Uint8Array> => {
    for (let hop = 0; ; hop++) {
      let res: Response;
      try {
        res = await doFetch(current, { redirect: "manual", signal: controller.signal });
      } catch (e) {
        // Only the timeout aborts while a request is live.
        if (controller.signal.aborted) throw new LibraryAddError("the download was aborted", { kind: "timeout" });
        throw new LibraryAddError(`could not download ${current.host}: ${e instanceof Error ? e.message : String(e)}`, {
          kind: "unreachable",
        });
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (location === null) {
          throw new LibraryAddError(`${current.host} answered ${res.status} with no Location`, {
            kind: "status",
            status: res.status,
          });
        }
        if (hop >= o.maxRedirects) {
          throw new LibraryAddError(`too many redirects (more than ${o.maxRedirects})`, { kind: "unreachable" });
        }
        current = parseHttpUrl(location, current);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new LibraryAddError(`${current.host} answered ${res.status}`, { kind: "status", status: res.status });
      }
      o.onFinalUrl?.(current);
      return readCapped(res, o.maxBytes, o.overflow ?? "error");
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

async function readCapped(res: Response, maxBytes: number, overflow: "error" | "truncate"): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (overflow === "error" && Number.isFinite(declared) && declared > maxBytes) {
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
    if (total + value.byteLength > maxBytes) {
      await reader.cancel();
      if (overflow === "error") throw overCap(maxBytes);
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      break;
    }
    total += value.byteLength;
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
