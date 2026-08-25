import { z } from "zod/v4";
import {
  LayoutSchema,
  SceneAnchorSchema,
  SceneComponentIdSchema,
  ThemeSchema,
  type SceneAnchor,
  type SceneCue,
  type SceneComponentId,
  type Theme,
} from "./scene-schema";
import { RemovalReasonSchema } from "./schema";
import { resolveSceneProps } from "./scene-registry";
import type { CaptionLine, CaptionWord } from "./captions";

/**
 * The user's edit layer (SPEC: direct manipulation).
 *
 * Kept in its OWN file, never in production.json: that document is derived and
 * every `produce` run overwrites it, so a user layer stored there would
 * evaporate on the next run. Separation is what lets the producer re-roll
 * `props` while hand edits survive — the merge rule from BRAINSTORM §4.6.
 */

export const ElementTransformSchema = z.object({
  dx: z.number().optional(),
  dy: z.number().optional(),
  scale: z.number().positive().optional(),
  /**
   * The element is deleted — SOFTLY (PLAN Task 2, one level down from
   * `SceneOverrideSchema.hidden` below): `editStyle`
   * (packages/scenes/src/editable.ts) suppresses it at the one chokepoint
   * every component's leaf renders its edit style through, so no
   * per-component change is needed and the remaining siblings close the
   * gap on their own — the same delete semantics a whole SCENE gets,
   * scoped to one of its elements. The backing array
   * (`props.messages`/`lines`/`nodes`/`items`) is never touched — ids are
   * positional, so hiding `message-1` can't renumber `message-2` out from
   * under its own edits.
   */
  hidden: z.boolean().optional(),
});
export type ElementTransform = z.infer<typeof ElementTransformSchema>;

export const SceneOverrideSchema = z.object({
  /** Merged over the producer's props, key by key. */
  props: z.record(z.string(), z.unknown()).default({}),
  /** Per-element nudges, keyed by the component's `data-edit-id`. */
  elements: z.record(z.string(), ElementTransformSchema).default({}),
  /**
   * Absolute output time. Setting this PINS the scene: it stops tracking the
   * words it was anchored to, which is why the UI has to say so out loud.
   */
  timing: z.object({ startSec: z.number().nonnegative(), endSec: z.number().nonnegative() }).optional(),
  /**
   * Component/layout swaps (design spec Scope: v1 in-scope). Optional — most
   * scenes never touch these — and validated against the same enums the
   * producer itself is constrained to, so an override can't name a component
   * or layout that doesn't exist in the registry.
   */
  component: SceneComponentIdSchema.optional(),
  layout: LayoutSchema.optional(),
  /**
   * How the VIDEO sits inside this scene's slot, when the automatic
   * face-aware crop gets it wrong.
   *
   * The motivating case: a `pip-bubble` fed a portrait canvas is cover-cropped
   * width-first, which puts the head at ~120% of the circle's diameter — and
   * that ratio is fixed no matter how large the bubble is, so no constant can
   * fix it. Zooming out inside a round mask would leave crescent gaps, so the
   * automatic path leaves it and this is the escape hatch: `scale` below 1
   * shows more of the source (the gap fills with the stage backdrop), `dy`
   * nudges the crop up or down.
   *
   * Deliberately per SCENE, not global: it is a property of one layout meeting
   * one moment's framing, which is exactly what the editor is for.
   */
  video: z
    .object({
      scale: z.number().positive().max(4).optional(),
      dy: z.number().optional(),
      dx: z.number().optional(),
      /** `false` switches the automatic idle-zoom layer off for this scene. */
      autoZoom: z.boolean().optional(),
    })
    .optional(),
  /**
   * The pip bubble's mask roundness and placement (R14 §52) — mirrors
   * `SceneCueSchema.pip`, validated here because this is the hand-editable
   * layer. Per scene like `video`: it is one bubble meeting one moment's
   * staging. Ignored unless the scene's resolved layout is `pip-bubble`, so
   * it survives a layout round-trip instead of bending other layouts.
   */
  pip: z
    .object({
      cornerRadius: z.number().min(0).max(1).optional(),
      x: z.number().min(0).max(1).optional(),
      y: z.number().min(0).max(1).optional(),
    })
    .optional(),
  /**
   * Vertical centre for this scene's captions (R15 §56). NOT part of the
   * top-level `captions` key — that one is the caption TEXT retype map,
   * keyed per word; position is a property of the SCENE, where the timeline
   * selection can address it and "apply to all" can fan it out.
   */
  captionY: z.number().min(0).max(1).optional(),
  /** Caption size multiplier (R16 §64) — same per-scene, fan-out-able shape
   * as `captionY`, and the same reasoning for living on the scene. */
  captionScale: z.number().min(0.2).max(3).optional(),
  /**
   * The graphic slot, reshaped by hand (PLAN 2026-07-31 Task 2) — frame
   * fractions like every other rect. Validated HERE even though
   * `SceneCueSchema.graphicRect` is not: this one is hand-editable user
   * data, and §35's lesson is that validators are the constraint. The
   * renderer additionally clamps into the platform-safe area at draw time.
   */
  graphicRect: z
    .object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      w: z.number().min(0.08).max(1),
      h: z.number().min(0.05).max(1),
    })
    .optional(),
  /**
   * The word range of the cue this edit was made against, stamped by the
   * editor at save time (stampSceneAnchors). This is the edit's IDENTITY
   * across a re-plan: ids are positional (`scene-${i}`) and a re-plan can
   * hand an id to a different moment — matching on the anchor instead is
   * what stops that edit landing there silently (handoff-edit-anchoring).
   * Optional: docs written before this field keep id-only behaviour, the
   * same no-retroactive-protection posture §137 took for captions.
   */
  anchor: SceneAnchorSchema.optional(),
  /**
   * The scene is deleted — SOFTLY (PLAN 2026-07-30 Task C): the cue drops
   * from the render (`dropHiddenCues`) and its window becomes a plain take,
   * but the plan still has the scene and the timeline shows a restorable
   * ghost. Restore DELETES this key rather than writing `false`, matching
   * `clearVideo`/`clearTiming`: an explicit `hidden: false` would still be
   * an override with nothing to say.
   */
  hidden: z.boolean().optional(),
});
export type SceneOverride = z.infer<typeof SceneOverrideSchema>;

/**
 * One retyped caption word (PLAN 2026-07-29 Task 7, scope (a) — decided with
 * the author: 1:1 in-place retype, timing untouched).
 *
 * Keyed by the word's SOURCE time since §137 (`captionKeyFor` below — the
 * original positional key is what a user cut broke), GUARDED by the text that
 * was there when the edit was made — the same verification-anchor pattern as
 * `AppliedRepair.heard` (§17). Captions are derived (repaired transcript
 * through the TimeMap), so a changed cleanup level or repair set can still
 * re-word the stream under an anchor that survived; the guard means a stale
 * edit is DROPPED WITH A LOG rather than silently landing on the wrong word.
 */
export const CaptionEditSchema = z.object({
  /** The replacement text. */
  text: z.string().min(1).max(80),
  /** The word this edit replaced — the stale-index guard. */
  was: z.string(),
});
export type CaptionEdit = z.infer<typeof CaptionEditSchema>;

/**
 * A free-text rewrite of a contiguous caption word RUN (2026-08-18) — the one
 * deliberate relaxation of the 1:1 retype contract, for range edits only.
 * Single-word retype (`CaptionEditSchema` above) is untouched, and
 * `transcript.words` is NEVER spliced — scene anchors are raw indices into it
 * — so everything happens on the derived `CaptionLine[]`
 * (`applyCaptionRangeEdits` below).
 *
 * Endpoints are anchored by §137 source-time keys (`captionKeyFor`), so a
 * user cut elsewhere cannot shift the run. `was` is the NFC-normalized,
 * space-joined BASE text of the run — the `captionEditWas` base-truth rule,
 * run-wide: the reducer scrubs every per-word retype inside the interval in
 * the same commit that stores the entry, so the run `applyCaptionRangeEdits`
 * reads at apply time IS the base run, and a live (post-retype) join would
 * fail the guard forever. A WHOLE-RUN stale guard: if any word in the run is
 * re-worded or cut later, the entire edit is reported dropped, never
 * partially guessed at. Identity is the `(fromKey, toKey)`
 * pair — retyping the run back to its `was` DELETES the entry (the
 * clearVideo/`patchCaption` rule). An array like `cuts`, `.default([])` so
 * every pre-existing overrides.json parses byte-identically. NEVER
 * legacy-keyed: the field postdates §137, so `migrateCaptionKeys` must not
 * process it — there are no positional range edits to upgrade.
 */
export const CaptionRangeEditSchema = z.object({
  fromKey: z.string().regex(/^w\d+$/),
  toKey: z.string().regex(/^w\d+$/),
  text: z.string().min(1).max(400),
  was: z.string(),
});
export type CaptionRangeEdit = z.infer<typeof CaptionRangeEditSchema>;

/**
 * The `was` a caption edit should store (R15 §59). The FIRST edit's `was` is
 * the base truth (the word as transcribed); every later re-edit of the same
 * index sees the LIVE (already-edited) text, and storing that as `was` would
 * make `applyCaptionEdits`' stale-guard drop the edit against the base lines.
 * Preserving the existing entry's `was` keeps the guard anchored to the base
 * — and makes "retyped back to the original" detectable, which is when the
 * override should clear entirely.
 */
export function captionEditWas(
  captions: Record<string, CaptionEdit>,
  key: string,
  seen: string,
): string {
  return captions[key]?.was ?? seen;
}

/**
 * The `was` a RANGE edit should store — `captionEditWas` for the
 * `(fromKey, toKey)` pair. The first edit's `was` is the base truth; a
 * re-edit of the SAME run (its endpoints are re-minted verbatim, see
 * `applyCaptionRangeEdits`' srcStart minting) sees the LIVE, already-rewritten
 * text, and storing that as `was` would stale the guard against the base
 * lines the next apply runs on. Preserving the existing pair's `was` keeps
 * the guard anchored to the base — and makes "retyped back to the original"
 * detectable, which is when the entry should clear entirely.
 */
export function captionRangeEditWas(
  rangeEdits: readonly CaptionRangeEdit[],
  fromKey: string,
  toKey: string,
  seen: string,
): string {
  return rangeEdits.find((e) => e.fromKey === fromKey && e.toKey === toKey)?.was ?? seen;
}

/**
 * The id a pre-§137 split gets when it is upgraded: the output milliseconds of
 * whatever `at` the file holds NOW.
 *
 * Load-bearing for the migration — a saved doc hiding `scene-0@600` should
 * still match that half after the upgrade — but ONLY for a doc that has not
 * already been through a re-anchoring produce run, and the distinction is not
 * cosmetic (final review, Important 3). `at` is the one thing a re-cut moves,
 * so on a doc the §137 bug already damaged this reproduces the CURRENT time,
 * not the original: the field workdir's live `overrides.json` holds
 * `splits: [0]`, mints id `"0"`, and its saved `scene-0@600` matches nothing.
 * There is no better derivation available — the original ms is genuinely gone
 * from a re-anchored file, and nothing on disk records it — so the honest
 * statement is that a doc damaged BEFORE this fix landed cannot recover its
 * split-half overrides, and only `overrides.json.bak` can (which is why
 * `produce`'s write gate must not spend it; final review, Critical 2).
 */
export function legacySplitId(at: number): string {
  return String(Math.round(at * 1000));
}

export const SplitSchema = z.union([
  // `.finite()` is stated rather than assumed. JSON has no Infinity literal
  // but an overflowing one (`1e400`) parses to it, and a non-finite `at`
  // would derive `id: "Infinity"` — one shared name for every such split,
  // the same garbage-derived-key failure `captionKeyFor` refuses for caption
  // words. zod v4's `z.number()` already rejects non-finite where v3's did
  // not, so this is a requirement written down at the site instead of a
  // default that has already changed once underneath this file.
  z.object({ at: z.number().finite().nonnegative(), id: z.string().min(1) }),
  // Legacy: a bare number, upgraded in place so every overrides.json written
  // before §137 parses and keeps its split-half overrides attached.
  z.number().finite().nonnegative().transform((at) => ({ at, id: legacySplitId(at) })),
]);
export type Split = z.infer<typeof SplitSchema>;

