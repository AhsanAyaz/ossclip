import type { SceneCue } from "./scene-schema";
import type { TimeMap } from "./timemap";
// Types only (take-looks-by-source R6-8): `OverrideDocSchema` imports
// `normalizeTakeLooks` from here at runtime, so a value import back would
// be a module cycle — and the schema module is the one that must finish
// evaluating first. The look VALUES are validated there, against
// `SceneOverrideSchema` itself, before this module ever sees them.
import type { SceneOverride } from "./overrides";

/**
 * Take looks attached to source time (docs/designs/take-looks-by-source.md).
 *
 * ossclip never stores its takes: each run, and the editor live, rebuilds
 * them from the gaps graphics leave and names them by position. A look saved
 * under that positional name moved onto other footage whenever anything
 * renumbered the takes — a cut in front, a graphic added or moved, a kept
 * cleanup range. So a look belongs to a SOURCE range instead (§155: key on
 * the property the disruption cannot move), and a take piece shows the look
 * of the footage it plays, wherever that footage lands on the output.
 *
 * Everything here is pure and works in integer source MILLISECONDS
 * internally (L1: every helper rounds source seconds to the millisecond
 * itself), so "under 1 ms", ties and coalescing are exact comparisons rather
 * than float judgement calls.
 */

/** Source seconds, ms-rounded. */
export type SrcRange = { srcIn: number; srcOut: number };
/** The five look fields (L1). `video` carries `volume` and `autoZoom` too —
 * they are look fields as much as the framing is. */
export type TakeLook = Pick<SceneOverride, "video" | "pip" | "layout" | "captionY" | "captionScale">;
export type TakeLookEntry = SrcRange & { look: TakeLook };

// Member order is fixed so one look always serializes one way: deep-equal
// coalescing compares serializations, and a second produce run with no edits
// must write a byte-equal `takeLooks` (R6-10).
const VIDEO_MEMBERS = ["scale", "dx", "dy", "autoZoom", "volume"] as const;
const PIP_MEMBERS = ["cornerRadius", "x", "y"] as const;

type MsEntry = { a: number; b: number; look: TakeLook };

const toMs = (sec: number): number => Math.round(sec * 1000);
const toSec = (ms: number): number => ms / 1000;

function pickMembers<K extends string>(raw: unknown, members: readonly K[]): Partial<Record<K, unknown>> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const src = raw as Record<string, unknown>;
  const out: Partial<Record<K, unknown>> = {};
  for (const m of members) if (src[m] !== undefined) out[m] = src[m];
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The look part of an override entry (R6-8): the five keys, with undefined
 * values and empty `video`/`pip` records dropped, in a fixed key order.
 * Migration (L3) reads a take's id-keyed values through this, and every
 * stored look passes through it, so "an empty look" means one thing
 * everywhere. Takes `TakeLook` as well as a whole `SceneOverride`, which is
 * assignable to it.
 */
export function inScope(o?: SceneOverride | TakeLook): TakeLook {
  if (o === undefined) return {};
  const out: TakeLook = {};
  const video = pickMembers(o.video, VIDEO_MEMBERS);
  if (video) out.video = video as TakeLook["video"];
  const pip = pickMembers(o.pip, PIP_MEMBERS);
  if (pip) out.pip = pip as TakeLook["pip"];
  if (o.layout !== undefined) out.layout = o.layout;
  if (o.captionY !== undefined) out.captionY = o.captionY;
  if (o.captionScale !== undefined) out.captionScale = o.captionScale;
  return out;
}

const isEmptyLook = (look: TakeLook): boolean => Object.keys(look).length === 0;
// `inScope` fixes the key order, so equal looks serialize identically.
const lookKey = (look: TakeLook): string => JSON.stringify(inScope(look));

/** A copy deep enough that a caller mutating `video`/`pip` cannot reach the
 * stored entry. */
const cloneLook = (look: TakeLook): TakeLook => inScope(look);

/**
 * Sort, resolve overlaps (the LATER entry in input order wins on the
 * overlapped part, m3), coalesce neighbours whose gap is ≤ 1 ms and whose
 * looks are deep-equal, and drop empty looks (S9). Empties drop FIRST: an
 * empty entry says nothing, so it must not punch a hole in an earlier one.
 */
function normalizeMs(entries: readonly MsEntry[]): MsEntry[] {
  let painted: MsEntry[] = [];
  for (const e of entries) {
    if (!(e.a < e.b) || isEmptyLook(e.look)) continue;
    const next: MsEntry[] = [];
    for (const p of painted) {
      if (p.b <= e.a || p.a >= e.b) {
        next.push(p);
        continue;
      }
      if (p.a < e.a) next.push({ a: p.a, b: e.a, look: p.look });
      if (p.b > e.b) next.push({ a: e.b, b: p.b, look: p.look });
    }
    next.push(e);
    painted = next;
  }
  painted.sort((x, y) => x.a - y.a);
  const out: MsEntry[] = [];
  for (const e of painted) {
    const last = out[out.length - 1];
    if (last !== undefined && e.a - last.b <= 1 && lookKey(last.look) === lookKey(e.look)) {
      out[out.length - 1] = { a: last.a, b: e.b, look: last.look };
      continue;
    }
    out.push(e);
  }
  return out;
}

