import type { Transcript } from "./schema";
import type { Scene, SceneCue } from "./scene-schema";
import { resolveSceneProps } from "./scene-registry";
import type { LoadedSfxSound } from "./sfx-pack";
import type { SfxPlacement, SfxValidationIssue } from "./producer/sfx";
import type { TimeMap } from "./timemap";

/** Scenes shorter than this on screen get extended; still shorter → dropped. */
const MIN_SCENE_SEC = 1.2;
const DROP_BELOW_SEC = 0.8;
/**
 * On a short take a 2s graphic reads as a flicker, and there is no later beat
 * to make up for it — hold every surviving scene longer (FINDINGS §29).
 */
const SHORT_TAKE_SEC = 45;
const SHORT_TAKE_MIN_SCENE_SEC = 3;
/**
 * A graphic holds through the WHOLE moment that motivated it (R23 §114).
 * The old 5s punch-out implemented §4.5's pattern interrupt (§3's fix for
 * 10s static cards), but post-launch footage showed its real effect: scenes
 * started on their context and LEFT while the speaker was still on it — the
 * card gone, the captions still discussing it. The interrupt rhythm now
 * comes from the coverage budget and moment alternation (the beat scheduler
 * prices a graphic at its full span), not from cutting cards off early.
 * This ceiling is the safety net for a rambling moment, not the normal
 * exit; it was the lower-third hold since R20 §95 and is now every
 * layout's. Exported: the beat scheduler budgets coverage with it (§7).
 */
export const MAX_SCENE_SEC = 15;
/** R20 §95's lower-third ceiling — now the universal one; kept as an alias
 * so published consumers of the old name keep compiling. */
export const MAX_OVERLAY_SCENE_SEC = MAX_SCENE_SEC;
/** Breathing room enforced between consecutive scenes. */
const SCENE_GAP_SEC = 0.05;

export interface AssembleResult {
  cues: SceneCue[];
  dropped: Array<{ id: string; reason: string }>;
}

/**
 * Resolve word-anchored scenes into output-timed cues (PHASE1 §5):
 * anchors → output time via the TimeMap (scenes whose words were cut are
 * dropped), props resolved as defaults←props←overrides, then sorted,
 * de-overlapped and given a minimum on-screen duration. Gaps are implicit
 * full-bleed — the stage defaults to the talking head when no cue is active.
 */
export function assembleScenes(
  scenes: readonly Scene[],
  transcript: Transcript,
  map: TimeMap,
): AssembleResult {
  const dropped: AssembleResult["dropped"] = [];
  const resolved: SceneCue[] = [];

  for (const scene of scenes) {
    const words = transcript.words.slice(scene.anchor.startWord, scene.anchor.endWord + 1);
    if (words.length === 0) {
      dropped.push({ id: scene.id, reason: "anchor out of transcript range" });
      continue;
    }
    const mapped = words
      .map((w) => map.mapWord(w))
      .filter((m): m is { start: number; end: number } => m !== null);
    if (mapped.length === 0) {
      dropped.push({ id: scene.id, reason: "anchor words were entirely cut" });
      continue;
    }
    const props = resolveSceneProps(scene.component, scene.props, scene.overrides);
    if (props === null) {
      dropped.push({ id: scene.id, reason: `invalid props for ${scene.component}` });
      continue;
    }
    resolved.push({
      id: scene.id,
      // The cue remembers which words it was planned against, so edits keyed
      // to it can survive a re-plan's id renumbering (handoff-edit-anchoring).
      anchor: scene.anchor,
      layout: scene.layout,
      component: scene.component,
      props,
      startSec: Math.min(...mapped.map((m) => m.start)),
      endSec: Math.max(...mapped.map((m) => m.end)),
    });
  }

  resolved.sort((a, b) => a.startSec - b.startSec);

  // Never let the floor eat the video: a 3s minimum is right on a 30s take and
  // absurd on a 6s one, so it is also capped at a share of the runtime.
  const minScene =
    map.outputDuration < SHORT_TAKE_SEC
      ? Math.max(MIN_SCENE_SEC, Math.min(SHORT_TAKE_MIN_SCENE_SEC, map.outputDuration * 0.15))
      : MIN_SCENE_SEC;

  // Scenes are exclusive — one stage state at a time.
  const cues: SceneCue[] = [];
  for (const cue of resolved) {
    const prev = cues[cues.length - 1];
    if (prev && cue.startSec < prev.endSec + SCENE_GAP_SEC) {
      cue.startSec = prev.endSec + SCENE_GAP_SEC;
    }
    if (cue.endSec - cue.startSec < minScene) {
      cue.endSec = cue.startSec + minScene;
    }
    cue.endSec = Math.min(cue.endSec, cue.startSec + MAX_SCENE_SEC, map.outputDuration);
    if (cue.endSec - cue.startSec < DROP_BELOW_SEC) {
      dropped.push({ id: cue.id, reason: "too short after clamping" });
      continue;
    }
    cues.push(cue);
  }

  // The min-duration extension above can re-introduce overlap with the NEXT
  // cue's start; walk once more and trim forward.
  for (let i = 0; i < cues.length - 1; i++) {
    const cur = cues[i]!;
    const next = cues[i + 1]!;
    if (next.startSec < cur.endSec + SCENE_GAP_SEC) {
      cur.endSec = Math.max(cur.startSec + DROP_BELOW_SEC, next.startSec - SCENE_GAP_SEC);
    }
  }

  return { cues, dropped };
}

