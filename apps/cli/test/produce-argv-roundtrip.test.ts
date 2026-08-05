import { describe, expect, it } from "vitest";
import { produceArgv, type ProduceAnswers } from "../src/interactive/produce-argv";
import { extrasFor } from "../src/interactive/produce-wizard";

const answers = (over: Partial<ProduceAnswers> = {}): ProduceAnswers => ({
  input: "./take.mp4",
  aspect: "9:16",
  cleanup: "standard",
  graphics: false,
  extras: {},
  ...over,
});

/**
 * Parses wizard argv with the REAL program — `buildProgram()` from
 * src/program.ts — and captures the options object `produce`'s action would
 * receive, with only that action's effect stubbed out.
 *
 * This used to hand-declare thirteen options mirroring index.ts. A replica
 * drifts silently: rename `--whisper-model` in index.ts and the wizard keeps
 * emitting the old spelling, the replica keeps accepting it, this passes, and
 * the shipped CLI breaks. Parsing against the real thing is the only shape
 * where that is unrepresentable.
 */
const parse = async (argv: string[]): Promise<Record<string, unknown>> => {
  const { buildProgram } = await import("../src/program");
  const program = buildProgram();
  // Drift must fail as a named test, not as process.exit(1) inside the vitest
  // worker — and commander's own "error: unknown option" is not this suite's
  // output. Applied to the subcommands too: they were created before these
  // calls, so they do not inherit them.
  for (const cmd of [program, ...program.commands]) {
    cmd.exitOverride();
    cmd.configureOutput({ writeErr() {} });
  }
  let captured: Record<string, unknown> = {};
  const produce = program.commands.find((c) => c.name() === "produce");
  if (produce === undefined) throw new Error("the real program has no `produce` command");
  // Replaces the action handler commander already holds: every option
  // definition, parser and default above it is the shipped one.
  produce.action((input: string | undefined, opts: Record<string, unknown>) => {
    captured = { input, ...opts };
  });
  await program.parseAsync(["node", "ossclip", ...argv]);
  return captured;
};

describe("wizard argv survives the real commander parse", () => {
  it("a bare run reaches produce with every default intact", async () => {
    const opts = await parse(produceArgv(answers()));
    expect(opts.input).toBe("./take.mp4");
    expect(opts.aspect).toBe("9:16");
    expect(opts.cleanup).toBe("standard");
    expect(opts.produce).toBe(false);
    expect(opts.sourceFit).toBe("cover");
    expect(opts.collapseRetakes).toBe(false);
  });

  it("every tier-2 extra lands on the option commander names", async () => {
    const opts = await parse(
      produceArgv(
        answers({
          graphics: true,
          intent: "agents 101",
          out: "./short.mp4",
          aspect: "16:9",
          cleanup: "aggressive",
          extras: {
            clip: 60,
            sourceFit: "contain",
            speaker: "Ahsan",
            whisperModel: "medium.en",
            blooperMarker: "blooper",
            collapseRetakes: true,
            sourceIsEdited: true,
            llm: "claude-cli",
          },
        }),
      ),
    );
    expect(opts).toMatchObject({
      input: "./take.mp4",
      out: "./short.mp4",
      aspect: "16:9",
      cleanup: "aggressive",
      produce: true,
      intent: "agents 101",
      clip: 60,
      sourceFit: "contain",
      speaker: "Ahsan",
      whisperModel: "medium.en",
      blooperMarker: "blooper",
      collapseRetakes: true,
      sourceIsEdited: true,
      llm: "claude-cli",
    });
  });

  it("never offers the clip extra without graphics — produce.ts §93b refuses that combination", () => {
    // apps/cli/src/produce.ts throws "--clip needs the producer's editorial
    // judgement: add --produce" whenever --clip shows up without --produce.
    // produceArgv itself has no opinion — it would happily emit --clip with
    // graphics: false and extras.clip set, e.g.
    // produceArgv(answers({ graphics: false, extras: { clip: 60 } })) — so it
    // is extrasFor's filtering, asserted here, that is the only thing
    // standing between a "no" to graphics and that dead end nine prompts
    // later: the multiselect never lists the option in the first place.
    expect(extrasFor(false).some((e) => e.value === "graphicsClip")).toBe(false);
    expect(extrasFor(true).some((e) => e.value === "graphicsClip")).toBe(true);
  });

  it("rejects an argv containing a flag the CLI does not define", async () => {
    // Proves the harness would actually catch drift rather than silently
    // accepting anything — and that it fails as a test instead of exiting the
    // worker, which is what the missing exitOverride() used to do.
    await expect(parse(["produce", "./t.mp4", "--not-a-flag"])).rejects.toThrow(
      /unknown option/,
    );
  });
});
