import type { ProviderName, SfxLevel } from "@ossclip/core";

/**
 * Wizard answers → the argv a user could have typed.
 *
 * This is the load-bearing shape of the whole interactive layer: the wizard
 * produces ARGUMENTS, not a ProduceOptions, so the zod parses in program.ts
 * stay the only validation path and the printed command is the executed one.
 */

export interface ProduceExtras {
  clip?: number;
  sourceFit?: "cover" | "contain";
  speaker?: string;
  whisperModel?: string;
  whisperLanguage?: string;
  // No `collapseRetakes` (2026-08-16): retake collapse runs automatically
  // with --blooper-marker (inferredRetakesEnabled, produce.ts), so the
  // wizard never emits the legacy --collapse-retakes flag — it survives only
  // as a parseable no-op for recorded command.json replays.
  blooperMarker?: string;
  sourceIsEdited?: boolean;
  /** Opt-in "made with ossclip" credit. The wizard only ever turns it ON —
   * off is the default, and a config-on user who wants it off for one run
   * types `--no-watermark`, a flags-only surface like --sort. */
  watermark?: boolean;
  /** Captions tri-state, the watermark's mirror image: ON is the default,
   * so the wizard only ever turns them OFF (`false` → `--no-captions`) and
   * the positive `--captions` stays flags-only — it exists for replay
   * pinning, and emitting it here would restate the default. */
  captions?: boolean;
  /** Jump-cut punch tri-state, captions' twin polarity: auto (unset) already
   * punches face-only takes, so the wizard only ever turns it OFF (`false` →
   * `--no-jump-cuts`) and the positive `--add-jump-cuts` stays flags-only —
   * it exists to beat a future config-off, and emitting it here would
   * restate the default. */
  jumpCuts?: boolean;
  /** Sound effects, the watermark's polarity with a level attached: PRESENT
   * means on (the wizard only ever turns it ON — off is the default, there is
   * no `--no-sfx` spelling to mirror, and a config-on user who wants silence
   * for one run edits the config's `sfx` key), and the value is whatever the
   * level follow-up answered. Typed as core's `SfxLevel`, not an inline
   * union, for `llm`'s reason: a level added to `SfxLevelSchema` must not be
   * silently unofferable here. Only reachable under graphics — sound effects
   * are placed against the producer's beat sheet, so `extrasFor` gates the
   * entry the way it gates `--clip`. */
  sfx?: SfxLevel;
  /** The YouTube pack (Y2): the wizard only ever turns it ON — off is the
   * default, and a config-on user who wants it off for one run types
   * `--no-youtube`, flags-only like `--no-watermark`. */
  youtube?: boolean;
  /** Portrait photo path for the pack's AI thumbnail — the youtube entry's
   * follow-up prompt; empty answers never reach here (the wizard skips the
   * flag and the frame-grab cover stands). */
  portrait?: string;
  /** Who the channel is for — the youtube entry's first follow-up, skipped
   * when the config's `audience` already answers it. Empty answers never
   * reach here (default-elision: the config decides). */
  audience?: string;
  /** The durable thumbnail steer — the youtube entry's optional follow-up;
   * empty answers never reach here, same elision as `audience`. */
  thumbnailBrief?: string;
  /** core's ProviderName, not an inline union — a provider added there must
   * not be silently unofferable here (the pre-§132 union had already
   * drifted: it never listed "antigravity"). */
  llm?: ProviderName;
}

export interface ProduceAnswers {
  input: string;
  aspect: "9:16" | "16:9";
  cleanup: "exact" | "light" | "standard" | "aggressive";
  graphics: boolean;
  intent?: string;
  out?: string;
  /**
   * Review the cut in the editor instead of rendering now (§148). A main-flow
   * answer like `graphics`, not an extra: it decides what the run DOES, and
   * burying it in "Anything else?" would hide it from the people the wizard
   * exists for. The only answer whose wizard default (review) differs from
   * the CLI's (render) — which costs nothing here, because the elision rule
   * below keys off the CLI default, not off what the prompt preselected.
   */
  review?: boolean;
  extras: ProduceExtras;
}

export function produceArgv(a: ProduceAnswers): string[] {
  const argv = ["produce", a.input];

  // A flag whose value equals the default is NEVER emitted. A wizard run
  // where every answer was the default must teach `ossclip produce <file>`
  // and nothing more — anything longer becomes a command line the user
  // copies forever without knowing which parts mattered.
  if (a.aspect !== "9:16") argv.push("--aspect", a.aspect);
  if (a.cleanup !== "standard") argv.push("--cleanup", a.cleanup);
  if (a.out) argv.push("--out", a.out);
  // Rendering is the CLI's default, so only reviewing is worth saying — the
  // rule above is about the DEFAULT, not about which option the prompt
  // preselected. --out still travels either way: nothing renders now, but the
  // editor's Render button replays command.json, and that is where out lands.
  if (a.review === true) argv.push("--review");

  if (a.graphics) {
    argv.push("--produce");
    // Intent feeds the producer brain, which only runs under --produce —
    // emitting it alone would be a flag with nothing to act on.
    if (a.intent) argv.push("--intent", a.intent);
  }

  const e = a.extras;
  if (e.clip !== undefined) argv.push("--clip", String(e.clip));
  if (e.sourceFit === "contain") argv.push("--source-fit", "contain");
  if (e.speaker) argv.push("--speaker", e.speaker);
  if (e.whisperModel) argv.push("--whisper-model", e.whisperModel);
  // Empty answer means "whisper's default (en)" — the elision rule above:
  // no flag whose value equals the default.
  if (e.whisperLanguage) argv.push("--whisper-language", e.whisperLanguage);
  if (e.blooperMarker) argv.push("--blooper-marker", e.blooperMarker);
  if (e.sourceIsEdited === true) argv.push("--source-is-edited");
  if (e.watermark === true) argv.push("--watermark");
  // Strict `=== false` (never `!e.captions`): undefined means "the default,
  // on" and must emit nothing per the elision rule above.
  if (e.captions === false) argv.push("--no-captions");
  // Same strict rule: only the wizard's OFF tick emits, and only the
  // negative spelling — auto must stay an ABSENT flag, or the taught
  // command line restates a default.
  if (e.jumpCuts === false) argv.push("--no-jump-cuts");
  // One flag, never both: `--sfx-level` already implies `--sfx` (program.ts's
  // `sfxFlag`), which is why replay-argv pins a level WITHOUT the switch too —
  // emitting the pair would teach a flag that changes nothing. And `normal` is
  // the CLI's own default, so naming it would restate a default per the
  // elision rule above: a normal-level run's whole sound design is `--sfx`.
  if (e.sfx === "normal") argv.push("--sfx");
  else if (e.sfx !== undefined) argv.push("--sfx-level", e.sfx);
  // Watermark's shape: only the ON tick emits (off is the default, elided),
  // and the portrait only rides along with a value — the wizard already
  // dropped empty answers.
  if (e.youtube === true) argv.push("--youtube");
  // The youtube follow-ups ride only with a value, portrait's exact rule:
  // the wizard already dropped empty answers, and an unset field means "the
  // config decides" — emitting a bare flag would be a commander error.
  if (e.audience) argv.push("--audience", e.audience);
  if (e.portrait) argv.push("--portrait", e.portrait);
  if (e.thumbnailBrief) argv.push("--thumbnail-brief", e.thumbnailBrief);
  if (e.llm) argv.push("--llm", e.llm);

  return argv;
}