/**
 * One sound effect, ready for the renderer: a staged file, an OUTPUT-time
 * instant, and the mix level it plays at. No word index survives — by this
 * point the anchor has done its job (timemap.ts:13's "all overlay timings live
 * in OUTPUT time").
 */
export interface SfxCue {
  /** Path under the render's public dir — `sfx/<id>.<ext>`, POSIX-literal. */
  soundFile: string;
  atSec: number;
  /** The sound's own gain times the placement's, resolved once here. */
  gain: number;
}

/** Where staged sounds live inside the render's public dir. */
export const SFX_PUBLIC_SUBDIR = "sfx";

/**
 * The staged name for a sound, keyed on its ID rather than its own filename:
 * two packs may both ship a `whoosh.mp3`, and the id is what the plan actually
 * references (ids are unique by construction — `loadSfxLibrary` merges by id).
 *
 * POSIX-literal `/`, never `join()` — this is a URL `staticFile()` resolves,
 * not a filesystem path, and a Windows `\` here would be served verbatim
 * (produce.ts's `sideImageDestRel` lesson). The extension is taken with a
 * regex rather than `extname` to keep this module free of node built-ins.
 */
export function sfxStagedFile(sound: { id: string; file: string }): string {
  const ext = /\.[^./\\]+$/.exec(sound.file)?.[0] ?? "";
  return `${SFX_PUBLIC_SUBDIR}/${sound.id}${ext}`;
}

/**
 * Scene id → the output second that scene STARTS on, the scene-timing context
 * `resolveSfxCues` places a scene-anchored placement against (2026-08-29).
 *
 * Built from the FINAL cue list — after `applyOverrides`, the splits, the
 * pinned-timing reclamp and the hidden-cue drop — because that is the only
 * list that knows where the user actually put the graphic. Feeding it the
 * producer's raw scenes would reintroduce the exact field failure the scene
 * link exists to fix.
 *
 * Keyed on the ROOT id (`splitCues` mints a second half as `<root>@<split
 * id>`) and keeping the EARLIEST start, because a sound marks an ENTRANCE: a
 * half the user split off later is the same graphic continuing, not a second
 * appearance. A hidden scene is absent from the cues and therefore from this
 * map, which is what makes "scene gone" a fact the resolver can report.
 *
 * Pure and cue-shaped rather than `SceneCue`-typed so the EDITOR can build the
 * same map from the cue list its player is drawing — one implementation, or
 * the diamond and the render's cue disagree about where scene-3 starts.
 */
export function sceneStartSeconds(
  cues: readonly { id: string; startSec: number }[],
): Map<string, number> {
  const starts = new Map<string, number>();
  for (const c of cues) {
    const root = c.id.split("@")[0]!;
    const prev = starts.get(root);
    if (prev === undefined || c.startSec < prev) starts.set(root, c.startSec);
  }
  return starts;
}

/**
 * Word-anchored SFX placements → output-timed cues, the `assembleScenes`
 * contract for a track of instants rather than spans (PHASE1 §5).
 *
 * Every drop is reported with the SAME machine-readable `reason` vocabulary
 * the planning passes use, so `formatSfxAccounting` can count planning drops
 * and render drops in one line. `placement` is the index in the plan handed
 * in, which is the plan `production.json` stores — the editor can name the
 * entry a warning is about.
 *
 * `exists` is injected (the `defaultProviderName(env, hasBin)` seam): the
 * check is a real one — a user who deletes a pack between planning and
 * re-rendering must get a dropped cue, not a Remotion 404 after the render has
 * already spent its minutes — but the filesystem stays the CALLER's business,
 * so the whole matrix is testable without writing mp3s to a tmp dir. The
 * default assumes present: a caller that cannot see a filesystem has no basis
 * for dropping anything.
 *
 * `sceneStarts` is the other injected seam (`sceneStartSeconds` builds it):
 * a placement carrying a `sceneId` fires at that scene's FINAL start — the
 * user's moves and trims already in it — instead of at the word the model
 * rationalised it against. Defaults to empty, which is honest rather than
 * silent: with no scene context every scene link reports "scene gone" and
 * falls back to its word, which is exactly what happens when the scene really
 * is gone.
 *
 * Not every entry in `dropped` is a drop. "scene gone" is an ISSUE — the cue
 * is still emitted, on the word anchor — and is named in the same list so the
 * console and report.txt say why the effect moved (`SfxDropReasonSchema` owns
 * the distinction, and `DROP_REASONS` keeps it out of the casualty count).
 */
