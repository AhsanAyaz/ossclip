/**
 * The pure rules of approving a drawn shot (storyboard design §8, §9; §169):
 * which shots become clip scenes, the production.json record for them, the
 * length a shot's clip is rendered at, the words it is drawn for, and the
 * key that says when a clip must be rendered again.
 *
 * Browser-safe on purpose, as record.ts is: the editor reads the approval
 * this record holds, and a page that ever judges a shot's length or its
 * clip's freshness must do it with the SAME rules the server renders by, not
 * a copy (plan B2a Task 1). So the runtime imports are zod-only modules and
 * ../assemble (type imports plus ../scene-registry, both already on the
 * browser surface), and `clipKey` takes its hash function as an argument
 * rather than importing node:crypto.
 */
import { MAX_SCENE_SEC } from "../assemble";
import { SCENE_REGISTRY } from "../scene-registry";
import type { Scene } from "../scene-schema";
import type { ProductionStoryboard } from "../schema";
import { STORYBOARD_MIN_SHOT_SEC, type Storyboard, type StoryboardShot } from "./record";

/**
 * Scene ids of shot clips. A prefix of their own, so a shot's scene can never
 * take the id of a planned or script scene (`momentSceneId`), and the
 * editor's overrides keyed on it follow the shot, not a scene index.
 */
export const SHOT_SCENE_ID_PREFIX = "shot-";

export function shotSceneId(shotId: string): string {
  return SHOT_SCENE_ID_PREFIX + shotId;
}

type ApprovedShot = StoryboardShot & { approval: NonNullable<StoryboardShot["approval"]> };

/**
 * A dropped shot keeps its approval in storyboard.json (its files stay until
 * the author clears them, design §8) but leaves the video, so both
 * conditions decide. Sorted by start word because the scene list is in
 * timeline order and the rows need not be: an author-added row is appended.
 */
function approvedShots(sb: Storyboard): ApprovedShot[] {
  return sb.shots
    .filter((s): s is ApprovedShot => s.kept && s.approval !== undefined)
    .slice()
    .sort((a, b) => a.startWord - b.startWord);
}

/**
 * One ClipScene per shot that is kept and approved, in startWord order.
 *
 * Built as a script clip's scene is (producer/script-plan.ts), so assembly
 * treats it as any clip scene (design §8): starts it at its first kept word,
 * pushes it past an overlapping scene, drops it when all its words are cut.
 * `muted: true` because a drawn clip has no sound; the registry's default
 * would play its silent track under the voice for nothing.
 */
export function approvedClipScenes(sb: Storyboard): Scene[] {
  return approvedShots(sb).map((s) => ({
    id: shotSceneId(s.id),
    anchor: { startWord: s.startWord, endWord: s.endWord },
    layout: SCENE_REGISTRY.ClipScene.defaultLayout,
    component: "ClipScene",
    props: { src: s.approval.src, durationSec: s.approval.durationSec, muted: true },
    overrides: {},
    rationale: `storyboard shot ${s.id}`,
  }));
}

/**
 * The production.json record for the same shots as `approvedClipScenes`.
 * Undefined when there are none, so a storyboard run with nothing approved
 * writes no `storyboard` field rather than an empty one.
 */
export function productionStoryboardOf(sb: Storyboard): ProductionStoryboard | undefined {
  const shots = approvedShots(sb);
  if (shots.length === 0) return undefined;
  return {
    shots: shots.map((s) => ({
      id: s.id,
      startWord: s.startWord,
      endWord: s.endWord,
      clip: s.approval.clip,
      src: s.approval.src,
      durationSec: s.approval.durationSec,
    })),
  };
}

/**
 * The length Approve renders the shot's clip at (design §8, step 1): output
 * seconds from its first kept word's start to its last kept word's end, so
 * a cut inside the span shortens the clip with it. Clamped to the shortest
 * shot `ossclip draw` accepts and the longest a scene may last; rounded to
 * 2 decimals so float noise in the time map cannot change the clip key.
 *
 * `at[i]` is raw word i's output {start,end}, or null when the cut removed
 * it. Null when no word of the shot is kept: there is nothing to render a
 * clip against, and the scene would leave the video anyway.
 */
export function shotLengthSec(
  shot: { startWord: number; endWord: number },
  at: readonly ({ start: number; end: number } | null)[],
): number | null {
  let first: { start: number; end: number } | null = null;
  let last: { start: number; end: number } | null = null;
  for (let i = shot.startWord; i <= shot.endWord; i++) {
    const t = at[i];
    if (!t) continue;
    first ??= t;
    last = t;
  }
  if (!first || !last) return null;
  const sec = Math.min(MAX_SCENE_SEC, Math.max(STORYBOARD_MIN_SHOT_SEC, last.end - first.start));
  return Math.round(sec * 100) / 100;
}

/** The kept words of the shot joined by one space: the line the viewer hears under it. */
export function shotSpokenLine(
  shot: { startWord: number; endWord: number },
  words: readonly { text: string }[],
  kept: (i: number) => boolean,
): string {
  const out: string[] = [];
  for (let i = shot.startWord; i <= shot.endWord && i < words.length; i++) {
    if (kept(i)) out.push(words[i]!.text);
  }
  return out.join(" ");
}

/** What a clip's pixels depend on (design §8, "The clip key"), and nothing else. */
export interface ClipKeyParts {
  code: string;
  kitVersion: number;
  theme: unknown;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
}

/**
 * JSON with every object's keys sorted, so the key does not depend on the
 * order the theme's fields happened to be written in (a spread, an override
 * merge, a file round trip). The same rule as kit-plan.ts's `stableJson`,
 * repeated here because kit-plan.ts imports node:crypto and so cannot be on
 * the browser surface.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const obj = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
  });
}

/**
 * The clip key (design §8): a clip is rendered again only when its code, the
 * kit version, the theme, the frame size, the frame rate or the length
 * changes. `sha1Hex` is passed in so this module stays browser-safe; the
 * server passes node:crypto's, and the editor must pass the same to compare.
 */
export function clipKey(parts: ClipKeyParts, sha1Hex: (text: string) => string): string {
  const { code, kitVersion, theme, width, height, fps, durationSec } = parts;
  return sha1Hex(stableJson({ code, kitVersion, theme, width, height, fps, durationSec }));
}
