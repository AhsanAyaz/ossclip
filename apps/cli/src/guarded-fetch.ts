/**
 * A `fetch` that refuses loopback, private and link-local addresses, for the
 * logo finder's downloads (logo-finder spec §Step 2). The domains it fetches
 * were named by an LLM reading a transcript, so a name can resolve anywhere —
 * `localhost`, the router, a cloud metadata endpoint at 169.254.169.254.
 *
 * The check sits INSIDE the connection, in the `lookup` that `node:http`
 * calls to resolve the host it is about to connect to. Checking with a
 * separate `dns.lookup` first and then connecting would resolve twice, and a
 * rebinding DNS server can answer public to the check and private to the
 * connect. The spec asks for an undici dispatcher; undici is not a direct
 * dependency and Node's global `fetch` takes no custom `lookup` without it,
 * so this is built on `node:http`/`node:https` instead (plan ruling "Pinned
 * guard without undici").
 *
 * It implements only the surface `fetchLibraryBytes` uses — GET, no body,
 * `redirect: "manual"`, `signal` — and refuses anything else rather than
 * quietly behaving unlike `fetch`. It follows no redirects: each hop goes
 * back through `fetchLibraryBytes`, which re-enters here, so every hop's
 * address is checked.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions, type LookupOptions } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

/**
 * `dns.lookup`'s `all: true` shape. `family` is optional so a test can
 * answer `{address}` alone; it is derived from the address when absent.
 */
export type LookupFn = (
  hostname: string,
  options: LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: { address: string; family?: number }[]) => void,
) => void;

// logo-finder spec §Step 2's list, verbatim. `BlockList` also matches the
// IPv4-mapped IPv6 spelling (`::ffff:127.0.0.1`, `::ffff:7f00:1`) of every
// IPv4 rule, which is the same host by another name.
const blocked = new BlockList();
blocked.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
blocked.addSubnet("10.0.0.0", 8, "ipv4"); // RFC 1918
blocked.addSubnet("172.16.0.0", 12, "ipv4");
blocked.addSubnet("192.168.0.0", 16, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, incl. cloud metadata
blocked.addSubnet("0.0.0.0", 8, "ipv4"); // "this network"; 0.0.0.0 reaches localhost on Linux/macOS
blocked.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT, also Tailscale's range
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6"); // unique local
blocked.addSubnet("fe80::", 10, "ipv6"); // link-local

/** True only for a well-formed IP outside every blocked range. */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 0) return false;
  return !blocked.check(ip, v === 4 ? "ipv4" : "ipv6");
}

const refusal = (host: string, how: string): Error => new Error(`refused: ${host} ${how} a private address`);

type GuardOptions = {
  lookup?: LookupFn;
  /** Seam for tests that must reach a 127.0.0.1 server; production uses the default. */
  isAllowed?: (ip: string, host: string) => boolean;
  /** Socket idle timeout. Optional: `fetchLibraryBytes` already races its own. */
  timeoutMs?: number;
};

/**
 * The `lookup` option handed to `http.request`. It always resolves every
 * address, so a name with one public and one private answer cannot be
 * steered onto the private one, and only answers with what is left.
 */
function guardedLookup(o: GuardOptions, isAllowed: (ip: string, host: string) => boolean) {
  const resolve: LookupFn = o.lookup ?? (dnsLookup as unknown as LookupFn);
  return (
    hostname: string,
    options: LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "");
      const kept: LookupAddress[] = addresses
        .filter((a) => isAllowed(a.address, hostname))
        .map((a) => ({ address: a.address, family: a.family ?? isIP(a.address) }));
      if (kept.length === 0) return callback(refusal(hostname, "resolves to"), "");
      // Node asks for `all` when it races families (autoSelectFamily); else
      // it wants the single-address callback form.
      if (options.all) return callback(null, kept);
      callback(null, kept[0]!.address, kept[0]!.family);
    });
  };
}

function toHeaders(res: IncomingMessage): Headers {
  const h = new Headers();
  // rawHeaders keeps repeats (`set-cookie`) that `res.headers` folds or drops.
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) h.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
  return h;
}

// `new Response(body, {status})` throws for these when given any body.
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

export function createGuardedFetch(o: GuardOptions = {}): typeof fetch {
  const isAllowed = o.isAllowed ?? ((ip: string) => isPublicAddress(ip));
  const lookup = guardedLookup(o, isAllowed);

  const guarded = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new Error("guarded fetch takes a URL, not a Request");
    }
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`guarded fetch only fetches http(s) URLs (got ${url.protocol})`);
    }
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET") throw new Error(`guarded fetch only sends GET (got ${method})`);
    if (init.body !== undefined && init.body !== null) throw new Error("guarded fetch sends no body");
    // Following a redirect here would connect to the next hop without the
    // caller re-checking its scheme; the caller follows them by hand.
    if (init.redirect !== "manual") throw new Error('guarded fetch needs redirect: "manual"');

    // An IP-literal host never goes through `lookup` — Node connects to it
    // directly — so it is checked here. `URL` keeps IPv6 brackets.
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if (isIP(host) !== 0 && !isAllowed(host, host)) throw refusal(host, "is");

    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();

    const headers: Record<string, string> = Object.fromEntries(new Headers(init.headers).entries());
    // Node's http does not decompress, unlike `fetch`; asking for identity
    // keeps the bytes the caller reads the bytes of the file.
    headers["accept-encoding"] ??= "identity";

    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          headers,
          lookup,
          signal,
          // No pooled socket: a keep-alive socket from the shared agent was
          // connected by whoever opened it, through no guard at all.
          agent: false,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const responseHeaders = toHeaders(res);
          if (NULL_BODY.has(status)) {
            res.resume();
            resolve(new Response(null, { status, statusText: res.statusMessage, headers: responseHeaders }));
            return;
          }
          const body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
          resolve(new Response(body, { status, statusText: res.statusMessage, headers: responseHeaders }));
        },
      );
      req.on("error", reject);
      if (o.timeoutMs !== undefined) {
        const ms = o.timeoutMs;
        req.setTimeout(ms, () => req.destroy(new Error(`timed out after ${ms} ms`)));
      }
      req.end();
    });
  };
  return guarded as typeof fetch;
}
