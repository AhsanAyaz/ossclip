/**
 * What command.json must record: the argv of the parse that ACTUALLY ran
 * (§129).
 *
 * `produce` records its invocation into the workdir so the editor's Render
 * button can replay it byte for byte. It used to record `process.argv`,
 * which is the truth for exactly one entry point — a directly typed
 * `ossclip produce …`. The wizard has always BUILT a produce argv and
 * re-entered `program.parseAsync(["node", "ossclip", ...argv])`, and the
 * bare-path route does the same; in both, process.argv still holds the
 * ORIGINAL invocation — no `produce` literal, none of the wizard's answers —
 * so every re-entered run recorded a command that replays as
 * `ossclip <path> --llm …` and dies at commander's front door with
 * "error: unknown option '--llm'" (§129's field artifact). The re-entry
 * sites in program.ts stash the argv they are about to parse here; the
 * recording prefers the stash and falls back to process.argv, which keeps
 * the direct path byte-identical to what it always wrote.
 */

// Type-only, so no runtime edge back into produce.ts (which imports this
// module): the tri-state's vocabulary belongs to its resolver.
import type { JumpCutsMode } from "./produce";
// Type-only for the same reason: the level's own zod enum lives in core's
// producer half, and this module must stay a pure argv builder.
import type { SfxLevel } from "@ossclip/core";

let stashed: string[] | null = null;

/**
 * Called by every parseAsync re-entry in program.ts, immediately before the
 * parse, with the argv minus its ["node", "ossclip"] prefix. Copied so a
 * caller reusing its array cannot retroactively edit the record.
 */
export function setReplayArgv(argv: string[]): void {
  stashed = [...argv];
}

/**
 * Consume-on-read (§129): commander 12 keeps option state across parseAsync
 * calls (see the bare-`produce` refusal in program.ts), and a stash kept
 * across parses would be the same trap one layer up — a menu choice that
 * never reaches `produce` must not leave its argv behind for a later
 * recording in the same process to mistake for its own.
 */
export function consumeReplayArgv(): string[] | null {
  const argv = stashed;
  stashed = null;
  return argv;
}

/**
 * The args `produce` writes into command.json: the argv of the parse that
 * ran (stash for a re-entered wizard/bare-path run, process.argv for a
 * directly typed one), plus the §75/§93g pins. The pins guard on
 * `includes` so a flag the user actually typed — or a pin recorded by the
 * run a replay is re-running — is never appended twice.
 */
