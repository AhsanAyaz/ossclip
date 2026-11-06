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

// logo-finder spec §Step 2's list, plus ruling R12's additions (multicast,
// reserved, benchmarking, IETF protocol assignments). An IPv6 spelling that
// embeds an IPv4 is unwrapped and checked against this list below, so it is
// the one place an IPv4 range is named.
const blocked4 = new BlockList();
blocked4.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
blocked4.addSubnet("10.0.0.0", 8, "ipv4"); // RFC 1918
blocked4.addSubnet("172.16.0.0", 12, "ipv4");
blocked4.addSubnet("192.168.0.0", 16, "ipv4");
blocked4.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, incl. cloud metadata
blocked4.addSubnet("0.0.0.0", 8, "ipv4"); // "this network"; 0.0.0.0 reaches localhost on Linux/macOS
blocked4.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT, also Tailscale's range
blocked4.addSubnet("224.0.0.0", 4, "ipv4"); // multicast (R12)
blocked4.addSubnet("240.0.0.0", 4, "ipv4"); // reserved, incl. 255.255.255.255 broadcast (R12)
blocked4.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking (R12)
blocked4.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments (R12)

const blocked6 = new BlockList();
blocked6.addSubnet("fc00::", 7, "ipv6"); // unique local
blocked6.addSubnet("fe80::", 10, "ipv6"); // link-local
blocked6.addSubnet("ff00::", 8, "ipv6"); // multicast (R12)

/** The eight 16-bit groups of a valid IPv6 address (zone id already stripped). */
function hextets(ip: string): number[] {
  let s = ip;
  const tail: number[] = [];
  // A trailing dotted quad (`::ffff:127.0.0.1`) is the last two groups.
  const quad = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (quad) {
    const [a, b, c, d] = quad.slice(2).map(Number) as [number, number, number, number];
    tail.push((a << 8) | b, (c << 8) | d);
    s = quad[1]!.endsWith("::") ? quad[1]! : quad[1]!.slice(0, -1);
  }
  const groups = (part: string): number[] => (part === "" ? [] : part.split(":").map((g) => parseInt(g, 16)));
  const [head, rest] = s.split("::") as [string, string | undefined];
  const left = groups(head);
  const right = [...(rest === undefined ? [] : groups(rest)), ...tail];
  if (rest === undefined) return [...left, ...right];
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

const v4of = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
const zero = (h: number[], from: number, to: number): boolean => h.slice(from, to).every((g) => g === 0);

/**
 * The IPv4 an IPv6 address stands for, when it is one of the spellings that
 * reach an IPv4 host (R12): IPv4-compatible `::/96`, IPv4-mapped
 * `::ffff:0:0/96`, SIIT-translated `::ffff:0:0:0/96`, 6to4 `2002::/16`
 * (bits 16–48). Without this, `::ffff:7f00:1` or `2002:7f00:1::` would be a
 * second name for 127.0.0.1 that no IPv4 rule sees.
 */
function embeddedV4(h: number[]): string | undefined {
  if (zero(h, 0, 6)) return v4of(h[6]!, h[7]!);
  if (zero(h, 0, 5) && h[5] === 0xffff) return v4of(h[6]!, h[7]!);
  if (zero(h, 0, 4) && h[4] === 0xffff && h[5] === 0) return v4of(h[6]!, h[7]!);
  if (h[0] === 0x2002) return v4of(h[1]!, h[2]!);
  return undefined;
}

/**
 * NAT64 `64:ff9b::/96` and the local-use `64:ff9b:1::/48` are refused
 * whatever IPv4 they embed (R12). On a NAT64 network such an address is a
 * hop through the gateway, a box on the local network, so even a public
 * embedded IPv4 is reached by way of local infrastructure.
 */
const isNat64 = (h: number[]): boolean =>
  h[0] === 0x64 && h[1] === 0xff9b && (h[2] === 1 || zero(h, 2, 6));

/** True only for a well-formed IP outside every blocked range. */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 0) return false;
  if (v === 4) return !blocked4.check(ip, "ipv4");
  const h = hextets(ip.replace(/%.*$/, ""));
  if (isNat64(h)) return false;
  const v4 = embeddedV4(h);
  // `::` and `::1` land here as IPv4-compatible 0.0.0.0 and 0.0.0.1, both in 0/8.
  if (v4 !== undefined) return !blocked4.check(v4, "ipv4");
  return !blocked6.check(ip.replace(/%.*$/, ""), "ipv6");
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

// `new Response(body, {status})` throws for these when given any body. 1xx
// is not here: it is refused with every status outside 200-599.
const NULL_BODY = new Set([204, 205, 304]);

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
          // A throw in this callback is outside the promise: it would crash
          // the process and leave the caller waiting forever.
          try {
            const status = res.statusCode ?? 0;
            // Node's parser accepts any three digits; `Response` throws a
            // RangeError outside 200-599.
            if (status < 200 || status > 599) throw new Error(`${url.host} answered an invalid status ${status}`);
            const responseHeaders = toHeaders(res);
            const init = { status, statusText: res.statusMessage, headers: responseHeaders };
            if (NULL_BODY.has(status)) {
              res.resume();
              resolve(new Response(null, init));
              return;
            }
            resolve(new Response(Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>, init));
          } catch (err) {
            res.destroy();
            reject(err);
          }
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
