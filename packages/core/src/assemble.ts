import type { Transcript } from "./schema";
import type { Scene, SceneCue } from "./scene-schema";
import { resolveSceneProps } from "./scene-registry";
import type { TimeMap } from "./timemap";

/** Scenes shorter than this on screen get extended; still shorter → dropped. */
const MIN_SCENE_SEC = 1.2;
const DROP_BELOW_SEC = 0.8;
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

  // Scenes are exclusive — one stage state at a time.
  const cues: SceneCue[] = [];
  for (const cue of resolved) {
    const prev = cues[cues.length - 1];
    if (prev && cue.startSec < prev.endSec + SCENE_GAP_SEC) {
      cue.startSec = prev.endSec + SCENE_GAP_SEC;
    }
    if (cue.endSec - cue.startSec < MIN_SCENE_SEC) {
      cue.endSec = cue.startSec + MIN_SCENE_SEC;
    }
    cue.endSec = Math.min(cue.endSec, map.outputDuration);
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
