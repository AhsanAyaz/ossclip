import {
  ENTRY_LEAD_SEC,
  ITEM_LEAD_SEC,
  ITEM_TIMING_COMPONENTS,
  SCENE_GAP_SEC,
  SCENE_REGISTRY,
  addFormFields,
  addFormProps,
  frameWindow,
  itemPinText,
  resolveItemWords,
  revealItemTexts,
  wordOutputStart,
  type AddFormField,
  type AddedOffered,
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
 * The add form's helpers moved here from AddGraphicPopover.tsx (§5), which
 * re-exports them until the modal replaces it.
 */

/**
 * Step 1's list (editor-added-graphics §5): a plain name and one line on what
 * each type shows. Written for the author, not the planner — `whenToUse` in
 * the registry is LLM-facing and says how to fill the props. Keyed by
 * `AddedOffered`, so a type joining the menu without copy fails the
 * typecheck. Each line stays under 60 characters so the list never wraps in
 * the popover's width.
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
  const parsed = SCENE_REGISTRY[component].propsSchema.safeParse(addFormProps(component, values));
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
function hasItemTiming(component: string): component is ItemTimingComponent {
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
 * `itemPinText`. The estimates test runs both and compares, so the copy
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
 * Rows for a graphic without the marker, from its live cue (coordinator
 * ruling on Task 6 concern 3): each item's word is the one whose item time
 * on the live map (`wordOutputStart` − `ITEM_LEAD_SEC`, floored at 0 as
 * assembly bakes it) is the cue's `reveal.itemAtSec[k]`, the first such in
 * transcript order. Auto, with no note: the planner matched it, not the
 * author. No time, or no word at that time (a time remapped off every
 * word), is unmatched, placed by the renderer. Estimates are `revealFrames`
 * over the live cue as it is, null on the legacy stagger (see `ModalRow`).
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
    const hit = at === null ? -1 : itemTimes.findIndex((t) => t !== null && Math.abs(t - at) <= BAKED_MATCH_SEC);
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
 * lands; every block word when no item has one.
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
 * bubble answers the last one, the popover's rule. */
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
 */
export function keptSpanStartOf(word: Word, map: TimeMap): number | null {
  if (wordOutputStart(word, map) === null) return null;
  const inside = map.spans.find((sp) => word.start >= sp.srcIn && word.start <= sp.srcOut);
  if (inside !== undefined) return inside.srcIn;
  return map.spans.find((sp) => sp.srcIn > word.start)?.srcIn ?? null;
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
 * (coordinator ruling on Task 6 concern 6).
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
