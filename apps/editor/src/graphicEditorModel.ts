import {
  ADDED_OFFERED,
  ENTRY_LEAD_SEC,
  ITEM_LEAD_SEC,
  ITEM_TIMING_COMPONENTS,
  SCENE_GAP_SEC,
  SCENE_REGISTRY,
  addFormFields,
  addFormProps,
  applyOverrides,
  blockWindow,
  emptyOverrideDoc,
  frameWindow,
  itemPinText,
  resolveItemTimings,
  resolveItemWords,
  resolveSceneProps,
  resolveTimingPin,
  revealItemTexts,
  sceneKeyRoot,
  wordOutputStart,
  type AddFormField,
  type AddedOffered,
  type OverrideDoc,
  type SceneComponentId,
  type SceneCue,
  type SceneTiming,
  type TimeMap,
  type Word,
} from "@ossclip/core/browser";
import { isLegacyReveal, revealFrames } from "@ossclip/scenes";
import type { ItemPins } from "./useEdits";

/**
 * The graphic editor modal's logic (graphic-editor-modal §5, §6), pure so
 * every Save rule and every row state is tested without a DOM, a Player or
 * the reducer: the modal renders `modalRows`, gates picks with
 * `allowedWords`, and dispatches whatever `saveFor` returns, or nothing when
 * it returns null.
 *
 * The add form's helpers moved here from the add popover the modal
 * replaced (§5).
 */

/**
 * Step 1's list (editor-added-graphics §5): a plain name and one line on what
 * each type shows. Written for the author, not the planner — `whenToUse` in
 * the registry is LLM-facing and says how to fill the props. Keyed by
 * `AddedOffered`, so a type joining the menu without copy fails the
 * typecheck. Each line stays under 60 characters so the list never wraps in
 * the modal's type column.
 */
export const ADD_TYPE_COPY: Record<AddedOffered, { name: string; line: string }> = {
  TitleCard: { name: "Title card", line: "One big line of text" },
  StatCard: { name: "Stat", line: "A number with a short label" },
  RuleCard: { name: "Rule", line: "A short heading over the rule it introduces" },
  StrikethroughReveal: { name: "Struck lines", line: "Up to four short lines that can be crossed out" },
  BulletList: { name: "Bullet list", line: "Two to five short points" },
  FlowDiagram: { name: "Flow", line: "Two to five steps joined in a chain" },
  ChatMock: { name: "Chat", line: "Chat bubbles from a user and an agent" },
  CardRow: { name: "Card row", line: "Two to four named cards side by side" },
  CtaCard: { name: "Call to action", line: "Asks viewers to comment, subscribe or open a link" },
  BugCard: { name: "Numbered problem", line: "A numbered problem with a short headline" },
  PhoneDemo: { name: "Phone captions", line: "Caption words shown on a phone screen" },
};

/** One form per type, built on first use. `addFormFields` walks the props
 * schema through `z.toJSONSchema` on every call, and the form re-reads its
 * fields on every keystroke. */
const FIELDS = new Map<AddedOffered, AddFormField[]>();
export function addFormFieldsFor(component: AddedOffered): AddFormField[] {
  let fields = FIELDS.get(component);
  if (fields === undefined) {
    fields = addFormFields(component);
    FIELDS.set(component, fields);
  }
  return fields;
}

/**
 * The form's starting values (§5 "Prefill"): the FIRST text field holds the
 * selected words when they fit its cap — G2, the author types the main text
 * in the same step and never sees a placeholder. Too long and it starts
 * empty rather than cut: a title clipped mid-word is a worse start than a
 * blank one. Lists start with no rows; a choice or a number starts unset, so
 * the author picks it rather than inheriting a guess.
 */
export function initialAddValues(component: AddedOffered, selectedText: string): Record<string, unknown> {
  let prefilled = false;
  const values: Record<string, unknown> = {};
  for (const f of addFormFieldsFor(component)) {
    switch (f.kind) {
      case "text":
        values[f.key] = !prefilled && selectedText.length <= f.max ? selectedText : "";
        prefilled = true;
        break;
      case "list":
      case "messages":
        values[f.key] = [];
        break;
      case "choice":
      case "number":
        values[f.key] = undefined;
        break;
    }
  }
  return values;
}

/**
 * Why Add is off, or null when it may be pressed. The RAW registry schema,
 * not `resolveSceneProps`: that merges the registry's `defaultProps` first,
 * so an empty TitleCard would pass as "TITLE" — and the conversion that
 * renders the entry parses it raw and would skip it (§2 step 2). The Add
 * gate and the conversion must say the same thing.
 */
export function addFormIssue(component: AddedOffered, values: Record<string, unknown>): string | null {
  return propsIssue(component, addFormProps(component, values));
}

/** `addFormIssue` on props already in the doc's shape: the modal holds its
 * state as scene props (`ModalState`), not as form values, so it asks the
 * same RAW parse of those. */
