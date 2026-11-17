import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { frameWindow } from "./frames";
import { rebaseCue } from "./kit-rebase";
import { SCENE_REGISTRY } from "./scene-registry";
import {
  SceneComponentIdSchema,
  type Layout,
  type SceneComponentId,
  type SceneCue,
  type Theme,
} from "./scene-schema";

/**
 * The clip kit's plan (§162, design "Phase 3: clip kit"): which scenes of a
 * produced project become transparent clips, what each is called, and
 * whether last export's file can be reused. Pure — the CLI owns the files,
 * the renders and the clock.
 */

/**
 * Part of every reuse key: bump it when a kit clip of the SAME inputs would
 * now render differently (the panel, the composition), so every clip made
 * by the older kit re-renders instead of being reused stale.
 */
export const KIT_VERSION = 1;

export interface KitClipPlan {
  sceneId: string;
  component: SceneComponentId;
  /** "source": a `clip:` cue (ClipScene) — the author's own file, never re-rendered (design 3.2). */
  kind: "render" | "source";
  /** `kitFileName(sceneId, component)`. Only a "render" plan writes it. */
  fileName: string;
  /** On the output timeline, at `settings.fps`: `frameWindow(...).from` of the original cue. */
  startFrame: number;
  /** `frameWindow(...)` of the original cue — the frames the scene has in the full render. */
  durationInFrames: number;
  /** The cue rebased to its own frame 0 (`rebaseCue`); what a "render" plan draws. */
  cue: SceneCue;
  /** sha256 hex of `{kitVersion, cue (rebased), theme, settings}`. */
  reuseKey: string;
  /** What the clip cannot carry over, for the report. */
  notes: string[];
}

export interface KitSettings {
  width: number;
  height: number;
  fps: number;
}

/**
 * The layouts that move the speaker. A kit clip has no footage to move, so
 * the scene is exported as its graphic only (design 3.2).
 */
const SPEAKER_LAYOUTS: ReadonlySet<Layout> = new Set(["split-left", "split-right", "video-top", "pip-bubble"]);
/** The layouts whose full render draws a solid or blurred backdrop under the graphic. */
const BACKDROP_LAYOUTS: ReadonlySet<Layout> = new Set(["graphic-only", "blurred-behind"]);

/**
 * Whether a kit clip draws this cue on the flat dark panel (plan decision 2,
 * Task 2's `flatPanel`): every component that is not full-frame and keeps
 * its scrim. Restated here only to keep the report's note true — a
 * full-frame scene in `graphic-only` loses its backdrop with nothing in its
 * place, and a note claiming a panel would send the author looking for one.
 */
function drawsFlatPanel(component: SceneComponentId): boolean {
  const meta = SCENE_REGISTRY[component];
  return meta.fullFrame !== true && meta.scrim !== false;
}

function notesFor(cue: SceneCue, component: SceneComponentId): string[] {
  const notes: string[] = [];
  if (SPEAKER_LAYOUTS.has(cue.layout)) notes.push(`speaker not reframed (${cue.layout})`);
  if (BACKDROP_LAYOUTS.has(cue.layout) && drawsFlatPanel(component)) {
    notes.push(`backdrop replaced by a flat panel (${cue.layout})`);
  }
  return notes;
}

/**
 * JSON with every object's keys sorted, so the key does not depend on the
 * order a cue's fields happened to be written in (a spread, an override
 * merge, a file round trip). Undefined members drop out, as in JSON.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const obj = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
  });
}

/**
 * The reuse key (design 3.2): a clip re-renders only when its scene, the
 * look or the frame size changed. The REBASED cue, so a scene that only
 * moved on the timeline keeps its clip — its pixels do not depend on where
 * it sits.
 */
function reuseKeyFor(cue: SceneCue, theme: Theme, settings: KitSettings): string {
  const material = stableJson({ kitVersion: KIT_VERSION, cue, theme, settings });
  return createHash("sha256").update(material).digest("hex");
}

