import {
  backfillSrcStart,
  captionAnchorOf,
  captionEditsToKeep,
  isLegacyCaptionKey,
  mapFromKeptSpans,
  migrateCaptionKeys,
  type AppliedCaptionEdits,
  type CaptionEdit,
  type CaptionKeyMigration,
  type CaptionLine,
  type KeptSpan,
  type OverrideDoc,
} from "@ossclip/core/browser";

/**
 * The parts of `render-props.json` the caption repair reads. Deliberately NOT
 * `RawRenderProps` (App.tsx): stating the three fields keeps this testable
 * without standing up a whole production, and keeps the pure decision out of
 * the component that owns the fetch.
 */
export interface CaptionAnchorSource {
  captionLines?: CaptionLine[];
  /** The pristine pre-edit lines, when the workdir is new enough to have them. */
  baseCaptionLines?: CaptionLine[];
  /** The kept spans the same file carries — the map the projection runs through. */
  spans?: KeptSpan[];
}

/** Only the keys that actually changed, so the caller can spread it. */
export type AnchoredCaptionLines = Omit<CaptionAnchorSource, "spans">;

/**
 * Give every caption word a source anchor before anything derives a key from
 * it (§137).
 *
 * `render-props.json` predates `srcStart` and the editor loads it as an
 * unvalidated cast, so lines that TYPECHECK as `CaptionLine` still arrive
 * without the field on any workdir produced before this change. Nothing
 * downstream can address such a word — `applyCaptionEdits` skips it and
 * `migrateCaptionKeys` resolves nothing — so a retype would appear to work and
 * silently revert, which is the field case this plan exists to remove. This is
 * the one place on the load path where the file's own `spans` are still in
 * hand to recover it from.
 *
 * BOTH line sets are repaired. App.tsx merges edits onto
 * `baseCaptionLines ?? captionLines`, so leaving the base side unanchored
 * would break the edits at exactly the point they are applied.
 *
 * NO USABLE MAP, NO REPAIR — the constraint carried from Task 1's review, and
 * the reason this is not a one-line call at the fetch. An empty `TimeMap`'s
 * `toSource` returns 0 for every input, so backfilling through one would put
 * the ENTIRE video on a single anchor `w0`, under which one stored edit
 * rewrites the first word it meets and reports nothing. That is the same
 * one-shared-key failure `captionKeyFor` refuses for `NaN`, dressed up as a
 * successful migration.
 *
 * The verdict is taken from the MAP, never from `spans.length` (§137 review):
 * `TimeMap`'s constructor DROPS any span with `srcOut <= srcIn`, so a
 * non-empty `[{srcIn: 5, srcOut: 5, …}]` builds an empty map and would have
 * walked straight through an array-length check into exactly the failure above.
 * `render-props.json` is consumed as an unvalidated cast, so that shape is
 * reachable from a hand-edited or truncated file.
 *
 * A constructor THROW (overlapping or backwards spans — the same file, the
 * same lack of a parse) is also "no repair". Escaping would matter: this is
 * the load path, and one of its two callers sits inside a render-poll catch
 * block whose recovery is to restart the interval — a deterministic throw
 * there would retry forever with `render.running` stuck true, which the Save
 * guard turns into a permanent save lockout with the user's unsaved edits
 * still in memory.
 *
 * The map built here is a PROBE, not the one that does the work: it is
 * discarded, and `backfillSrcStart` constructs its own from the same `spans`
 * (captions.ts). So the `try` below does not wrap the throw site that would
 * actually fire — it wraps a REHEARSAL of it. That is sound only because
 * `TimeMap`'s construction is deterministic and side-effect-free on identical
 * input: whatever this probe survives, the real construction survives too, and
 * whatever it throws on never reaches the real one because we return first.
 * Written down rather than tidied away, because it is the assumption the
 * safety of this function rests on (§137 review round 2 — an earlier version
 * of this comment claimed the map was built once, which it is not).
 *
 * Anchorless words are the honest outcome in every one of these cases: they
 * simply cannot carry an edit, and every edit that then finds no home is
 * REPORTED by `applyCaptionEdits`.
 *
 * Pure — the caller owns the fetch.
 */