export function propsIssue(component: AddedOffered, props: Record<string, unknown>): string | null {
  const parsed = SCENE_REGISTRY[component].propsSchema.safeParse(props);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  if (issue === undefined) return "invalid";
  return issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

type ItemTimingComponent = (typeof ITEM_TIMING_COMPONENTS)[number];
type ItemPin = NonNullable<ItemPins["pins"][number]>;

/** The components with item rows (Terms, "Covered components"): the
 * offered types without item timing (§5) get fields and the When row only,
 * and never an `itemPins` marker. PhoneDemo has revealed pills but is not
 * one of them (NG2), so this is the core list, not "has reveal items". */
export function hasItemTiming(component: string): component is ItemTimingComponent {
  return (ITEM_TIMING_COMPONENTS as readonly string[]).includes(component);
}

/** Each item's text as a pin stores it, [] for a type without item rows. */
function itemTexts(component: string, props: Record<string, unknown>): string[] {
  if (!hasItemTiming(component)) return [];
  return (revealItemTexts(component, props) ?? []).map(itemPinText);
}

/**
 * One item row (§5): its text as a pin stores it, its state (Terms, item
 * states), its word and the time the renderer gives it.
 *
 * `word` is the transcript index the item lands on (pinned, auto), or for a
 * cut pin the pinned word that is cut: it has no time, but the strip strikes
 * it through with the item's marker (§5) and it still bounds its
 * neighbours' picks (§3). Null for an unmatched item.
 *
 * `estSec` is the renderer's own entry time for the item, output seconds on
 * the live clock: `revealFrames` over the cue, the schedule the render runs.
 * An unmatched or cut item has no word time of its own, so this is its
 * estimate; a pinned or auto one can still be clamped by the cue (a word
 * said before its final start enters on frame 0), and the box should say
 * when it enters, not when its word is said. Null only for a graphic
 * without the marker whose live cue is on its component's legacy stagger
 * (no item times, no timing prop: a stored BulletList, an older added
 * graphic). That stagger is each component's own (CardRow's beats,
 * StrikethroughReveal's wrapped rows) and not an item time, so there is
 * nothing honest to show.
 *
 * `note` is the reason a stored pin is not honoured (§3's table, a stale
 * text, or a component or count mismatch), else null.
 */
export type ModalRow = {
  text: string;
  state: "pinned" | "auto" | "cut" | "unmatched";
  word: number | null;
  estSec: number | null;
  note: string | null;
};

/**
 * What the rows are resolved against. `words` is the run's transcript list
 * (`sfxPlan.words`), `window` the block window (Terms: the selection's span
 * on an add, `blockWindow` on an edit), `liveMap` the live clock. `cue` is
 * the preview cue's final window in output seconds on that clock, and
 * `ownReveal` whether the root's own override sets `reveal`: without one, a
 * bounding pin forces `synced` (§3 step 5), and the estimates must follow.
 * `liveCue` is the root's cue as the stage renders it now (an edit; absent
 * on an add): with no marker in effect, the rows read it rather than
 * resolve (`modalRows`).
 *
 * No null clock or words here: without them the modal does not place items
 * at all (§4, "the preview cannot place items yet"), which is the modal's
 * branch to take, not a row state.
 */
export type RowContext = {
  words: readonly Word[];
  window: { srcStart: number; srcEnd: number };
  liveMap: TimeMap;
  cue: { startSec: number; endSec: number };
  fps: number;
  ownReveal: boolean;
  liveCue?: Pick<SceneCue, "startSec" | "endSec" | "props" | "reveal"> | undefined;
};

/**
 * The item rows for one graphic, as the render times it (§3, §5).
 * `itemPins` is the marker in effect, `shownItemPins` in the modal.
 *
 * Absent, with a `liveCue`, the graphic is not on word timing yet (an
 * unmarked plan graphic, before any item change) and the modal shows what
 * renders now (G5, G7), not what word timing would do: `liveRows`. The
 * first item change puts the marker in effect, and the rows switch to the
 * live resolution below. Absent with no `liveCue`, every item is auto.
 *
 * Step 2 of `resolveItemTimings` (stale pins become auto) is restated here
 * because the modal needs per-row reasons, and that function reports them
 * only as prefixed log lines. Its three tests are the same three: component,
 * count (only noted when a pin was set), and each pin's text against
 * `itemPinText`. The "drift:" tests run each of the three through both
 * this and the real pass (`resolveItemTimings`, then `revealFrames`) and
 * compare the times, the timed rows and the forced `synced`, so the copy
 * cannot drift unnoticed.
 */
export function modalRows(
  component: string,
  props: Record<string, unknown>,
  itemPins: ItemPins | undefined,
  ctx: RowContext,
): ModalRow[] {
  if (!hasItemTiming(component)) return [];
  if (itemPins === undefined && ctx.liveCue !== undefined) return liveRows(component, props, ctx, ctx.liveCue);
  const items = revealItemTexts(component, props) ?? [];
  const texts = items.map(itemPinText);
  const notes: (string | null)[] = texts.map(() => null);
  let pins: (ItemPin | null)[] = texts.map(() => null);
  if (itemPins !== undefined) {
    const anyPin = itemPins.pins.some((p) => p !== null);
    if (itemPins.component !== component) {
      if (anyPin) notes.fill(`pinned for ${itemPins.component}, not ${component}: matched by its text`);
    } else if (itemPins.pins.length !== texts.length) {
      if (anyPin) notes.fill(`pinned when there were ${itemPins.pins.length} items: matched by its text`);
    } else {
      pins = itemPins.pins.map((p, k) => {
        if (p === null || p.text === texts[k]) return p;
        notes[k] = "its text changed since it was pinned";
        return null;
      });
    }
  }

  const { words, window, liveMap, cue, fps } = ctx;
  // Once per call: `mapWord` walks the spans (resolveItemTimings' reason).
  const wordTimes = words.map((w) => wordOutputStart(w, liveMap));
  const allWords = words.map((w) => ({ text: w.text, srcStart: w.start }));
  const resolved = resolveItemWords(items, allWords, window, (i) => wordTimes[i] !== null, pins);
  // A cut pin's word, which `resolveItemWords` does not hand back: resolved
  // again with every word spoken, rows 1–3 of §3 decide the same (none reads
  // `isSpoken`, and a cut pin bounds either way), so each pin that came back
  // cut comes back pinned here, on its word. Only when there is one.
  const asSpoken = resolved.items.some((it) => it.state === "cut")
    ? resolveItemWords(items, allWords, window, () => true, pins).items
    : null;

  // resolveItemTimings steps 4 and 5, then the renderer's schedule.
  const itemAtSec = resolved.items.map((it) => {
    const at = it.word === null ? null : (wordTimes[it.word] ?? null);
    return at === null ? null : Math.max(0, at - ITEM_LEAD_SEC);
  });
  const bounded = resolved.items.some((it) => it.state === "pinned" || it.state === "cut");
  const { durationInFrames } = frameWindow(cue.startSec, cue.endSec, fps);
  const frames = revealFrames({
    count: items.length,
    // Never read: `itemAtSec` is always given with word timing on, so the
    // legacy stagger (the component's own step) is not this schedule.
    legacyStepFrames: 0,
    fps,
    durationInFrames,
    // SceneLayer's `timing`: the cue's unrounded start, frameWindow's length.
    cueStartSec: cue.startSec,
    itemAtSec,
    props: { ...revealPropsOf(props), ...(bounded && !ctx.ownReveal ? { reveal: "synced" } : {}) },
  });

  return resolved.items.map((it, k) => ({
    text: texts[k]!,
    state: it.state,
    word: it.state === "cut" ? (asSpoken?.[k]?.word ?? null) : it.word,
    estSec: cue.startSec + frames[k]! / fps,
    note: it.note ?? notes[k]!,
  }));
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The reveal props as the renderer reads them off a cue's props. */
const revealPropsOf = (props: Record<string, unknown>) => ({
  reveal: str(props.reveal),
  pacing: str(props.pacing),
  revealSpeed: typeof props.revealSpeed === "number" ? props.revealSpeed : undefined,
});

/** How close a baked item time must be to a word's to name that word:
 * float noise only, since both are the same `mapWord` start less the lead. */
const BAKED_MATCH_SEC = 1e-6;

/**
 * Rows for a graphic without the marker, from its live cue (§5 with G5 and
 * G7: the modal shows what renders, and until an item change writes the
 * marker (§6) that is the baked timing): each item's word is the one whose
 * item time on the live map (`wordOutputStart` − `ITEM_LEAD_SEC`, floored at
 * 0 as assembly bakes it) is the cue's `reveal.itemAtSec[k]`. Looked up in
 * the block's window words first, then the whole transcript: two words can
 * share an item time (both floored to 0 near the top of the output, or
 * clamped to one seam), and the one outside the block is never the word the
 * planner meant when one inside it fits. Auto, with no note: the planner
 * matched it, not the author. No time, or no word at that time (a time
 * remapped off every word), is unmatched, placed by the renderer. Estimates
 * are `revealFrames` over the live cue as it is, null on the legacy stagger
 * (see `ModalRow`).
 */
function liveRows(
  component: ItemTimingComponent,
  props: Record<string, unknown>,
  ctx: RowContext,
  live: NonNullable<RowContext["liveCue"]>,
): ModalRow[] {
  const texts = (revealItemTexts(component, props) ?? []).map(itemPinText);
  const itemAtSec = live.reveal?.itemAtSec;
  const liveProps = revealPropsOf(live.props ?? {});
  const itemTimes = ctx.words.map((w) => {
    const at = wordOutputStart(w, ctx.liveMap);
    return at === null ? null : Math.max(0, at - ITEM_LEAD_SEC);
  });
  const inBlock = windowWords(ctx.words, ctx.window);
  const legacy = isLegacyReveal(itemAtSec, liveProps);
  const { durationInFrames } = frameWindow(live.startSec, live.endSec, ctx.fps);
  const frames = legacy
    ? null
    : revealFrames({
        count: texts.length,
        // Not legacy (checked above), so the step is never read.
        legacyStepFrames: 0,
        fps: ctx.fps,
        durationInFrames,
        cueStartSec: live.startSec,
        itemAtSec,
        props: liveProps,
      });
  return texts.map((text, k) => {
    const at = itemAtSec?.[k] ?? null;
    const fits = (i: number): boolean => {
      const t = itemTimes[i];
      return at !== null && t !== null && t !== undefined && Math.abs(t - at) <= BAKED_MATCH_SEC;
    };
    const hit = at === null ? -1 : (inBlock.find(fits) ?? itemTimes.findIndex((_, i) => fits(i)));
    return {
      text,
      state: hit === -1 ? "unmatched" : "auto",
      word: hit === -1 ? null : hit,
      estSec: frames === null ? null : live.startSec + frames[k]! / ctx.fps,
      note: null,
    };
  });
}

/** Window words (Terms): every transcript word whose source start lies in
 * the block window, cut or not, half-open as `resolveItemWords` reads it.
 * The strip shows these, a cut pin struck through on its word (§5). */
export function windowWords(words: readonly Word[], window: { srcStart: number; srcEnd: number }): number[] {
  const out: number[] = [];
  words.forEach((w, i) => {
    if (w.start >= window.srcStart && w.start < window.srcEnd) out.push(i);
  });
  return out;
}

/** Block words (Terms): the window words with a word time on the live
 * clock, by the planner's own conversion. The only words a pick may land
 * on: a pin on a cut word would be cut from the moment it was made. */
export function blockWords(
  words: readonly Word[],
  window: { srcStart: number; srcEnd: number },
  liveMap: TimeMap,
): number[] {
  return windowWords(words, window).filter((i) => wordOutputStart(words[i]!, liveMap) !== null);
}

/**
 * The words a pick may choose (§5), from `blockWords`.
 *
 * An item: strictly between its neighbouring bounding pins' words (pinned or
 * cut, §3), the only picks the resolver will honour in order (row 3), so
 * nothing is offered that would come back "out of order". An auto neighbour
 * does not bound: it is re-matched around the new pin. The row being picked
 * is not its own bound.
 *
 * The start: up to the first item that has a word (pinned or auto) and on
 * it, the mockup's rule, so the graphic is on screen when its first item
 * lands; every block word when no item has one. A cut item 1 does not
 * limit it (nor does an unmatched one): it has no time to be on screen
 * for, so the limit is the first item that does, as in the mockup.
 */
export function allowedWords(rows: ModalRow[], picking: number | "start", blockWords: number[]): Set<number> {
  if (picking === "start") {
    const first = rows.find((r) => r.state === "pinned" || r.state === "auto");
    const last = first?.word ?? Infinity;
    return new Set(blockWords.filter((i) => i <= last));
  }
  const bounds = (r: ModalRow): boolean => r.state === "pinned" || r.state === "cut";
  let low = -Infinity;
  for (let j = picking - 1; j >= 0; j--) {
    const r = rows[j]!;
    if (bounds(r) && r.word !== null) {
      low = r.word;
      break;
    }
  }
  let high = Infinity;
  for (let j = picking + 1; j < rows.length; j++) {
    const r = rows[j]!;
    if (bounds(r) && r.word !== null) {
      high = r.word;
      break;
    }
  }
  return new Set(blockWords.filter((i) => i > low && i < high));
}

/**
 * One item as the modal holds it. `id` is stable across deletes and adds
 * and never reused, so Save can tell an edited row from a shifted one (a
 * delete at index 0 moves every later row down one). `pin` is what Save
 * would store for the row: the stored pin as it was (even a stale one,
 * §6), or the author's pick.
 */
export type ModalItem = { id: number; pin: ItemPin | null };

/**
 * The modal's state, opened and current (§6 compares the two).
 *
 * `props` are scene props as the doc stores them (CardRow's cards as
 * objects), never the add form's raw values: the item texts come from
 * `revealItemTexts` on these. On an edit, the root's merged props.
 * `items` runs parallel to those texts, [] for a type without item timing.
 * `stored` is the marker the graphic had at open (edit), kept to compare
 * and to fall back on; nothing writes it. `timing` is the root's timing pin,
 * the When row's to set.
 */
export type ModalState = {
  mode: "add" | "edit";
  component: string;
  props: Record<string, unknown>;
  items: readonly ModalItem[];
  nextId: number;
  stored: ItemPins | undefined;
  timing: SceneTiming | undefined;
};

/**
 * The state the modal opens with. A marker for this component and count
 * puts each stored pin on its row; a mismatched one (§3 step 2) leaves every
 * row auto, and stays as `stored` so Save can leave it alone (§6).
 */
export function openModal(input: {
  mode: "add" | "edit";
  component: string;
  props: Record<string, unknown>;
  itemPins?: ItemPins | undefined;
  timing?: SceneTiming | undefined;
}): ModalState {
  const texts = itemTexts(input.component, input.props);
  const stored = input.itemPins;
  const fits = stored !== undefined && stored.component === input.component && stored.pins.length === texts.length;
  return {
    mode: input.mode,
    component: input.component,
    props: input.props,
    items: texts.map((_, k) => ({ id: k, pin: fits ? (stored.pins[k] ?? null) : null })),
    nextId: texts.length,
    stored,
    timing: input.timing,
  };
}

/** Throws unless `props` has one item per row: the ops below keep the two
 * parallel, and a ChatMock whose `keyword` collapses it to one item
 * (`revealItemTexts`) has no message rows to add or delete. Loud on
 * purpose, `addFormFields`' `bound` posture: a silent mismatch would put
 * one row's pin on another's item. */
function checked(state: ModalState): ModalState {
  const n = itemTexts(state.component, state.props).length;
  if (n !== state.items.length) {
    throw new Error(`graphic editor: ${n} items for ${state.items.length} rows in ${state.component}`);
  }
  return state;
}

/**
 * New props at the same item count: a field or an item's text typed.
 * `rows` are the rows the modal showed before the edit (`modalRows` on
 * `shownItemPins`), because §6 decides by them: a row shown pinned or cut
 * keeps its pin with the new text, so typing never loses a pin; a row whose
 * stored pin was shown auto (moved, outside, out of order, stale) stores
 * what the modal showed once the author edits it, which is auto.
 */
export function withProps(state: ModalState, props: Record<string, unknown>, rows: readonly ModalRow[]): ModalState {
  const before = itemTexts(state.component, state.props);
  const after = itemTexts(state.component, props);
  const items = state.items.map((item, k): ModalItem => {
    const text = after[k];
    if (text === undefined || text === before[k]) return item;
    const shown = rows[k]?.state;
    const keeps = item.pin !== null && (shown === "pinned" || shown === "cut");
    return { ...item, pin: keeps ? { src: item.pin!.src, text } : null };
  });
  return checked({ ...state, props, items });
}

/** Item `k` pinned to `word` (§2: the word's source start, the item's text). */
export function pinItem(state: ModalState, k: number, word: Word): ModalState {
  const text = itemTexts(state.component, state.props)[k];
  if (text === undefined) throw new Error(`graphic editor: no item ${k + 1} to pin`);
  return { ...state, items: state.items.map((it, j) => (j === k ? { ...it, pin: { src: word.start, text } } : it)) };
}

/** Item `k` back to auto. */
export function unpinItem(state: ModalState, k: number): ModalState {
  return { ...state, items: state.items.map((it, j) => (j === k ? { ...it, pin: null } : it)) };
}

/** The props key that holds a covered component's items, and its form
 * field: the add form's own list field, so a new row is the shape the form
 * would have made. */
function itemList(state: ModalState): { field: AddFormField & { kind: "list" | "messages" }; list: unknown[] } {
  const component = state.component;
  if (!hasItemTiming(component)) throw new Error(`graphic editor: ${component} has no item rows`);
  const field = addFormFieldsFor(component).find(
    (f): f is AddFormField & { kind: "list" | "messages" } => f.kind === "list" || f.kind === "messages",
  );
  if (field === undefined) throw new Error(`graphic editor: ${component} has no list field`);
  const list = state.props[field.key];
  return { field, list: Array.isArray(list) ? list : [] };
}

/** Delete row `k`: its item and its pin, at the same index (§6). */
export function removeItem(state: ModalState, k: number): ModalState {
  const { field, list } = itemList(state);
  return checked({
    ...state,
    props: { ...state.props, [field.key]: list.filter((_, j) => j !== k) },
    items: state.items.filter((_, j) => j !== k),
  });
}

/** Add an empty row at the end, auto (§6: `null` for a new row). A new
 * bubble answers the last one, the add form's rule. */
export function appendItem(state: ModalState): ModalState {
  const { field, list } = itemList(state);
  const blank =
    field.kind === "messages"
      ? { from: field.from[list.length % field.from.length]!, text: "" }
      : field.item === "text-object"
        ? { text: "" }
        : "";
  return checked({
    ...state,
    props: { ...state.props, [field.key]: [...list, blank] },
    items: [...state.items, { id: state.nextId, pin: null }],
    nextId: state.nextId + 1,
  });
}

/** Whether the author changed an item (§6): a row added or deleted, or a
 * row's text or pin. Other fields (title, kicker, a bubble's sender) are
 * not items. */
function itemsChanged(opened: ModalState, now: ModalState): boolean {
  if (opened.component !== now.component) return true;
  if (opened.items.length !== now.items.length) return true;
  const before = itemTexts(opened.component, opened.props);
  const after = itemTexts(now.component, now.props);
  return now.items.some((it, k) => {
    const was = opened.items[k]!;
    return it.id !== was.id || after[k] !== before[k] || !same(it.pin, was.pin);
  });
}

/** The pins in effect for `now` (§6), what `modalRows` should show: the
 * rows' own once an item changed (or on an add, which always writes them);
 * until then the stored marker, mismatch and all, since Save leaves it. */
export function shownItemPins(opened: ModalState, now: ModalState): ItemPins | undefined {
  if (!hasItemTiming(now.component)) return undefined;
  if (opened.mode === "add" || itemsChanged(opened, now)) {
    return { component: now.component, pins: now.items.map((it) => it.pin) };
  }
  return opened.stored;
}

/**
 * What Save dispatches (§6), or null for nothing.
 *
 * An add: the whole entry, with the marker for a covered type always (G2:
 * its auto items are timed from the first preview) and the When row's pin
 * when set.
 *
 * An edit, only what changed (`patchProps` merges the whole patch): props
 * whose value differs, `clearKeys` for the ones the author emptied out of
 * the props, the timing pin when the When row moved it, and `itemPins` only
 * after an item change, written from the rows for the current component (a
 * mismatched marker is left as stored until then, so swapping back restores
 * it). A marker equal to the stored one is left out. Nothing at all → null:
 * `patchProps` would create `scenes[id]` even for an empty patch.
 */
export function saveFor(
  opened: ModalState,
  now: ModalState,
): null | { props: Record<string, unknown>; clearKeys: string[]; itemPins?: ItemPins; timing?: SceneTiming } {
  const covered = hasItemTiming(now.component);
  const rowPins = (): ItemPins => ({ component: now.component, pins: now.items.map((it) => it.pin) });
  if (opened.mode === "add") {
    return {
      props: now.props,
      clearKeys: [],
      ...(covered ? { itemPins: rowPins() } : {}),
      ...(now.timing !== undefined ? { timing: now.timing } : {}),
    };
  }
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(now.props)) {
    if (value !== undefined && !same(value, opened.props[key])) props[key] = value;
  }
  const clearKeys = Object.keys(opened.props).filter(
    (key) => opened.props[key] !== undefined && now.props[key] === undefined,
  );
  const timing = now.timing !== undefined && !same(now.timing, opened.timing) ? now.timing : undefined;
  const pins = covered && itemsChanged(opened, now) ? rowPins() : undefined;
  const itemPins = pins !== undefined && !same(pins, opened.stored) ? pins : undefined;
  if (Object.keys(props).length === 0 && clearKeys.length === 0 && timing === undefined && itemPins === undefined) {
    return null;
  }
  return {
    props,
    clearKeys,
    ...(itemPins !== undefined ? { itemPins } : {}),
    ...(timing !== undefined ? { timing } : {}),
  };
}

/** Structural equality over the JSON values props and pins are, with an
 * `undefined` key the same as an absent one (the `clearKeys` reading). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = (r: Record<string, unknown>) => Object.keys(r).filter((k) => r[k] !== undefined);
  const ka = keys(ra);
  return ka.length === keys(rb).length && ka.every((k) => same(ra[k], rb[k]));
}

/**
 * The source start of the kept span `word` plays in on `map`, the When
 * row's floor (§5), or null when the word is cut. A word whose start a cut
 * clips plays from the next span's start, where `mapWord` clamps it.
 *
 * The span is `TimeMap.spanOf`'s, the lookup `toOutput` (and so `mapWord`)
 * times the start by: a start a hair past a span's `srcOut` is timed in
 * that span, so it is floored there, not at the next one's start.
 */
export function keptSpanStartOf(word: Word, map: TimeMap): number | null {
  if (wordOutputStart(word, map) === null) return null;
  return map.spanOf(word.start)?.srcIn ?? null;
}

/**
 * The When row's timing pin (§5): the graphic enters `ENTRY_LEAD_SEC` ahead
 * of `word` on the live clock, as assembly leads an entry word, never before
 * the previous graphic's end plus `SCENE_GAP_SEC` (output seconds on the
 * live clock, `prevGraphicEndSec`), and ends where the cue does
 * (`cueEndSec`, output). Stored in source seconds, so it survives the next
 * re-cut (`SceneTimingSchema`'s src arm).
 *
 * The floor at `keptSpanStart` (`keptSpanStartOf`, source seconds) is
 * applied AFTER `toSource`, in source seconds: a lead that reaches back
 * over a seam maps into the span before the cut, and `toSource` gives the
 * earlier preimage of the seam instant itself. Either way the pin would
 * start before the cut pause, and on a clock that revives the pause the
 * graphic would enter inside it (`resolveTimingPin` resolves the src pin as
 * stored). A one-time set: it does not follow item 1 later.
 *
 * Null when the pin would end at or before it starts (a word at or after
 * the cue's end): `SceneTimingSchema` refuses an inverted src pin and
 * `patchProps` stores it verbatim, so the caller refuses that word instead
 * (§5, When row: the pin it writes must be one the doc can hold).
 *
 * Throws for a word with no time on the live clock: only block words are
 * offered (`blockWords`), so that is a caller bug, not a state.
 */
export function whenRowPin(
  word: Word,
  liveMap: TimeMap,
  keptSpanStart: number,
  prevGraphicEndSec: number | null,
  cueEndSec: number,
): { srcStart: number; srcEnd: number } | null {
  const at = wordOutputStart(word, liveMap);
  if (at === null) throw new Error(`graphic editor: "${word.text}" is cut, so nothing can start on it`);
  const outStart = Math.max(at - ENTRY_LEAD_SEC, prevGraphicEndSec === null ? -Infinity : prevGraphicEndSec + SCENE_GAP_SEC);
  const srcStart = Math.max(liveMap.toSource(outStart), keptSpanStart);
  const srcEnd = liveMap.toSource(cueEndSec);
  return srcEnd > srcStart ? { srcStart, srcEnd } : null;
}

/** The list field a type's item rows edit (the add form's own, so a row is
 * the shape the form makes), or null for a type without one. */
export function listFieldOf(component: string): (AddFormField & { kind: "list" | "messages" }) | null {
  if (!(ADDED_OFFERED as readonly string[]).includes(component)) return null;
  return (
    addFormFieldsFor(component as AddedOffered).find(
      (f): f is AddFormField & { kind: "list" | "messages" } => f.kind === "list" || f.kind === "messages",
    ) ?? null
  );
}

/** A list entry's text as its row shows it: a string item itself, a card's,
 * line's or bubble's own `text` (CardRow's sub-line is not typed here). */
export function entryText(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry !== null && typeof entry === "object") return str((entry as Record<string, unknown>).text) ?? "";
  return "";
}

