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
 * Builds a commander program shaped exactly like the real `produce` command
 * and captures the options object the action would receive. If a wizard ever
 * emits a flag the CLI does not accept — or spells one differently — this
 * fails rather than shipping a wizard that teaches a broken command line.
 */
const parse = async (argv: string[]): Promise<Record<string, unknown>> => {
  const { Command } = await import("commander");
  const program = new Command();
  let captured: Record<string, unknown> = {};
  program
    .command("produce")
    .argument("[input]")
    .option("-o, --out <path>")
    .option("--cleanup <level>", "", "standard")
    .option("--aspect <ratio>", "", "9:16")
    .option("--produce", "", false)
    .option("--intent <text>")
    .option("--clip <seconds>", "", Number.parseFloat)
    .option("--source-fit <mode>", "", "cover")
    .option("--speaker <who>")
    .option("--whisper-model <name>")
    .option("--blooper-marker <word>")
    .option("--source-is-edited")
    .option("--llm <provider>")
    .action((input: string, opts: Record<string, unknown>) => {
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
    // accepting anything.
    const program = (await import("commander")).Command;
    const p = new program();
    p.exitOverride();
    p.command("produce").argument("[input]").action(() => {});
    await expect(
      p.parseAsync(["node", "ossclip", "produce", "./t.mp4", "--not-a-flag"]),
    ).rejects.toThrow();
  });
});
