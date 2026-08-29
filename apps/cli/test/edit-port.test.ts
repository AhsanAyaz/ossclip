import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditServer, type EditServer } from "../src/edit";
import { EditHealthSchema } from "../src/edit-health";
import {
  PORT_BUMP_ATTEMPTS,
  isAddrInUse,
  openEditServer,
  portsExhaustedMessage,
  probeEditHealth,
  resolvePortConflict,
  type EditPortDeps,
} from "../src/edit-port";

const health = (o: { workdir: string | null; pid?: number }) =>
  EditHealthSchema.parse({ app: "ossclip", workdir: o.workdir, pid: o.pid ?? 4242 });

describe("resolvePortConflict", () => {
  it("attaches when our own editor is already serving this project", () => {
    const d = resolvePortConflict({
      health: health({ workdir: "/tmp/proj" }),
      port: 5174,
      workdir: "/tmp/proj",
      interactive: true,
      pinned: false,
    });
    expect(d.kind).toBe("attach");
    expect(d).toMatchObject({ url: "http://127.0.0.1:5174" });
    expect(d.message).toBe("▸ already open at http://127.0.0.1:5174");
  });

  it("attaches through a non-normalized spelling of the same directory", () => {
    // A typed `ossclip edit /tmp/proj/../proj` is the same project as the one
    // the running server reported; two spellings must not read as two projects.
    const d = resolvePortConflict({
      health: health({ workdir: "/tmp/proj" }),
      port: 5174,
      workdir: "/tmp/proj/../proj",
      interactive: false,
      pinned: false,
    });
    expect(d.kind).toBe("attach");
  });

  it("attaches when both sides are the project picker", () => {
    const d = resolvePortConflict({
      health: health({ workdir: null }),
      port: 5174,
      workdir: null,
      interactive: false,
      pinned: false,
    });
    expect(d.kind).toBe("attach");
  });

  it("asks at a TTY when our editor is serving a DIFFERENT project", () => {
    const d = resolvePortConflict({
      health: health({ workdir: "/tmp/other-take", pid: 991 }),
      port: 5174,
      workdir: "/tmp/proj",
      interactive: true,
      pinned: false,
    });
    expect(d.kind).toBe("ask");
    expect(d).toMatchObject({ holder: { pid: 991, workdir: "/tmp/other-take" } });
    // The BASENAME, which is what a user recognises, plus the pid they would
    // be stopping.
    expect(d.message).toContain('"other-take"');
    expect(d.message).toContain("991");
  });

  it("names the picker rather than an empty pair of quotes", () => {
    const d = resolvePortConflict({
      health: health({ workdir: null }),
      port: 5174,
      workdir: "/tmp/proj",
      interactive: true,
      pinned: false,
    });
    expect(d.kind).toBe("ask");
    expect(d.message).toContain("no project");
  });

  it("bumps without asking when there is no TTY to answer", () => {
    const d = resolvePortConflict({
      health: health({ workdir: "/tmp/other-take", pid: 7 }),
      port: 5174,
      workdir: "/tmp/proj",
      interactive: false,
      pinned: false,
    });
    expect(d.kind).toBe("bump");
    // Naming who holds it is the whole point of the line — a port that
    // silently moved with no explanation is the confusing half of the bug.
    expect(d.message).toContain('"other-take"');
    expect(d.message).toContain("pid 7");
  });

  it("bumps around a process that did not identify as ossclip", () => {
    const d = resolvePortConflict({
      health: null,
      port: 5174,
      workdir: "/tmp/proj",
      interactive: true,
      pinned: false,
    });
    // Never a prompt and never a kill: a stranger is not ours to stop, even
    // at a TTY where we could ask.
    expect(d.kind).toBe("bump");
    expect(d.message).toContain("another program");
  });

  it("refuses instead of moving when the user PINNED the port and a stranger holds it", () => {
    const d = resolvePortConflict({
      health: null,
      port: 8080,
      workdir: "/tmp/proj",
      interactive: true,
      pinned: true,
    });
    expect(d.kind).toBe("refuse");
    expect(d.message).toContain("8080");
    expect(d.message).toContain("--port");
  });

  it("refuses a pinned port held by another project when nobody can be asked", () => {
    const d = resolvePortConflict({
      health: health({ workdir: "/tmp/other-take", pid: 3 }),
      port: 8080,
      workdir: "/tmp/proj",
      interactive: false,
      pinned: true,
    });
    expect(d.kind).toBe("refuse");
  });

  it("still attaches and still asks when the port was pinned", () => {
    // Pinning only forbids the SILENT bump; the right answers stay right.
    expect(
      resolvePortConflict({
        health: health({ workdir: "/tmp/proj" }),
        port: 8080,
        workdir: "/tmp/proj",
        interactive: false,
        pinned: true,
      }).kind,
    ).toBe("attach");
    expect(
      resolvePortConflict({
        health: health({ workdir: "/tmp/other" }),
        port: 8080,
        workdir: "/tmp/proj",
        interactive: true,
        pinned: true,
      }).kind,
    ).toBe("ask");
  });
});