/**
 * A split id that no split in `existing` already holds.
 *
 * Uniqueness is load-bearing (§137): the id is the ONLY thing tying an
 * override to a split half — `splitCues` names the half `${rootId}@${id}` and
 * `dropHiddenCues` filters on that exact string — so two splits sharing an id
 * mint two cues with one name, and deleting one half deletes both, as does
 * any framing or timing edit on it.
 *
 * Decoupling `id` from `at` is what made this reachable. While the id was
 * recomputed from the time, two ids could only collide if two splits sat
 * within 0.5ms of each other, which `SPLIT_MIN_PIECE_SEC` forbids. Now a
 * split minted at 1.2s and re-anchored to 0.6s by a re-cut still holds
 * `"1200"`, so ⌘B at 1.2s again asks for an id that is taken — and
 * `addSplit`'s dedupe cannot see it, because that compares `at` and 0.6 is
 * nowhere near 1.2.
 *
 * The suffix is a COUNTER, deliberately, not a nonce or a timestamp: this
 * value is persisted in the user's `overrides.json` and names a cue, so it
 * has to be reproducible from the doc alone.
 */
export function mintSplitId(at: number, existing: readonly Split[]): string {
  const base = legacySplitId(at);
  const taken = new Set(existing.map((s) => s.id));
  if (!taken.has(base)) return base;
  // Starts at 2 so the first collision reads as "the second `1200`".
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export const OverrideDocSchema = z.object({
  /** Global style tokens — the look is a system, so these are not per-element. */
  theme: ThemeSchema.partial().default({}),
  /**
   * Captions OFF for the whole video. Doc-global like `theme`, deliberately
   * NOT a per-scene key: visibility is one decision about the output —
   * `captionY`/`captionScale` (per scene, above) style captions, this one
   * removes the track. Optional with NO default so every overrides.json
   * written before the key existed parses byte-identically; absent means
   * visible, and the editor DELETES the key rather than writing `false`
   * (the clearVideo/restoreScene rule — an explicit false is still an
   * override with nothing to say). Produce ORs this with `--no-captions`
   * (`resolveCaptionsHidden`, apps/cli/src/produce.ts): either surface can
   * hide, neither can force captions back on over the other.
   */
  captionsHidden: z.boolean().optional(),
  scenes: z.record(z.string(), SceneOverrideSchema).default({}),
  /** Retyped caption words, keyed by the word's source time (§137). */
  captions: z.record(z.string(), CaptionEditSchema).default({}),
  /**
   * Per-word caption HIDES ("delete word from captions") — non-destructive:
   * the word stays in the transcript and in the video's audio; only the
   * rendered caption drops it. Keyed by the word's source time
   * (`captionKeyFor`, §137) like `captions` above, so a user cut never
   * shifts a hide onto a different word. `was` is the LIVE (post-retype)
   * text at hide time — hides apply AFTER retypes (`applyCaptionLayers`
   * below) — the same stale-guard contract as `CaptionEditSchema.was`:
   * a re-derived stream under a surviving anchor drops the hide WITH A
   * REPORT rather than deleting the wrong word. Restore DELETES the key
   * (the restoreScene/captionsHidden rule — an entry with nothing to say is
   * still an override), and `.default({})` keeps every pre-existing
   * overrides.json parsing byte-identically. This field NEVER existed in
   * the legacy positional-key era, so `migrateCaptionKeys` must NOT process
   * it — there are no legacy hides to upgrade.
   */
  captionWordsHidden: z.record(z.string(), z.object({ was: z.string() })).default({}),
  /**
   * Multi-word free-text rewrites — see `CaptionRangeEditSchema` for the
   * whole contract (endpoint anchoring, the whole-run `was` guard, identity
   * by pair, why it is never legacy-keyed). Applied between per-word retypes
   * and hides (`applyCaptionLayers`).
   */
  captionRangeEdits: z.array(CaptionRangeEditSchema).default([]),
  /**
   * Per-LINE caption TIMING nudges — "when does this caption appear, and when
   * does it leave". Stored as DELTAS against the DERIVED window (`lead` moves
   * the line's OPENING seam, `tail` its CLOSING seam), keyed by the LINE's
   * FIRST WORD's SOURCE time (`captionKeyFor`, §137). Deltas over source keys
   * make the record recut-immune for free: a recut rebuilds every derived
   * `start`/`end` through the new TimeMap and the deltas simply re-apply on
   * top — zero work in `remapOverridesThroughRecut`, the same property every
   * other caption record leans on (captions.ts:14-20: `srcStart` is the one
   * field a re-cut cannot move). Restore DELETES the key, and a patch whose
   * deltas are both under 1ms in magnitude also deletes (the clearVideo/
   * patchCaption clear-override rule — a nudge of nothing is still an
   * override). `.default({})` keeps every pre-existing overrides.json parsing
   * byte-identically, and the field NEVER existed in the legacy
   * positional-key era, so `migrateCaptionKeys` must not process it.
   *
   * PER LINE, NOT PER WORD, and that is the whole point of the field. It
   * replaces `captionWordTiming` (deleted 2026-08-18), which stored the same
   * shape against individual WORDS and was measured to be MATHEMATICALLY
   * INERT: on a live workdir (117 lines / 301 words) 116/116 inter-line gaps
   * were exactly 0.0, 184/184 intra-line word boundaries exactly 0.0,
   * `line.start === words[0].start` 117/117 and `line.end === lastWord.end`
   * 117/117 — `transcribe.ts` chains words (`next.start = w.end`) and
   * `captions.ts:203-213`'s hold pass clamps each line's end to the next
   * line's start, so the caption stream is a GAP-FREE PARTITION. A per-word
   * clamp of `[max(lineStart, prevEnd), min(lineEnd, nextStart)]` therefore
   * collapsed to exactly `[w.start, w.end]` for EVERY word: the user dragged,
   * every stored delta came back zero, and the reducer's sub-ms rule deleted
   * them again. Do not reintroduce word-level clamping against a packed
   * stream. Word stamps also only drive the karaoke highlight INSIDE a line's
   * `<Sequence>` window (CaptionTrack.tsx:228-229, 387) — "when a caption
   * appears" IS `line.start`/`line.end`, so timing has to move LINE windows.
   * The ±30s range is per SEAM, which is why it is wider than the old
   * per-word ±10s: a line may be dragged well clear of its neighbours, and
   * `applyCaptionLineTiming`'s sweep — not the schema — is what keeps seams
   * ordered and inside the track.
   */
  captionLineTiming: z
    .record(
      z.string(),
      z.object({
        lead: z.number().min(-30).max(30),
        tail: z.number().min(-30).max(30),
      }),
    )
    .default({}),
  /**
   * Scene split points. `at` is ABSOLUTE output seconds (R16 §61 — Cmd/Ctrl+B
   * at the playhead) and moves when a re-cut re-anchors the doc; `id` is
   * minted once when the split is created and NEVER recomputed (§137). The
   * split half is named `${rootId}@${id}`, so re-anchoring `at` cannot rename
   * the half out from under a `hidden` (or any other) override on it — the
   * bug that resurrected a deleted scene in the field case.
   *
   * `at` stays time-anchored rather than scene-anchored on purpose: a re-plan
   * can rename or move scenes, and WHERE to cut is a decision about a MOMENT
   * of the output. Applied by `splitCues` after the plain fill, so a split
   * lands on graphic cues and takes alike.
   */
  splits: z.array(SplitSchema).default([]),
  /**
   * User cuts — ranges of the OUTPUT to remove, in the output seconds of the
   * CURRENT render-props (what the user saw when they cut) (PLAN 2026-08-04
   * Task 4). Optional-with-default like `splits` above, so an `overrides.json`
   * written before this field existed still parses unchanged. Consumed by
   * `produce.ts` (subtracted from the automatic cutlist's keep-spans) and by
   * `recut.ts`'s `remapOverridesThroughRecut`, which re-anchors every OTHER
   * absolute-output-seconds value in this doc through the resulting re-cut —
   * see that module's docstring for why a bare "shift everything after the
   * cut point" is not the actual rule.
   *
   * `src` (review fix wave, PLAN 2026-08-04 Task 4): a cut's `startSec`/
   * `endSec` alone are meaningless without knowing WHICH render-props they
   * were drawn against — a bare output-seconds pair has no faithful
   * representation once its own cut has happened (Task 4b's Bug A: remapping
   * it through the very recut it caused collapses it to a zero-width point).
   * `src` is the cut's resolved SOURCE-time range, computed once — the first
   * produce run that sees a `src`-less cut resolves it against the
   * render-props the user was looking at, and the write-back records it here
   * — and used directly, unconverted, on every run after that. `startSec`/
   * `endSec` are left exactly as the user drew them even once `src` exists:
   * a historical record of what render-props they were looking at, never
   * authoritative again once `src` is present.
   *
   * The editor (PLAN 2026-08-04 Task 4c) MUST NEVER WRITE OR
   * PRESERVE-AND-MODIFY `src` ITSELF — resolving it is produce's job alone.
   * Creating a cut writes ONLY `{startSec, endSec}`; if a cut's range is
   * ever edited/moved (not currently exposed, but the rule holds for any
   * future gesture that would), its `src` is DELETED rather than carried
   * forward, so the next produce re-resolves it against the render-props
   * current at that point rather than an anchor drawn for a range that no
   * longer means the same thing; Restore removes the WHOLE entry, `src`
   * included — there is no "not cut" state for one array entry to hold.
   */
  cuts: z
    .array(
      z.object({
        startSec: z.number().nonnegative(),
        endSec: z.number().nonnegative(),
        src: z
          .object({ startSec: z.number().nonnegative(), endSec: z.number().nonnegative() })
          .optional(),
      }),
    )
    .default([]),
  /**
   * The user's VETO over the automatic cutlist (cut review step 3). `cuts`
   * above is the user ADDING a removal; this is the user DECLINING one the
   * pipeline proposed — opposite directions, deliberately not merged.
   * Consumed by `applyCleanupChoices` (cutlist.ts, which owns the matching
   * semantics), in produce and in the editor alike.
   *
   * `reasons` are the category master switches ("keep all pauses"). Only
   * `false` is ever WRITTEN — a `true` entry restates the default, and the
   * editor DELETES the key instead (the `hidden`/`captionsHidden` rule: an
   * override with nothing to say). A `true` on disk is still parsed and
   * means default, tolerantly. `user` and `clip` keys parse but are inert
   * (`cleanupVetoable`): declining your own cut is Restore on the cut, and
   * "keeping" the --clip window's removal would silently un-clip the video.
   *
   * `kept` are individual vetoes, in SOURCE seconds — and that anchoring is
   * the whole trick, same as `cuts[].src` above: a bare output-seconds pair
   * is meaningless once its own re-cut has happened, while source time is
   * stable across every re-cut. This layer is therefore RECUT-IMMUNE BY
   * CONSTRUCTION and — unlike `splits` and `scenes[*].timing` — needs NO
   * entry in `remapOverridesThroughRecut`. Matching against the (possibly
   * re-produced) cutlist is by OVERLAP, never float equality of endpoints;
   * `vetoedRemovals` (cutlist.ts) states why.
   *
   * Optional-with-default like `splits`/`cuts`, so every overrides.json
   * written before the key existed parses byte-identically; absent means
   * today's behaviour exactly.
   */
  cleanup: z
    .object({
      reasons: z.partialRecord(RemovalReasonSchema, z.boolean()).default({}),
      kept: z
        .array(z.object({ srcIn: z.number().nonnegative(), srcOut: z.number().nonnegative() }))
        .default([]),
    })
    .default({ reasons: {}, kept: [] }),
});
export type OverrideDoc = z.infer<typeof OverrideDocSchema>;

export const emptyOverrideDoc = (): OverrideDoc => OverrideDocSchema.parse({});

export interface AppliedOverrides {
  cues: SceneCue[];
  /** Scene ids the document mentions that the current plan no longer has. */
  orphans: string[];
}

/**
 * Merge the user's layer onto assembled cues.
 *
 * Orphans are REPORTED rather than dropped quietly: after a re-plan, edits
 * pointing at scenes that no longer exist are the user's lost work, and
 * silence would make it look like the editor forgot them.
 */
/**
 * Props for a scene whose COMPONENT the user just swapped.
 *
 * The producer's `cue.props` were written for the OLD component and are not
 * merged in here at all — they were shaped for a different schema (a
 * `StatCard`'s `value`/`label` mean nothing to a `FlowDiagram`) and passing
 * them through would either fail validation or silently satisfy it with
 * garbage. Falling back to the NEW component's `defaultProps` — same base
 * `resolveSceneProps` always starts from — renders something coherent
 * instead. `resolveSceneProps` returning null (an override value that fits
 * no schema at all) still can't drop the scene: the registry's own
 * `defaultProps` are the floor every component is built to satisfy on their
 * own, so that's the guaranteed-valid fallback.
 */
function resolveSwappedProps(
  component: SceneComponentId,
  propsOverride: Record<string, unknown>,
): Record<string, unknown> {
  return (
    resolveSceneProps(component, {}, propsOverride) ??
    // The override didn't fit the new schema at all — fall back to the
    // registry's OWN defaults with nothing layered on top, run back through
    // `resolveSceneProps` (rather than the raw `defaultProps` object) so
    // zod-defaulted fields (e.g. `emphasizeLast`) are filled in the same way
    // every other resolved cue's props are. `defaultProps` is guaranteed to
    // validate on its own — every component in the registry is built on that
    // invariant — so this can never itself return null.
    resolveSceneProps(component, {}, {})!
  );
}

/**
 * The override entry a cue resolves against: its own, layered over its split
 * ROOT's (R16 §68). A split half is still the same scene — captions scaled
 * on the original must render scaled on both halves — so `id@<split id>`
 * inherits everything from `id` (the suffix is the split's own minted id since
 * §137, not a time), with two exceptions that describe the WHOLE original
 * rather than a piece of it: `timing` (the root's absolute window would undo
 * the split) and `hidden` (deleting the original is not deleting one half).
 * The half's OWN entry wins key by key, and the record-shaped keys merge
 * field-wise so nudging one field on a half doesn't drop the rest of what it
 * inherited.
 */
function effectiveOverride(
  scenes: Record<string, SceneOverride>,
  id: string,
): SceneOverride | undefined {
  const own = scenes[id];
  const at = id.indexOf("@");
  if (at === -1) return own;
  const root = scenes[id.slice(0, at)];
  if (!root) return own;
  const { timing: _timing, hidden: _hidden, ...base } = root;
  if (!own) return { ...base, props: { ...base.props }, elements: { ...base.elements } };
  return {
    ...base,
    ...own,
    props: { ...base.props, ...own.props },
    elements: { ...base.elements, ...own.elements },
    ...(base.video || own.video ? { video: { ...base.video, ...own.video } } : {}),
    ...(base.pip || own.pip ? { pip: { ...base.pip, ...own.pip } } : {}),
  };
}

export function applyOverrides(cues: readonly SceneCue[], doc: OverrideDoc): AppliedOverrides {
  const ids = new Set(cues.map((c) => c.id));
  const orphans = Object.keys(doc.scenes).filter((id) => !ids.has(id));
  const out = cues.map((cue) => {
    const o = effectiveOverride(doc.scenes, cue.id);
    if (!o) return cue;
    const swapped = o.component !== undefined && o.component !== cue.component;
    const component = o.component ?? cue.component;
    const props =
      o.component !== undefined && swapped
        ? resolveSwappedProps(o.component, o.props)
        : { ...cue.props, ...o.props };
    // A rect `routeAroundSourceText` baked into the base cue was computed
    // FOR that cue's original layout — under a layout override it would
    // silently keep winning over the new layout's slot, parking the graphic
    // where the OLD layout needed it. Same reason the editor's `patchLayout`
    // drops the override rect on a swap. A hand-set `o.graphicRect` is the
    // user's own placement and still wins below.
    const layoutSwapped = o.layout !== undefined && o.layout !== cue.layout;
    const { graphicRect: _staleRouted, ...cueSansRoutedRect } = cue;
    return {
      ...(layoutSwapped ? cueSansRoutedRect : cue),
      component,
      layout: o.layout ?? cue.layout,
      props,
      ...(Object.keys(o.elements).length > 0 ? { elements: o.elements } : {}),
      ...(o.video ? { video: o.video } : {}),
      ...(o.pip ? { pip: o.pip } : {}),
      ...(o.captionY !== undefined ? { captionY: o.captionY } : {}),
      ...(o.captionScale !== undefined ? { captionScale: o.captionScale } : {}),
      // After ...cue, so a hand-set rect WINS over one routeAroundSourceText
      // baked into the base cues.
      ...(o.graphicRect ? { graphicRect: o.graphicRect } : {}),
      // Never onto an ALREADY-pinned cue (R16 §68): the second override pass
      // runs after `splitCues`, and re-applying a pinned scene's original
      // window to its first half — which kept the scene's id — would undo
      // the cut and overlap the second half. An unsplit pinned cue skips a
      // byte-identical re-application; a not-yet-pinned cue pins as before.
      ...(o.timing && !cue.pinned
        ? { startSec: o.timing.startSec, endSec: o.timing.endSec, pinned: true }
        : {}),
    };
  });
  return { cues: out, orphans };
}

/**
 * A split half shorter than this is a slip, not an edit — the split is
 * ignored rather than minting an unusably thin cue. Exported so the editor
 * can refuse the keystroke up front instead of silently no-opping.
 */
export const SPLIT_MIN_PIECE_SEC = 0.3;

/**
 * Cut cues at the stored split points (R16 §61).
 *
 * Both halves keep everything but their window; the half STARTING at the
 * split takes the id `${rootId}@${split.id}` — named by the split's OWN
 * minted id (§137), so edits on it stay attached while the split exists,
 * survive further splits of the same original cue, and are reported as
 * orphans (never misapplied) if the split is removed. The id used to be
 * recomputed from the split's CURRENT start time, which meant a re-cut
 * re-anchoring `at` renamed the half and orphaned every override on it —
 * the field case where a deleted scene came back after a 0.6s cut.
 * Runs AFTER `fillPlainCues` so takes split like scenes do, and
 * BEFORE the final override pass so the halves' own edits (framing, timing,
 * elements) land on them. A split that misses every cue — after a re-plan
 * moved the material — is skipped; the time stays in the doc, harmless.
 * NOTE for graphic halves: the second half re-enters through its component's
 * intro animation (a Sequence restarts at its own frame 0) — acceptable for
 * the feature's real use, cutting takes and re-timing halves.
 */
export function splitCues(cues: readonly SceneCue[], splits: readonly Split[]): SceneCue[] {
  const out = [...cues];
  for (const s of [...splits].sort((a, b) => a.at - b.at)) {
    const i = out.findIndex(
      (c) => s.at >= c.startSec + SPLIT_MIN_PIECE_SEC && s.at <= c.endSec - SPLIT_MIN_PIECE_SEC,
    );
    if (i === -1) continue;
    const cue = out[i]!;
    // Derive from the ROOT id, not the (possibly already-split) cue id:
    // `take-0@6000`, never `take-0@3000@6000` — so a half's id depends only
    // on the original cue and the split that made it, and adding an EARLIER
    // split cannot rename later halves out from under their edits.
    out.splice(
      i,
      1,
      { ...cue, endSec: s.at },
      // The suffix comes from the SPLIT's own id, not from `s.at` — that is
      // the §137 fix.
      { ...cue, id: `${cue.id.split("@")[0]}@${s.id}`, startSec: s.at },
    );
  }
  return out;
}

export interface DropHiddenResult {
  cues: SceneCue[];
  /** Ids the edit layer hid, in cue order — for the console and the ghosts. */
  hidden: string[];
}

/**
 * Drop the cues the user deleted. A separate pass rather than a branch in
 * `applyOverrides`, deliberately: that function's 1:1 contract (every cue in
 * → every cue out) is load-bearing for its callers and much of its test
 * suite, and hiding is the one edit that breaks it. Runs immediately after
 * it, in `produce.ts` and the editor's live memo alike — BEFORE the plain
 * fill, so a deleted scene's window becomes an editable take on both sides.
 */
export function dropHiddenCues(cues: readonly SceneCue[], doc: OverrideDoc): DropHiddenResult {
  const hidden: string[] = [];
  const out = cues.filter((cue) => {
    if (doc.scenes[cue.id]?.hidden !== true) return true;
    hidden.push(cue.id);
    return false;
  });
  return { cues: out, hidden };
}

/**
 * Split at the stored split points BEFORE dropping hidden cues (PLAN
 * 2026-08-04 Task 1, bug 3).
 *
 * `dropHiddenCues` matches by the EXACT id the user deleted, and a split
 * root's `hidden` is meant to apply only to "the root's own post-split
 * segment (the half that still carries the bare id)" per `effectiveOverride`
 * above — but `produce.ts` and the editor's live memo both called
 * `dropHiddenCues` on the ROOT cues, before `splitCues` had run. That erased
 * the ENTIRE pre-split window (both halves at once); the plain fill then
 * covered it with one take, and the later `splitCues` call cut that PLAIN
 * take into two plain pieces — killing the graphic on the half the user
 * never asked to delete (field case: `scene-6` deleted, `scene-6@36400` died
 * with it). Splitting first means a hidden root id only ever matches the
 * post-split cue that kept the bare id, exactly the exception
 * `effectiveOverride` already promises. Safe to call again after the fill's
 * own `splitCues` pass — re-splitting at a boundary that already exists is a
 * no-op (the split point sits exactly on the joint, so neither piece's
 * window contains it).
 */
export function splitThenDropHidden(
  cues: readonly SceneCue[],
  doc: OverrideDoc,
): DropHiddenResult {
  return dropHiddenCues(splitCues(cues, doc.splits), doc);
}

/**
 * Stamp every scene override with the anchor of the cue it currently targets
 * — the edit's identity across a re-plan (see SceneOverrideSchema.anchor).
 * Called by the EDITOR at save time, from the cues in its memory, never from
 * render-props.json on disk: after a mid-session re-render the disk can
 * describe a newer plan than the one the user is looking at, and stamping
 * from it would record the wrong identity — the misapply this exists to stop.
 * Cues without an anchor (plain takes, pre-anchor render-props) stamp nothing.
 *
 * RE-stamps on every save, deliberately: the cue on screen is always the
 * freshest truth about what the user is editing, so a stale stamp from an
 * earlier plan is overwritten rather than preserved. A split half's cue
 * carries its root's anchor verbatim (`splitCues` spreads the root cue), so
 * the `id@<split id>` entry stamps through the same by-id lookup as its root.
 *
 * `doc` must have been through `OverrideDocSchema` — the `captionEditsToKeep`
 * rule: a literal `"__proto__"` key surviving `JSON.parse` as an own property
 * would assign through the prototype in the record rebuild below.
 */
export function stampSceneAnchors(doc: OverrideDoc, cues: readonly SceneCue[]): OverrideDoc {
  const anchorById = new Map<string, SceneAnchor>();
  for (const c of cues) {
    if (c.anchor) anchorById.set(c.id, c.anchor);
  }
  const scenes: Record<string, SceneOverride> = {};
  for (const [id, entry] of Object.entries(doc.scenes)) {
    const anchor = anchorById.get(id);
    scenes[id] = anchor ? { ...entry, anchor } : entry;
  }
  return { ...doc, scenes };
}

/** Shared word count of two anchors — inclusive word-index ranges, so
 * touching at a single word counts as 1 and disjoint ranges go ≤ 0. */
const wordOverlap = (a: SceneAnchor, b: SceneAnchor): number =>
  Math.min(a.endWord, b.endWord) - Math.max(a.startWord, b.startWord) + 1;

/**
 * The inert suffix a misapply-blocked edit is parked under. `#` never
 * appears in a cue id (`scene-${i}`, `take-*`, split halves use `@`), so a
 * parked key matches no cue and the edit sits harmless — data and anchor
 * intact — until a later plan brings its words back and rescues it.
 */
const PARKED_SUFFIX = "#orphaned";

export interface SceneRemapResult {
  doc: OverrideDoc;
  /** Human sentences for produce to print — one per re-keyed, parked, or blocked entry. */
  notes: string[];
}

/**
 * Re-key scene overrides onto the cues that carry their WORDS — the
 * produce-side counterpart of `stampSceneAnchors` above
 * (handoff-edit-anchoring; §137 is the caption-side precedent).
 *
 * Ids are positional (`scene-${i}`) and a re-plan renumbers them freely: in
 * the two plan pairs measured for this change, 8/11 and 2/10 ids moved while
 * every anchor still found its moment at 100% overlap — and in the field,
 * `scene-4` was a TerminalMock over words 85..116 in one plan and a
 * FlowDiagram over words 47..57 in the next. An edit keyed by id alone lands
 * on that impostor silently. So the stored anchor, not the key, is the
 * edit's identity: an entry whose id still means the same moment (any word
 * overlap) is untouched; one whose words moved follows them to their new id;
 * one whose words are GONE while its id points at a different moment is
 * parked under `${key}#orphaned` rather than left to join the impostor. A
 * parked entry's root id is historical, not a claim on today's cue, so it
 * skips the id-agreement shortcut and matches purely by anchor.
 *
 * Anchor-less (pre-migration) entries pass through byte-identical with no
 * note — the same no-retroactive-protection posture §137 took for captions.
 * Total on any parsed doc: conflicts resolve deterministically (kept entries
 * are immovable; contending re-keys go to the larger overlap; an occupied
 * park slot keeps its incumbent), never a throw.
 *
 * Runs on the post-fill, PRE-`splitCues` cue list, so a split-half key
 * (`id@splitId`) re-keys by its ROOT and keeps its suffix — the half cue it
 * must match only exists after `splitCues` runs. `doc` must have been
 * through `OverrideDocSchema` — the `captionEditsToKeep` rule: a literal
 * `"__proto__"` key surviving `JSON.parse` as an own property would assign
 * through the prototype in the record rebuild below.
 */
export function remapSceneOverrides(
  doc: OverrideDoc,
  cues: readonly SceneCue[],
): SceneRemapResult {
  // Anchor-bearing root cues only. Plain fill takes carry no anchor by
  // construction, and the `@` filter guards against a caller passing a
  // POST-split list — a half carries its root's anchor verbatim
  // (`splitCues` spreads the root cue), and matching a half's id here would
  // mint double-suffixed keys like `scene-1@2000@abc`.
  const anchored = cues.filter(
    (c): c is SceneCue & { anchor: SceneAnchor } =>
      c.anchor !== undefined && !c.id.includes("@"),
  );
  const notes: string[] = [];
  const scenes: Record<string, SceneOverride> = {};
  interface Claim {
    key: string;
    entry: SceneOverride;
    /** Where this entry lands if it loses its target: `${baseKey}#orphaned`. */
    parkKey: string;
    ov: number;
  }
  /** Entries headed for a park slot, with the sentence explaining why. */
  const parks: Array<{ key: string; entry: SceneOverride; parkKey: string; note: string }> = [];
  /** Re-keying entries, grouped by the key they want — collisions resolve below. */
  const rekeys = new Map<string, Claim[]>();

  for (const [key, entry] of Object.entries(doc.scenes)) {
    const stored = entry.anchor;
    if (!stored) {
      // Pre-migration entry: exactly today's id-only behaviour, silently.
      scenes[key] = entry;
      continue;
    }
    const isParked = key.endsWith(PARKED_SUFFIX);
    const baseKey = isParked ? key.slice(0, -PARKED_SUFFIX.length) : key;
    const at = baseKey.indexOf("@");
    const rootId = at === -1 ? baseKey : baseKey.slice(0, at);
    const parkKey = `${baseKey}${PARKED_SUFFIX}`;
    const current = anchored.find((c) => c.id === rootId);
    if (!isParked && current && wordOverlap(stored, current.anchor) > 0) {
      scenes[key] = entry; // the id still means the same moment
      continue;
    }
    // Id missing, pointing at a different moment, or historical (parked):
    // follow the anchor.
    const best = anchored
      .map((c) => ({ c, ov: wordOverlap(stored, c.anchor) }))
      .filter((x) => x.ov > 0)
      // Larger overlap first; on a tie, the cue whose id matches the stored
      // root (reachable only for parked entries — an unparked id match with
      // overlap was kept above), then the earlier cue.
      .sort(
        (a, b) =>
          b.ov - a.ov ||
          Number(b.c.id === rootId) - Number(a.c.id === rootId) ||
          a.c.startSec - b.c.startSec,
      )[0];
    if (!best) {
      if (!isParked && current) {
        // The words are gone AND the id now belongs to a different moment.
        // Leaving the entry under `key` would join the impostor — the exact
        // silent misapply this pass exists to prevent. Park it.
        parks.push({
          key,
          entry,
          parkKey,
          note: `edit for ${key} parked — its words left the plan, and ${rootId} now shows a different moment`,
        });
      } else {
        // The old id matches nothing (or the entry is already parked):
        // today's orphan path — `applyOverrides` reports it, nothing can
        // misapply, so no note either.
        scenes[key] = entry;
      }
      continue;
    }
    const newKey = at === -1 ? best.c.id : `${best.c.id}${baseKey.slice(at)}`;
    const list = rekeys.get(newKey) ?? [];
    list.push({ key, entry, parkKey, ov: best.ov });
    rekeys.set(newKey, list);
  }

  for (const [newKey, contenders] of rekeys) {
    if (scenes[newKey] !== undefined) {
      // Kept entries are immovable: an anchor-less one must behave exactly
      // as today, and an id-plus-anchor match is the strongest claim there
      // is. A re-keyer arriving at a held key parks instead of evicting.
      for (const c of contenders) {
        parks.push({
          key: c.key,
          entry: c.entry,
          parkKey: c.parkKey,
          note: `edit for ${c.key} parked — ${newKey} already carries its own edit`,
        });
      }
      continue;
    }
    // Two entries re-keying onto one cue: the larger overlap wins, the loser
    // parks, both get a sentence. On an exact tie, doc order — deterministic,
    // and as good as any claim two different stored anchors can make on the
    // same cue. (`sort` is stable, so equal overlaps keep insertion order.)
    const [winner, ...losers] = [...contenders].sort((a, b) => b.ov - a.ov);
    scenes[newKey] = winner!.entry;
    notes.push(
      winner!.key.endsWith(PARKED_SUFFIX)
        ? `edit for ${winner!.key} rescued to ${newKey} — its words are back in the plan`
        : `edit for ${winner!.key} re-keyed to ${newKey} — the plan renumbered, its words moved there`,
    );
    for (const l of losers) {
      parks.push({
        key: l.key,
        entry: l.entry,
        parkKey: l.parkKey,
        note: `edit for ${l.key} parked — the edit from ${winner!.key} overlaps ${newKey}'s words more (${winner!.ov} vs ${l.ov})`,
      });
    }
  }

  for (const p of parks) {
    if (scenes[p.parkKey] !== undefined) {
      // Doubly-pathological: the slot already holds a still-parked edit for
      // the same base key (edit → re-plan parks it → edit again → re-plan
      // again). One inert slot, two edits — keep the incumbent, like every
      // other hold, and say the loss out loud rather than overwriting
      // silently.
      notes.push(`edit for ${p.key} dropped — ${p.parkKey} already holds an earlier parked edit`);
      continue;
    }
    scenes[p.parkKey] = p.entry;
    notes.push(p.note);
  }

  return { doc: { ...doc, scenes }, notes };
}

/**
 * A caption edit's key: the word's source start, quantised to milliseconds
 * (§137). Positional indices were the original design and a user cut breaks
 * them — removing one word shifts every later index, so the `was` guard below
 * fires on every edit and the user's retypes vanish into the report nobody
 * printed. Source time is the one property of a word that a re-cut cannot
 * move.
 *
 * THROWS on a non-finite `srcStart` rather than minting `wNaN`. The type
 * promises a number and `captions.ts:33-39` says outright that the promise is
 * a lie at the render-props boundary — the editor loads that file as an
 * unvalidated cast, so a pre-§137 workdir yields words with the field absent.
 * `w${Math.round(NaN * 1000)}` is `"wNaN"` for EVERY word: one shared anchor
 * for a whole video, under which a single stored edit would rewrite every word
 * in it. That is the failure this whole change exists to prevent, arriving
 * silently. Parse, never coerce — and a loud throw is the parse here, since a
 * missing anchor has no honest fallback. `backfillSrcStart` (Task 6's load
 * path) is what keeps legacy files from reaching this.
 */
export function captionKeyFor(srcStart: number): string {
  if (!Number.isFinite(srcStart)) {
    throw new Error(
      `captionKeyFor: caption words need a finite srcStart (§137), got ${String(srcStart)} — ` +
        `run backfillSrcStart on lines read from a pre-§137 render-props.json`,
    );
  }
  return `w${Math.round(srcStart * 1000)}`;
}

/** A pre-§137 key: a bare non-negative integer, i.e. a caption-word position. */
export function isLegacyCaptionKey(key: string): boolean {
  return /^\d+$/.test(key);
}

/**
 * The anchor a word carries, or null when it carries none.
 *
 * `captionKeyFor` THROWS on a non-finite `srcStart` and should: reaching it
 * with one is a programmer error. A word that simply has no `srcStart` is a
 * DATA condition, not a programmer error — the render-props boundary is an
 * unvalidated cast (`captions.ts:33-39`), so a pre-§137 workdir loads with the
 * field absent on every word (the editor's own e2e fixture is exactly that,
 * preserved on purpose). The editor calls `applyCaptionEdits` inside a
 * render-time `useMemo` with no error boundary above it, so a throw down there
 * white-screens the whole editor over a file that merely predates the field
 * (§137 review). Distinguishing the two here keeps the parse loud where it
 * means something and turns the boundary case into "this word can carry no
 * edit" — the edits that then find no home are REPORTED (`found: null` /
 * `unresolved`), which is the honest answer. `backfillSrcStart` on the load
 * path is what makes these words anchorable again.
 *
 * PUBLIC since §137 Task 5, deliberately: the editor needs the same verdict
 * before it writes an edit, and a second copy of "is this word anchorable"
 * living in `apps/editor` is how the two would drift apart. Every caller that
 * holds a word it did not itself construct should come through here rather
 * than calling `captionKeyFor` — a `useEdits` retype runs in a React event
 * handler with no error boundary above it, so a throw there is a crash on any
 * pre-§137 workdir, not a caught parse failure.
 */
export function captionAnchorOf(word: CaptionWord | undefined): string | null {
  if (!word || !Number.isFinite(word.srcStart)) return null;
  return captionKeyFor(word.srcStart);
}

/**
 * How far either side of the stored index the migration will look for `was`
 * (§137).
 *
 * A JUDGEMENT, not a measurement — stated because this is the constant that
 * decides how much of a user's saved work the one-shot upgrade recovers, and
 * it shipped with a *what* comment and no *why* (final review, Important 2).
 * The trade runs in both directions at once: every extra word the scan
 * considers is another chance that a common word (`the`, `it`) matches by
 * coincidence, and the ambiguity rule below turns a coincidence into a
 * REFUSAL. So widening this recovers more far-drifted edits and refuses more
 * near ones; it is not a free "more is better" dial. Eight words is on the
 * order of two or three seconds of speech — comfortably past the field case (a
 * 0.6s trim moved every stored index by one) while still short enough that the
 * window usually holds a given word once.
 *
 * The bound is affordable only because being past it is no longer a LOSS. Such
 * an edit is reported `out-of-range` — the word is still on screen, merely too
 * far from where the edit was stored to be sure it is the same one — and both
 * migration callers carry it through into the doc they keep, so a later run
 * against a different cut can still place it. Deleting it was the final
 * review's Critical 1.
 *
 * THE TWO MIGRATION PATHS SEE DIFFERENT DRIFT, which is what makes the value
 * user-visible rather than internal. The editor migrates against the LAST
 * run's `render-props.json`, and its live preview deliberately never applies
 * `doc.cuts` (`App.tsx`) — so the positions the doc stored and the positions
 * it resolves against are the same ones: drift 0, every legacy edit exact-hits
 * and shows as applied. `produce` migrates against lines built AFTER the
 * user's new cut, so its drift is the number of caption words that cut
 * removed. A cut removing more than this many words therefore shows every
 * retype in the preview and reports them `out-of-range` in the render. Closing
 * that gap would mean re-implementing the EDL in the browser, which is the one
 * thing `App.tsx`'s live memo exists to avoid, so the divergence is STATED
 * rather than fixed — and `out-of-range` plus the write-back's preservation
 * rule is what keeps it a message instead of vanished work.
 *
 * Exported so the report lines can name the bound they hit, and so the
 * boundary tests are written against the constant rather than against `8`.
 */
export const MIGRATION_SEARCH_RADIUS = 8;

/**
 * WHY an edit could not be migrated. Reported rather than folded into one
 * message (§137 Task 6 review, Minor 7): each cause needs something different
 * from the user, and blaming the cut for all of them sends someone looking for
 * a word that is still sitting on screen.
 *  - `not-found`: no word here says `was` any more — a cut removed it, or a
 *    re-plan rewrote it.
 *  - `out-of-range`: a word here DOES say `was`, but only past
 *    `MIGRATION_SEARCH_RADIUS` from the stored index. Split out of
 *    `not-found` (final review, Important 2): the two are the same silence to
 *    the code and opposite advice to the user — one word is gone, the other is
 *    sitting on screen untouched, and telling that user "the cut removed it"
 *    sends them to redo work they can still see.
 *  - `ambiguous`: several words nearby say `was` and the search cannot tell
 *    which one the user meant.
 *  - `unanchorable`: the word IS here, but carries no source time to key on —
 *    a render-props.json with no usable `spans` to backfill from.
 *  - `collision`: two legacy edits resolved to the same word; neither can be
 *    trusted over the other.
 *  - `superseded`: a legacy edit resolved onto a word an already-source-keyed
 *    edit holds. The CURRENT-format edit wins and is kept; this is the older
 *    duplicate being retired, not a loss of the live edit.
 */
export type CaptionMigrationReason =
  | "not-found"
  | "out-of-range"
  | "ambiguous"
  | "unanchorable"
  | "collision"
  | "superseded";

export interface CaptionKeyMigration {
  edits: Record<string, CaptionEdit>;
  /**
   * Edits the migration would not commit — reported, never guessed at. Keyed
   * by their ORIGINAL doc key, which is the only name the user's file knows
   * them by, and carrying WHY (see `CaptionMigrationReason`).
   */
  unresolved: Array<{ key: string; was: string; reason: CaptionMigrationReason }>;
}

/**
 * An answer from `resolveCaptionAnchor`: an anchor, or why there is none.
 * `collision`/`superseded` are excluded because they are not properties of one
 * edit at all — they need the other claims to be visible first.
 */
type AnchorClaim =
  | { to: string }
  | { to: null; reason: Exclude<CaptionMigrationReason, "collision" | "superseded"> };

/**
 * Where one stored edit wants to land, or why it cannot land anywhere.
 *
 * Split out of `migrateCaptionKeys` so every edit can be resolved BEFORE any
 * of them is written: a collision is only visible once both claims exist, and
 * a function that writes as it goes cannot see the second claim coming.
 */
function resolveCaptionAnchor(
  key: string,
  edit: CaptionEdit,
  words: readonly CaptionWord[],
): AnchorClaim {
  // Already a source key (or something that is not a position at all) — the
  // doc's own key stands, and the collision check downstream still applies.
  if (!isLegacyCaptionKey(key)) return { to: key };
  const at = Number(key);
  // The record confirming itself — see `migrateCaptionKeys` for why this
  // wins ahead of the ambiguity rule rather than through it. A confirmed
  // position that carries no anchor resolves to NOTHING rather than falling
  // through to the search: the record already named the word, and letting the
  // search then pick a same-text word elsewhere would rewrite one the user
  // did not edit.
  if (words[at]?.text === edit.was) return anchorOrUnanchorable(words[at]);
  const matches: number[] = [];
  for (let d = 1; d <= MIGRATION_SEARCH_RADIUS; d++) {
    for (const i of [at - d, at + d]) {
      if (words[i]?.text === edit.was) matches.push(i);
    }
  }
  // Ambiguity is judged on the TEXT matches, before anchors are considered —
  // an unanchorable candidate still means the search could not tell two words
  // apart, so it must not silently narrow the field to one.
  if (matches.length === 0) {
    // Nothing WITHIN the radius — but that is two different facts, and they
    // owe the user opposite advice (final review, Important 2). A full scan
    // (only ever on the failure path, so it costs nothing on a healthy doc)
    // separates "the cut removed this word" from "the word is right there,
    // further from the stored index than the search is willing to trust". The
    // second is not re-anchored — past the radius the position record has been
    // proven wrong by too much for a lone text match to stand in for it — but
    // it is REPORTED as what it is, and the callers keep the edit in the doc
    // so a later run can still place it.
    const elsewhere = words.some((w) => w.text === edit.was);
    return { to: null, reason: elsewhere ? "out-of-range" : "not-found" };
  }
  if (matches.length > 1) return { to: null, reason: "ambiguous" };
  return anchorOrUnanchorable(words[matches[0]!]);
}

/** The word was FOUND; whether it can be keyed on is a separate question. */
function anchorOrUnanchorable(word: CaptionWord | undefined): AnchorClaim {
  const anchor = captionAnchorOf(word);
  return anchor === null ? { to: null, reason: "unanchorable" } : { to: anchor };
}

/**
 * Upgrade pre-§137 positional keys to source-time keys.
 *
 * Position first, and an exact position hit WINS OUTRIGHT — it is not a
 * guess. The stored index is the position the editor recorded when the user
 * made the edit, and `was` matching the word now sitting there is that record
 * confirming itself: two independent facts agreeing. The same word appearing
 * elsewhere nearby weakens neither, so the ambiguity rule below deliberately
 * does NOT gate this branch (ruling on the §137 plan, task 2: folding the
 * exact hit into the candidate scan makes a confirmed record lose to an
 * unrelated coincidence, and a doc that never drifted at all would stop
 * migrating because the user happened to edit a repeated word — that breaks
 * "every existing overrides.json keeps working" for a case where we have the
 * answer).
 *
 * When the word at that position is NOT the edit's `was`, the position has
 * been PROVEN wrong (a cut removed words before it), so search outward for
 * the `was`: that recovers the field case rather than discarding work the
 * user already did. Ambiguity gates that search alone — two candidates a
 * search genuinely cannot tell apart are reported instead, because a wrong
 * anchor silently rewrites the wrong word, which is worse than an edit the
 * user has to redo.
 *
 * TWO LEGACY EDITS RESOLVING TO THE SAME WORD are that same ambiguity one
 * level up, and both go to `unresolved` — the output is a Record, so writing as
 * we went would have the second edit silently overwrite the first and report
 * nothing, which is the very bug this task was opened for. It is not a corner
 * case:
 *  - an outward search can land on the word another edit exact-hit (`the cat
 *    sat on a mat`, edits at "0" and "5", both `was: "the"`);
 *  - two words can share a `srcStart` outright — `backfillSrcStart`
 *    (`captions.ts:44-50`) maps seam preimages and cut-clamped words onto the
 *    same source instant BY DESIGN, so duplicate keys are manufactured, not
 *    float trivia.
 * Neither edit is guessed at, both are named, and the user can re-apply the
 * one they meant.
 *
 * A LEGACY EDIT COLLIDING WITH AN ALREADY-SOURCE-KEYED ONE is NOT that case,
 * and refusing both was a real bug (§137 Task 6 review, Important 3): a doc
 * holding both key spaces at once — `{"0": …, "w6000": …}` over one word — is
 * the normal shape of any project edited before and after this change, and
 * treating it as an unbreakable tie DELETED the newer, current-format edit
 * whose anchor was never in doubt. The source-keyed edit WINS: it is the one
 * the editor wrote most recently, it names its word directly rather than by a
 * position something may have shifted, and it is the format everything else
 * reads. Only the legacy claim is retired, reported as `superseded`. (There
 * can be at most one source-keyed claimant per anchor: such a claim resolves
 * to its own key, and a Record cannot hold one key twice.)
 */
export function migrateCaptionKeys(
  edits: Record<string, CaptionEdit>,
  lines: readonly CaptionLine[],
): CaptionKeyMigration {
  const words = lines.flatMap((l) => l.words);
  const out: Record<string, CaptionEdit> = {};
  const unresolved: CaptionKeyMigration["unresolved"] = [];

  // Resolve every edit first, write second — see the collision paragraph.
  const claims = Object.entries(edits).map(([key, edit]) => ({
    key,
    edit,
    legacy: isLegacyCaptionKey(key),
    claim: resolveCaptionAnchor(key, edit, words),
  }));
  type Claim = (typeof claims)[number];
  const claimants = new Map<string, Claim[]>();
  for (const c of claims) {
    if (c.claim.to === null) continue;
    const rivals = claimants.get(c.claim.to);
    if (rivals) rivals.push(c);
    else claimants.set(c.claim.to, [c]);
  }

  for (const c of claims) {
    if (c.claim.to === null) {
      unresolved.push({ key: c.key, was: c.edit.was, reason: c.claim.reason });
      continue;
    }
    const rivals = claimants.get(c.claim.to)!;
    // Identity, not `.key` — the winner has to be THIS claim object, or a
    // second claimant would write itself in over the one that already won.
    const winner = rivals.length === 1 ? rivals[0]! : rivals.find((r) => !r.legacy);
    if (winner === c) {
      out[c.claim.to] = c.edit;
      continue;
    }
    unresolved.push({
      key: c.key,
      was: c.edit.was,
      // `winner` undefined means every claimant was legacy: a genuine tie.
      reason: winner === undefined ? "collision" : "superseded",
    });
  }
  return { edits: out, unresolved };
}

/**
 * The caption map to KEEP after a migration: everything it placed, plus every
 * edit it would not place, left exactly as the user's file holds it.
 *
 * `migration.edits` alone is what both callers wrote back at first, and it is
 * a DELETE (final review, Critical 1): an edit produce cannot anchor this run
 * may well be anchorable the next one — a different cut, re-planned lines, or
 * simply a `MIGRATION_SEARCH_RADIUS` the drift no longer exceeds — and
 * dropping it forecloses that, permanently, on a run the user only asked to
 * render. Nobody asked for a delete. An unresolved key left in the doc costs
 * nothing: it addresses no word, so it applies to nothing, and it is reported
 * by name on every run. That was the pre-§137 status quo for a stale key and
 * it is the right one.
 *
 * `superseded` is the ONE retirement, and it is not a loss: a newer
 * source-keyed edit already covers that word (see `migrateCaptionKeys`), so
 * keeping the older legacy duplicate would re-report the same collision on
 * every run forever with nothing the user could do about it.
 *
 * Preserved keys cannot collide with placed ones — a preserved key is legacy
 * (`/^\d+$/`, since a source key always resolves to itself and wins its
 * anchor) and a placed key is always `w<ms>`. `before` must have been through
 * `OverrideDocSchema`, for the `"__proto__"` reason `migrateCaptionKeys`
 * states.
 */
export function captionEditsToKeep(
  before: Record<string, CaptionEdit>,
  migration: CaptionKeyMigration,
): Record<string, CaptionEdit> {
  const out: Record<string, CaptionEdit> = { ...migration.edits };
  for (const u of migration.unresolved) {
    if (u.reason === "superseded") continue;
    const edit = before[u.key];
    // Unreachable — `unresolved` is built from `before`'s own entries — but
    // this is user data on its way back to disk, and a lookup that came back
    // undefined must not be written into a map typed as `CaptionEdit`.
    if (edit !== undefined) out[u.key] = edit;
  }
  return out;
}

export interface AppliedCaptionEdits {
  lines: CaptionLine[];
  /**
   * Edits that did not apply. `found: null` means no word carries that source
   * anchor any more (a cut removed it); a string means the word is there but
   * says something else (a re-plan changed it).
   *
   * `reason` is present ONLY for the third case — a SECOND word carrying an
   * anchor an earlier word already claimed, which is not a stale edit at all
   * (the edit may well have applied, to the first word). Written only when it
   * has something to say, the same rule the override doc's own optional keys
   * follow; absent means the ordinary stale report `found` already
   * distinguishes. A key can therefore appear in this array more than once.
   */
  dropped: Array<{
    key: string;
    expected: string;
    found: string | null;
    reason?: "duplicate-anchor";
  }>;
}

/**
 * Apply retyped caption words. Text only, never timing — the stamps drive the
 * kinetic highlight and the 1:1 constraint is what keeps scene anchors and
 * §21's copy/caption agreement intact.
 *
 * Keyed by source time since §137, so a user cut earlier in the video no
 * longer shifts every later edit onto the wrong word. An edit that does not
 * apply is REPORTED — callers must surface `dropped`; the editor discarding it
 * is what made this failure invisible in the field case.
 *
 * AT MOST ONE WORD per edit — the first carrying the key, and the guard's
 * verdict on that word is final. Keys are millisecond-quantised, so two words
 * CAN share one (`captions.ts:44-50`: backfilled seam preimages and
 * cut-clamped words land on the same source instant by design, and rounding
 * closes sub-millisecond gaps besides). A plain `.map()` rewrites every word
 * that matches — fanning one retype out onto a word the user never touched,
 * which is exactly the "wrong anchor silently rewrites the wrong word" the
 * migration's ambiguity rule refuses to commit, and a breach of the 1:1
 * in-place retype contract above. Later claimants are reported with
 * `reason: "duplicate-anchor"` and left alone rather than edited.
 */
export function applyCaptionEdits(
  lines: readonly CaptionLine[],
  edits: Record<string, CaptionEdit>,
): AppliedCaptionEdits {
  const dropped: AppliedCaptionEdits["dropped"] = [];
  if (Object.keys(edits).length === 0) return { lines: [...lines], dropped };

  const seen = new Set<string>();
  const out = lines.map((line) => ({
    ...line,
    words: line.words.map((w) => {
      // No anchor, no edit — a pre-§137 word cannot be addressed, and this is
      // the boundary that must not throw (see `captionAnchorOf`). The stored
      // edits then fall out of the sweep below as `found: null`.
      const key = captionAnchorOf(w);
      if (key === null) return w;
      const edit = edits[key];
      if (!edit) return w;
      // An earlier word already answered for this anchor — whichever way it
      // answered. Applying here too would fan one retype onto a second word;
      // re-running the guard here would let an edit be applied AND reported
      // dropped for the same key.
      if (seen.has(key)) {
        dropped.push({ key, expected: edit.was, found: w.text, reason: "duplicate-anchor" });
        return w;
      }
      seen.add(key);
      if (w.text !== edit.was) {
        dropped.push({ key, expected: edit.was, found: w.text });
        return w;
      }
      return { ...w, text: edit.text };
    }),
  }));

  // An anchor no word carries any more — the cut removed the word the user
  // edited. Silence here is exactly the field case, so say it.
  for (const [key, edit] of Object.entries(edits)) {
    if (!seen.has(key)) dropped.push({ key, expected: edit.was, found: null });
  }
  return { lines: out, dropped };
}

/**
 * Re-time replacement tokens over ONE line's stretch of a rewritten run —
 * `repair.ts`'s `retime` model (producer/repair.ts:137-154), restated here
 * for CaptionWords: stamps distributed across the window weighted by token
 * length + 1, strictly increasing, the last token's `end` pinned to the
 * window end so the run never leaks past the span it replaced. The measured
 * window edges (first run word's start, last run word's end) are kept;
 * only the interior boundaries are interpolated — interpolated boundaries
 * are a guess, and `retime`'s comment is explicit that a guess must never
 * displace a measurement, which is why the equal-count fast path in
 * `applyCaptionRangeEdits` below bypasses this entirely.
 */
function retimeCaptionTokens(
  tokens: readonly string[],
  windowStart: number,
  windowEnd: number,
  srcStarts: readonly number[],
): CaptionWord[] {
  const weights = tokens.map((t) => t.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const out: CaptionWord[] = [];
  let cursor = windowStart;
  for (let i = 0; i < tokens.length; i++) {
    const share = ((windowEnd - windowStart) * weights[i]!) / total;
    const end = i === tokens.length - 1 ? windowEnd : cursor + share;
    out.push({ text: tokens[i]!, start: cursor, end, srcStart: srcStarts[i]! });
    cursor = end;
  }
  return out;
}

/**
 * Apply the free-text RANGE rewrites (`captionRangeEdits`) — the one layer
 * allowed to change word COUNT, which is why it exists at all: everything it
 * reshapes is the derived `CaptionLine[]`, never `transcript.words` (scene
 * anchors are raw indices into that array — splicing it is the forbidden
 * operation this whole edit family is built around).
 *
 * Same reporting shape as `applyCaptionEdits`; drop `key`s are the COMPOSITE
 * `${fromKey}..${toKey}` — the pair is the entry's identity, and either half
 * alone names only an endpoint. Each entry drops AT MOST ONCE (unlike the
 * per-word layers, where one key can be reported per extra claimant), which
 * is what lets `reconcileCaptionEdits` count applied entries by subtraction.
 *
 * Locating: `fromKey`'s first claimant across the flat word order (the
 * per-word first-claimant rule — ms-quantised keys CAN collide,
 * captions.ts:44-50), then a FORWARD walk to `toKey`; a missing endpoint, or
 * a `toKey` that only occurs before `fromKey`, is `found: null`. An entry
 * whose pair was already applied, or whose `fromKey` an earlier range edit's
 * run consumed, is `duplicate-anchor` — reachable only in a hand-edited doc,
 * since the reducer scrubs overlapping entries at creation, and reported
 * rather than guessed at like every other collision in this file.
 *
 * The whole-run stale guard: the run's live texts, NFC-normalized and
 * space-joined, must equal `was` byte for byte, or the WHOLE edit drops with
 * the joined text as `found` — never a partial rewrite of the words that
 * still match (a half-applied rewrite reads as garbage, and there is no
 * per-word truth to fall back on once the counts differ).
 *
 * Retiming across lines: the run may span several lines, and their `start`/
 * `end` WINDOWS are deliberately not re-packed — Sequence windows and
 * `buildCaptionLines`' breakpoint semantics stay exactly as produced.
 * Replacement tokens are distributed across the affected lines
 * proportionally to each line's share of the run's summed word duration,
 * rounded by largest remainder (deterministic — earlier line wins a tie) so
 * every token lands somewhere and the totals match. Within a line the stamps
 * follow `retimeCaptionTokens` above; a token count equal to the run's word
 * count skips all of it and keeps the measured per-word stamps AND srcStarts
 * verbatim (measured ASR boundaries beat interpolation — `retime`'s rule).
 * A line allotted zero tokens loses its run words, and if that empties it
 * the line is omitted (the `applyCaptionWordHides` rule — no zero-word
 * Sequence).
 *
 * srcStart minting for count-changed runs: linear across `[fromSrc, toSrc]`
 * (the endpoints' own source starts), endpoints re-minted verbatim — which
 * is what lets the user select a rewritten run again and edit it (its
 * endpoints still answer to the same pair). Strictly increasing whenever the
 * span is non-degenerate; when the span is too short for 1ms-distinct
 * quantised keys (`captionKeyFor` rounds to ms), later words SHARE quantised
 * keys — an accepted, documented duplicate-anchor case the existing
 * machinery reports if a per-word edit ever targets one.
 */
export function applyCaptionRangeEdits(
  lines: readonly CaptionLine[],
  rangeEdits: readonly CaptionRangeEdit[],
): AppliedCaptionEdits {
  const dropped: AppliedCaptionEdits["dropped"] = [];
  if (rangeEdits.length === 0) return { lines: [...lines], dropped };

  let out: CaptionLine[] = [...lines];
  const seenPairs = new Set<string>();
  const consumed = new Set<string>();

  for (const entry of rangeEdits) {
    const key = `${entry.fromKey}..${entry.toKey}`;
    // Flatten the CURRENT lines — edits apply sequentially, so a later entry
    // addresses the stream as the earlier ones left it (that is how a
    // re-minted endpoint stays addressable at all).
    const flat: Array<{ line: number; word: number; w: CaptionWord }> = [];
    for (let li = 0; li < out.length; li++) {
      for (let wi = 0; wi < out[li]!.words.length; wi++) {
        flat.push({ line: li, word: wi, w: out[li]!.words[wi]! });
      }
    }
    const fromIdx = flat.findIndex((f) => captionAnchorOf(f.w) === entry.fromKey);
    if (seenPairs.has(key) || consumed.has(entry.fromKey)) {
      dropped.push({
        key,
        expected: entry.was,
        found: fromIdx === -1 ? null : flat[fromIdx]!.w.text,
        reason: "duplicate-anchor",
      });
      continue;
    }
    if (fromIdx === -1) {
      dropped.push({ key, expected: entry.was, found: null });
      continue;
    }
    // FORWARD only: a toKey sitting before fromKey is a run that crosses a
    // gap the stream no longer bridges — `found: null`, never a guess.
    let toIdx = -1;
    for (let i = fromIdx; i < flat.length; i++) {
      if (captionAnchorOf(flat[i]!.w) === entry.toKey) {
        toIdx = i;
        break;
      }
    }
    if (toIdx === -1) {
      dropped.push({ key, expected: entry.was, found: null });
      continue;
    }
    const run = flat.slice(fromIdx, toIdx + 1);
    const joined = run
      .map((f) => f.w.text)
      .join(" ")
      .normalize("NFC");
    if (joined !== entry.was.normalize("NFC")) {
      dropped.push({ key, expected: entry.was, found: joined });
      continue;
    }
    const tokens = entry.text.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      // Defensive: zod's min(1) admits a whitespace-only string, and a run
      // rewritten to NOTHING is a delete, which is the hide layer's job —
      // treated as a stale-style drop rather than silently emptying the run.
      dropped.push({ key, expected: entry.was, found: joined });
      continue;
    }
    seenPairs.add(key);
    for (const f of run) {
      const a = captionAnchorOf(f.w);
      if (a !== null) consumed.add(a);
    }

    if (tokens.length === run.length) {
      // Equal count: keep the measured stamps AND srcStarts verbatim —
      // `retime`'s fast path, for its reason (measured ASR onsets beat any
      // interpolation, and verbatim srcStarts keep every anchor addressable).
      const replaced = new Map(run.map((f, i) => [`${f.line}:${f.word}`, tokens[i]!]));
      out = out.map((line, li) => ({
        ...line,
        words: line.words.map((w, wi) => {
          const text = replaced.get(`${li}:${wi}`);
          return text === undefined ? w : { ...w, text };
        }),
      }));
      continue;
    }

    // Count changed: distribute tokens across the affected lines by each
    // line's share of the run's total duration, largest-remainder rounded.
    const lineOrder: number[] = [];
    const runByLine = new Map<number, { first: number; last: number; words: CaptionWord[] }>();
    for (const f of run) {
      const seg = runByLine.get(f.line);
      if (seg) {
        seg.last = f.word;
        seg.words.push(f.w);
      } else {
        lineOrder.push(f.line);
        runByLine.set(f.line, { first: f.word, last: f.word, words: [f.w] });
      }
    }
    const shares = lineOrder.map((li) =>
      runByLine.get(li)!.words.reduce((a, w) => a + (w.end - w.start), 0),
    );
    const totalShare = shares.reduce((a, b) => a + b, 0);
    // Zero total duration (every run word zero-width) has no proportion to
    // honor — fall back to equal weights so the rounding below still lands
    // every token somewhere deterministic.
    const weights = totalShare > 0 ? shares : shares.map(() => 1);
    const weightTotal = totalShare > 0 ? totalShare : shares.length;
    const quotas = weights.map((s) => (tokens.length * s) / weightTotal);
    const counts = quotas.map((q) => Math.floor(q));
    let leftover = tokens.length - counts.reduce((a, b) => a + b, 0);
    // Largest remainder first; ties break to the EARLIER line — stated so
    // the distribution is reproducible from the doc alone, like every other
    // persisted derivation in this file.
    const byRemainder = quotas
      .map((q, i) => ({ i, rem: q - Math.floor(q) }))
      .sort((a, b) => b.rem - a.rem || a.i - b.i);
    for (let k = 0; leftover > 0; k = (k + 1) % byRemainder.length) {
      counts[byRemainder[k]!.i]!++;
      leftover--;
    }

    const fromSrc = run[0]!.w.srcStart;
    const toSrc = run[run.length - 1]!.w.srcStart;
    const srcStarts = tokens.map((_, j) =>
      tokens.length === 1 ? fromSrc : fromSrc + ((toSrc - fromSrc) * j) / (tokens.length - 1),
    );

    let tokenCursor = 0;
    const next: CaptionLine[] = [];
    for (let li = 0; li < out.length; li++) {
      const line = out[li]!;
      const seg = runByLine.get(li);
      if (!seg) {
        next.push(line);
        continue;
      }
      const n = counts[lineOrder.indexOf(li)]!;
      const lineTokens = tokens.slice(tokenCursor, tokenCursor + n);
      const lineSrcs = srcStarts.slice(tokenCursor, tokenCursor + n);
      tokenCursor += n;
      const minted =
        n === 0
          ? []
          : retimeCaptionTokens(
              lineTokens,
              seg.words[0]!.start,
              seg.words[seg.words.length - 1]!.end,
              lineSrcs,
            );
      const words = [...line.words.slice(0, seg.first), ...minted, ...line.words.slice(seg.last + 1)];
      // Window untouched (the no-re-pack rule above); an emptied line is
      // omitted, same as `applyCaptionWordHides`.
      if (words.length === 0) continue;
      next.push({ ...line, words });
    }
    out = next;
  }
  return { lines: out, dropped };
}

/**
 * Drop hidden caption words (the `captionWordsHidden` layer). Same reporting
 * shape as `applyCaptionEdits` — callers must surface `dropped` for the same
 * reason: a hide that silently fails looks like the editor forgot it.
 *
 * Runs on the DERIVED `CaptionLine[]`, never on `transcript.words` — scene
 * anchors are raw word INDICES into the transcript, so splicing a word out of
 * it would shift every later anchor onto the wrong word: the forbidden
 * operation this whole layer exists to avoid. The transcript stays intact;
 * only the rendered caption stream loses the word.
 *
 * Line WINDOWS are recomputed here, deliberately: `buildCaptionLines` derives
 * `start` from the first word and `end` from the last word plus a hold
 * (captions.ts:203-213), so hiding a boundary word would otherwise leave the
 * line lingering on screen over silence — up for the hidden first word's
 * duration, or held past the hidden last word's end. A hidden FIRST word moves
 * `start` to the first survivor; a hidden LAST word re-bases the packer's hold
 * delta onto whichever word is now last (clamped so the line never ends before
 * its own last word); middle hides leave the window alone. A line whose words
 * are ALL hidden is omitted entirely, so the downstream CaptionTrack emits no
 * Sequence for it.
 *
 * `was` is the LIVE (post-retype) text at hide time — hides apply AFTER
 * retypes (`applyCaptionLayers` below) — so un-retyping a word under a hide
 * stales the hide, and it is REPORTED rather than guessed at. Same
 * first-claimant rule as `applyCaptionEdits`: ms-quantised keys CAN collide
 * (`captions.ts:44-50` manufactures duplicates by design), and one hide must
 * remove one word, not every word sharing its instant.
 */
export function applyCaptionWordHides(
  lines: readonly CaptionLine[],
  hides: Record<string, { was: string }>,
): AppliedCaptionEdits {
  const dropped: AppliedCaptionEdits["dropped"] = [];
  if (Object.keys(hides).length === 0) return { lines: [...lines], dropped };

  const seen = new Set<string>();
  const out: CaptionLine[] = [];
  for (const line of lines) {
    const kept: CaptionWord[] = [];
    for (const w of line.words) {
      // No anchor, no hide — same boundary rule as `applyCaptionEdits`: a
      // pre-§137 word cannot be addressed, and the stored hides then fall out
      // of the sweep below as `found: null`.
      const key = captionAnchorOf(w);
      const hide = key === null ? undefined : hides[key];
      if (key === null || !hide) {
        kept.push(w);
        continue;
      }
      // An earlier word already answered for this anchor — whichever way it
      // answered. Hiding here too would fan one delete onto a second word.
      if (seen.has(key)) {
        dropped.push({ key, expected: hide.was, found: w.text, reason: "duplicate-anchor" });
        kept.push(w);
        continue;
      }
      seen.add(key);
      if (w.text !== hide.was) {
        dropped.push({ key, expected: hide.was, found: w.text });
        kept.push(w);
        continue;
      }
      // Matched: the word is dropped from the line.
    }
    if (kept.length === line.words.length) {
      out.push(line);
      continue;
    }
    // Every word hidden — the line goes with them, rather than a zero-word
    // line the CaptionTrack would still mount a Sequence for.
    if (kept.length === 0) continue;
    const lastOriginal = line.words[line.words.length - 1]!;
    const firstKept = kept[0]!;
    const lastKept = kept[kept.length - 1]!;
    const start = firstKept === line.words[0] ? line.start : firstKept.start;
    // The packer's hold delta (captions.ts:203-213) rides on whichever word
    // is now last; clamped so the line never ends before its own last word
    // (the delta can be negative when the hold was clamped to outputDuration).
    const end =
      lastKept === lastOriginal
        ? line.end
        : Math.max(lastKept.end, lastKept.end + (line.end - lastOriginal.end));
    out.push({ words: kept, start, end });
  }

  // An anchor no word carries any more — a later cut removed the word the
  // user hid. Silence here is the field-case failure mode, so say it.
  for (const [key, hide] of Object.entries(hides)) {
    if (!seen.has(key)) dropped.push({ key, expected: hide.was, found: null });
  }
  return { lines: out, dropped };
}

/**
 * The floor a caption's window may shrink to. A caption nobody can read is a
 * delete wearing a timing nudge's clothes — deletes are the hide layer's
 * gesture, with its own guard and report. Also the minimum WIDTH of every
 * line's window, which is what keeps §115 (`packages/scenes/src/frames.ts`)
 * true: 50ms is more than one frame at any fps this renders at, so two
 * adjacent windows can never round onto the same frame.
 *
 * (Was `MIN_TIMED_WORD_SEC`, the same 0.05 measured against a WORD, until the
 * per-word layer was found inert — see `captionLineTiming`'s docstring.)
 *
 * Exported for the EDITOR's drag bounds (`captionDragBounds`,
 * apps/editor/src/TranscriptPanel.tsx): the popover has to stop a drag exactly
 * where this sweep would, and a second copy of the floor in the browser is how
 * the two would drift apart.
 */
export const MIN_CAPTION_SEC = 0.05;

/**
 * Re-time a line's words from one window onto another, PROPORTIONALLY — the
 * arithmetic that keeps the karaoke highlight in sync when a line's
 * `<Sequence>` window moves under it (`CaptionTrack.tsx:228-229, 387` reads
 * the word stamps INSIDE the window; a window moved without them would light
 * the wrong words up, or none).
 *
 * The source is the WINDOW, not the words' own span: on the packed stream
 * both are the same interval (`line.start === words[0].start` and
 * `line.end === lastWord.end`, measured 117/117 — `captionLineTiming`'s
 * docstring), and on a line that DOES carry lead-in or hold (the hide layer
 * can re-base either edge) mapping the window preserves that slack instead of
 * stretching the words over it.
 *
 * Pure and exported so a caller previewing a drag and the apply pass below
 * share ONE piece of arithmetic (the openCommand/openInBrowser split).
 * Identity when the source window is degenerate — a zero-width or inverted
 * span has no ratio to scale by, and `0/0` would put NaN stamps in the render
 * props. The caller owns `toStart < toEnd`; a target handed backwards would
 * mirror the word order, which `applyCaptionLineTiming`'s edge sweep makes
 * unreachable.
 */
export function scaleWordsIntoWindow(
  words: readonly CaptionWord[],
  fromStart: number,
  fromEnd: number,
  toStart: number,
  toEnd: number,
): CaptionWord[] {
  const span = fromEnd - fromStart;
  if (!(span > 0)) return words.map((w) => ({ ...w }));
  const ratio = (toEnd - toStart) / span;
  const at = (t: number): number => toStart + (t - fromStart) * ratio;
  return words.map((w) => ({ ...w, start: at(w.start), end: at(w.end) }));
}

/**
 * Apply per-LINE caption TIMING nudges (`captionLineTiming`) — the LAST
 * layer, after hides, because it must operate on the SURVIVING lines: a hide
 * can move a line's window (or remove the line entirely), and a nudge stored
 * on a line the hides emptied has no window to move (it falls out of the
 * sweep as `found: null`, like every other orphaned caption record).
 *
 * EDGES, NOT ONE SHARED SEAM. Each line owns its `[start, end]` pair, and a
 * line's END and the next line's START are two separate numbers here — even
 * though on a real transcript they are always equal, because the packer chains
 * words (`transcribe.ts`: `next.start = w.end`) and clamps each line's end to
 * the next line's start (`captions.ts:203-213`), giving inter-line gaps of
 * exactly zero (measured 116/116, see `captionLineTiming`). A nudge CLOSES the
 * two onto one value only when they were already COINCIDENT: that is what
 * makes a lead on the packed stream move both sides of the boundary, one edit
 * and two windows, exactly as before.
 *
 * They are two numbers because GAPS ARE REAL: `applyCaptionWordHides` re-bases
 * a line's window onto its surviving words, `MAX_CAPTION_WORD_LEAD_SEC`
 * (captions.ts:147, 169) clamps a word's display start, and an overrides.json
 * can be hand-edited. This code
 * used to hold ONE `seams` array whose interior entry was read off the later
 * line's start, conflating the two: with lines `[0,2] [2,4] [5,6]`, a
 * lead-only drag of the middle line (`{lead: -0.05, tail: 0}`, exactly what
 * the editor writes) rebuilt the UNTOUCHED third caption as `[4,6]` — a full
 * second early, its words stretched 2x by `scaleWordsIntoWindow`, with no drop
 * reported (review 2026-08-19).
 *
 * The edge model still protects §115 (`packages/scenes/src/frames.ts:1-21` —
 * no two lines may share a frame) BY CONSTRUCTION, which is what the old "LINE
 * WINDOWS NEVER CHANGE" rule existed for: the sweep below leaves the edges
 * ORDERED (`start_0 <= end_0 <= start_1 <= ... <= end_n-1`) with every window
 * at least `MIN_CAPTION_SEC` wide, and ordered non-overlapping windows at
 * least 50ms wide cannot round onto a shared frame.
 *
 * THE SWEEP, forward: every edge is clamped into the track's ORIGINAL outer
 * bounds, no line may open before the previous line CLOSED, and no window may
 * be narrower than `MIN_CAPTION_SEC`. A backward pass then pulls lines left if
 * a track too short to hold every line at the floor made the forward pass run
 * into the end. Ordering is enforced against the NEIGHBOUR'S OWN edge, never a
 * derived seam: a nudge that runs past it is BLOCKED there rather than pushing
 * it, so a gap gets consumed but no untouched caption ever moves. (A nudge
 * takes time FROM a neighbour only through the coincidence rule above — the
 * packed case, where the two share the boundary being dragged.) The outer
 * bounds never GROW: a caption must not appear before the first caption of the
 * track or linger past the last, where there is no output left to show it
 * over.
 *
 * BOTH SIDES OF ONE BOUNDARY: line i's `tail` and line i+1's `lead` address
 * the same coincident boundary. The LATER line's `lead` wins,
 * deterministically — the UI writes both sides of a drag consistently, so this
 * only decides hand-edited docs, and a stated winner beats an
 * order-of-iteration accident. (A stored `lead: 0` still claims its edge; an
 * entry the user cleared is DELETED from the doc, not written as zeros.)
 *
 * Lines whose window the sweep did not move are returned VERBATIM — including
 * their word stamps — so a nudge on one caption cannot perturb the rest of
 * the track. The ones that did move (the nudged line AND, on a coincident
 * boundary, its neighbour) have their words scaled into the new window by
 * `scaleWordsIntoWindow`.
 *
 * DELIBERATELY NO `was` GUARD, unlike `captionWordsHidden`: timing is
 * text-orthogonal — a retype under a timing nudge changes what the caption
 * says, not when it is said, and staleness on text would drop nudges the user
 * never un-meant. `expected` in the drop reports is therefore always `""`
 * (the record stores no text to expect). Same first-claimant rule as every
 * per-word layer: ms-quantised anchors CAN collide (captions.ts:44-50), and
 * one nudge must move one line.
 */
export function applyCaptionLineTiming(
  lines: readonly CaptionLine[],
  timing: Record<string, { lead: number; tail: number }>,
): AppliedCaptionEdits {
  const dropped: AppliedCaptionEdits["dropped"] = [];
  const n = lines.length;
  // NO LINES is not "no nudges to report": every stored key is an anchor that
  // no line starts on, which is exactly the `found: null` case the sweep at
  // the bottom exists to say out loud, and what this function's own docstring
  // promises. `applyCaptionEdits` and `applyCaptionWordHides` never took this
  // shortcut either. The editor's false-banner guard lives at the CALLER
  // (`App.tsx`: `if (!renderProps) return { lines: [], dropped: [] }`), where
  // "nothing loaded yet" is distinguishable from "this cut has no captions" —
  // silence here instead let produce report nudges as applied that never were.
  if (n === 0) {
    for (const key of Object.keys(timing)) dropped.push({ key, expected: "", found: null });
    return { lines: [], dropped };
  }
  if (Object.keys(timing).length === 0) return { lines: [...lines], dropped };

  // One `[start, end]` pair PER LINE — never a shared seam array (see the
  // docstring: the conflation moved untouched captions on a gapped stream).
  const starts = lines.map((l) => l.start);
  const ends = lines.map((l) => l.end);

  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const line = lines[i]!;
    // No anchor, no nudge — the same boundary rule as `applyCaptionEdits`: a
    // pre-§137 word cannot be addressed, and the stored nudges then fall out
    // of the sweep below as `found: null`.
    const key = captionAnchorOf(line.words[0]);
    const entry = key === null ? undefined : timing[key];
    if (key === null || !entry) continue;
    // An earlier line already answered for this anchor — nudging here too
    // would fan one nudge onto a second line.
    if (seen.has(key)) {
      dropped.push({ key, expected: "", found: line.words[0]!.text, reason: "duplicate-anchor" });
      continue;
    }
    seen.add(key);
    // Deltas ride on the line's OWN edges, so a gapped stream moves the edge
    // the user dragged rather than the neighbour's. Tail first, then lead:
    // lines are visited in order, so line i+1's lead lands on a shared
    // boundary AFTER line i's tail — the documented "later lead wins".
    ends[i] = line.end + entry.tail;
    // COINCIDENCE, tested against the ORIGINAL edges: only a boundary the two
    // lines already SHARED travels with the nudge (the packed stream, where
    // every one of them is shared). Across a gap the neighbour stays where it
    // is — the sweep below still stops the moved edge from crossing it.
    // Assigning the same number, not recomputing it, keeps the two exactly
    // equal: a float `+ delta` computed twice can differ in the last bit, and
    // an unequal pair is an overlap the sweep would then have to fix.
    if (i + 1 < n && lines[i + 1]!.start === line.end) starts[i + 1] = ends[i]!;
    starts[i] = line.start + entry.lead;
    if (i > 0 && lines[i - 1]!.end === line.start) ends[i - 1] = starts[i]!;
  }

  const lo = lines[0]!.start;
  const hi = lines[n - 1]!.end;
  // Forward: into the track's bounds, never opening before the previous line
  // CLOSED (its own edge, not a derived seam), never narrower than the floor.
  for (let i = 0; i < n; i++) {
    const floor = i === 0 ? lo : Math.max(lo, ends[i - 1]!);
    starts[i] = Math.min(Math.max(starts[i]!, floor), hi);
    ends[i] = Math.min(Math.max(ends[i]!, starts[i]! + MIN_CAPTION_SEC), hi);
  }
  // The forward pass caps at `hi`, so a track with less room than
  // `n * MIN_CAPTION_SEC` can leave the last lines piled on the end. Pull them
  // back (never before `lo`) so the edges stay ordered.
  for (let i = n - 1; i >= 0; i--) {
    const ceil = i === n - 1 ? hi : Math.min(hi, starts[i + 1]!);
    ends[i] = Math.max(Math.min(ends[i]!, ceil), lo);
    starts[i] = Math.max(Math.min(starts[i]!, ends[i]! - MIN_CAPTION_SEC), lo);
  }

  const out = lines.map((line, i) => {
    const start = starts[i]!;
    const end = ends[i]!;
    // Neither edge moved: VERBATIM, same reference and same word stamps.
    if (start === line.start && end === line.end) return line;
    return {
      ...line,
      start,
      end,
      words: scaleWordsIntoWindow(line.words, line.start, line.end, start, end),
    };
  });

  // An anchor no line starts on any more — a later cut removed the word the
  // line was keyed to, or a hide emptied the line. Silence here is the
  // field-case failure mode, so say it.
  for (const key of Object.keys(timing)) {
    if (!seen.has(key)) dropped.push({ key, expected: "", found: null });
  }
  return { lines: out, dropped };
}

