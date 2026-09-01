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

  it("--color-grade reaches produce as its raw value", async () => {
    // Raw on purpose: the value may be a preset id or a .cube filename, and
    // classification/validation live at the use site (colorGradeFlagValue /
    // resolveProductionColorGrade), never in transit.
    const opts = await runProduce(["produce", "in.mp4", "--color-grade", "punchy", "--no-render"]);
    expect(opts.colorGrade).toBe("punchy");
  });

  it("--no-color-grade arrives as false, and untyped as undefined", async () => {
    // The tri-state's whole point: false is a typed disable that beats a
    // config grade, and undefined is what lets overrides.json/config decide.
    const off = await runProduce(["produce", "in.mp4", "--no-color-grade", "--no-render"]);
    expect(off.colorGrade).toBe(false);
    const untyped = await runProduce(["produce", "in.mp4", "--no-render"]);
    expect(untyped.colorGrade).toBeUndefined();
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

  // --whisper-backend (2026-09-01): the flag that decides whether the audio
  // is decoded on this machine or posted to a server. It rides THREE
  // commands, and the two that are not `produce` reach produce() through
  // their own action bodies — the `--resolution` failure mode, three times
  // over.
  it("--whisper-backend reaches produce, and untyped stays undefined", async () => {
    const remote = await runProduce(["produce", "in.mp4", "--whisper-backend", "remote", "--no-render"]);
    expect(remote.whisperBackend).toBe("remote");
    const local = await runProduce(["produce", "in.mp4", "--whisper-backend", "local", "--no-render"]);
    expect(local.whisperBackend).toBe("local");
    // Untyped means "let a configured whisperUrl decide" — a default here
    // would make the config unable to select remote at all.
    const untyped = await runProduce(["produce", "in.mp4", "--no-render"]);
    expect(untyped.whisperBackend).toBeUndefined();
  });

  it("a typo'd --whisper-backend is an error, never a silent local run", async () => {
    // CLAUDE.md's parse-don't-coerce: falling back to local is exactly the
    // slow decode the flag exists to avoid on a weak CPU.
    await expect(
      runProduce(["produce", "in.mp4", "--whisper-backend", "groq", "--no-render"]),
    ).rejects.toThrow();
  });

  it("--whisper-backend reaches produce through `transcribe` too", async () => {
    const opts = await runProduce(["transcribe", "in.mp4", "--whisper-backend", "remote"]);
    expect(opts.whisperBackend).toBe("remote");
    await expect(runProduce(["transcribe", "in.mp4", "--whisper-backend", "groq"])).rejects.toThrow();
  });

  it("--whisper-backend reaches produce through `analyze`'s two hops", async () => {
    // analyze forwards through runAnalyze, so this pins BOTH hops. The
    // command then dies reading a production.json the stubbed produce never
    // wrote — irrelevant to what is under test, which is the options object
    // produce was handed.
    produceSpy.mockClear();
    const { buildProgram } = await import("../src/program");
    const program = buildProgram();
    for (const cmd of [program, ...program.commands]) {
      cmd.exitOverride();
      cmd.configureOutput({ writeErr() {} });
    }
    await program
      .parseAsync(["node", "ossclip", "analyze", "in.mp4", "--whisper-backend", "remote"])
      .catch(() => {});
    expect(produceSpy).toHaveBeenCalledTimes(1);
    expect(produceSpy.mock.calls[0]![1]).toMatchObject({ whisperBackend: "remote" });
  });

  it("a typed --editor-port is pinned, and reaches the offer", async () => {
    offerEditorSpy.mockClear();
    await runProduce(["produce", "in.mp4", "--no-render", "--open-editor", "--editor-port", "5200"]);
    expect(offerEditorSpy.mock.calls[0]![1]).toMatchObject({ port: 5200, portPinned: true });
  });
});