export function anchorCaptionLines(props: CaptionAnchorSource): AnchoredCaptionLines {
  const spans = props.spans;
  if (spans === undefined) return {};
  let kept: number;
  try {
    // Probe only — see the "PROBE, not the one that does the work" paragraph
    // above before assuming this map is reused.
    kept = mapFromKeptSpans(spans).spans.length;
  } catch {
    return {};
  }
  if (kept === 0) return {};
  const out: AnchoredCaptionLines = {};
  // Each key is set only when the file actually has it, so the result stays
  // safe to spread over the raw props: writing `baseCaptionLines: undefined`
  // would be indistinguishable from the absent key to a reader, and App.tsx's
  // `baseCaptionLines ?? captionLines` fallback depends on the difference
  // being invisible only by accident.
  if (props.captionLines) out.captionLines = backfillSrcStart(props.captionLines, spans);
  if (props.baseCaptionLines) {
    out.baseCaptionLines = backfillSrcStart(props.baseCaptionLines, spans);
  }
  return out;
}

export interface MigratedOverrideDoc {
  doc: OverrideDoc;
  /**
   * Edits `migrateCaptionKeys` refused to place, keyed by the name the user's
   * file knows them by — what the load-time banner reports.
   *
   * They ARE still in `doc`, under those same original keys, since the final
   * review (Important 5). Stripping them was safe only while the editor never
   * wrote: `edits.load` clears undo and marks the doc clean, so the first save
   * after opening a legacy project deleted them from disk permanently, with a
   * dismissible banner and a `console.warn` as the whole record. Keeping them
   * restores the property that made `PUT /api/overrides` harmless without a
   * `.bak` — a save round-trips what the editor loaded — and matches what
   * `produce` now writes back (`captionEditsToKeep`), so the two paths agree
   * about which edits a project still holds.
   */
  unresolved: CaptionKeyMigration["unresolved"];
}

/**
 * Upgrade a loaded override doc's pre-§137 positional caption keys to the
 * source-time keys everything downstream reads.
 *
 * THE OTHER HALF OF THE LOAD-PATH REPAIR, and it must run AFTER
 * `anchorCaptionLines` on the same props: `migrateCaptionKeys` resolves a
 * legacy key by finding the word it named and asking for that word's anchor,
 * so against un-backfilled lines every word answers `null` and the migration
 * "succeeds" having resolved nothing — every edit into `unresolved`. That
 * ordering is the whole §137 Task 6 decision: the repair lives HERE, in the
 * editor, because this is the one place that holds anchored lines. The edit
 * server (`apps/cli/src/edit.ts`) still serves the render props exactly as
 * they sit on disk, and a `migrateCaptionKeys` bolted on there would be that
 * inert no-op.
 *
 * The doc must already have been through `OverrideDocSchema` — it has, at
 * `edit.ts:263`, before it was serialised to this client. Never call this on
 * raw `JSON.parse` output: a doc holding a literal `"__proto__"` caption key
 * comes back from `JSON.parse` as an own property, and the plain-object
 * accumulator inside `migrateCaptionKeys` would assign THROUGH it — zero own
 * keys out, a mutated prototype, and an empty `unresolved` claiming nothing
 * was lost. The schema is what strips that.
 *
 * The lines are `baseCaptionLines ?? captionLines`, character for character
 * the expression `App.tsx` merges edits onto and the Transcript panel renders.
 * Resolving against anything else would key edits to words the guard then
 * compares against different ones.
 *
 * A doc that is already source-keyed passes through unchanged: a non-legacy
 * key is its own answer, and a Record cannot hold the same key twice, so no
 * two source-keyed edits can claim one anchor. That is why this is safe to run
 * on every load rather than sniffing for legacy keys first. It is NOT true of
 * a MIXED doc — one edited before and after this change, holding `{"0": …,
 * "w6000": …}` over one word — where both claim the same anchor. There the
 * source-keyed edit wins and the legacy one is retired as `superseded`
 * (`migrateCaptionKeys`); an earlier version of this comment claimed the
 * collision rule "cannot fire", which was false for exactly the doc shape this
 * plan manufactures, and cost the user their current-format edit (§137 Task 6
 * review, Important 3).
 *
 * WHAT IT WOULD NOT PLACE STAYS IN THE DOC — see `MigratedOverrideDoc` for
 * why. Those keys are positional, so they address no word and cannot apply;
 * `sourceKeyedCaptionEdits` below is what keeps them out of the apply pass,
 * mirroring produce's use of `migration.edits` there.
 *
 * THIS PATH SEES LESS DRIFT THAN PRODUCE'S, always. It resolves against the
 * LAST run's lines with the live memo deliberately not applying `doc.cuts`, so
 * a stored index that a pending cut will invalidate still exact-hits here —
 * the preview can show an edit as applied that the render then reports
 * `out-of-range`. Stated, not closed: see `MIGRATION_SEARCH_RADIUS`.
 *
 * Pure — the caller owns the fetch.
 */