/** The entry with its text replaced and every other key kept: a card's
 * `sub`, a line's `struck`, a bubble's `from` are not the row's to drop. */
export function withEntryText(entry: unknown, text: string): unknown {
  if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) return { ...entry, text };
  return text;
}

/**
 * Whether the rows may be added to or deleted (§5: counts within the
 * schema's own min and max, which the buttons gate). Not for a ChatMock
 * whose `keyword` collapses it to one item (`revealItemTexts`): its message
 * rows are not its items, and `appendItem`/`removeItem` refuse it rather
 * than put one row's pin on another's item. A type without item timing
 * (PhoneDemo's caption words) has no pins to keep in step, so it may.
 */
export function rowsResizable(component: string, props: Record<string, unknown>): boolean {
  const field = listFieldOf(component);
  if (field === null) return false;
  if (!hasItemTiming(component)) return true;
  const list = props[field.key];
  return itemTexts(component, props).length === (Array.isArray(list) ? list.length : 0);
}

/**
 * Why the primary button is off, said the way the author fixes it, or null
 * when it may be pressed (§5 "Needs text", the footer reason). The checks
 * read the form's own fields, in the form's order; anything they do not
 * name falls back to the schema's own first complaint (`propsIssue`), so the
 * gate is never looser than the parse the entry must pass.
 */
