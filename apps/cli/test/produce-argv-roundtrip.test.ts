import { describe, expect, it } from "vitest";
import { produceArgv, type ProduceAnswers } from "../src/interactive/produce-argv";
import { extrasFor, rememberPatch, youtubeFollowups } from "../src/interactive/produce-wizard";
import { dictionaryFlag, jumpCutsFlag, resolveJumpCuts } from "../src/produce";

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
    captured = {
      input,
      ...opts,
      // The jump-cuts tri-state's typed-vs-default distinction is invisible
      // in the VALUE — `--no-jump-cuts`'s key defaults true — so the harness
      // records commander's source verdict too: the exact second input
      // jumpCutsFlag consumes in the real action.
      jumpCutsTyped: produce.getOptionValueSource("jumpCuts") === "cli",
    };
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
    // The jump-cuts pair CANNOT share one key (the positive is spelled
    // --add-jump-cuts), so untyped looks like this: addJumpCuts undefined,
    // jumpCuts filled with commander's --no-* default TRUE — and only the
    // recorded source verdict says it wasn't typed. jumpCutsFlag turns
    // exactly this shape back into "auto".
    expect(opts.addJumpCuts).toBeUndefined();
    expect(opts.jumpCuts).toBe(true);
    expect(opts.jumpCutsTyped).toBe(false);
    // The youtube tri-state, same declaration shape as watermark: untyped
    // must reach produce as undefined ("let the config decide"), and the
    // portrait as undefined ("the config's path, if any").
    expect(opts.youtube).toBeUndefined();
    expect(opts.portrait).toBeUndefined();
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
            sourceIsEdited: true,
            captions: false,
            watermark: true,
            jumpCuts: false,
            youtube: true,
            portrait: "/me.jpg",
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
      sourceIsEdited: true,
      captions: false,
      watermark: true,
      // The wizard's --no-jump-cuts landing on commander's own key.
      jumpCuts: false,
      youtube: true,
      portrait: "/me.jpg",
      llm: "claude-cli",
    });
  });

  // 2026-08-16 gate decision: the wizard no longer emits --collapse-retakes
  // (the field is gone from ProduceExtras), but the flag itself must STAY
  // parseable — recorded command.json replays from older releases carry it,
  // and a replay erroring on its own recorded command is the exact
  // compatibility break the inert flag exists to prevent.
  it("--collapse-retakes still parses as a legacy no-op for old recorded replays", async () => {
    const opts = await parse(["produce", "./take.mp4", "--collapse-retakes"]);
    expect(opts.collapseRetakes).toBe(true);
  });

  // --cover-text-reset (2026-08-19): a plain opt-in flag, NOT a tri-state —
  // "not typed" means "keep the user's headline", which is the default and
  // needs no third state. Its own key, because --cover/--no-cover already
  // share one with the cover's output PATH.
  it("--cover-text-reset lands on its own key; untyped stays undefined", async () => {
    expect((await parse(["produce", "./take.mp4", "--cover-text-reset"])).coverTextReset).toBe(true);
    expect((await parse(["produce", "./take.mp4"])).coverTextReset).toBeUndefined();
    // The cover flags stay independent: neither touches the other's key.
    const both = await parse(["produce", "./take.mp4", "--cover", "/c.jpg", "--cover-text-reset"]);
    expect(both.cover).toBe("/c.jpg");
    expect(both.coverTextReset).toBe(true);
  });

  // The tri-state's other two corners, against the real option declarations:
  // --no-watermark must land as false (it beats a config-on inside produce),
  // never as undefined or a separate `noWatermark` key.
  it("--no-watermark reaches produce as watermark: false", async () => {
    const opts = await parse(["produce", "./take.mp4", "--no-watermark"]);
    expect(opts.watermark).toBe(false);
  });

  // The youtube tri-state's corners, watermark's exact shape: --no-youtube
  // must land as youtube: false (the only state resolveYoutube reads as
  // flag-off), --youtube as true, and --portrait as its raw path.
  it("--youtube/--no-youtube land on one key; --portrait carries its path", async () => {
    expect((await parse(["produce", "./take.mp4", "--youtube"])).youtube).toBe(true);
    expect((await parse(["produce", "./take.mp4", "--no-youtube"])).youtube).toBe(false);
    expect(
      (await parse(["produce", "./take.mp4", "--youtube", "--portrait", "/me.jpg"])).portrait,
    ).toBe("/me.jpg");
  });

  // The youtube steer flags, --portrait's exact contract: raw text through
  // commander, untyped stays undefined so the config can supply the value.
  it("--audience and --thumbnail-brief carry their text; untyped stays undefined", async () => {
    const typed = await parse([
      "produce", "./take.mp4",
      "--audience", "junior web devs learning AI tooling",
      "--thumbnail-brief", "always show the terminal",
    ]);
    expect(typed.audience).toBe("junior web devs learning AI tooling");
    expect(typed.thumbnailBrief).toBe("always show the terminal");
    const bare = await parse(["produce", "./take.mp4"]);
    expect(bare.audience).toBeUndefined();
    expect(bare.thumbnailBrief).toBeUndefined();
  });

  // --dictionary is ONE comma-separated value (a variadic option fights the
  // optional positional [input]); commander hands the raw string through and
  // the action's dictionaryFlag does the splitting.
  it("--dictionary reaches the action as its raw comma-separated value, split by dictionaryFlag", async () => {
    const opts = await parse(["produce", "./take.mp4", "--dictionary", "JSON, ossclip, Genkit"]);
    expect(opts.dictionary).toBe("JSON, ossclip, Genkit");
    expect(dictionaryFlag(opts.dictionary as string)).toEqual(["JSON", "ossclip", "Genkit"]);
    // Untyped must stay undefined so the config's dictionary can supply the
    // default (typed-beats-config, like the watermark).
    expect((await parse(["produce", "./take.mp4"])).dictionary).toBeUndefined();
  });

  // The captions tri-state's other two corners, against the real option
  // declarations: --no-captions must land as captions: false (the only
  // state resolveCaptionsHidden reads as flag-off), and the pin's
  // --captions must land as true — never as a separate `noCaptions` key.
  it("--no-captions reaches produce as captions: false, --captions as true", async () => {
    expect((await parse(["produce", "./take.mp4", "--no-captions"])).captions).toBe(false);
    expect((await parse(["produce", "./take.mp4", "--captions"])).captions).toBe(true);
  });

  // The jump-cuts tri-state through the REAL option declarations, then
  // through the real reunification (resolveJumpCuts ∘ jumpCutsFlag) — the
  // action itself is stubbed by this harness, so the mapping is asserted on
  // exactly the two values the shipped action reads.
  it("--add-jump-cuts resolves to force, --no-jump-cuts to off, bare to auto", async () => {
    const mode = async (argv: string[]) => {
      const opts = await parse(argv);
      return resolveJumpCuts(
        jumpCutsFlag(opts.addJumpCuts as boolean | undefined, opts.jumpCutsTyped as boolean),
      );
    };
    expect(await mode(["produce", "./take.mp4", "--add-jump-cuts"])).toBe("force");
    expect(await mode(["produce", "./take.mp4", "--no-jump-cuts"])).toBe("off");
    expect(await mode(["produce", "./take.mp4"])).toBe("auto");
  });

  it("typing both jump-cut flags errors instead of picking a winner", async () => {
    // Commander accepts both (they are separate keys — the pair can't share
    // one); the refusal is jumpCutsFlag's, on the values that parse yields.
    const opts = await parse(["produce", "./take.mp4", "--add-jump-cuts", "--no-jump-cuts"]);
    expect(opts.addJumpCuts).toBe(true);
    expect(opts.jumpCutsTyped).toBe(true);
    expect(() =>
      jumpCutsFlag(opts.addJumpCuts as boolean | undefined, opts.jumpCutsTyped as boolean),
    ).toThrow(/--add-jump-cuts contradicts --no-jump-cuts/);
  });

  // The wizard's OFF switch for the punch, same tier and phrasing as
  // captionsOff: listed whether or not graphics are on, teaching the
  // negative flag.
  it("lists the jump-cuts OFF switch in the extras menu", () => {
    for (const graphics of [false, true]) {
      const entry = extrasFor(graphics).find((e) => e.value === "jumpCutsOff");
      expect(entry?.hint).toBe("--no-jump-cuts");
    }
  });

  // The youtube pack entry (Y1): listed whether or not graphics are on — the
  // metadata call rides the run's provider when one exists and skips loudly
  // otherwise, so the entry is never a guaranteed dead end the way the clip
  // extra is. Counts pinned so a silently dropped entry fails by name.
  it("lists the youtube pack entry in the extras menu", () => {
    for (const graphics of [false, true]) {
      const entry = extrasFor(graphics).find((e) => e.value === "youtube");
      // The hint teaches the flag AND warns about the interactive stop the
      // tick adds (concept approval before render, thumbnail UX 2026-08-16)
      // — a surprise prompt mid-run reads as a hang.
      expect(entry?.hint).toMatch(/--youtube/);
      expect(entry?.hint).toMatch(/approve the thumbnail concept before render/);
    }
    expect(extrasFor(true)).toHaveLength(11);
    expect(extrasFor(false)).toHaveLength(10); // graphicsClip filtered out
  });

  // The youtube follow-up gating (thumbnail UX, 2026-08-16): each follow-up
  // is skipped when ~/.ossclip/config.json already answers it — the
  // watermarkFromConfig idea applied to the follow-up tier.
  it("youtubeFollowups asks only what the config doesn't already supply", () => {
    expect(youtubeFollowups({})).toEqual(["audience", "portrait", "brief"]);
    expect(youtubeFollowups({ audience: "junior devs" })).toEqual(["portrait", "brief"]);
    expect(youtubeFollowups({ portrait: "/me.jpg" })).toEqual(["audience", "brief"]);
    expect(youtubeFollowups({ thumbnailBrief: "show the terminal" })).toEqual([
      "audience",
      "portrait",
    ]);
    expect(
      youtubeFollowups({ audience: "devs", portrait: "/me.jpg", thumbnailBrief: "terminal" }),
    ).toEqual([]);
    // Parse-don't-coerce corners: whitespace and non-strings mean "still
    // ask", never a skipped question over a bogus config value.
    expect(youtubeFollowups({ audience: "   " })).toEqual(["audience", "portrait", "brief"]);
    expect(youtubeFollowups({ audience: true as unknown as string })).toEqual([
      "audience",
      "portrait",
      "brief",
    ]);
  });

  // The remember offer (UX completion, 2026-08-17): rememberPatch decides
  // whether the wizard offers to persist the youtube follow-up answers, and
  // exactly which keys a yes would write. null means no offer at all.
  it("rememberPatch returns null when nothing was freshly typed", () => {
    expect(rememberPatch({}, {})).toBeNull();
    // Whitespace never qualifies — the prompts already drop it, but a
    // durable config write gets the same parse-don't-coerce guard.
    expect(rememberPatch({ audience: "   " }, {})).toBeNull();
    // Everything already in the config: the follow-ups were never asked, so
    // there is nothing fresh even if values somehow arrive typed.
    expect(
      rememberPatch(
        { audience: "devs", thumbnailBrief: "terminal" },
        { audience: "devs", portrait: "/me.jpg", thumbnailBrief: "terminal" },
      ),
    ).toBeNull();
  });

  it("rememberPatch keeps only the freshly typed keys and never re-saves config-supplied ones", () => {
    // Mixed fresh+config: audience came from the config (its follow-up was
    // skipped), so only the two typed answers may reach the patch — a saved
    // audience here could clobber a hand-edited config.json.
    expect(
      rememberPatch(
        { audience: "stale", thumbnailBrief: "always show the terminal" },
        { audience: "junior devs" },
      ),
    ).toEqual({ thumbnailBrief: "always show the terminal" });
    expect(rememberPatch({ audience: "junior devs" }, {})).toEqual({ audience: "junior devs" });
  });

  it("rememberPatch stores the portrait as the expanded absolute path", () => {
    // A `~` string in config.json would work today (produce.ts expands the
    // config value too), but absolute is self-documenting in a hand-edited
    // file — so the patch carries the expansion, with `home` injected.
    expect(rememberPatch({ portrait: "~/Pictures/me.jpg" }, {}, "/Users/test")).toEqual({
      portrait: "/Users/test/Pictures/me.jpg",
    });
    // A typed relative path is anchored to cwd, the resolvedInput rule: a
    // relative string saved as-is would mean a different file per launch dir.
    const rel = rememberPatch({ portrait: "pics/me.jpg" }, {}, "/Users/test");
    expect(rel?.portrait).toMatch(/^\//);
    expect(rel?.portrait?.endsWith("/pics/me.jpg")).toBe(true);
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
