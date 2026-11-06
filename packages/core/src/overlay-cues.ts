/**
 * The overlay resolver (overlay-library spec §Resolve → render props):
 * word-indexed placements → output-timed `OverlayCue`s, plus each overlay's
 * pop as an ordinary `SfxCue` ("there's no new audio path").
 *
 * Browser-safe on purpose — produce renders with it and the editor's lane
 * and preview (Task 7) place chips with it, and two resolvers are how the
 * chip and the render would disagree. Runtime imports are `./overlay-match`
 * (no imports at all) only; everything from `./assemble`, `./schema` and
 * `./timemap` is a type. File and sound lookups are injected, the
 * `resolveSfxCues` seam, so nothing here touches a filesystem.
 */
import type { SfxCue } from "./assemble";
import { mentionsOf } from "./overlay-match";
import type { OverlayEntrySnapshot, OverlayPlacement, OverlayRect, Word } from "./schema";
import type { TimeMap } from "./timemap";

/** Where snapshotted library files live inside the render's public dir and the workdir. */
export const OVERLAY_PUBLIC_SUBDIR = "library";

/**
 * The staged name for an entry's file, keyed on its id (plan Global
 * Constraints, served paths). POSIX-literal `/`, never `join()`: this is a URL
 * `staticFile()` resolves, the `sfxStagedFile` / `sideImageDestRel` rule.
 */
export function overlayStagedFile(e: { id: string; ext: string }): string {
  return `${OVERLAY_PUBLIC_SUBDIR}/${e.id}.${e.ext}`;
}

/** One overlay, ready for the renderer. Output seconds; no word index survives. */
export interface OverlayCue {
  /** The placement id — lets the editor tie a rendered overlay back to its chip. */
  id: string;
  /** `library/<id>.<ext>` under the render's public dir. */
  file: string;
  /**
   * A label only (ruling R8): GIF-vs-still is decided by the file's
   * extension, never by `kind`.
   */
  kind: "logo" | "image" | "gif";
  look: "overlay" | "card";
  atSec: number;
  endSec: number;
  /** A hand-placed box (overlay-transform); absent = the automatic placement. */
  rect?: OverlayRect;
}

export interface OverlayIssue {
  /** The placement id the issue is about. */
  placement: string;
  /**
   * "moved forward" and "unknown sound" are ISSUES — the cue is still
   * emitted — and the rest are drops (the `SfxValidationIssue` "scene gone"
   * distinction). A plain union: computed and printed, never read back.
   */
  reason: "unknown entry" | "cut word" | "moved forward" | "outside transcript" | "missing file" | "unknown sound";
  issue: string;
}

/** Plan Global Constraints, defaults: overlay 1.5s, card 2.0s, clamped 0.5–6. */
const DEFAULT_DURATION_SEC = { overlay: 1.5, card: 2.0 } as const;
const MIN_DURATION_SEC = 0.5;
const MAX_DURATION_SEC = 6;
/** Spec §Placement schema: `sound` defaults to the bundled pop. */
const DEFAULT_SOUND = "pop";
/** Plan Global Constraints: a planned sfx within this of an overlay sound is dropped. */
const SFX_NEAR_OVERLAY_SEC = 0.5;

/**
 * Placements → cues. Checks run identity first (unknown entry, missing file),
 * then position, `resolveSfxCues`' order.
 *
 * A cut word (spec §Resolve, my call there):
 * - a `match` falls forward to the next KEPT mention of its entry's names,
 *   through `mentionsOf` with every OTHER snapshot entry competing for words
 *   (ruling R10), so it can only land where a fresh match could and never on
 *   the "Google" inside a later "Google Developers Expert";
 * - a `user` placement moves to the next kept word — the user chose a moment,
 *   not a name;
 * - with nowhere to go it is dropped with "cut word", never silently lost
 *   (plan review focus 3).
 *
 * `soundFile` resolves a sound id to its staged file; absent, the caller is
 * not resolving audio (e.g. a silent preview) and no sound cues or sound
 * issues are produced. An id it does not know keeps the overlay, silent, with
 * an "unknown sound" issue (spec §Resolve: "the overlay stays, plays silent").
 * `exists` defaults to present, `resolveSfxCues`' reasoning.
 */