export function saveBlocker(component: AddedOffered, props: Record<string, unknown>): string | null {
  for (const f of addFormFieldsFor(component)) {
    const value = props[f.key];
    switch (f.kind) {
      case "text": {
        const text = typeof value === "string" ? value : "";
        if (text.trim() === "") return `${f.label} needs text.`;
        if (text.length > f.max) return `${f.label} is too long (${text.length}/${f.max}).`;
        break;
      }
      case "choice":
        if (typeof value !== "string" || !f.options.includes(value)) return `Choose the ${f.label.toLowerCase()}.`;
        break;
      case "number":
        if (typeof value !== "number" || !Number.isInteger(value) || value < f.min || value > f.max) {
          return `${f.label} needs a whole number from ${f.min} to ${f.max}.`;
        }
        break;
      case "list":
      case "messages": {
        const list = Array.isArray(value) ? value : [];
        const plural = f.kind === "messages" ? "messages" : f.label.toLowerCase();
        const one = plural.replace(/s$/, "");
        const empty = list.filter((e) => entryText(e).trim() === "").length;
        if (empty > 0) {
          return `${empty} ${empty === 1 ? `${one} needs` : `${plural} need`} text. Type it or delete the row.`;
        }
        const long = list.findIndex((e) => entryText(e).length > f.itemMax);
        if (long !== -1) return `${one[0]!.toUpperCase()}${one.slice(1)} ${long + 1} is too long (${entryText(list[long]).length}/${f.itemMax}).`;
        if (list.length < f.min) return `Add at least ${f.min} ${plural}.`;
        if (list.length > f.max) return `${f.max} ${plural} is the most this graphic holds.`;
        break;
      }
    }
  }
  return propsIssue(component, props);
}

