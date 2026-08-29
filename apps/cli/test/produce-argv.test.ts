import { describe, expect, it } from "vitest";
import { produceArgv, type ProduceAnswers } from "../src/interactive/produce-argv";

const answers = (over: Partial<ProduceAnswers> = {}): ProduceAnswers => ({
  input: "./take.mp4",
  aspect: "9:16",
  cleanup: "standard",
  graphics: false,
  extras: {},
  ...over,
});

describe("produceArgv", () => {
  // The single most important property: a wizard run where every answer is
  // the default must teach `ossclip produce <file>` and nothing more. Emitting
  // --aspect 9:16 --cleanup standard would grow a command line the user then
  // copies forever.
  it("emits no flag for an answer that equals the default", () => {
    expect(produceArgv(answers())).toEqual(["produce", "./take.mp4"]);
  });

  // §148: the wizard leans to review, so this is the ONE answer whose
  // wizard-default differs from the CLI default — and the elision rule is
  // still what decides the argv. `--review` is emitted because it is not the
  // CLI's default, not because the wizard preselected it.
  it("emits --review when the user chose to review the cut first", () => {
    expect(produceArgv(answers({ review: true }))).toEqual([
      "produce", "./take.mp4", "--review",
    ]);
  });

  it("emits nothing for render-now — the CLI default stays untaught", () => {
    expect(produceArgv(answers({ review: false }))).toEqual(["produce", "./take.mp4"]);
    expect(produceArgv(answers({ review: undefined }))).toEqual(["produce", "./take.mp4"]);
  });

  it("emits the non-default shape and cleanup", () => {
    expect(produceArgv(answers({ aspect: "16:9", cleanup: "aggressive" }))).toEqual([
      "produce", "./take.mp4", "--aspect", "16:9", "--cleanup", "aggressive",
    ]);
  });

  it("pairs --intent with --produce", () => {
    expect(produceArgv(answers({ graphics: true, intent: "agents 101" }))).toEqual([
      "produce", "./take.mp4", "--produce", "--intent", "agents 101",
    ]);
  });

  // --intent without --produce is meaningless: the intent feeds the producer
  // brain, which only runs under --produce.
  it("drops an intent when graphics are off", () => {
    expect(produceArgv(answers({ graphics: false, intent: "orphaned" }))).toEqual([
      "produce", "./take.mp4",
    ]);
  });

  it("emits --out only when given", () => {
    expect(produceArgv(answers({ out: "./short.mp4" }))).toEqual([
      "produce", "./take.mp4", "--out", "./short.mp4",
    ]);
  });

  it("emits every tier-2 extra that was set", () => {
    expect(
      produceArgv(
        answers({
          extras: {
            clip: 60,
            sourceFit: "contain",
            speaker: "Ahsan, host of Code with Ahsan",
            whisperModel: "medium.en",
            whisperLanguage: "ur",
            blooperMarker: "blooper",
            sourceIsEdited: true,
            captions: false,
            watermark: true,
            jumpCuts: false,
            sfx: "meme",
            youtube: true,
            portrait: "/me.jpg",
            llm: "claude-cli",
          },
        }),
      ),
    ).toEqual([
      "produce", "./take.mp4",
      "--clip", "60",
      "--source-fit", "contain",
      "--speaker", "Ahsan, host of Code with Ahsan",
      "--whisper-model", "medium.en",
      "--whisper-language", "ur",
      "--blooper-marker", "blooper",
      "--source-is-edited",
      "--watermark",
      "--no-captions",
      "--no-jump-cuts",
      "--sfx-level", "meme",
      "--youtube",
      "--portrait", "/me.jpg",
      "--llm", "claude-cli",
    ]);
  });

  // §132: the wizard's provider select gained antigravity — the emitter must
  // pass it through like any other ProviderName, no special casing.
  it("emits --llm antigravity", () => {
    expect(produceArgv(answers({ extras: { llm: "antigravity" } }))).toEqual([
      "produce", "./take.mp4", "--llm", "antigravity",
    ]);
  });

  // The wizard's language follow-up returns "" for "keep whisper's en
  // default" — that answer must not grow the taught command line (Urdu field
  // test 2026-08-05: only a typed code means anything).
  it("omits an empty --whisper-language rather than emitting a bare flag", () => {
    expect(
      produceArgv(answers({ extras: { whisperModel: "medium.en", whisperLanguage: "" } })),
    ).toEqual(["produce", "./take.mp4", "--whisper-model", "medium.en"]);
  });

  it("omits source-fit when it is the default cover", () => {
    expect(produceArgv(answers({ extras: { sourceFit: "cover" } }))).toEqual([
      "produce", "./take.mp4",
    ]);
  });

  it("omits a false --source-is-edited rather than emitting the flag", () => {
    expect(produceArgv(answers({ extras: { sourceIsEdited: false } }))).toEqual([
      "produce", "./take.mp4",
    ]);
  });

  // 2026-08-16 gate decision: retake collapse rides --blooper-marker
  // automatically (inferredRetakesEnabled, produce.ts), so ProduceExtras no
  // longer HAS a collapseRetakes field — the wizard structurally cannot emit
  // the legacy flag. A marker answer alone must teach only --blooper-marker.
  it("never emits --collapse-retakes — a marker answer teaches only --blooper-marker", () => {
    expect(produceArgv(answers({ extras: { blooperMarker: "blooper" } }))).toEqual([
      "produce", "./take.mp4", "--blooper-marker", "blooper",
    ]);
  });

  // Off is the watermark's universal default (open-source etiquette: the
  // credit is opt-in) — the elision rule applies exactly as everywhere else.
  it("omits a false --watermark rather than emitting the flag", () => {
    expect(produceArgv(answers({ extras: { watermark: false } }))).toEqual([
      "produce", "./take.mp4",
    ]);
  });

  // Captions are the watermark's mirror: ON is the default, so only `false`
  // (the wizard's "Turn the burned-in captions off" tick) may emit anything
  // — and it must be the negative flag. An explicit `true` restates the
  // default and must emit nothing, per the elision rule.
  it("emits --no-captions for captions: false, and nothing for true/unset", () => {
    expect(produceArgv(answers({ extras: { captions: false } }))).toEqual([
      "produce", "./take.mp4", "--no-captions",
    ]);
    expect(produceArgv(answers({ extras: { captions: true } }))).toEqual([
      "produce", "./take.mp4",
    ]);
  });

  // The youtube pack shares the watermark's polarity: off is the universal
  // default, so only the wizard's ON tick emits — and a false must emit
  // nothing per the elision rule (the OFF spelling --no-youtube is
  // flags-only). The portrait rides only with a value: the wizard's empty
  // follow-up answer never sets the field, and a bare --portrait with no
  // path would be a commander error anyway.
  it("emits --youtube only for true, --portrait only with a path", () => {
    expect(produceArgv(answers({ extras: { youtube: true } }))).toEqual([
      "produce", "./take.mp4", "--youtube",
    ]);
    expect(produceArgv(answers({ extras: { youtube: false } }))).toEqual([
      "produce", "./take.mp4",
    ]);
    expect(
      produceArgv(answers({ extras: { youtube: true, portrait: "~/Pictures/me.jpg" } })),
    ).toEqual(["produce", "./take.mp4", "--youtube", "--portrait", "~/Pictures/me.jpg"]);
  });

  // The youtube follow-ups (thumbnail UX, 2026-08-16) share the portrait's
  // rule: only a value emits — the wizard already dropped empty answers, and
  // an unset field means "the config decides" per the elision rule.
  it("emits --audience and --thumbnail-brief only with values, in prompt order", () => {
    expect(
      produceArgv(
        answers({
          extras: {
            youtube: true,
            audience: "junior web devs",
            portrait: "/me.jpg",
            thumbnailBrief: "always show the terminal",
          },
        }),
      ),
    ).toEqual([
      "produce", "./take.mp4",
      "--youtube",
      "--audience", "junior web devs",
      "--portrait", "/me.jpg",
      "--thumbnail-brief", "always show the terminal",
    ]);
    expect(produceArgv(answers({ extras: { youtube: true, audience: "" } }))).toEqual([
      "produce", "./take.mp4", "--youtube",
    ]);
  });

  // Sound effects (2026-08-29) share the watermark's polarity — present is
  // ON, absent emits nothing — but the level decides the SPELLING. `normal`
  // is the CLI's own default, so it must never appear on the taught command
  // line: the bare `--sfx` says everything. The other two levels ride
  // `--sfx-level` ALONE, because that flag already implies `--sfx`
  // (program.ts's sfxFlag, the same rule replay-argv pins with) and the pair
  // would teach a redundant flag.
  it("emits --sfx for the normal level and --sfx-level alone for the others", () => {
    expect(produceArgv(answers({ graphics: true, extras: { sfx: "normal" } }))).toEqual([
      "produce", "./take.mp4", "--produce", "--sfx",
    ]);
    expect(produceArgv(answers({ graphics: true, extras: { sfx: "subtle" } }))).toEqual([
      "produce", "./take.mp4", "--produce", "--sfx-level", "subtle",
    ]);
    expect(produceArgv(answers({ graphics: true, extras: { sfx: "meme" } }))).toEqual([
      "produce", "./take.mp4", "--produce", "--sfx-level", "meme",
    ]);
  });

  // Unpicked means the field is never set, and an unset sfx must stay silent:
  // off is the default, and the config's `sfx` key is what decides for a
  // config-on user (there is no `--no-sfx` for the wizard to emit anyway).
  it("emits nothing for an unpicked sfx extra", () => {
    expect(produceArgv(answers({ graphics: true, extras: {} }))).toEqual([
      "produce", "./take.mp4", "--produce",
    ]);
  });

  // Jump cuts share captions' polarity: auto (unset) already punches, so
  // only the wizard's OFF tick may emit anything — and only the negative
  // spelling. `true` restates the default (and force is flags-only), so it
  // must emit nothing per the elision rule.
  it("emits --no-jump-cuts for jumpCuts: false, and nothing for true/unset", () => {
    expect(produceArgv(answers({ extras: { jumpCuts: false } }))).toEqual([
      "produce", "./take.mp4", "--no-jump-cuts",
    ]);
    expect(produceArgv(answers({ extras: { jumpCuts: true } }))).toEqual([
      "produce", "./take.mp4",
    ]);
    expect(produceArgv(answers())).toEqual(["produce", "./take.mp4"]);
  });
});