export interface AppliedCaptionLayers {
  lines: CaptionLine[];
  /** Every layer's drop reports, tagged with which layer refused them. */
  dropped: Array<
    AppliedCaptionEdits["dropped"][number] & { layer: "edit" | "range" | "hide" | "timing" }
  >;
}

/**
 * The caption edit layers, composed in their ONE authoritative order — the
 * single chokepoint both the editor preview and produce consume, so the two
 * can never disagree about caption content.
 *
 * Per-word edits → RANGE edits → hides → LINE TIMING. Edits BEFORE hides is the
 * `was` contract: a hide's `was` records the LIVE text the user saw when they
 * deleted the word, which is the post-retype text — running hides first
 * would stale every hide sitting on a retyped word. Range edits sit between
 * the two, but the order barely earns the word: the reducer's creation-time
 * scrubbing (`useEdits`' `patchCaptionRange`) removes every per-word edit
 * and hide inside a new range's interval, so a LIVE range edit never
 * coexists with either inside its own words — the order only matters for
 * hand-edited docs, where the layers' own guards report rather than guess.
 * Timing runs LAST because it must see the surviving LINES: the hide layer
 * re-bases a line's window onto its surviving words and drops a line whose
 * words are all hidden, and a nudge on a line that no longer exists has no
 * window to move (`applyCaptionLineTiming`). Drop reports carry which layer
 * refused them, since "the retype missed", "the rewrite missed" and "the
 * delete missed" send the user to different gestures.
 */