/**
 * The one cue the modal's preview plays (§4 "The modal's preview", G5): the
 * cue as the stage would assemble it (`base`: on an add the selection's
 * one-scene assembly on the live clock, on an edit the root's live cue),
 * carrying the modal's props, its When-row pin and its items timed by the
 * very pass the stage runs (`resolveItemTimings` on this one cue, on the
 * live clock), so what the preview shows is what Save makes the stage show.
 *
 * Props go through `resolveSceneProps` (the registry's defaults under the
 * author's, what assembly hands a component): the modal holds the RAW props
 * an add stores, and a component drawn from them alone would miss its
 * defaulted fields. Props that do not parse give `base` back whole, its own
 * component and props: the preview keeps the last graphic that could render
 * while the author is mid-edit, and never draws a component over props of
 * another shape (a scene reading `items` off a TitleCard's props throws).
 *
 * `pins` is `shownItemPins`. Undefined (an unmarked graphic, before any item
 * change) leaves `base`'s own item times, the baked timing the stage draws
 * (`modalRows`' live rows read the same). `ownReveal` is the root's own
 * override `reveal`, which keeps a bounding pin from forcing `synced` (§3
 * step 5); the resolver tests its presence in the doc, so it rides in a
 * one-entry doc beside the pins.
 */
export function previewCue(
  base: SceneCue,
  now: ModalState,
  pins: ItemPins | undefined,
  ctx: {
    words: readonly Word[] | null;
    window: { srcStart: number; srcEnd: number } | null;
    liveMap: TimeMap | null;
    ownReveal: unknown;
  },
): SceneCue {
  const component = now.component as SceneComponentId;
  const props = component in SCENE_REGISTRY ? resolveSceneProps(component, now.props) : null;
  if (props === null) return base;
  let cue: SceneCue = { ...base, component, props };
  if (now.timing !== undefined && ctx.liveMap !== null) {
    const at = resolveTimingPin(now.timing, ctx.liveMap);
    if (at !== null) {
      // A pin is the author's absolute window and wins over the entry word,
      // `applyOverrides`' rule (reveal-timing final review I-3).
      const { entryAtSec: _entry, ...rest } = cue;
      cue = { ...rest, startSec: at.startSec, endSec: at.endSec };
    }
  }
  const { words, window, liveMap } = ctx;
  if (pins === undefined || !hasItemTiming(now.component) || words === null || window === null || liveMap === null) {
    return cue;
  }
  const doc: OverrideDoc = {
    ...emptyOverrideDoc(),
    scenes: {
      [cue.id]: {
        props: ctx.ownReveal === undefined ? {} : { reveal: ctx.ownReveal },
        elements: {},
        itemPins: pins,
      },
    },
  };
  const roots = new Map([[cue.id, { component: now.component, props: now.props, window }]]);
  return resolveItemTimings([cue], doc, words, liveMap, roots).cues[0] ?? cue;
}