const fromMs = (entries: readonly MsEntry[]): TakeLookEntry[] =>
  entries.map((e) => ({ srcIn: toSec(e.a), srcOut: toSec(e.b), look: cloneLook(e.look) }));

/**
 * The stored list, normalized (S9: the schema normalizes instead of
 * rejecting). Drops an item that is not an entry, has a non-finite edge, has
 * `srcIn ≥ srcOut` once ms-rounded, or carries an empty look; then sorts,
 * resolves overlaps (later wins) and coalesces. Structural checks only: the
 * look's VALUES are `SceneOverrideSchema`'s to validate, which
 * `OverrideDocSchema.takeLooks` does per entry before calling this.
 */
export function normalizeTakeLooks(raw: unknown[]): TakeLookEntry[] {
  const entries: MsEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { srcIn, srcOut, look } = item as Record<string, unknown>;
    if (typeof srcIn !== "number" || typeof srcOut !== "number") continue;
    if (!Number.isFinite(srcIn) || !Number.isFinite(srcOut)) continue;
    if (typeof look !== "object" || look === null) continue;
    entries.push({ a: toMs(srcIn), b: toMs(srcOut), look: inScope(look as TakeLook) });
  }
  return fromMs(normalizeMs(entries));
}

/**
 * The source segments an output window plays on `map`'s clock (L1): one per
 * kept span the window touches, each clipped to that span exactly — no inset
 * (B7). A list, because a live-clock piece can cross a seam (S7). Ranges that
 * round to nothing are dropped; a window that only touches a span's edge
 * plays none of it.
 */
export function pieceSourceRanges(
  window: { startSec: number; endSec: number },
  map: TimeMap,
): SrcRange[] {
  const out: SrcRange[] = [];
  for (const sp of map.spans) {
    const lo = Math.max(window.startSec, sp.outIn);
    const hi = Math.min(window.endSec, sp.outOut);
    if (!(hi > lo)) continue;
    const a = toMs(sp.srcIn + (lo - sp.outIn));
    const b = toMs(sp.srcIn + (hi - sp.outIn));
    if (b > a) out.push({ srcIn: toSec(a), srcOut: toSec(b) });
  }
  return out;
}

/**
 * The look a piece playing `ranges` shows (L1): the single ENTRY with the
 * largest total overlap — per entry, not per distinct look (m2), so two
 * entries that happen to share a look do not add up. An overlap under 1 ms
 * counts as none (the floor), a tie goes to the lower `srcIn` (then the
 * earlier entry), and nothing overlapping gives `{}`. A piece spanning two
 * looks therefore shows the larger one; it is never split at a look boundary
 * (non-goal, review S4).
 */
export function lookAt(looks: readonly TakeLookEntry[], ranges: readonly SrcRange[]): TakeLook {
  const rs = ranges.map((r) => ({ a: toMs(r.srcIn), b: toMs(r.srcOut) }));
  let best: { overlap: number; a: number; look: TakeLook } | undefined;
  for (const e of looks) {
    const a = toMs(e.srcIn);
    const b = toMs(e.srcOut);
    let overlap = 0;
    for (const r of rs) {
      const o = Math.min(b, r.b) - Math.max(a, r.a);
      // Integer ms, so "under 1 ms" is exactly "no whole millisecond".
      if (o >= 1) overlap += o;
    }
    if (overlap === 0) continue;
    if (best === undefined || overlap > best.overlap || (overlap === best.overlap && a < best.a)) {
      best = { overlap, a, look: e.look };
    }
  }
  return best === undefined ? {} : cloneLook(best.look);
}

/**
 * Rewrite every part of the hull of `ranges` (R6-3: `[min srcIn, max
 * srcOut]`, material a live cut removed in between included, so restored
 * material inside a piece shows that piece's look and an older one cannot
 * come back). Entries are fragmented at the hull's edges; each part inside
 * the hull — an entry's piece of it, or a gap, as `{}` — goes through
 * `rewrite` on its OWN current look. Then normalized.
 */