export function migrateLoadedDoc(
  doc: OverrideDoc,
  props: CaptionAnchorSource,
): MigratedOverrideDoc {
  const lines = props.baseCaptionLines ?? props.captionLines ?? [];
  const migrated = migrateCaptionKeys(doc.captions, lines);
  return {
    doc: { ...doc, captions: captionEditsToKeep(doc.captions, migrated) },
    unresolved: migrated.unresolved,
  };
}

/**
 * Just the edits that address a word — the ones the apply pass may see.
 *
 * The doc now carries unresolved LEGACY edits through (`migrateLoadedDoc`), and
 * a positional key matches no anchor, so feeding the raw map to
 * `applyCaptionEdits` would report every one of them as `found: null` — "no
 * word in this cut sits at that moment any more", which is the exact
 * misdiagnosis §137 removed from the CLI's own drop lines, raised on every
 * render, over edits the load-time banner already named. produce splits the
 * same two sets by using `migration.edits` for the apply and
 * `captionEditsToKeep` for the doc; this is that split on the editor side.
 *
 * Pure, and a no-op for the overwhelmingly common already-source-keyed doc.
 */
export function sourceKeyedCaptionEdits(
  captions: Record<string, CaptionEdit>,
): Record<string, CaptionEdit> {
  const out: Record<string, CaptionEdit> = {};
  for (const [key, edit] of Object.entries(captions)) {
    if (!isLegacyCaptionKey(key)) out[key] = edit;
  }
  return out;
}

/**
 * Caption edits that were in the editor's doc before a render and are not in
 * the doc it reloads afterwards (final review, Important 4).
 *
 * A completed render is the one moment the editor replaces its whole doc with
 * one it did not write, and until now nothing checked what came back. The
 * ledger's claim that such losses "are reported in the run log, which the
 * editor's render panel shows" is FALSE on success: `App.tsx` clears `render`
 * the moment the exit code is 0, taking the log with it, and the reloaded doc
 * is already clean — so `unresolved` is empty, `dropped` is empty, and a
 * retype disappears from the transcript between one frame and the next with
 * nothing on screen about it.
 *
 * BY CONTENT, NOT BY KEY, and that is the whole subtlety: the successful case
 * is precisely a re-KEY (`"3"` → `"w2368"`), so a key diff would report every
 * repair as a loss. An edit survived if some entry in the new doc says the
 * same thing — same replacement text over the same `was`. Counted as a
 * multiset so that the same retype stored twice, with one of the two dropped,
 * is still reported once.
 *
 * Pure — the caller owns the fetch and the banner.
 */
export function vanishedCaptionEdits(
  before: Record<string, CaptionEdit>,
  after: Record<string, CaptionEdit>,
): CaptionEdit[] {
  // `JSON.stringify` of the PAIR rather than a joined string: a retype's
  // `text` is free-form user input (the field case's is `"The same prompt for
  // bash,"`), so any separator character it might contain is one a pair could
  // forge — `["a", "b|c"]` and `["a|b", "c"]` must not share an identity.
  const idOf = (e: CaptionEdit): string => JSON.stringify([e.text, e.was]);
  const survivors = new Map<string, number>();
  for (const e of Object.values(after)) survivors.set(idOf(e), (survivors.get(idOf(e)) ?? 0) + 1);
  const lost: CaptionEdit[] = [];
  for (const e of Object.values(before)) {
    const left = survivors.get(idOf(e)) ?? 0;
    if (left > 0) survivors.set(idOf(e), left - 1);
    else lost.push(e);
  }
  return lost;
}

/**
 * What the user is told about an edit that did not come back from a render.
 *
 * Deliberately does NOT guess at a cause, and does NOT point at
 * `overrides.json.bak`. All the editor knows is that the doc it now holds is
 * missing an edit it had — the reason lives in a run log this component has
 * already discarded — and the `.bak` is only the right advice when the edit
 * had reached disk at all, which is false for the other way this fires (a
 * retype made WHILE the render ran, which the reload discards by design).
 * Naming the words and stating the fact is everything that is actually known.
 */
export function renderLossNotices(lost: readonly CaptionEdit[]): string[] {
  return lost.map(
    (e) =>
      `“${e.was}” was retyped as “${e.text}”, and the overrides this render wrote back ` +
      `no longer have it. Retype it if you still want it.`,
  );
}

/**
 * What the user is told about edits the migration could not place (§137).
 *
 * A one-time EVENT — this is what the migration decided at LOAD, and nothing
 * the user does afterwards re-runs it or reports it again. Kept separate from
 * `droppedEditNotices` below for exactly that reason: this list is state, that
 * one is a live property of the doc. (Since the final review the edits
 * themselves are no longer gone — they stay in the doc under their original
 * keys, inert — so this is a notice about what could not be placed, not about
 * what was deleted.)
 *
 * ONE SENTENCE PER CAUSE (§137 Task 6 review, Minor 7). An earlier version
 * blamed the cut for all of them, which is wrong for three of the four: an
 * ambiguous or superseded edit's word is still sitting on screen, and an
 * unanchorable one is a defect in the project's files, not in the cut. Each
 * cause also asks something different of the user, and only `not-found` and
 * `ambiguous` ask for a retype at all.
 */
