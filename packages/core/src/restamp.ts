/**
 * Re-stamping a re-transcribed source range onto the words already in
 * `transcript.json` (Phase A, 2026-08-26).
 *
 * WHY THIS EXISTS: inside a kept retake whisper mis-POSITIONS words — "has
 * its" displays while the audio says "could read 50 files", stamps off by
 * 1.5-3s — because the original decode ran over material the cut later
 * revived. Re-decoding just that span fixes the positions; the problem is
 * that everything downstream indexes into the words ARRAY.
 *
 * THE ONE LOAD-BEARING CONSTRAINT: the splice changes STAMPS ONLY — never
 * text, never word count. `ProductionSchema.transcript`'s doctrine is that
 * analysis and the cutlist index into `transcript.words`, and produce's
 * beat/clip caches (`beatSheetCacheKey`, `clipWindowCacheKey`) hash word
 * TEXT. A count-preserving, text-preserving splice therefore keeps every word
 * index valid, every LLM cache warm, `--transcript` replay unaffected and the
 * repairs diff still applicable. Every function here is written to that rule:
 * `alignRestamp` returns exactly as many words, with exactly the same text, as
 * it was given, and `spliceTranscript` refuses a count that does not match.
 *
 * PURE, and browser-safe on purpose: `rekeyCaptionRecords` runs in the
 * editor's `useEdits` reducer (the doc is client-owned — the server never
 * touches `overrides.json`), so nothing in this module may reach a node
 * built-in. That is also why `normalizeAlignToken` is restated here instead of
 * imported from `analyze.ts`, which pulls in `./exec` → `child_process`.
 */
import { captionKeyFor } from "./overrides";
import type { OverrideDoc } from "./overrides";
import type { Transcript, Word } from "./schema";

/**
 * The comparison form for alignment: `analyze.ts`'s `normalizeToken`,
 * character for character. Kept byte-identical (rather than "close enough")
 * so a word the filler/retake passes consider the same word is the same word
 * here too — two normalizers that drift are two different transcripts.
 */
export function normalizeAlignToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}-]+$/gu, "");
}

/**
 * A caption key's millisecond, derived from `captionKeyFor` rather than
 * restating its `Math.round(s * 1000)` (§137). The mapping this module emits
 * is consumed by `rekeyCaptionRecords` against keys the EDITOR minted through
 * `captionKeyFor`, so a second rounding rule here is a silent off-by-one-ms
 * that parks every entry.
 */
export function captionKeyMs(srcStart: number): number {
  return Number(captionKeyFor(srcStart).slice(1));
}

/** One source anchor that MOVED, at `captionKeyFor`'s ms quantization. */
export interface StampMove {
  fromMs: number;
  toMs: number;
}

export interface RestampResult {
  /** Same length, same text as `oldWords` — only `start`/`end` differ. */
  words: Word[];
  /** Every `srcStart` that moved; unmoved words are deliberately absent. */
  mapping: StampMove[];
  /** What the alignment could not do exactly, in the user's language. */
  reports: string[];
}

/** Where an old word's stamps came from — see `alignRestamp`'s two cases. */
type Alignment = { kind: "matched"; newIndex: number } | { kind: "gap" };

/**
 * Longest common subsequence over normalized tokens, as index pairs.
 *
 * MONOTONE BY CONSTRUCTION, which is the property the whole splice rests on:
 * an alignment that could cross would let a later old word take an earlier new
 * stamp and hand the transcript a non-monotone word list, which
 * `captions.ts`'s line packing reads as gibberish. Classic O(n*m) DP —
 * a re-transcribed range is a handful of seconds of speech (tens of words), so
 * the table is tiny and the simple algorithm is the readable one.
 */