export function applyCaptionLayers(
  lines: readonly CaptionLine[],
  doc: OverrideDoc,
): AppliedCaptionLayers {
  const edited = applyCaptionEdits(lines, doc.captions);
  const ranged = applyCaptionRangeEdits(edited.lines, doc.captionRangeEdits);
  const hidden = applyCaptionWordHides(ranged.lines, doc.captionWordsHidden);
  const timed = applyCaptionLineTiming(hidden.lines, doc.captionLineTiming);
  return {
    lines: timed.lines,
    dropped: [
      ...edited.dropped.map((d) => ({ ...d, layer: "edit" as const })),
      ...ranged.dropped.map((d) => ({ ...d, layer: "range" as const })),
      ...hidden.dropped.map((d) => ({ ...d, layer: "hide" as const })),
      ...timed.dropped.map((d) => ({ ...d, layer: "timing" as const })),
    ],
  };
}

/** Theme tokens the user set, over whatever the production already had. */
export function resolveTheme(base: Theme, doc: OverrideDoc): Theme {
  return ThemeSchema.parse({ ...base, ...doc.theme });
}

export function setElementTransform(
  doc: OverrideDoc,
  sceneId: string,
  elementId: string,
  patch: ElementTransform,
): OverrideDoc {
  const scene = doc.scenes[sceneId] ?? SceneOverrideSchema.parse({});
  return {
    ...doc,
    scenes: {
      ...doc.scenes,
      [sceneId]: {
        ...scene,
        elements: { ...scene.elements, [elementId]: { ...scene.elements[elementId], ...patch } },
      },
    },
  };
}

