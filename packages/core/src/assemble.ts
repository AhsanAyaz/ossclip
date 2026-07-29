import type { Transcript } from "./schema";
import type { Scene, SceneCue } from "./scene-schema";
import { resolveSceneProps } from "./scene-registry";
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
 * A graphic punches in, makes its point, and hands the frame back to the
 * speaker — it does not have to span the moment that motivated it. Keeps the
 * §4.5 pattern-interrupt rhythm instead of 10s static cards (FINDINGS §3).
 * Exported: the beat scheduler budgets coverage with this same number (§7).
 */
export const MAX_SCENE_SEC = 5;
/**
 * A lower third never TAKES the frame — the speaker stays full-bleed the
 * whole time — so the pattern-interrupt argument behind MAX_SCENE_SEC does
 * not apply and the punch-out at 5s was cutting cards off mid-sentence
 * (R20 §95, seen on the first real landscape run). It holds through its
 * whole moment instead, under this generous ceiling so a rambling moment
 * still cannot pin one static card up for a minute.
 */
export const MAX_OVERLAY_SCENE_SEC = 15;

/** The on-screen cap for a cue, by how much frame its layout takes. */
const maxSceneSecFor = (layout: SceneCue["layout"]): number =>
  layout === "lower-third" ? MAX_OVERLAY_SCENE_SEC : MAX_SCENE_SEC;
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
    cue.endSec = Math.min(cue.endSec, cue.startSec + maxSceneSecFor(cue.layout), map.outputDuration);
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
