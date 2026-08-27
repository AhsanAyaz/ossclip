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
});
