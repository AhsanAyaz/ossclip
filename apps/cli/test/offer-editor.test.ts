import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// `vi.mock` is hoisted above these, so both see the mocked module.
import { startEditServer, type EditServer } from "../src/edit";
import { offerEditor } from "../src/interactive/offer-editor";
import type { ProduceResult } from "../src/produce";

/**
 * The end-of-run editor offer runs the SAME busy-port ladder `ossclip edit`
 * does. It shipped without it: a produce finishing into an editor already open
 * on that project died on EADDRINUSE, throwing away the run summary behind a
 * Node stack.
 */

// Hoisted, because vi.mock's factory is lifted above these declarations.
const opened = vi.hoisted(() => [] as string[]);
const started = vi.hoisted(() => [] as Array<{ close: () => void }>);

vi.mock("../src/open", () => ({
  // The offer opens a browser unconditionally; a test suite that pops a real
  // window on the runner is not a test suite.
  openInBrowser: (url: string) => opened.push(url),
}));

vi.mock("../src/edit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/edit")>();
  return {
    ...actual,
    // Whether apps/editor happens to be BUILT on this runner must not decide
    // whether this test runs (offerEditor bails early with a "run pnpm build"
    // line when the page dir is missing). The path only feeds static file
    // serving, which nothing here requests.
    resolveEditorPageDir: () => tmpdir(),
    // Real servers on real ports — but tracked, because offerEditor keeps the
    // one it starts and a leaked listener would hold the worker open.
    startEditServer: async (...args: Parameters<typeof actual.startEditServer>) => {
      const server = await actual.startEditServer(...args);
      started.push(server);
      return server;
    },
  };
});

const SHARED_RECENTS = join(tmpdir(), "ossclip-test-recents");
let strangers: Server[] = [];
afterEach(() => {
  for (const s of started) s.close();
  started.length = 0;
  opened.length = 0;
  for (const s of strangers) s.close();
  strangers = [];
});

async function fixtureWorkdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ossclip-offer-"));
  await writeFile(
    join(dir, "render-props.json"),
    JSON.stringify({ videoFileName: "clip.mp4", sceneCues: [], captionLines: [], spans: [] }),
  );
  return dir;
}

/** Only the two fields the offer reads — an explicit `flag: true` short-circuits
 * decideOpenEditor before `rendered` is consulted, but it is spelled anyway so
 * the fixture matches a real finished run. */
const runResult = (workdir: string): ProduceResult =>
  ({ workdir, rendered: true }) as unknown as ProduceResult;

const portOf = (url: string): number => Number(new URL(url).port);

/** A listener that is NOT ossclip: no /api/health, so the flow may step around
 * it but must never kill it. */
async function stranger(): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  strangers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return typeof addr === "object" && addr !== null ? addr.port : 0;
}

describe("offerEditor port conflicts", () => {
  it("attaches to the editor already open on this project", async () => {
    const dir = await fixtureWorkdir();
    const first = await startEditServer(dir, { port: 0, recentDir: SHARED_RECENTS });
    const port = portOf(first.url);

    await offerEditor(runResult(dir), { flag: true, port, portPinned: false });

    // One server, not two: the browser was pointed at the running one.
    expect(started).toHaveLength(1);
    expect(opened).toEqual([`http://127.0.0.1:${port}`]);
  });

  it("steps around a stranger on the DEFAULT port instead of refusing", async () => {
    // `--editor-port` untyped means commander's 5174, which is nobody's
    // choice: an unpinned port must bump so the run still ends in an editor.
    const dir = await fixtureWorkdir();
    const port = await stranger();

    await offerEditor(runResult(dir), { flag: true, port, portPinned: false });

    expect(opened).toHaveLength(1);
    expect(portOf(opened[0]!)).not.toBe(port);
    expect((started[0] as EditServer | undefined)?.url).toBe(opened[0]);
  });

  it("refuses rather than moving when the user typed --editor-port", async () => {
    const dir = await fixtureWorkdir();
    const port = await stranger();

    await expect(
      offerEditor(runResult(dir), { flag: true, port, portPinned: true }),
    ).rejects.toThrow(`port ${port} is taken by something that isn't ossclip`);
    expect(opened).toEqual([]);
  });
});