export function resolveSfxCues(
  placements: readonly SfxPlacement[],
  transcript: Transcript,
  map: TimeMap,
  sounds: readonly LoadedSfxSound[],
  opts: {
    exists?: (absPath: string) => boolean;
    sceneStarts?: ReadonlyMap<string, number>;
  } = {},
): { cues: SfxCue[]; dropped: SfxValidationIssue[] } {
  const exists = opts.exists ?? (() => true);
  const sceneStarts = opts.sceneStarts ?? new Map<string, number>();
  const byId = new Map(sounds.map((s) => [s.id, s]));
  const cues: SfxCue[] = [];
  const dropped: SfxValidationIssue[] = [];

  for (let i = 0; i < placements.length; i++) {
    const p = placements[i]!;
    // Identity first, then position — `normalizeSfxPlan`'s pass order, so a
    // placement naming a sound that no longer exists reads as an unknown
    // sound whether it was dropped at planning or here.
    const sound = byId.get(p.soundId);
    if (!sound) {
      dropped.push({
        placement: i,
        reason: "unknown sound",
        issue: `"${p.soundId}" is not in the sound library any more`,
      });
      continue;
    }
    if (!exists(sound.absPath)) {
      dropped.push({
        placement: i,
        reason: "missing file",
        issue: `"${p.soundId}" points at ${sound.absPath}, which is gone`,
      });
      continue;
    }
    // The SCENE anchor outranks the word (field report, 2026-08-29): a sound
    // placed "as the TitleCard enters" has to follow the card when the user
    // moves or trims it, and the map already carries the scene's final start.
    // The word passes below are SKIPPED when it resolves, deliberately — the
    // graphic is on screen whether or not the speech that motivated it
    // survived the cut, so a cut-word drop here would silence an effect that
    // has a perfectly good instant to fire on.
    let atSec = p.sceneId === undefined ? undefined : sceneStarts.get(p.sceneId);
    if (atSec === undefined) {
      if (p.sceneId !== undefined) {
        // An ISSUE, not a drop: `word` is required precisely so a placement
        // outlives the scene it was synced to (deleted, hidden or renumbered
        // by a re-plan are all normal). Printed so report.txt says why the
        // whoosh is back on the speech.
        dropped.push({
          placement: i,
          reason: "scene gone",
          issue: `"${p.soundId}" scene ${p.sceneId} gone — using word anchor`,
        });
      }
      const word = transcript.words[p.word];
      if (!word) {
        dropped.push({
          placement: i,
          reason: "outside transcript",
          issue: `word ${p.word} is beyond this transcript (${transcript.words.length} words)`,
        });
        continue;
      }
      // The cut check, `assembleScenes`' rule for a single anchor: a scene whose
      // words were cut is dropped rather than slid to the nearest kept instant,
      // and an effect is even less forgiving — it would fire over speech that
      // never motivated it.
      const mapped = map.mapWord(word);
      if (mapped === null) {
        dropped.push({
          placement: i,
          reason: "cut word",
          issue: `"${p.soundId}" was anchored to word ${p.word} ("${word.text}"), which this cut removed`,
        });
        continue;
      }
      // The word's START: the effect fires as the word lands, which is what
      // the model was asked to place ("the effect fires at that word").
      atSec = mapped.start;
    }
    cues.push({
      soundFile: sfxStagedFile(sound),
      atSec,
      // ONE multiplication, here — the renderer receives a number and does no
      // mixing arithmetic of its own, so what the editor shows as a gain and
      // what the render plays can never disagree.
      gain: sound.gain * (p.gain ?? 1),
    });
  }

  // Sorted by time: the plan is already word-sorted, but a cut can only ever
  // preserve order, and a track the renderer walks in time order is one a
  // human reading render-props.json can check against the video.
  cues.sort((a, b) => a.atSec - b.atSec);
  return { cues, dropped };
}