describe("port helpers", () => {
  it("names the whole exhausted range", () => {
    expect(portsExhaustedMessage(5175, 20)).toContain("5175-5194");
  });

  it("recognises only EADDRINUSE as a port conflict", () => {
    expect(isAddrInUse(Object.assign(new Error("x"), { code: "EADDRINUSE" }))).toBe(true);
    expect(isAddrInUse(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(false);
    expect(isAddrInUse(new Error("x"))).toBe(false);
    expect(isAddrInUse(null)).toBe(false);
  });
});

/** A start seam over a set of "taken" ports, plus the deps that never fire in
 * the case under test spelled as throws — a test that silently prompted or
 * killed would otherwise pass. */
function fakeDeps(
  taken: Set<number>,
  over: Partial<EditPortDeps> = {},
): EditPortDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    start: async (port: number) => {
      if (taken.has(port)) throw Object.assign(new Error("in use"), { code: "EADDRINUSE" });
      return { url: `http://127.0.0.1:${port}`, close: () => {} };
    },
    health: async () => null,
    interactive: false,
    ask: () => {
      throw new Error("must not prompt");
    },
    kill: () => {
      throw new Error("must not kill");
    },
    log: (l) => logs.push(l),
    wait: async () => {},
    ...over,
  };
}

describe("openEditServer", () => {
  it("starts on the requested port without probing anything", async () => {
    const deps = fakeDeps(new Set(), {
      health: async () => {
        throw new Error("must not probe a port that was free");
      },
    });
    const r = await openEditServer("/tmp/proj", { port: 5174, pinned: false }, deps);
    expect(r).toMatchObject({ kind: "started", server: { url: "http://127.0.0.1:5174" } });
  });

  it("lets a non-EADDRINUSE bind failure through untouched", async () => {
    // EACCES on a privileged port is the user's real error; bumping to 81 and
    // pretending it worked would hide it.
    const deps = fakeDeps(new Set(), {
      start: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });
    await expect(
      openEditServer("/tmp/proj", { port: 80, pinned: false }, deps),
    ).rejects.toThrow("permission denied");
  });

  it("bumps past a run of taken ports", async () => {
    const deps = fakeDeps(new Set([5174, 5175, 5176]));
    const r = await openEditServer("/tmp/proj", { port: 5174, pinned: false }, deps);
    expect(r).toMatchObject({ kind: "started", server: { url: "http://127.0.0.1:5177" } });
    expect(deps.logs[0]).toContain("another program");
  });

  it("gives up with a readable message when the whole range is taken", async () => {
    const taken = new Set<number>();
    for (let p = 5174; p < 5174 + PORT_BUMP_ATTEMPTS + 1; p++) taken.add(p);
    await expect(
      openEditServer("/tmp/proj", { port: 5174, pinned: false }, fakeDeps(taken)),
    ).rejects.toThrow(portsExhaustedMessage(5175, PORT_BUMP_ATTEMPTS));
  });

  it("stops the other project's server and takes the port back", async () => {
    const taken = new Set([5174]);
    const killed: number[] = [];
    const deps = fakeDeps(taken, {
      health: async () => health({ workdir: "/tmp/other", pid: 555 }),
      interactive: true,
      ask: async () => "stop",
      kill: (pid) => {
        killed.push(pid);
        taken.delete(5174);
      },
    });
    const r = await openEditServer("/tmp/proj", { port: 5174, pinned: false }, deps);
    expect(killed).toEqual([555]);
    expect(r).toMatchObject({ kind: "started", server: { url: "http://127.0.0.1:5174" } });
  });

  it("falls through to the next free port when the stopped server will not die", async () => {
    const deps = fakeDeps(new Set([5174]), {
      health: async () => health({ workdir: "/tmp/other", pid: 555 }),
      interactive: true,
      ask: async () => "stop",
      kill: () => {},
    });
    const r = await openEditServer("/tmp/proj", { port: 5174, pinned: false }, deps);
    expect(r).toMatchObject({ kind: "started", server: { url: "http://127.0.0.1:5175" } });
    expect(deps.logs.at(-1)).toContain("still busy");
  });

  it("changes nothing when the user cancels the prompt", async () => {
    const deps = fakeDeps(new Set([5174]), {
      health: async () => health({ workdir: "/tmp/other", pid: 555 }),
      interactive: true,
      ask: async () => "cancel",
    });
    expect(await openEditServer("/tmp/proj", { port: 5174, pinned: false }, deps)).toEqual({
      kind: "cancelled",
    });
  });
});

