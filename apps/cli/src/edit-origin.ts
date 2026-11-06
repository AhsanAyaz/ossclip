/**
 * Which requests the `ossclip edit` server answers at all.
 *
 * The server listens on 127.0.0.1 only, but that alone does not keep other
 * websites out:
 *
 * - **DNS rebinding.** A page on `evil.example` re-points its own hostname at
 *   127.0.0.1 and calls this server. To the browser that is same-origin, so
 *   no CORS rule applies, and the page can read workdirs and render props or
 *   drive the library-add routes (R14's URL fetch and local-path copy). Its
 *   requests still carry `Host: evil.example:<port>`, which is what the first
 *   check refuses.
 * - **Cross-site requests.** Any page can send a "simple" request to
 *   127.0.0.1:<port> without a preflight. R14 closed that only for the three
 *   library routes, by demanding `application/json`. An `Origin` header that
 *   is not loopback is refused here for every route.
 *
 * Loopback names on ANY port are trusted, because the dev editor (vite on
 * 5173, or the e2e port) proxies to this server and its requests carry its own
 * port. A rebinding page cannot get a loopback name into `Host`, since that
 * name comes from the URL it was loaded from.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The hostname of a `Host` header value or an origin URL, lower-cased; null if it does not parse. */
function hostnameOf(value: string, asOrigin: boolean): string | null {
  try {
    return new URL(asOrigin ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export type EditRequestVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Pure: headers in, verdict out, so the matrix is tested without a server.
 * A missing `Host` is refused (HTTP/1.1 requires it, and every real client
 * sends one). A missing `Origin` is allowed: same-origin GETs, the second
 * `ossclip edit` probing `/api/health`, and curl send none.
 */
export function checkEditRequest(headers: { host?: string; origin?: string }): EditRequestVerdict {
  const host = headers.host === undefined ? null : hostnameOf(headers.host, false);
  if (host === null || !LOOPBACK_HOSTNAMES.has(host)) {
    return { ok: false, reason: `refused: Host "${headers.host ?? ""}" is not this machine (DNS rebinding guard)` };
  }
  if (headers.origin !== undefined) {
    // "null" (a sandboxed iframe, a file:// page) parses to no hostname we accept.
    const origin = hostnameOf(headers.origin, true);
    if (origin === null || !LOOPBACK_HOSTNAMES.has(origin)) {
      return { ok: false, reason: `refused: request from another site (Origin "${headers.origin}")` };
    }
  }
  return { ok: true };
}
