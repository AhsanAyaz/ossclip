import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeReplayArgv, recordedProduceArgs, setReplayArgv } from "../src/replay-argv";
import { produceArgv } from "../src/interactive/produce-argv";

/**
 * §129: command.json must record the argv of the parse that ACTUALLY ran.
 * The field artifact this pins against: a bare-path run recorded
 * process.argv — `["./Anyhropic c Compiler", "--llm", "gemini"]`, no
 * `produce` literal — and the editor's Render replayed a command that dies
 * on "unknown option '--llm'".
 */

// The stash is module state; a test that set it and never consumed it would
// leak its argv into the next test's recording — the exact bug class §129
// documents, so the drain is not optional hygiene here.
afterEach(() => {
  consumeReplayArgv();
});

const wizardAnswers = {
  input: "./take.mp4",
  aspect: "9:16" as const,
  cleanup: "standard" as const,
  graphics: true,
  intent: "agents 101",
  extras: { llm: "gemini" as const, clip: 60 },
};

describe("recordedProduceArgs (§129)", () => {
  it("a wizard-shaped re-entry records args starting with `produce`, typed flags exactly once", () => {
    const argv = produceArgv(wizardAnswers);
    setReplayArgv(argv);
    const rec = recordedProduceArgs({ llm: "gemini", clipWindow: "12:345" });
    // The stashed argv IS the record's base — nothing from process.argv
    // (which in this worker is vitest's own invocation) leaks in.
    expect(rec.slice(0, argv.length)).toEqual(argv);
    expect(rec[0]).toBe("produce");
    // The wizard already emitted --llm gemini; the §75 pin must not append a
    // second one.
    expect(rec.filter((a) => a === "--llm")).toHaveLength(1);
    // --clip-window was NOT in the typed argv, so the §93g pin appends it.
    expect(rec.filter((a) => a === "--clip-window")).toHaveLength(1);
    expect(rec).toContain("--produce");
    expect(rec).toContain("--intent");
  });

  it("a direct `ossclip produce …` records process.argv.slice(2) byte-identically", () => {
    const typed = ["produce", "./take.mp4", "--llm", "mock"];
    const original = process.argv;
    process.argv = ["/usr/bin/node", "/usr/local/bin/ossclip", ...typed];
    try {
      // No stash — the direct path never re-enters parseAsync.
      expect(recordedProduceArgs({ llm: "mock" })).toEqual(typed);
      expect(recordedProduceArgs({})).toEqual(typed);
    } finally {
      process.argv = original;
    }
  });

  it("the stash is consume-on-read — one stash describes exactly one parse", () => {
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({})).toEqual(["produce", "./a.mp4"]);
    // A second recording in the same process falls back to process.argv
    // instead of replaying a stale stash from a parse it never ran.
    expect(recordedProduceArgs({})).toEqual(process.argv.slice(2));
  });

  it("pins append when the typed argv lacks them", () => {
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({ llm: "gemini", clipWindow: "3:99" })).toEqual([
      "produce",
      "./a.mp4",
      "--llm",
      "gemini",
      "--clip-window",
      "3:99",
    ]);
  });

  // The watermark pin (same §75 shape as --llm, in BOTH directions): the
  // effective default is config-dependent, so command.json must carry the
  // RESOLVED state — on OR off — or a replay under a different config
  // silently renders a different video.
  it("pins a config-sourced --watermark into the record", () => {
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({ watermark: true })).toEqual([
      "produce",
      "./a.mp4",
      "--watermark",
    ]);
  });

  it("pins a resolved-off --no-watermark into the record", () => {
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({ watermark: false })).toEqual([
      "produce",
      "./a.mp4",
      "--no-watermark",
    ]);
  });

  it("never doubles a watermark flag the user already typed", () => {
    setReplayArgv(["produce", "./a.mp4", "--watermark"]);
    const on = recordedProduceArgs({ watermark: true });
    expect(on.filter((a) => a === "--watermark")).toHaveLength(1);
    setReplayArgv(["produce", "./a.mp4", "--no-watermark"]);
    const off = recordedProduceArgs({ watermark: false });
    expect(off.filter((a) => a === "--no-watermark")).toHaveLength(1);
    expect(off).not.toContain("--watermark");
  });

  // The drift scenario the bidirectional pin exists for (review, Important):
  // a record made resolved-off is later replayed on a machine whose config
  // says watermark: true. The recorded --no-watermark reaches commander as
  // watermark: false, the typed flag beats the config (resolveWatermark),
  // and re-recording pins off again — the replay must never gain a credit
  // the original run didn't render.
  it("an off-record replayed under a config-on still says off", () => {
    // Run 1: watermark resolved off (no flag typed, config off) — pinned.
    setReplayArgv(["produce", "./a.mp4"]);
    const recorded = recordedProduceArgs({ watermark: false });
    expect(recorded).toContain("--no-watermark");
    // Run 2 (the replay, now under config watermark: true): the record's
    // --no-watermark is a typed flag, so the resolution is false again and
    // the re-record stays off, un-doubled.
    setReplayArgv(recorded);
    const replayed = recordedProduceArgs({ watermark: false });
    expect(replayed.filter((a) => a === "--no-watermark")).toHaveLength(1);
    expect(replayed).not.toContain("--watermark");
  });
});

describe("program.ts stashes at re-entry (§129)", () => {
  it("the non-TTY bare-path route stashes the exact produce argv it parses", async () => {
    // Same harness as bare-path.test.ts: the REAL program, only the produce
    // action's effect stubbed — here with a stub that performs the same
    // recording read produce() does, so what's asserted is the seam itself:
    // re-entry stash in, command.json args out.
    const dir = mkdtempSync(join(tmpdir(), "ossclip-replay-"));
    const { buildProgram } = await import("../src/program");
    const program = buildProgram();
    for (const cmd of [program, ...program.commands]) {
      cmd.exitOverride();
      cmd.configureOutput({ writeErr() {}, writeOut() {} });
    }
    const produce = program.commands.find((c) => c.name() === "produce");
    if (produce === undefined) throw new Error("the real program has no `produce` command");
    let recorded: string[] | undefined;
    produce.action((() => {
      recorded = recordedProduceArgs({});
    }) as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync(["node", "ossclip", dir]);
    } finally {
      log.mockRestore();
    }
    // NOT process.argv (vitest's own invocation): the record starts with the
    // `produce` literal the re-entered parse actually ran.
    expect(recorded).toEqual(["produce", dir]);
  });
});