function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Re-stamp `oldWords` from a fresh decode of the same audio span.
 *
 * `newWords` carry CLIP-RELATIVE stamps (whisper decodes the sliced wav and
 * knows nothing about where the slice came from), so `spanStart` — the slice's
 * source second — is added here. Doing the offset inside the pure function
 * rather than at the call site is what lets the whole "did the stamps land
 * where the audio is" question be tested without a whisper binary
 * (`openCommand`/`openInBrowser`, CLAUDE.md).
 *
 * Two cases, and only two:
 *  - MATCHED (the old word's normalized token is in the LCS): it takes the new
 *    word's stamps verbatim. This is the case the feature exists for.
 *  - GAP (the decode said something else here): the old TEXT is kept — the
 *    count/text constraint above is absolute — and its stamps are INTERPOLATED
 *    evenly across the interval its matched neighbours left free. Interpolating
 *    is a guess about position within a known interval; rewriting the text
 *    would be a guess about what was said, and the second one silently
 *    invalidates every word index in the production.
 *
 * NO ANCHORS AT ALL (empty LCS, or an empty decode) is refused rather than
 * guessed at: the old stamps are returned untouched with a report. Simple and
 * reported beats clever and silent — a range whose decode agrees with nothing
 * is exactly where a stretched-to-fit interpolation would move every caption
 * onto the wrong word.
 */
export function alignRestamp(
  oldWords: readonly Word[],
  newWords: readonly Word[],
  spanStart: number,
): RestampResult {
  const reports: string[] = [];
  if (oldWords.length === 0) return { words: [], mapping: [], reports };

  const pairs = lcsPairs(
    oldWords.map((w) => normalizeAlignToken(w.text)),
    newWords.map((w) => normalizeAlignToken(w.text)),
  );
  if (pairs.length === 0) {
    reports.push(
      `re-transcription of ${spanStart.toFixed(3)}s matched none of the ${oldWords.length} ` +
        `word(s) already there — stamps left as they were`,
    );
    return { words: oldWords.map((w) => ({ ...w })), mapping: [], reports };
  }

  const at = new Map<number, number>(pairs.map(([o, n]) => [o, n]));
  const plan: Alignment[] = oldWords.map((_, i) => {
    const newIndex = at.get(i);
    return newIndex === undefined ? { kind: "gap" as const } : { kind: "matched" as const, newIndex };
  });
  // Clip-relative → source seconds, once, here. Clamped at 0 because a slice
  // that starts at 0 plus whisper's occasional tiny negative is still a
  // `WordSchema.start` that must parse (`nonnegative`).
  const newStart = (i: number): number => Math.max(0, newWords[i]!.start + spanStart);
  const newEnd = (i: number): number => Math.max(0, newWords[i]!.end + spanStart);

  const words: Word[] = oldWords.map((w) => ({ ...w }));
  let squeezed = 0;
  let i = 0;
  while (i < words.length) {
    const step = plan[i]!;
    if (step.kind === "matched") {
      words[i] = { ...words[i]!, start: newStart(step.newIndex), end: newEnd(step.newIndex) };
      i++;
      continue;
    }
    // The whole run of consecutive gap words shares one interval, so find its
    // end before spending any of it.
    let j = i;
    while (j < words.length && plan[j]!.kind === "gap") j++;
    const before = i > 0 ? plan[i - 1] : undefined;
    const after = j < words.length ? plan[j] : undefined;
    // Outside the matched region the interval is bounded by the SPAN, not by a
    // neighbour: a leading gap can start no earlier than the slice does, and a
    // trailing one can end no later than the decode heard anything.
    const left = before?.kind === "matched" ? newEnd(before.newIndex) : Math.max(0, spanStart);
    const right = after?.kind === "matched"
      ? newStart(after.newIndex)
      : newWords.length > 0
        ? newEnd(newWords.length - 1)
        : left;
    const span = right - left;
    if (span <= 0) squeezed += j - i;
    // Equal slices, not old-duration-proportional: the old durations are the
    // very thing this run has no evidence for (the decode disagreed about the
    // words), so weighting by them dresses up a guess as a measurement. When
    // the interval is empty — the decode dropped words the old transcript has
    // — every word in the run collapses to a zero-length stamp at `left`,
    // which keeps the list monotone and is REPORTED below rather than papered
    // over by pushing past the next matched anchor.
    const slice = span > 0 ? span / (j - i) : 0;
    for (let k = i; k < j; k++) {
      const s = left + slice * (k - i);
      words[k] = { ...words[k]!, start: s, end: s + slice };
    }
    i = j;
  }
  if (squeezed > 0) {
    reports.push(
      `${squeezed} word(s) the re-transcription did not hear got zero-length stamps — ` +
        `the decode has no room between the words it did hear`,
    );
  }

  const mapping: StampMove[] = [];
  for (let k = 0; k < words.length; k++) {
    const fromMs = captionKeyMs(oldWords[k]!.start);
    const toMs = captionKeyMs(words[k]!.start);
    if (fromMs !== toMs) mapping.push({ fromMs, toMs });
  }
  return { words, mapping, reports };
}

export interface RekeyResult {
  doc: OverrideDoc;
  reports: string[];
}

/** `w123` → 123; anything else (a legacy positional key) → null. */
function keyMs(key: string): number | null {
  const m = /^w(-?\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/**
 * Move every caption record that is anchored to a stamp the splice moved.
 *
 * The map is EXACT — it comes out of the splice itself, not out of a radius
 * search like `migrateCaptionKeys` — so there is nothing to guess: a record
 * keyed `w6000` whose word now starts at 6.42s belongs at `w6420` and nowhere
 * else. What survives from §137 is its REFUSAL rule: two old stamps can round
 * onto one new millisecond (the decode pulled two words together), and rather
 * than let the second entry silently overwrite the first, the loser is PARKED
 * at its original key and reported. A parked entry is stale, not lost — its
 * own `was` guard will drop it with a report at apply time — and the user can
 * see both keys named.
 *
 * Applies to the five source-keyed caption records: `captions`,
 * `captionWordsHidden`, `captionLineTiming` and `captionLineWindows` (both
 * line head keys) and `captionRangeEdits` (`fromKey`/`toKey` endpoints).
 * `splits`/`cuts` are NOT re-keyed: they anchor to a moment of the FOOTAGE,
 * which a re-decode does not move.
 *
 * A window's VALUE is left alone while its key moves, and the asymmetry is the
 * point: the key names the WORD the caption belongs to (a stamp the re-decode
 * just corrected), the value is where the user placed that caption against the
 * AUDIO (which the re-decode did not touch).
 */
export function rekeyCaptionRecords(doc: OverrideDoc, mapping: readonly StampMove[]): RekeyResult {
  const reports: string[] = [];
  if (mapping.length === 0) return { doc, reports };
  const moves = new Map<number, number>();
  for (const m of mapping) moves.set(m.fromMs, m.toMs);

  /**
   * Re-key one record. Entries are processed in ascending original ms so the
   * outcome does not depend on JSON key order, and the first claimant of a
   * target key wins.
   */
  const rekeyRecord = <T>(record: Record<string, T>, label: string): Record<string, T> => {
    const out: Record<string, T> = {};
    const entries = Object.entries(record).sort((a, b) => (keyMs(a[0]) ?? 0) - (keyMs(b[0]) ?? 0));
    for (const [key, value] of entries) {
      const ms = keyMs(key);
      const to = ms === null ? undefined : moves.get(ms);
      const want = to === undefined ? key : `w${to}`;
      if (!(want in out)) {
        out[want] = value;
        continue;
      }
      // Target taken. Park at the original key when that is still free —
      // never overwrite the entry that got there first (§137's never-misapply
      // rule), and never drop the user's work silently.
      if (!(key in out)) {
        out[key] = value;
        reports.push(
          `${label} entry ${key} could not move to ${want} — another entry is already there; ` +
            `left where it was`,
        );
      } else {
        reports.push(`${label} entry ${key} collided on both ${want} and its own key — dropped`);
      }
    }
    return out;
  };

  const moved = (key: string): string => {
    const ms = keyMs(key);
    const to = ms === null ? undefined : moves.get(ms);
    return to === undefined ? key : `w${to}`;
  };

  return {
    doc: {
      ...doc,
      captions: rekeyRecord(doc.captions, "caption retype"),
      captionWordsHidden: rekeyRecord(doc.captionWordsHidden, "caption hide"),
      captionLineTiming: rekeyRecord(doc.captionLineTiming, "caption timing"),
      captionLineWindows: rekeyRecord(doc.captionLineWindows, "caption window"),
      // An array, not a record, so there is no key to collide on: BOTH
      // endpoints move independently and identity stays the `(fromKey, toKey)`
      // pair the entry already had.
      captionRangeEdits: doc.captionRangeEdits.map((e) => ({
        ...e,
        fromKey: moved(e.fromKey),
        toKey: moved(e.toKey),
      })),
    },
    reports,
  };
}

/**
 * The contiguous index range of `words` that lies wholly inside `[srcIn,
 * srcOut]` — the ONE definition of "the words in this span", shared by the
 * server picking what to re-align and `spliceTranscript` putting it back. Two
 * copies of this predicate is how the two halves would splice different runs.
 *
 * WHOLLY inside, not overlapping: a word straddling the boundary has audio
 * outside the slice, so the fresh decode never heard all of it and has no
 * business re-stamping it. Monotone words make the answer contiguous.
 */
export function wordsInSpan(
  words: readonly Word[],
  srcIn: number,
  srcOut: number,
): { from: number; to: number } {
  let from = words.length;
  let to = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.start >= srcIn && w.end <= srcOut) {
      if (i < from) from = i;
      to = i + 1;
    }
  }
  // Nothing in the span: an empty range AT ZERO, not `words.length..0`, so a
  // caller that splices it back unconditionally is a no-op rather than a throw.
  return from === words.length ? { from: 0, to: 0 } : { from, to };
}

/**
 * Put a re-stamped run back into the transcript.
 *
 * THROWS on a count mismatch rather than accepting it: a splice that changes
 * the word count invalidates every scene anchor and cutlist index in the
 * production (see this module's header), so a caller that produced the wrong
 * number of words is a programmer error and must not reach disk. `language`
 * and every word outside the range are carried through untouched.
 */
export function spliceTranscript(
  transcript: Transcript,
  range: { from: number; to: number },
  restamped: readonly Word[],
): Transcript {
  const { from, to } = range;
  if (from < 0 || to > transcript.words.length || from > to) {
    throw new Error(`spliceTranscript: range ${from}..${to} is outside 0..${transcript.words.length}`);
  }
  if (restamped.length !== to - from) {
    throw new Error(
      `spliceTranscript: stamps-only splice needs ${to - from} word(s), got ${restamped.length}`,
    );
  }
  return {
    ...transcript,
    words: [
      ...transcript.words.slice(0, from),
      ...restamped.map((w) => ({ ...w })),
      ...transcript.words.slice(to),
    ],
  };
}