/**
 * The previous graphic's end on the live clock (§5 When row: a start is
 * never before it plus `SCENE_GAP_SEC`): the latest end among the graphic
 * cues that start before `startSec`, the block's own halves left out
 * (`ownRoot`, its root id; null on an add, which has no cue yet). Plain takes
 * do not count: the fill re-derives them around whatever graphics exist.
 */
export function previousGraphicEndSec(
  cues: readonly SceneCue[],
  startSec: number,
  ownRoot: string | null,
): number | null {
  let end: number | null = null;
  for (const c of cues) {
    if (c.kind === "plain" || c.startSec >= startSec) continue;
    if (ownRoot !== null && sceneKeyRoot(c.id) === ownRoot) continue;
    if (end === null || c.endSec > end) end = c.endSec;
  }
  return end;
}

/** Float noise between a start and the word time it was led from. */
const START_EPS = 1e-6;

/**
 * The word the block starts on, for the When row and the strip's start
 * flag (§5): the first block word timed at or after the cue's start on the
 * live clock. A start led `ENTRY_LEAD_SEC` ahead of a word (`whenRowPin`,
 * assembly's entry lead) names that word; a start floored onto a word (an
 * add's own first word) names it too. Null when no block word is.
 */
export function startWordOf(
  blockWords: readonly number[],
  words: readonly Word[],
  liveMap: TimeMap,
  startSec: number,
): number | null {
  for (const i of blockWords) {
    const t = wordOutputStart(words[i]!, liveMap);
    if (t !== null && t >= startSec - START_EPS) return i;
  }
  return null;
}