export function recordedProduceArgs(pins: {
  llm?: string;
  /** The RESOLVED §143 effort — flag or valid config, never a raw config string. */
  llmEffort?: "low" | "medium" | "high";
  clipWindow?: string;
  watermark?: boolean;
  /** The RESOLVED cover-overlay switch — config-dependent, so pinned both ways. */
  coverInVideo?: boolean;
  captions?: boolean;
  jumpCuts?: JumpCutsMode;
  /** The RESOLVED dictionary terms — pinned only when non-empty. */
  dictionary?: string[];
  youtube?: boolean;
  /** The RESOLVED portrait path — a path, never a secret. */
  portrait?: string;
  /** The RESOLVED audience text — pinned only when non-empty. */
  audience?: string;
  /** The RESOLVED thumbnail brief — pinned only when non-empty. */
  thumbnailBrief?: string;
  /** The RESOLVED `--sfx` switch (flag or config), pinned only when ON. */
  sfx?: boolean;
  /** The RESOLVED `--sfx-level`, pinned alongside an ON `sfx`. */
  sfxLevel?: SfxLevel;
}): string[] {
  // --review and --no-render are stripped at record (cut-review step 1):
  // command.json exists for exactly one consumer — the editor's Render
  // button, which replays this argv to produce the video — and a record
  // carrying --no-render would replay as a run that skips the render again,
  // while a recorded --review would ALSO spawn a second editor from inside
  // the replay child. Record the invocation the user wants Render to run.
  // Both are bare boolean flags, so a value-free filter cannot orphan an
  // option's argument.
  const args = (consumeReplayArgv() ?? process.argv.slice(2)).filter(
    (a) => a !== "--review" && a !== "--no-render",
  );
  if (pins.llm !== undefined && !args.includes("--llm")) {
    args.push("--llm", pins.llm);
  }
  // The effort pin (§143), the dictionary's rationale: the resolved level may
  // have come from ~/.ossclip/config.json's `llmEffort`, and it steers the
  // editorial call — an unpinned record would replay a DIFFERENT plan the
  // moment that config is edited. Unset stays unpinned: there is no flag
  // spelling for "agy's own default", and an argv without the flag replays as
  // "config decides" — the same accepted cost as the dictionary's empty case.
  if (pins.llmEffort !== undefined && !args.includes("--llm-effort")) {
    args.push("--llm-effort", pins.llmEffort);
  }
  if (pins.clipWindow !== undefined && !args.includes("--clip-window")) {
    args.push("--clip-window", pins.clipWindow);
  }
  // The watermark, pinned like §75 pinned the provider — in BOTH directions
  // (review, Important): the effective default is config-dependent, so "no
  // flag in the argv" does not replay identically everywhere. An off-record
  // left unpinned would silently GAIN a watermark the moment the replay runs
  // under a config-on (`~/.ossclip/config.json` edited later, or the editor's
  // Render on another machine) — the exact drift §75 exists to prevent, just
  // mirrored. So every record carries the RESOLVED state: `--watermark` when
  // on, `--no-watermark` when off, and a typed flag (already in the argv,
  // caught by the includes-guard) is never doubled. One flag per command.json
  // is the price; determinism is the contract, byte-identity of off-records
  // was only ever a nicety.
  if (pins.watermark !== undefined && !args.includes("--watermark") && !args.includes("--no-watermark")) {
    args.push(pins.watermark ? "--watermark" : "--no-watermark");
  }
  // The cover overlay, the watermark's rationale VERBATIM and for a live
  // reason, not future-proofing: its effective default is config-dependent
  // (`coverInVideo: true` in ~/.ossclip/config.json), so an unpinned record
  // would gain — or lose — an overlay on the first frames of the replayed
  // video the moment that config is edited, or the moment Render runs on
  // another machine. Both directions, includes-guarded on BOTH spellings so a
  // typed flag is never doubled.
  if (
    pins.coverInVideo !== undefined &&
    !args.includes("--cover-in-video") &&
    !args.includes("--no-cover-in-video")
  ) {
    args.push(pins.coverInVideo ? "--cover-in-video" : "--no-cover-in-video");
  }
  // The captions flag, pinned both ways like the watermark above — but here
  // as future-proofing plus consistency rather than a live bug: captions'
  // default is ON independent of any config today, so an argv without the
  // flag would currently replay identically everywhere. Pinned anyway
  // because (a) the watermark review already made "every record carries the
  // RESOLVED state" §75's rule, and one unpinned tri-state would turn
  // command.json's contract into per-flag trivia; and (b) the moment a
  // config key or a changed default ever appears, every unpinned old record
  // would silently re-resolve under it — the watermark's exact drift, just
  // deferred. Note this pins the FLAG's state only; the editor's
  // `captionsHidden` override is not folded in (see produce.ts's call site).
  if (pins.captions !== undefined && !args.includes("--captions") && !args.includes("--no-captions")) {
    args.push(pins.captions ? "--captions" : "--no-captions");
  }
  // The jump-cuts pin covers the two TYPED states only — force spells
  // --add-jump-cuts, off spells --no-jump-cuts, and either typed flag
  // settles the tri-state, so the includes-guard checks BOTH spellings
  // before appending either. "auto" stays UNPINNED, which is the captions
  // rationale run in reverse: there is no flag that SPELLS auto to pin
  // with, and with no config input today an argv carrying neither flag
  // replays as auto identically everywhere. The captions comment's warning
  // still applies — the day a jumpCuts config key lands, auto records made
  // after it must pin their resolved on/off like the watermark's, and the
  // old unpinned auto records are the accepted cost of a flag pair that
  // reserves both spellings for the typed states.
  if (
    pins.jumpCuts !== undefined &&
    pins.jumpCuts !== "auto" &&
    !args.includes("--add-jump-cuts") &&
    !args.includes("--no-jump-cuts")
  ) {
    args.push(pins.jumpCuts === "force" ? "--add-jump-cuts" : "--no-jump-cuts");
  }
  // The dictionary pin (review finding, F4 follow-up): the resolved terms may
  // have come from ~/.ossclip/config.json, and the dictionary feeds the
  // whisper prompt, the repair vouched set and caption casing — so an
  // unpinned record replays a DIFFERENT transcript the moment that config is
  // edited. Comma-joined into one value, the exact spelling `--dictionary`
  // takes (dictionaryFlag re-splits and trims on replay). Empty stays
  // unpinned: there is no flag spelling for "no terms", and `--dictionary ""`
  // would split to [] anyway — an argv without the flag replays as "config
  // decides", the accepted cost mirroring jump-cuts' unpinnable auto.
  if (pins.dictionary !== undefined && pins.dictionary.length > 0 && !args.includes("--dictionary")) {
    args.push("--dictionary", pins.dictionary.join(", "));
  }
  // The youtube pin — the watermark's rationale verbatim: its effective
  // default is config-dependent (`youtube: true` in ~/.ossclip/config.json),
  // so every record carries the RESOLVED state in BOTH directions, or a
  // later config edit silently changes what the editor's Render writes
  // beside the replayed video.
  if (pins.youtube !== undefined && !args.includes("--youtube") && !args.includes("--no-youtube")) {
    args.push(pins.youtube ? "--youtube" : "--no-youtube");
  }
  // The portrait pin: the resolved PATH (never a secret — the API key stays
  // in the environment), so a replay renders the thumbnail from the same
  // face the run did even after the config's `portrait` moves.
  if (pins.portrait !== undefined && !args.includes("--portrait")) {
    args.push("--portrait", pins.portrait);
  }
  // Audience and thumbnail-brief pins, the portrait's rationale exactly: the
  // resolved values may have come from ~/.ossclip/config.json, and both steer
  // LLM prompts (the youtube pack, the thumbnail concept) — an unpinned
  // record would replay different metadata after a config edit. Empty stays
  // unpinned, the dictionary's rule: there is no flag spelling for "no
  // steer", and an argv without the flag replays as "config decides".
  if (pins.audience !== undefined && pins.audience.length > 0 && !args.includes("--audience")) {
    args.push("--audience", pins.audience);
  }
  if (
    pins.thumbnailBrief !== undefined &&
    pins.thumbnailBrief.length > 0 &&
    !args.includes("--thumbnail-brief")
  ) {
    args.push("--thumbnail-brief", pins.thumbnailBrief);
  }
  // The sound-effect pins, the watermark's config-dependent-default rationale
  // on a pair of flags: `sfx`/`sfxLevel` are both config keys, so an unpinned
  // record replays a different amount of sound design — or none — the moment
  // that config is edited or the replay runs on another machine. It matters
  // more here than for the watermark: an editor render carries the REVIEWED
  // plan forward from production.json instead of re-placing (produce's
  // `priorSfxPlan`), so `--sfx` is what decides whether the sound design the
  // user just dragged into place is in the video at all.
  //
  // ON ONLY, and that is the jump-cuts "auto" case rather than the watermark's
  // both-directions rule: there is no `--no-sfx` spelling to pin an off-run
  // with (program.ts declares `--sfx` alone, so the config key can still
  // supply the default). An off-record replayed under a later config-on
  // therefore GAINS sound effects — the accepted cost of a flag with one
  // spelling, and the day `--no-sfx` exists this pin becomes unconditional
  // like the watermark's. `--sfx-level` implies `--sfx`, so a typed level in
  // the argv already settles the switch and the includes-guard leaves it be.
  if (pins.sfx === true) {
    if (!args.includes("--sfx") && !args.includes("--sfx-level")) args.push("--sfx");
    if (pins.sfxLevel !== undefined && !args.includes("--sfx-level")) {
      args.push("--sfx-level", pins.sfxLevel);
    }
  }
  return args;
}
