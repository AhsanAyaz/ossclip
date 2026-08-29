import { describe, expect, it, vi } from "vitest";

/**
 * Flags must reach `produce()`, not merely PARSE (2026-08-27).
 *
 * `produce-argv-roundtrip` stubs the action handler, so it proves commander
 * accepts a flag — and would pass just as happily if the action never
 * forwarded it. `--resolution` shipped exactly that way for one render: the
 * option was defined, the value parsed, and the action's produce() call never
 * mentioned it, so a `--resolution auto` run wrote 1080p and said nothing.
 * This suite captures the OPTIONS OBJECT produce actually receives.
 */
// Shaped like a real result: the action reads telemetry fields off it, and a
// bare object would fail on those rather than on the assertion under test.
const produceSpy = vi.fn(async () => ({
  workdir: "/tmp/x",
  outPath: "/tmp/x/out.mp4",
  llmProvider: undefined,
  sourceDurationSec: 1,
  sceneCount: 0,
  phaseTimings: { transcribe: 0, analyze: 0, render: 0 },
}));

vi.mock("../src/produce", async (importOriginal) => {
  // Everything else stays REAL — program.ts imports the flag parsers
  // (`dictionaryFlag`, `jumpCutsFlag`, `reviewFlag`) from this same module,
  // and stubbing those would test a program the user never runs.
  const actual = await importOriginal<typeof import("../src/produce")>();
  return { ...actual, produce: produceSpy };
});

/**
 * The end-of-run editor offer, stubbed: it is the one call in the action that
 * would START A SERVER on a real port during this suite. Its own options are
 * captured here for the same reason produce's are — `--editor-port`'s
 * "did the user type it" bit only exists at THIS call site, so a parse-level
 * test could not see it go missing.
 */
const offerEditorSpy = vi.fn(async () => {});
vi.mock("../src/interactive/offer-editor", () => ({ offerEditor: offerEditorSpy }));

const runProduce = async (argv: string[]): Promise<Record<string, unknown>> => {
  produceSpy.mockClear();
  const { buildProgram } = await import("../src/program");
  const program = buildProgram();
  for (const cmd of [program, ...program.commands]) {
    cmd.exitOverride();
    cmd.configureOutput({ writeErr() {} });
  }
  await program.parseAsync(["node", "ossclip", ...argv]);
  expect(produceSpy).toHaveBeenCalledTimes(1);
  return produceSpy.mock.calls[0]![1] as unknown as Record<string, unknown>;
};

describe("produce flag forwarding", () => {
  it("--resolution reaches produce", async () => {
    const opts = await runProduce(["produce", "in.mp4", "--resolution", "auto", "--no-render"]);
    expect(opts.resolution).toBe("auto");
  });

  it("an untyped --resolution arrives undefined, so the config can supply it", async () => {
    const opts = await runProduce(["produce", "in.mp4", "--no-render"]);
    expect(opts.resolution).toBeUndefined();
  });

  it("commander's own 5174 does NOT count as a pinned --editor-port", async () => {
    // Untyped means nobody chose that number, so a busy port must attach or
    // bump rather than refuse (edit-port.ts's `pinned`). Reported as typed
    // here, the common produce → editor path would end in an error instead of
    // an open editor.
    offerEditorSpy.mockClear();
    await runProduce(["produce", "in.mp4", "--no-render", "--open-editor"]);
    expect(offerEditorSpy.mock.calls[0]![1]).toMatchObject({ port: 5174, portPinned: false });
  });

  it("a typed --editor-port is pinned, and reaches the offer", async () => {
    offerEditorSpy.mockClear();
    await runProduce(["produce", "in.mp4", "--no-render", "--open-editor", "--editor-port", "5200"]);
    expect(offerEditorSpy.mock.calls[0]![1]).toMatchObject({ port: 5200, portPinned: true });
  });
});