// ---- Against real sockets ------------------------------------------------
// The pure matrix above cannot catch a health route that never answers or a
// listen that crashes instead of rejecting — which is the entire bug. These
// run two real servers on real ephemeral ports.

const SHARED_RECENTS = join(tmpdir(), "ossclip-test-recents");
let servers: EditServer[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

async function fixtureWorkdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ossclip-editport-"));
  await writeFile(
    join(dir, "render-props.json"),
    JSON.stringify({ videoFileName: "clip.mp4", sceneCues: [], captionLines: [], spans: [] }),
  );
  return dir;
}

/** The live seams minus the two that need a human or a signal. */
function realDeps(dir: string, over: Partial<EditPortDeps> = {}): EditPortDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    start: async (port: number) => {
      const s = await startEditServer(dir, { port, recentDir: SHARED_RECENTS });
      servers.push(s);
      return s;
    },
    health: (port) => probeEditHealth(port),
    interactive: false,
    ask: () => {
      throw new Error("must not prompt");
    },
    kill: () => {
      throw new Error("must not kill");
    },
    log: (l) => logs.push(l),
    wait: async () => {},
    ...over,
  };
}

const portOf = (url: string): number => Number(new URL(url).port);

describe("edit server port conflicts, end to end", () => {
  it("rejects rather than crashing the process when the port is taken", async () => {
    const dir = await fixtureWorkdir();
    const first = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    servers.push(first);
    await expect(
      startEditServer(dir, { port: portOf(first.url), recentDir: SHARED_RECENTS }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("attaches to the editor already serving this workdir", async () => {
    const dir = await fixtureWorkdir();
    const first = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    servers.push(first);
    const port = portOf(first.url);
    const deps = realDeps(dir);
    const r = await openEditServer(dir, { port, pinned: false }, deps);
    expect(r).toEqual({ kind: "attached", url: `http://127.0.0.1:${port}` });
    expect(deps.logs[0]).toBe(`▸ already open at http://127.0.0.1:${port}`);
  });

  it("bumps to a free port when the running editor holds another project", async () => {
    const held = await fixtureWorkdir();
    const wanted = await fixtureWorkdir();
    const first = await startEditServer(held, { port: 0, recentDir: SHARED_RECENTS });
    servers.push(first);
    const port = portOf(first.url);
    const deps = realDeps(wanted);
    const r = await openEditServer(wanted, { port, pinned: false }, deps);
    expect(r.kind).toBe("started");
    if (r.kind !== "started") throw new Error("unreachable");
    expect(portOf(r.server.url)).not.toBe(port);
    expect(deps.logs[0]).toContain("using the next free port");
  });
});