/** Reset: DELETE the entry, so "reset" stays distinct from "nudged to 0,0". */
export function clearElementTransform(
  doc: OverrideDoc,
  sceneId: string,
  elementId: string,
): OverrideDoc {
  const scene = doc.scenes[sceneId];
  if (!scene) return doc;
  const { [elementId]: _removed, ...rest } = scene.elements;
  return { ...doc, scenes: { ...doc.scenes, [sceneId]: { ...scene, elements: rest } } };
}

/**
 * Un-hide ONE element: DELETE only the `hidden` key (PLAN Task 2), so a
 * nudge/scale made before the delete survives the restore — the
 * element-level mirror of `restoreScene`'s "delete the key, don't write a
 * false-ish value" rule below. `clearElementTransform` above stays the FULL
 * reset (nudges included); this is the narrower "bring it back as it was"
 * gesture the element panel's Restore button offers.
 */
export function restoreElement(
  doc: OverrideDoc,
  sceneId: string,
  elementId: string,
): OverrideDoc {
  const scene = doc.scenes[sceneId];
  const entry = scene?.elements[elementId];
  if (!scene || !entry?.hidden) return doc;
  const { hidden: _dropped, ...rest } = entry;
  // `elements` merges per ID, not per FIELD (`effectiveOverride` above:
  // `elements: { ...base.elements, ...own.elements }` replaces a shared id
  // WHOLESALE, unlike `video`/`pip`, which merge field by field). Review
  // fix wave, PLAN Task 2: a half whose own entry was ONLY `{hidden:true}`
  // would otherwise be left with the empty leftover `{}` once `hidden` is
  // stripped — and that empty object still wins the wholesale merge,
  // permanently shadowing whatever nudge the split ROOT had for this id,
  // even though "restore keeps nudges" is exactly this function's promise.
  // Dropping the key entirely once nothing but `hidden` was ever on it lets
  // the root's own entry (if any) show through again — same "delete rather
  // than leave an inert key" instinct as clearVideo/clearTiming.
  const { [elementId]: _own, ...withoutEntry } = scene.elements;
  const elements =
    Object.keys(rest).length > 0 ? { ...scene.elements, [elementId]: rest } : withoutEntry;
  return {
    ...doc,
    scenes: { ...doc.scenes, [sceneId]: { ...scene, elements } },
  };
}