export function resolveOverlayCues(
  resolved: { entries: OverlayEntrySnapshot[]; placements: OverlayPlacement[] },
  words: readonly Word[],
  map: TimeMap,
  outputDurationSec: number,
  opts: {
    exists?: (stagedRel: string) => boolean;
    soundFile?: (soundId: string) => { soundFile: string; gain: number; durationSec?: number } | undefined;
  } = {},
): { cues: OverlayCue[]; soundCues: SfxCue[]; issues: OverlayIssue[] } {
  const exists = opts.exists ?? (() => true);
  const byId = new Map(resolved.entries.map((e) => [e.id, e]));
  const kept = (i: number): boolean => map.mapWord(words[i]!) !== null;
  const cues: OverlayCue[] = [];
  const soundCues: SfxCue[] = [];
  const issues: OverlayIssue[] = [];

  for (const p of resolved.placements) {
    const entry = byId.get(p.entryId);
    if (!entry) {
      issues.push({ placement: p.id, reason: "unknown entry", issue: `"${p.entryId}" is not in this project's library snapshot` });
      continue;
    }
    const file = overlayStagedFile(entry);
    if (!exists(file)) {
      issues.push({ placement: p.id, reason: "missing file", issue: `"${entry.name}" points at ${file}, which is gone` });
      continue;
    }
    const word = words[p.word];
    if (!word) {
      issues.push({
        placement: p.id,
        reason: "outside transcript",
        issue: `word ${p.word} is beyond this transcript (${words.length} words)`,
      });
      continue;
    }

    let at = map.mapWord(word);
    if (at === null) {
      let next: number | undefined;
      if (p.source === "match") {
        const others = resolved.entries.filter((e) => e.id !== entry.id);
        next = mentionsOf(words, entry.names, kept, others).find((i) => i > p.word);
      } else {
        for (let i = p.word + 1; i < words.length && next === undefined; i++) if (kept(i)) next = i;
      }
      if (next === undefined) {
        issues.push({
          placement: p.id,
          reason: "cut word",
          issue: `"${entry.name}" was on word ${p.word} ("${word.text}"), which this cut removed, and no later ${
            p.source === "match" ? "mention" : "word"
          } survives`,
        });
        continue;
      }
      issues.push({
        placement: p.id,
        reason: "moved forward",
        issue: `"${entry.name}" moved from cut word ${p.word} ("${word.text}") to word ${next} ("${words[next]!.text}")`,
      });
      at = map.mapWord(words[next]!)!;
    }

    const look = p.look ?? entry.look ?? "overlay";
    const durationSec = Math.min(
      MAX_DURATION_SEC,
      Math.max(MIN_DURATION_SEC, p.durationSec ?? DEFAULT_DURATION_SEC[look]),
    );
    // The word's START, as with sfx: the logo lands as the name is spoken.
    const atSec = at.start;
    cues.push({
      id: p.id,
      file,
      kind: entry.kind,
      look,
      atSec,
      // Spec §Resolve: clamped to the composition end.
      endSec: Math.min(atSec + durationSec, outputDurationSec),
      ...(p.rect ? { rect: p.rect } : {}),
    });

    // `null` means silent at either level, so presence is `!== undefined`,
    // never `??` — `??` would turn an explicit mute back into a pop.
    const soundId = p.sound !== undefined ? p.sound : entry.sound !== undefined ? entry.sound : DEFAULT_SOUND;
    if (soundId === null || !opts.soundFile) continue;
    const sound = opts.soundFile(soundId);
    if (!sound) {
      issues.push({
        placement: p.id,
        reason: "unknown sound",
        issue: `"${entry.name}" sound "${soundId}" is not in the sound library — playing silent`,
      });
      continue;
    }
    soundCues.push({
      soundFile: sound.soundFile,
      atSec,
      overlayId: p.id,
      gain: sound.gain,
      ...(sound.durationSec === undefined ? {} : { durationSec: sound.durationSec }),
    });
  }

  // Time order, `resolveSfxCues`' reason: a fall-forward can reorder cues
  // relative to the placement list, and the renderer walks them in time.
  cues.sort((a, b) => a.atSec - b.atSec);
  soundCues.sort((a, b) => a.atSec - b.atSec);
  return { cues, soundCues, issues };
}

/**
 * Spacing against planned sfx (spec §Resolve, my call there): a planned
 * effect within `windowSec` of an overlay sound, either side, is dropped so
 * the two never stack into mush — the overlay pop wins. Inclusive at the
 * window edge. The caller reports `dropped` with reason `"overlay"`;
 * `droppedIndices[k]` is `dropped[k]`'s index in `sfx`, which is how it finds
 * the placement to report against (`resolveSfxCues`' `cuePlacements`).
 */
export function dropSfxNearOverlays(
  sfx: readonly SfxCue[],
  overlaySounds: readonly SfxCue[],
  windowSec: number = SFX_NEAR_OVERLAY_SEC,
): { kept: SfxCue[]; dropped: SfxCue[]; droppedIndices: number[] } {
  const kept: SfxCue[] = [];
  const dropped: SfxCue[] = [];
  const droppedIndices: number[] = [];
  sfx.forEach((s, i) => {
    if (overlaySounds.some((o) => Math.abs(s.atSec - o.atSec) <= windowSec)) {
      dropped.push(s);
      droppedIndices.push(i);
    } else kept.push(s);
  });
  return { kept, dropped, droppedIndices };
}