/**
 * The word an unmatched item's marker sits on in the strip: the last block
 * word whose item time (word time less `ITEM_LEAD_SEC`) is at or before the
 * renderer's estimate, so the dashed marker stands where the item comes in.
 * The first block word when the estimate is before them all; null with no
 * block words or no estimate.
 */
export function wordAtSec(
  blockWords: readonly number[],
  words: readonly Word[],
  liveMap: TimeMap,
  sec: number | null,
): number | null {
  if (sec === null || blockWords.length === 0) return null;
  let at: number = blockWords[0]!;
  for (const i of blockWords) {
    const t = wordOutputStart(words[i]!, liveMap);
    if (t !== null && t - ITEM_LEAD_SEC <= sec + START_EPS) at = i;
  }
  return at;
}

/** The word being said at `sec` on the live clock (the strip's playhead,
 * orange text), or null between words: its own `mapWord` span, half-open. */
export function spokenWordAt(
  windowWords: readonly number[],
  words: readonly Word[],
  liveMap: TimeMap,
  sec: number,
): number | null {
  for (const i of windowWords) {
    const span = liveMap.mapWord(words[i]!);
    if (span !== null && sec >= span.start && sec < span.end) return i;
  }
  return null;
}

/** m:ss.s — the modal's times, a tenth finer than the ruler's m:ss because
 * an item lands on one word of several in a second. */