function rewriteHull(
  looks: readonly TakeLookEntry[],
  ranges: readonly SrcRange[],
  rewrite: (look: TakeLook) => TakeLook,
): TakeLookEntry[] {
  const current = normalizeMs(
    looks.map((e) => ({ a: toMs(e.srcIn), b: toMs(e.srcOut), look: inScope(e.look) })),
  );
  if (ranges.length === 0) return fromMs(current);
  const h0 = Math.min(...ranges.map((r) => toMs(r.srcIn)));
  const h1 = Math.max(...ranges.map((r) => toMs(r.srcOut)));
  if (!(h1 > h0)) return fromMs(current);
  const out: MsEntry[] = [];
  const part = (a: number, b: number, look: TakeLook) => {
    if (b > a) out.push({ a, b, look: rewrite(look) });
  };
  let cursor = h0;
  for (const e of current) {
    if (e.b <= h0 || e.a >= h1) {
      out.push(e);
      continue;
    }
    if (e.a < h0) out.push({ a: e.a, b: h0, look: e.look });
    const s = Math.max(e.a, h0);
    const t = Math.min(e.b, h1);
    part(cursor, s, {});
    part(s, t, e.look);
    cursor = t;
    if (e.b > h1) out.push({ a: h1, b: e.b, look: e.look });
  }
  part(cursor, h1, {});
  return fromMs(normalizeMs(out));
}

/**
 * Write `patch` over the piece playing `ranges` (L1), field-scoped
 * (R4-S10): over the hull (R6-3), each part's OWN look is merged with the
 * patch, and fields the patch does not name keep their per-part values — so
 * an edit on a mixed piece sets the edited field everywhere in it and leaves
 * the minority look's other fields alone (R7-11).
 *
 * The write units (R6-2, R7-3) — `{scale, dx, dy}` and pip `{x, y}` — are
 * expanded from each part's own current value: a field-by-field merge of
 * the patch over THAT part's `video`/`pip` is exactly that expansion, since
 * the part's own values fill the members the patch does not name. A member
 * absent from both stays absent, never written as a default (`scale: 1`,
 * `dy: 0` would be a framing nobody chose). An explicit
 * `layout: "full-bleed"` is stored like any other choice.
 */
export function setTakeLook(
  looks: readonly TakeLookEntry[],
  ranges: readonly SrcRange[],
  patch: TakeLook,
): TakeLookEntry[] {
  const p = inScope(patch);
  return rewriteHull(looks, ranges, (cur) =>
    inScope({
      ...cur,
      ...p,
      ...(cur.video || p.video ? { video: { ...cur.video, ...p.video } } : {}),
      ...(cur.pip || p.pip ? { pip: { ...cur.pip, ...p.pip } } : {}),
    }),
  );
}

/**
 * Delete `fields` over every part of the hull of `ranges` (L1, R6-3) — a
 * real reset for those fields, not a write of their defaults. A part left
 * with nothing becomes a gap again.
 */
export function clearTakeLookFields(
  looks: readonly TakeLookEntry[],
  ranges: readonly SrcRange[],
  fields: readonly (keyof TakeLook)[],
): TakeLookEntry[] {
  return rewriteHull(looks, ranges, (cur) => {
    const next: TakeLook = { ...cur };
    for (const f of fields) delete next[f];
    return inScope(next);
  });
}

/**
 * Resolve every plain take's look from source time (L2) — the ONE pass both
 * pipelines run, only for a migrated doc (`doc.takeLooks !== undefined`, L3);
 * a legacy doc never reaches it.
 *
 * For each `kind === "plain"` cue (`take-kept-*` and halves included), the
 * look of the footage its window plays on `map`:
 * - `video`, `pip`, `captionY` and `captionScale` are SET from the look, and
 *   deleted when it lacks them. In look mode they come only from here, so
 *   nothing a carve or split copied from a neighbour leaks through (S14: a
 *   kept or minted block shows its own footage's look, not its host's).
 * - `layout` is the look's, else `"full-bleed"` — `fillPlainCues`' base. A
 *   minted kept block with no plain neighbour, which `carveKeptTakes` gives
 *   `"video-top"`, is therefore full-bleed in look mode unless its footage
 *   has a look (declared change; `carveKeptTakes` itself is unchanged, S13).
 * Graphic cues pass through as the same objects.
 */
export function applyTakeLooks(
  cues: readonly SceneCue[],
  looks: readonly TakeLookEntry[],
  map: TimeMap,
): SceneCue[] {
  return cues.map((cue) => {
    if (cue.kind !== "plain") return cue;
    const look = lookAt(looks, pieceSourceRanges(cue, map));
    const { video: _video, pip: _pip, captionY: _captionY, captionScale: _captionScale, ...rest } = cue;
    return {
      ...rest,
      layout: look.layout ?? "full-bleed",
      ...(look.video !== undefined ? { video: look.video } : {}),
      ...(look.pip !== undefined ? { pip: look.pip } : {}),
      ...(look.captionY !== undefined ? { captionY: look.captionY } : {}),
      ...(look.captionScale !== undefined ? { captionScale: look.captionScale } : {}),
    };
  });
}