/**
 * Un-pin: DELETE the `timing` override so the scene goes back to tracking its
 * word anchors. Distinct from setting a timing that happens to match the
 * derived one — this removes the override entirely.
 */
export function clearTiming(doc: OverrideDoc, sceneId: string): OverrideDoc {
  const scene = doc.scenes[sceneId];
  if (!scene || !scene.timing) return doc;
  const { timing: _removed, ...rest } = scene;
  return { ...doc, scenes: { ...doc.scenes, [sceneId]: rest } };
}

/**
 * Reset the hand-set graphic box: DELETE the key so the cue falls back to
 * its layout slot (or the routed rect), distinct from a rect that happens
 * to equal the default.
 */
export function clearGraphicRect(doc: OverrideDoc, sceneId: string): OverrideDoc {
  const scene = doc.scenes[sceneId];
  if (!scene || !scene.graphicRect) return doc;
  const { graphicRect: _removed, ...rest } = scene;
  return { ...doc, scenes: { ...doc.scenes, [sceneId]: rest } };
}

/** Same floor `assembleScenes` enforces — a pinned scene re-clamped past this
 * would be as unrenderable as one the assembler produced. */
const MIN_PINNED_SCENE_SEC = 1.2;
const PINNED_GAP_SEC = 0.05;

export interface ReclampResult {
  cues: SceneCue[];
  /** Ids whose pinned timing had to move to stop overlapping a neighbour. */
  adjusted: string[];
}

