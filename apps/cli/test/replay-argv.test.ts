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

  // The effort pin (§143), the dictionary's rationale: the resolved level may
  // have come from ~/.ossclip/config.json's `llmEffort`, and it keys the plan
  // caches — an unpinned record would re-plan on replay after a config edit.
  it("pins a config-sourced --llm-effort, once, and never pins an unset one", () => {
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({ llmEffort: "low" })).toEqual([
      "produce",
      "./a.mp4",
      "--llm-effort",
      "low",
    ]);
    // A typed flag is already in the argv; the includes-guard must not
    // double it (with a possibly different value) at the end.
    setReplayArgv(["produce", "./a.mp4", "--llm-effort", "high"]);
    const typed = recordedProduceArgs({ llmEffort: "high" });
    expect(typed.filter((a) => a === "--llm-effort")).toHaveLength(1);
    // Unset stays unpinned — there is no flag spelling for "agy's default".
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({})).toEqual(["produce", "./a.mp4"]);
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

  // The captions pin — same both-ways shape as the watermark above, kept
  // unconditional even though captions' default is config-independent today
  // (recordedProduceArgs' own comment has the future-proofing case): every
  // record carries the FLAG's resolved state, on or off.
  it("pins the resolved captions flag into the record, both directions", () => {
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({ captions: true })).toEqual([
      "produce",
      "./a.mp4",
      "--captions",
    ]);
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({ captions: false })).toEqual([
      "produce",
      "./a.mp4",
      "--no-captions",
    ]);
  });

  it("never doubles a captions flag the user already typed", () => {
    setReplayArgv(["produce", "./a.mp4", "--no-captions"]);
    const off = recordedProduceArgs({ captions: false });
    expect(off.filter((a) => a === "--no-captions")).toHaveLength(1);
    expect(off).not.toContain("--captions");
    setReplayArgv(["produce", "./a.mp4", "--captions"]);
    const on = recordedProduceArgs({ captions: true });
    expect(on.filter((a) => a === "--captions")).toHaveLength(1);
    expect(on).not.toContain("--no-captions");
  });

  // The replay round trip: a --no-captions record re-runs, produce sees
  // captions: false, pins false again — one flag, forever, never a flip.
  it("an off-captions record re-records byte-identically", () => {
    setReplayArgv(["produce", "./a.mp4"]);
    const recorded = recordedProduceArgs({ captions: false });
    setReplayArgv(recorded);
    expect(recordedProduceArgs({ captions: false })).toEqual(recorded);
  });

  // The jump-cuts pin covers the two TYPED states; "auto" has no flag
  // spelling to pin with and (no config input today) an argv carrying
  // neither flag replays as auto identically everywhere.
  it("pins force as --add-jump-cuts and off as --no-jump-cuts; auto appends nothing", () => {
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({ jumpCuts: "force" })).toEqual([
      "produce",
      "./a.mp4",
      "--add-jump-cuts",
    ]);
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({ jumpCuts: "off" })).toEqual([
      "produce",
      "./a.mp4",
      "--no-jump-cuts",
    ]);
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({ jumpCuts: "auto" })).toEqual(["produce", "./a.mp4"]);
  });

  // The youtube pin — the watermark's config-dependent-default rationale
  // verbatim: `youtube: true` in ~/.ossclip/config.json supplies the
  // effective default, so command.json must carry the RESOLVED state in
  // BOTH directions or a later config edit changes what Render replays.
  it("pins the resolved youtube flag into the record, both directions", () => {
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({ youtube: true })).toEqual(["produce", "./a.mp4", "--youtube"]);
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({ youtube: false })).toEqual([
      "produce",
      "./a.mp4",
      "--no-youtube",
    ]);
  });

  it("never doubles a youtube flag the user already typed — either spelling settles the pin", () => {
    setReplayArgv(["produce", "./a.mp4", "--youtube"]);
    const on = recordedProduceArgs({ youtube: true });
    expect(on.filter((a) => a === "--youtube")).toHaveLength(1);
    expect(on).not.toContain("--no-youtube");
    setReplayArgv(["produce", "./a.mp4", "--no-youtube"]);
    const off = recordedProduceArgs({ youtube: false });
    expect(off.filter((a) => a === "--no-youtube")).toHaveLength(1);
    expect(off).not.toContain("--youtube");
  });

  // The portrait pin: the RESOLVED path (which may have come from the
  // config) — a path only, never a secret; the thumbnail's API key stays in
  // the environment.
  it("pins a config-resolved --portrait, and never doubles a typed one", () => {
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({ portrait: "/me.jpg" })).toEqual([
      "produce",
      "./a.mp4",
      "--portrait",
      "/me.jpg",
    ]);
    setReplayArgv(["produce", "./a.mp4", "--portrait", "/other.jpg"]);
    const typed = recordedProduceArgs({ portrait: "/other.jpg" });
    expect(typed.filter((a) => a === "--portrait")).toHaveLength(1);
    // No resolved portrait (no flag, no config key) pins nothing — there is
    // no negative spelling to record.
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({ portrait: undefined })).toEqual(["produce", "./a.mp4"]);
  });

  // The audience/thumbnail-brief pins (thumbnail UX, 2026-08-16): the
  // portrait's rationale — the resolved text may come from the config, and
  // both steer LLM prompts, so an unpinned record replays different metadata
  // after a config edit. Empty stays unpinned (the dictionary's rule: no
  // flag spelling for "no steer").
  it("pins resolved --audience and --thumbnail-brief when non-empty, never doubled", () => {
    setReplayArgv(["produce", "./a.mp4"]);
    expect(
      recordedProduceArgs({ audience: "junior devs", thumbnailBrief: "show the terminal" }),
    ).toEqual([
      "produce",
      "./a.mp4",
      "--audience",
      "junior devs",
      "--thumbnail-brief",
      "show the terminal",
    ]);
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({ audience: "", thumbnailBrief: "" })).toEqual([
      "produce",
      "./a.mp4",
    ]);
    setReplayArgv([
      "produce", "./a.mp4", "--audience", "junior devs", "--thumbnail-brief", "show the terminal",
    ]);
    const typed = recordedProduceArgs({
      audience: "junior devs",
      thumbnailBrief: "show the terminal",
    });
    expect(typed.filter((a) => a === "--audience")).toHaveLength(1);
    expect(typed.filter((a) => a === "--thumbnail-brief")).toHaveLength(1);
  });

  // The replay round trip, the dictionary's shape: a pinned record re-parses
  // to the same resolved text, so a re-record is byte-identical.
  it("an audience/brief record re-records byte-identically", () => {
    setReplayArgv(["produce", "./a.mp4"]);
    const recorded = recordedProduceArgs({
      audience: "junior devs",
      thumbnailBrief: "show the terminal",
    });
    setReplayArgv(recorded);
    expect(
      recordedProduceArgs({ audience: "junior devs", thumbnailBrief: "show the terminal" }),
    ).toEqual(recorded);
  });

  // The dictionary pin (F4 review follow-up): the resolved terms may come
  // from the config, and they change the transcript itself (whisper prompt,
  // repair vouching, caption casing) — an unpinned record would replay a
  // different edit after a config edit. Comma-joined into the one value
  // --dictionary takes.
  it("pins the resolved dictionary as one comma-joined value", () => {
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({ dictionary: ["JSON", "ossclip"] })).toEqual([
      "produce",
      "./a.mp4",
      "--dictionary",
      "JSON, ossclip",
    ]);
  });

  it("an empty dictionary pins nothing, and a typed --dictionary is never doubled", () => {
    setReplayArgv(["produce", "./a.mp4"]);
    expect(recordedProduceArgs({ dictionary: [] })).toEqual(["produce", "./a.mp4"]);
    setReplayArgv(["produce", "./a.mp4", "--dictionary", "JSON, ossclip"]);
    const typed = recordedProduceArgs({ dictionary: ["JSON", "ossclip"] });
    expect(typed.filter((a) => a === "--dictionary")).toHaveLength(1);
    expect(typed).toEqual(["produce", "./a.mp4", "--dictionary", "JSON, ossclip"]);
  });

  // The replay round trip, captions' shape: the pinned value re-parses to
  // the same resolved terms (dictionaryFlag splits/trims), so a re-record is
  // byte-identical — a config edit between runs cannot drift the replay.
  it("a dictionary record re-records byte-identically", () => {
    setReplayArgv(["produce", "./a.mp4"]);
    const recorded = recordedProduceArgs({ dictionary: ["JSON", "ossclip"] });
    setReplayArgv(recorded);
    expect(recordedProduceArgs({ dictionary: ["JSON", "ossclip"] })).toEqual(recorded);
  });

  it("never doubles a jump-cuts flag the user already typed — either spelling settles the pin", () => {
    setReplayArgv(["produce", "./a.mp4", "--add-jump-cuts"]);
    const force = recordedProduceArgs({ jumpCuts: "force" });
    expect(force.filter((a) => a === "--add-jump-cuts")).toHaveLength(1);
    expect(force).not.toContain("--no-jump-cuts");
    setReplayArgv(["produce", "./a.mp4", "--no-jump-cuts"]);
    const off = recordedProduceArgs({ jumpCuts: "off" });
    expect(off.filter((a) => a === "--no-jump-cuts")).toHaveLength(1);
    expect(off).not.toContain("--add-jump-cuts");
  });

  // The --review/--no-render strip (cut-review step 1): command.json's one
  // consumer is the editor's Render button, and a record carrying either
  // flag replays as a run that skips the render again — --review would also
  // spawn a SECOND editor from inside the replay child. The record is the
  // invocation the user wants Render to run.
  it("strips --review and --no-render at record so the replay actually renders", () => {
    setReplayArgv(["produce", "./a.mp4", "--review", "--llm", "mock"]);
    const review = recordedProduceArgs({ llm: "mock" });
    expect(review).toEqual(["produce", "./a.mp4", "--llm", "mock"]);
    setReplayArgv(["produce", "./a.mp4", "--no-render"]);
    expect(recordedProduceArgs({})).toEqual(["produce", "./a.mp4"]);
    // Typed together (agreement, not a contradiction) both still go.
    setReplayArgv(["produce", "./a.mp4", "--review", "--no-render"]);
    const both = recordedProduceArgs({});
    expect(both).not.toContain("--review");
    expect(both).not.toContain("--no-render");
    expect(both).toEqual(["produce", "./a.mp4"]);
  });

  it("strips --no-render from the direct process.argv fallback too", () => {
    const original = process.argv;
    process.argv = [
      "/usr/bin/node",
      "/usr/local/bin/ossclip",
      "produce",
      "./take.mp4",
      "--no-render",
      "--llm",
      "mock",
    ];
    try {
      // No stash — the direct path records process.argv.slice(2), minus the
      // two render-skipping flags.
      expect(recordedProduceArgs({ llm: "mock" })).toEqual([
        "produce",
        "./take.mp4",
        "--llm",
        "mock",
      ]);
    } finally {
      process.argv = original;
    }
  });

  // The replay round trip, same shape as the captions one above: a typed
  // flag in the record resolves to the same mode on re-run, so the
  // re-record is byte-identical in both typed directions.
  it("a jump-cuts record re-records byte-identically, both directions", () => {
    setReplayArgv(["produce", "./a.mp4", "--no-jump-cuts"]);
    const off = recordedProduceArgs({ jumpCuts: "off" });
    setReplayArgv(off);
    expect(recordedProduceArgs({ jumpCuts: "off" })).toEqual(off);
    setReplayArgv(["produce", "./a.mp4", "--add-jump-cuts"]);
    const force = recordedProduceArgs({ jumpCuts: "force" });
    setReplayArgv(force);
    expect(recordedProduceArgs({ jumpCuts: "force" })).toEqual(force);
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
