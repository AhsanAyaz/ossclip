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
    // Tri-state, proven against the real program: an untyped watermark must
    // reach produce as undefined ("let the config decide"), which is what
    // the positive-before-negative option declaration exists to guarantee.
    expect(opts.watermark).toBeUndefined();
    // Same declaration shape for captions: untyped must be undefined ("the
    // default, ON") — a bare-boolean default here would make the pin unable
    // to tell "not typed" from a typed --captions.
    expect(opts.captions).toBeUndefined();
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
            whisperLanguage: "ur",
            blooperMarker: "blooper",
            collapseRetakes: true,
            sourceIsEdited: true,
            captions: false,
            watermark: true,
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
      whisperLanguage: "ur",
      blooperMarker: "blooper",
      collapseRetakes: true,
      sourceIsEdited: true,
      captions: false,
      watermark: true,
      llm: "claude-cli",
    });
  });

  // The tri-state's other two corners, against the real option declarations:
  // --no-watermark must land as false (it beats a config-on inside produce),
  // never as undefined or a separate `noWatermark` key.
  it("--no-watermark reaches produce as watermark: false", async () => {
    const opts = await parse(["produce", "./take.mp4", "--no-watermark"]);
    expect(opts.watermark).toBe(false);
  });

  // The captions tri-state's other two corners, against the real option
  // declarations: --no-captions must land as captions: false (the only
  // state resolveCaptionsHidden reads as flag-off), and the pin's
  // --captions must land as true — never as a separate `noCaptions` key.
  it("--no-captions reaches produce as captions: false, --captions as true", async () => {
    expect((await parse(["produce", "./take.mp4", "--no-captions"])).captions).toBe(false);
    expect((await parse(["produce", "./take.mp4", "--captions"])).captions).toBe(true);
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

  // Review, minor a: on a config-on machine the watermark entry sits
  // unchecked while the credit renders anyway — unchecked means "don't emit
  // the flag", not "off". The entry's hint must say so, and must stay the
  // plain "--watermark" teaching hint everywhere else.
  it("annotates the watermark extra's hint when the config already turns it on", () => {
    const annotated = extrasFor(true, { watermarkFromConfig: true }).find(
      (e) => e.value === "watermark",
    );
    expect(annotated?.hint).toMatch(/--no-watermark/);
    expect(annotated?.hint).toMatch(/config/);
    const plain = extrasFor(true).find((e) => e.value === "watermark");
    expect(plain?.hint).toBe("--watermark");
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