/**
 * The scene a cue id belongs to, stripping a split half's `@<split id>`
 * suffix. That suffix is opaque since §137 — a minted id, not a time — so the
 * `@` is the only thing this can key on; it is the
 * same idiom `splitCues` itself uses to derive a later half's id from its
 * root, and the same one `effectiveOverride` above inlines to find a half's
 * root entry. Two cues sharing a root are the SAME scene, cut in two.
 *
 * Exported (PLAN Task 2 review fix) for the editor's own use: a hidden
 * ELEMENT on a split half can be inherited from the root (`elements`
 * merges per id in `effectiveOverride`, and `elements` is NOT in that
 * function's inheritance-exclusion list the way `timing`/`hidden` are) —
 * Inspector.tsx's per-row Restore has to know whether the `hidden` it's
 * offering to undo lives on the half's own doc entry or the root's, and
 * this is the same root-id derivation either side of that decision needs.
 */
export function splitRootId(id: string): string {
  const at = id.indexOf("@");
  return at === -1 ? id : id.slice(0, at);
}

/**
 * Re-clamp every PINNED cue's absolute timing against its current neighbours
 * in the array, in order.
 *
 * A pin freezes a scene's timing at whatever the neighbours' timing was the
 * moment it was set — but a re-plan (a `--cleanup` level change, a re-run
 * after new source material) can move those neighbours, leaving the pinned
 * cue's frozen window overlapping one of them or the whole array out of
 * time order. That reaches `SceneLayer` and `buildCaptionLines`'
 * `breakpoints`, both of which assume non-overlapping, increasing windows.
 * The editor already clamps a pinned nudge against its neighbours at DRAG
 * time (`apps/editor/src/timing.ts`'s `clampTiming`) — this is the same
 * clamp, re-run here because a re-plan can invalidate a clamp that was
 * correct when it was made without the user touching anything.
 */