export function migrationLossNotices(
  unresolved: CaptionKeyMigration["unresolved"],
): string[] {
  return unresolved.map((u) => {
    const older = `“${u.was}” was retyped in an older version of this project`;
    switch (u.reason) {
      case "out-of-range":
        // The word is on screen, so this must not read like the cut removed
        // it (final review, Important 2). It also must not read like a loss —
        // the edit stays in the project — nor promise that a retype anchors
        // it, since the word the search found may itself carry no source
        // timing (final review round 2).
        return `${older}, and the word is still here but too far from where the edit was stored to be sure it is the same one — it was left alone. It is still saved. Retype it here if that is the word you meant.`;
      case "ambiguous":
        return `${older}, and more than one word here says it — it was left alone rather than applied to the wrong one. Retype the one you meant.`;
      case "unanchorable":
        return `${older}, but this project's files carry no source timing for that word, so nothing can be anchored to it. Re-run produce, then retype it.`;
      case "collision":
        return `${older} twice, and both point at the same word — neither was applied. Retype the one you meant.`;
      case "superseded":
        return `${older} and again since; the newer edit was kept and the older one dropped.`;
      default:
        return `${older}, and no word here says it any more — the cut probably removed it. Retype it if you still want it.`;
    }
  });
}

/**
 * What the user is told about edits that did not apply to the lines on screen.
 *
 * The editor used to take `applyCaptionEdits(...).lines` and drop `dropped` on
 * the floor, which is the whole field case: a retype that could not be
 * anchored simply reverted in front of the user with nothing said. Derived,
 * never stored — the list is a property of the CURRENT doc, so it re-evaluates
 * on every edit.
 *
 * IT DOES NOT ALWAYS CLEAR ITSELF, which is why the surface that renders it is
 * dismissible (§137 Task 6 review, Important 4). A stale `found`-mismatch does
 * clear when the user retypes or undoes. A `duplicate-anchor` does NOT: the
 * anchor is a property of the WORDS, so retyping mints the same key again and
 * the second word still carries it — `overrides.ts:777-780` reports it again,
 * forever. Only deleting the edit ends it, and `backfillSrcStart` manufactures
 * shared anchors by design at seams and cut-clamped words, so a legacy workdir
 * can strand a user under a banner they can do nothing about.
 *
 * `duplicate-anchor` is deliberately phrased as a note rather than a loss: the
 * edit applied, to the first word carrying that source moment (two words share
 * one by design — `captions.ts:44-50`), and telling the user to retype
 * something already on screen would be worse than saying nothing.
 */
export function droppedEditNotices(dropped: AppliedCaptionEdits["dropped"]): string[] {
  return dropped.map((d) => {
    if (d.reason === "duplicate-anchor") {
      return `“${d.expected}” shares its moment with another word — only the first was retyped.`;
    }
    if (d.found === null) {
      return `“${d.expected}” was retyped, but no word in this cut sits at that moment any more.`;
    }
    return `“${d.expected}” was retyped, but the transcript says “${d.found}” there now.`;
  });
}

/**
 * The source anchor a caption word's `data-caption-src` attribute carries, or
 * `null` when it carries none (§137).
 *
 * The DOM is the only channel between `CaptionTrack` (which renders inside the
 * Player) and `Overlay` (which hit-tests it and holds no caption lines), so
 * this is where an anchor re-enters the editor as a string. The verdict is
 * delegated to core's `captionAnchorOf` rather than re-tested here: that is the
 * single definition of "is this word anchorable", and the emitting side already
 * gates on it. A second, hand-rolled finiteness check in this exact path is how
 * the two would drift — and this path must never hand a non-finite value to
 * `captionKeyFor`, which throws, from a React event handler with no error
 * boundary above it.
 *
 * `Number("")` is 0, not NaN, so an empty attribute is excluded explicitly
 * rather than left to look like a real anchor at the start of the source.
 */
export function captionSrcFromAttribute(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const srcStart = Number(raw);
  // Only `srcStart` is read by `captionAnchorOf`; the rest of the shape is
  // what the DOM does not carry and does not need to.
  return captionAnchorOf({ text: "", start: 0, end: 0, srcStart }) === null ? null : srcStart;
}