export function clockText(sec: number): string {
  const tenths = Math.max(0, Math.round(sec * 10));
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/** What the modal opens an edit with (§5 "Edit"). */
export type EditModalInput = {
  component: AddedOffered;
  /** The root's merged props, as the first override pass leaves them:
   * before the item pass, whose forced `synced` is not the author's. */
  props: Record<string, unknown>;
  itemPins: ItemPins | undefined;
  timing: SceneTiming | undefined;
  /** The root's own override `reveal` (§3 step 5), undefined when unset. */
  ownReveal: unknown;
  /** The root as the stage draws it, its halves joined into one window. */
  liveCue: SceneCue;
  /** The block window (Terms), null without words, clocks or an anchor. */
  window: { srcStart: number; srcEnd: number } | null;
};

/**
 * An edit's inputs for the root `rootId` (§5: a split half opens its root),
 * or null when there is nothing the modal can edit: no block on the stage
 * under that root, or a type the add menu does not offer (the modal's form is
 * the add form; a clip, a terminal or a screenshot has none).
 *
 * `base` is the graphic-only base the live memo merges onto (`previewBase`,
 * added graphics reconciled), so the props are the root's merged props from
 * one `applyOverrides` (its own component swap included), the very list the
 * item pass takes its roots from (`itemTimingRoots`), and the window is
 * `blockWindow` on that cue, the window the stage resolves on. `cues` are the
 * live stage cues (`live.sceneCues`), for what the root looks like now.
 */
export function editModalInput(args: {
  rootId: string;
  cues: readonly SceneCue[];
  base: readonly SceneCue[];
  doc: OverrideDoc;
  words: readonly Word[] | null;
  pinMap: TimeMap | null;
  liveMap: TimeMap | null;
}): EditModalInput | null {
  const { rootId, cues, base, doc, words, pinMap, liveMap } = args;
  const halves = cues.filter((c) => c.kind !== "plain" && sceneKeyRoot(c.id) === rootId);
  const shown = halves.find((c) => c.id === rootId) ?? halves[0];
  if (shown === undefined) return null;
  const liveCue: SceneCue = {
    ...shown,
    startSec: Math.min(...halves.map((c) => c.startSec)),
    endSec: Math.max(...halves.map((c) => c.endSec)),
  };
  const baseCue = base.find((c) => c.id === rootId);
  const merged = baseCue === undefined ? shown : (applyOverrides([baseCue], doc).cues[0] ?? shown);
  const component = merged.component;
  if (component === undefined || !(ADDED_OFFERED as readonly string[]).includes(component)) return null;
  const own = doc.scenes[rootId];
  return {
    component: component as AddedOffered,
    props: merged.props ?? {},
    itemPins: own?.itemPins,
    timing: own?.timing,
    ownReveal: own?.props.reveal,
    liveCue,
    window:
      words === null || pinMap === null || liveMap === null ? null : blockWindow(merged, doc, words, pinMap, liveMap),
  };
}