export function reclampPinnedTiming(cues: readonly SceneCue[]): ReclampResult {
  const out = cues.map((c) => ({ ...c }));
  const adjusted: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const cue = out[i]!;
    if (!cue.pinned) continue;
    const prev = out[i - 1];
    const next = out[i + 1];
    // Two adjacent pinned cues that are split halves of the SAME scene are
    // not independent neighbours (PLAN 2026-08-04 Task 1 follow-up, found in
    // review): `splitThenDropHidden` now runs `splitCues` before this
    // function, so a pinned+split scene reaches here as two entries, both
    // still `pinned: true`, with an EXACT boundary (`left.endSec ===
    // right.startSec`) that `splitCues` already cut. Applying the usual
    // `PINNED_GAP_SEC` buffer between them would carve a sliver out of the
    // seam that `fillPlainCues` then fills with a spurious plain take
    // spliced between the two halves — bug 3 again, one layer up, even
    // though the cue array itself looks correctly split.
    const prevIsSibling = prev?.pinned === true && splitRootId(prev.id) === splitRootId(cue.id);
    const nextIsSibling = next?.pinned === true && splitRootId(next.id) === splitRootId(cue.id);
    const lo = prev ? prev.endSec + (prevIsSibling ? 0 : PINNED_GAP_SEC) : 0;
    const hi = next
      ? next.startSec - (nextIsSibling ? 0 : PINNED_GAP_SEC)
      : Number.POSITIVE_INFINITY;
    let s = Math.min(Math.max(cue.startSec, lo), Math.max(lo, hi - MIN_PINNED_SCENE_SEC));
    let e = Math.max(Math.min(cue.endSec, hi), s + MIN_PINNED_SCENE_SEC);
    if (e > hi) {
      e = hi;
      s = Math.max(lo, e - MIN_PINNED_SCENE_SEC);
    }
    if (s !== cue.startSec || e !== cue.endSec) {
      out[i] = { ...cue, startSec: s, endSec: e };
      adjusted.push(cue.id);
    }
  }
  return { cues: out, adjusted };
}