/**
 * One plan per visible scene, in timeline order. Plain cues are filler
 * takes, not scenes (`kind === "plain"`; absence means graphic, so never
 * test `=== "graphic"`). A hidden scene is already absent from the cues
 * the editor's overrides produce, which is how the author leaves one out.
 */
export function kitClipPlans(input: {
  cues: readonly SceneCue[];
  theme: Theme;
  settings: KitSettings;
}): KitClipPlan[] {
  const { theme, settings } = input;
  const plans: KitClipPlan[] = [];
  // Array.prototype.sort is stable, so equal starts keep the cues' order.
  const byStart = [...input.cues].sort((a, b) => a.startSec - b.startSec);
  for (const cue of byStart) {
    if (cue.kind === "plain" || cue.component === undefined) continue;
    const component = cue.component;
    const { from, durationInFrames } = frameWindow(cue.startSec, cue.endSec, settings.fps);
    const rebased = rebaseCue(cue, settings.fps);
    plans.push({
      sceneId: cue.id,
      component,
      kind: component === "ClipScene" ? "source" : "render",
      fileName: kitFileName(cue.id, component),
      startFrame: from,
      durationInFrames,
      cue: rebased,
      reuseKey: reuseKeyFor(rebased, theme, settings),
      notes: notesFor(cue, component),
    });
  }
  return plans;
}

/**
 * `<sceneId>-<component>.mov` (plan decision 3): named by scene id, so
 * hiding one scene renames no other clip and Resolve keeps its links. Only
 * `[A-Za-z0-9_-]` survives — the name goes into a URL, an XML attribute and
 * a Windows folder — and the stem is never empty.
 */
export function kitFileName(sceneId: string, component: string): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "-");
  const stem = [safe(sceneId), safe(component)].filter((s) => s !== "").join("-");
  return `${stem === "" ? "scene" : stem}.mov`;
}

/**
 * Whether a "render" plan's clip must be made again (Review Focus 3). Reuse
 * needs all three: a previous report, the file still on disk, and the same
 * key for this scene. A "source" plan is the author's own file and is never
 * rendered, `force` or not.
 */
export function needsRender(
  plan: KitClipPlan,
  previous: KitReport | null,
  fileExists: boolean,
  force: boolean,
): boolean {
  if (plan.kind === "source") return false;
  if (force || !fileExists || previous === null) return true;
  const before = previous.clips.find((c) => c.sceneId === plan.sceneId && c.kind === "render");
  return before?.reuseKey !== plan.reuseKey;
}

export interface KitReportClip {
  sceneId: string;
  component: SceneComponentId;
  kind: "render" | "source";
  /** The clip's file, or null when there is none (a skipped scene). */
  file: string | null;
  startSec: number;
  lengthSec: number;
  reuseKey: string | null;
  status: "rendered" | "reused" | "skipped";
  notes: string[];
}

export interface KitReport {
  version: 1;
  createdAt: string;
  kitVersion: number;
  /** The timeline's file name, or null under `--clips-only`. */
  timeline: string | null;
  clips: KitReportClip[];
  warnings: string[];
}

/**
 * `kit-report.json`, parsed with zod because the next run reads it back to
 * decide reuse: a hand-edited `"status": "renderd"` must fail the parse
 * (and count as no report, so everything re-renders), never read as a
 * status it is not.
 */
export const KitReportSchema: z.ZodType<KitReport> = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  kitVersion: z.number().int(),
  timeline: z.string().nullable(),
  clips: z.array(
    z.object({
      sceneId: z.string(),
      component: SceneComponentIdSchema,
      kind: z.enum(["render", "source"]),
      file: z.string().nullable(),
      startSec: z.number().nonnegative(),
      lengthSec: z.number().nonnegative(),
      reuseKey: z.string().nullable(),
      status: z.enum(["rendered", "reused", "skipped"]),
      notes: z.array(z.string()),
    }),
  ),
  warnings: z.array(z.string()),
});
