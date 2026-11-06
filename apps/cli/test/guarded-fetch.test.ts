import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LibraryAddError } from "@ossclip/core";
import { createGuardedFetch, isPublicAddress, type LookupFn } from "../src/guarded-fetch";
import { fetchLibraryBytes } from "../src/library-fetch";

describe("isPublicAddress", () => {
  // One row per range the logo-finder spec §Step 2 names, plus its
  // IPv4-mapped IPv6 spelling: the mapped form connects to the same host.
  const privateRows = [
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "0.1.2.3",
    "100.64.0.1",
    "100.127.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "febf::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.5",
    "::ffff:172.16.0.1",
    "::ffff:192.168.1.1",
    "::ffff:169.254.169.254",
    "::ffff:0.0.0.0",
    "::ffff:100.64.0.1",
    // R12: multicast, reserved/broadcast, benchmarking, IETF assignments.
    "224.0.0.1",
    "239.255.255.250",
    "ff02::1",
    "ff0e::1",
    "240.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "198.19.255.255",
    "192.0.0.1",
    "::ffff:255.255.255.255",
    // R12: IPv6 spellings that embed a private IPv4.
    "::127.0.0.1", // IPv4-compatible ::/96
    "::7f00:1",
    "::a00:5",
    "::ffff:0:127.0.0.1", // SIIT-translated ::ffff:0:0:0/96
    "::ffff:0:a00:5",
    "2002:7f00:1::", // 6to4 of 127.0.0.1
    "2002:a00:5::1", // 6to4 of 10.0.0.5
    "2002:a9fe:a9fe::", // 6to4 of 169.254.169.254
    // R12: NAT64 is refused whatever it embeds, public included.
    "64:ff9b::7f00:1",
    "64:ff9b::127.0.0.1",
    "64:ff9b::808:808",
    "64:ff9b:1::1",
    "64:ff9b:1:ffff::8.8.8.8",
    "fe80::1%lo0",
  ];
  for (const ip of privateRows) {
    it(`${ip} is not public`, () => expect(isPublicAddress(ip)).toBe(false));
  }

  const publicRows = [
    "8.8.8.8",
    "2606:4700::1",
    "172.32.0.1",
    "100.128.0.1",
    "198.20.0.1",
    "192.0.1.1",
    "223.255.255.255",
    "::ffff:8.8.8.8",
    "::8.8.8.8",
    "::ffff:0:8.8.8.8",
    "2002:808:808::1", // 6to4 of 8.8.8.8
    "64:ff9c::1", // just outside NAT64
    "64:ff9b:2::1", // outside both NAT64 prefixes
    "2001:4860:4860::8888",
  ];
  for (const ip of publicRows) {
    it(`${ip} is public`, () => expect(isPublicAddress(ip)).toBe(true));
  }

  it("a string that is not an IP is not public", () => {
    expect(isPublicAddress("example.com")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });
});

describe("createGuardedFetch", () => {
  let server: Server | undefined;
  let raw: NetServer | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await new Promise<void>((r) => (raw ? raw.close(() => r()) : r()));
    server = undefined;
    raw = undefined;
  });

  const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> => {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  };

  const lookupTo =
    (addresses: { address: string; family?: number }[]): LookupFn =>
    (_host, _opts, cb) =>
      cb(null, addresses);

  const allowAll = (): boolean => true;

  it("refuses a name that resolves to 127.0.0.1 without reaching the server", async () => {
    let hits = 0;
    const port = await listen((_req, res) => {
      hits++;
      res.end("hi");
    });
    const f = createGuardedFetch({ lookup: lookupTo([{ address: "127.0.0.1", family: 4 }]) });
    await expect(f(`http://public.test:${port}/`, { redirect: "manual" })).rejects.toThrow(
      "refused: public.test resolves to a private address",
    );
    expect(hits).toBe(0);
  });

  it("refuses when every resolved address is private", async () => {
    let hits = 0;
    const port = await listen((_req, res) => {
      hits++;
      res.end("hi");
    });
    const f = createGuardedFetch({ lookup: lookupTo([{ address: "10.0.0.5" }, { address: "127.0.0.1" }]) });
    await expect(f(`http://public.test:${port}/`, { redirect: "manual" })).rejects.toThrow(/private address/);
    expect(hits).toBe(0);
  });

  it("refuses a private IP-literal host before connecting", async () => {
    let hits = 0;
    const port = await listen((_req, res) => {
      hits++;
      res.end("hi");
    });
    const f = createGuardedFetch();
    await expect(f(`http://127.0.0.1:${port}/`, { redirect: "manual" })).rejects.toThrow(/private address/);
    await expect(f(`http://[::1]:${port}/`, { redirect: "manual" })).rejects.toThrow(/private address/);
    // `URL` normalizes these to 127.0.0.1 and ::ffff:7f00:1; both must still be caught.
    await expect(f(`http://2130706433:${port}/`, { redirect: "manual" })).rejects.toThrow(/private address/);
    await expect(f(`http://[::ffff:7f00:1]:${port}/`, { redirect: "manual" })).rejects.toThrow(/private address/);
    expect(hits).toBe(0);
  });

  it("redirect to a private address ends in the refusal, and /x is never called", async () => {
    let xHits = 0;
    const port = await listen((req, res) => {
      if (req.url === "/x") {
        xHits++;
        res.end("secret");
        return;
      }
      res.writeHead(302, { location: `http://127.0.0.1:${port}/x` }).end();
    });
    const lookup = lookupTo([{ address: "127.0.0.1", family: 4 }]);
    const isAllowed = (ip: string, host: string): boolean => ip === "127.0.0.1" && host === "first.test";
    const err = await fetchLibraryBytes(`http://first.test:${port}/`, {
      fetch: createGuardedFetch({ lookup, isAllowed }),
      maxBytes: 1024,
      timeoutMs: 5000,
      maxRedirects: 3,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LibraryAddError);
    expect(String(err)).toMatch(/private address/);
    expect(xHits).toBe(0);
  });

  it("returns an allowed 200 body and its headers", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "x-two": ["a", "b"] }).end("png-bytes");
    });
    const f = createGuardedFetch({ lookup: lookupTo([{ address: "127.0.0.1", family: 4 }]), isAllowed: allowAll });
    const res = await f(new URL(`http://ok.test:${port}/a.png`), { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-two")).toBe("a, b");
    expect(await res.text()).toBe("png-bytes");
  });

  it("works through fetchLibraryBytes when the address is allowed", async () => {
    const port = await listen((_req, res) => res.end("abc"));
    const f = createGuardedFetch({ lookup: lookupTo([{ address: "127.0.0.1" }]), isAllowed: allowAll });
    const bytes = await fetchLibraryBytes(`http://ok.test:${port}/`, {
      fetch: f,
      maxBytes: 1024,
      timeoutMs: 5000,
      maxRedirects: 3,
    });
    expect(new TextDecoder().decode(bytes)).toBe("abc");
  });

  it("returns a 3xx as-is under redirect: manual", async () => {
    const port = await listen((_req, res) => res.writeHead(302, { location: "/elsewhere" }).end());
    const f = createGuardedFetch({ lookup: lookupTo([{ address: "127.0.0.1" }]), isAllowed: allowAll });
    const res = await f(`http://ok.test:${port}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/elsewhere");
  });

  it("returns a null-body status without a body", async () => {
    const port = await listen((_req, res) => res.writeHead(204).end());
    const f = createGuardedFetch({ lookup: lookupTo([{ address: "127.0.0.1" }]), isAllowed: allowAll });
    const res = await f(`http://ok.test:${port}/`, { redirect: "manual" });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it("refuses to follow redirects itself", async () => {
    const f = createGuardedFetch({ lookup: lookupTo([{ address: "127.0.0.1" }]), isAllowed: allowAll });
    await expect(f("http://ok.test/")).rejects.toThrow(/redirect/);
    await expect(f("http://ok.test/", { redirect: "follow" })).rejects.toThrow(/redirect/);
  });

  it("refuses a non-GET method or a body", async () => {
    let hits = 0;
    const port = await listen((_req, res) => {
      hits++;
      res.end();
    });
    const f = createGuardedFetch({ lookup: lookupTo([{ address: "127.0.0.1" }]), isAllowed: allowAll });
    const url = `http://ok.test:${port}/`;
    await expect(f(url, { redirect: "manual", method: "POST" })).rejects.toThrow(/GET/);
    await expect(f(url, { redirect: "manual", body: "x" })).rejects.toThrow(/body/);
    expect(hits).toBe(0);
  });

  it("refuses non-http(s) schemes", async () => {
    const f = createGuardedFetch({ isAllowed: allowAll });
    for (const url of ["file:///etc/passwd", "data:text/plain,hi", "ftp://x/y"]) {
      await expect(f(url, { redirect: "manual" })).rejects.toThrow(/http/);
    }
  });

  it("an already-aborted signal never reaches the server", async () => {
    let hits = 0;
    const port = await listen((_req, res) => {
      hits++;
      res.end();
    });
    const f = createGuardedFetch({ lookup: lookupTo([{ address: "127.0.0.1" }]), isAllowed: allowAll });
    await expect(
      f(`http://ok.test:${port}/`, { redirect: "manual", signal: AbortSignal.abort() }),
    ).rejects.toThrow(/abort/i);
    expect(hits).toBe(0);
  });

  it("aborting mid-request destroys it", async () => {
    let closed: () => void = () => {};
    const serverSawClose = new Promise<void>((r) => (closed = r));
    const ac = new AbortController();
    const port = await listen((req) => {
      // Never answer: only the abort can end this exchange.
      req.socket.on("close", () => closed());
      ac.abort();
    });
    const f = createGuardedFetch({ lookup: lookupTo([{ address: "127.0.0.1" }]), isAllowed: allowAll });
    await expect(f(`http://ok.test:${port}/`, { redirect: "manual", signal: ac.signal })).rejects.toThrow(/abort/i);
    await serverSawClose;
  });

  it("a status outside 200-599 rejects instead of crashing the process", async () => {
    // `node:http` would refuse to write status 600, so the answer is raw bytes.
    raw = createNetServer((sock) => {
      sock.once("data", () => sock.end("HTTP/1.1 600 X\r\ncontent-length: 0\r\n\r\n"));
    });
    await new Promise<void>((r) => raw!.listen(0, "127.0.0.1", r));
    const port = (raw.address() as AddressInfo).port;
    const f = createGuardedFetch({ lookup: lookupTo([{ address: "127.0.0.1" }]), isAllowed: allowAll });
    await expect(f(`http://ok.test:${port}/`, { redirect: "manual" })).rejects.toThrow(
      `ok.test:${port} answered an invalid status 600`,
    );
  });

  it("timeoutMs destroys a request that never answers", async () => {
    const port = await listen(() => {});
    const f = createGuardedFetch({
      lookup: lookupTo([{ address: "127.0.0.1" }]),
      isAllowed: allowAll,
      timeoutMs: 50,
    });
    await expect(f(`http://ok.test:${port}/`, { redirect: "manual" })).rejects.toThrow(/timed out/);
  });
});
