/**
 * The pure half of `pnpm stills` (plan Task 3): which fixtures run, what cue
 * each still renders, which frame, and what the file is called. No React, no
 * Remotion, no filesystem — the composition (SceneStillComposition.tsx), the
 * render call (`renderSceneStill` in index.ts) and the script
 * (scripts/render-scene-stills.ts) are the I/O around it, the
 * render-options.ts split.
 *
 * Stills are for the author's eyes, not a pixel test (plan decision 6): font
 * rasterisation differs between machines, so nothing here compares images.
 */
import {
  SCENE_REGISTRY,
  SceneComponentIdSchema,
  type FaceCrop,
  type Layout,
  type SceneComponentId,
  type SceneCue,
  type Theme,
} from "@ossclip/core/browser";

/** The composition's frame rate — the render's own default (Root.tsx). */
export const STILL_FPS = 30;

/** Both output frames every fixture is drawn in, by their file-name tag. */
export const STILL_ASPECTS = {
  "16x9": { width: 1920, height: 1080 },
  "9x16": { width: 1080, height: 1920 },
} as const;
export type StillAspect = keyof typeof STILL_ASPECTS;

/**
 * Seconds the still's cue runs past its latest `atSec`. Long enough that no
 * still lands inside the layer's exit fade (EXIT_SEC, 0.3 s), which would
 * photograph a half-faded graphic and call it the settled state.
 */
export const STILL_TAIL_SEC = 2;

/**
 * One fixture, as `packages/scenes/test/stills.fixtures.ts` writes it.
 * Restated structurally rather than imported, because scenes cannot depend
 * on renderer and the fixtures live beside the scenes tests. `layout` is
 * optional: absent means the component's registry `defaultLayout`, which is
 * what the planner would place it in. `graphicRect` is the cue's own slot,
 * the one a 16:9 script run plans (`SCRIPT_LANDSCAPE_RECT`, §161) — without
 * it the harness could only show the layouts' own slots. `aspects` narrows
 * the frames a fixture is drawn in, for a placement that only one aspect
 * ever gets.
 */
export interface StillFixture {
  component: SceneComponentId;
  name: string;
  props: unknown;
  atSec: number[];
  layout?: Layout;
  graphicRect?: Rect;
  aspects?: StillAspect[];
  /** What is behind the graphic (§163): absent or `speaker` is today's flat field. */
  backdrop?: StillBackdrop;
  /** Where the stand-in speaker's face is, source fractions; `STAND_IN_FACE` when absent. */
  face?: { centerXFrac: number; centerYFrac: number; sizeFrac: number };
}

/**
 * The three backdrops (design "Terms"), each an existing layout. `speaker`
 * stays the harness's flat field: a still has no footage, and a stand-in
 * under the whole frame would only make every speaker still harder to read.
 */
export type StillBackdrop = "speaker" | "solid" | "bubble";
const BACKDROP_LAYOUT = { solid: "graphic-only", bubble: "pip-bubble" } as const;

/**
 * The stand-in speaker's face when a fixture names none: an arm's-length
 * framing a little right of centre, the face box 0.3 of the source height,
 * in a 16:9 source — the shape of the explainer footage the picture is for.
 */
export const STAND_IN_FACE = {
  centerXFrac: 0.52,
  centerYFrac: 0.38,
  sizeFrac: 0.3,
  sourceAspect: 16 / 9,
} as const satisfies FaceCrop;

/** The stand-in source's own pixels — a 1080p landscape take. */
const STAND_IN_SOURCE = { width: 1920, height: 1080 } as const;

/**
 * The stand-in's shapes in source pixels: a head-sized ellipse centred on
 * the face, as tall as the face box and three quarters as wide. As tall as
 * the BOX, not the whole head, so a still answers the one question it is
 * for — is the face at the size the head zoom promises (55% of the picture)?
 */
export function standInGeometry(face: { centerXFrac: number; centerYFrac: number; sizeFrac: number }): {
  width: number;
  height: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
} {
  const { width, height } = STAND_IN_SOURCE;
  const ry = (face.sizeFrac * height) / 2;
  return { width, height, cx: face.centerXFrac * width, cy: face.centerYFrac * height, rx: ry * 0.75, ry };
}

/**
 * The stand-in footage as an SVG document: a flat mid-grey frame with a
 * lighter ellipse at the face. Drawn as an image of the SOURCE's shape so
 * VideoStage crops it with the same `object-fit: cover` and object-position
 * the real video gets — the still then shows the real picture geometry, crop
 * and head zoom included, with no video file.
 */
export function standInSvg(face: { centerXFrac: number; centerYFrac: number; sizeFrac: number }): string {
  const g = standInGeometry(face);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${g.width}" height="${g.height}" viewBox="0 0 ${g.width} ${g.height}">` +
    `<rect width="${g.width}" height="${g.height}" fill="#808080"/>` +
    `<ellipse cx="${g.cx}" cy="${g.cy}" rx="${g.rx}" ry="${g.ry}" fill="#C8C8C8"/>` +
    `</svg>`
  );
}

/** A slot in frame fractions — `SceneCue.graphicRect`'s shape. */
type Rect = NonNullable<SceneCue["graphicRect"]>;

/** The composition's input props: one scene, drawn alone. */
export interface SceneStillProps {
  component: SceneComponentId;
  /** Already parsed by the component's registry schema (defaults filled). */
  props: Record<string, unknown>;
  layout: Layout;
  /** The cue's own slot, when the fixture plans one. */
  graphicRect?: Rect;
  theme: Theme;
  frame: { width: number; height: number };
  /** Solid colour behind the scene, standing in for the speaker's video. */
  background: string;
  /** The cue's length and the composition's — latest `atSec` + STILL_TAIL_SEC. */
  durationSec: number;
  /**
   * `solid` or `bubble`: draw VideoStage with the stand-in footage under the
   * scene. Absent for every other still, so their props — and pixels — are
   * exactly what they were.
   */
  backdrop?: "solid" | "bubble";
  /** The stand-in's face, present with `backdrop`; also what VideoStage frames. */
  face?: FaceCrop & { centerXFrac: number; sizeFrac: number };
}

/**
 * The one cue a still renders: the real `SceneCue` shape starting at 0, so
 * `SceneLayer` places it exactly as a render would — slot, fit scale, scrim
 * and entrance all come from the same code, which is the point of drawing
 * stills through the layer rather than mounting the component bare.
 */
export function stillCue(p: SceneStillProps): SceneCue {
  return {
    id: "still",
    kind: "graphic",
    layout: p.layout,
    component: p.component,
    props: p.props,
    startSec: 0,
    endSec: p.durationSec,
    ...(p.graphicRect ? { graphicRect: p.graphicRect } : {}),
  };
}

/** The frame to photograph for `atSec` — Remotion's `renderStill` takes frames. */
export function stillFrame(atSec: number, fps: number = STILL_FPS): number {
  return Math.round(atSec * fps);
}

/** `<Component>-<name>-<16x9|9x16>-<atSec>s.png`, the harness's naming. */
export function stillFileName(
  fixture: Pick<StillFixture, "component" | "name">,
  aspect: StillAspect,
  atSec: number,
): string {
  return `${fixture.component}-${fixture.name}-${aspect}-${atSec}s.png`;
}

/**
 * The fixtures `pnpm stills [Component]` renders: all of them with no
 * argument, else that component's. The name is parsed with core's
 * `SceneComponentIdSchema` (the one id enum; this package carries no zod of
 * its own) and must then be a component that HAS fixtures, so a typo and a
 * component nobody has written a fixture for both fail with the list of
 * names that would render something — a run that renders nothing and exits
 * 0 is the silent failure this refuses.
 */
export function selectStillFixtures<F extends StillFixture>(
  fixtures: readonly F[],
  arg: string | undefined,
): F[] {
  if (arg === undefined) return [...fixtures];
  const names = [...new Set(fixtures.map((f) => f.component))];
  const parsed = SceneComponentIdSchema.safeParse(arg);
  if (!parsed.success || !names.includes(parsed.data)) {
    throw new Error(
      `unknown component "${arg}" — fixtures exist for: ${names.join(", ") || "(none)"}`,
    );
  }
  return fixtures.filter((f) => f.component === parsed.data);
}

/** One PNG to render. */
export interface StillJob {
  props: SceneStillProps;
  atSec: number;
  fileName: string;
}

/**
 * Every still for `fixtures`: each fixture × its aspects (both unless it
 * names them) × each `atSec`.
 * Props go through the component's registry schema here, before any browser
 * starts, so a fixture that breaks a copy cap fails by name instead of as a
 * render of props no planner could produce.
 */
export function stillJobs(
  fixtures: readonly StillFixture[],
  theme: Theme,
  background: string,
): StillJob[] {
  const jobs: StillJob[] = [];
  for (const f of fixtures) {
    const meta = SCENE_REGISTRY[f.component];
    const parsed = meta.propsSchema.safeParse(f.props);
    if (!parsed.success) {
      throw new Error(`still fixture ${f.component}/${f.name}: ${parsed.error.message}`);
    }
    if (f.atSec.length === 0) throw new Error(`still fixture ${f.component}/${f.name}: no atSec`);
    const durationSec = Math.max(...f.atSec) + STILL_TAIL_SEC;
    // A backdrop IS a layout; a fixture naming both must agree, or the still
    // would photograph something other than what its name says.
    const backdrop = f.backdrop && f.backdrop !== "speaker" ? f.backdrop : undefined;
    const layout = backdrop ? BACKDROP_LAYOUT[backdrop] : (f.layout ?? meta.defaultLayout);
    if (backdrop && f.layout && f.layout !== layout) {
      throw new Error(
        `still fixture ${f.component}/${f.name}: backdrop "${backdrop}" is layout "${layout}", not "${f.layout}"`,
      );
    }
    const stand = backdrop
      ? { backdrop, face: { ...(f.face ?? STAND_IN_FACE), sourceAspect: STAND_IN_FACE.sourceAspect } }
      : {};
    for (const aspect of f.aspects ?? (Object.keys(STILL_ASPECTS) as StillAspect[])) {
      for (const atSec of f.atSec) {
        jobs.push({
          atSec,
          fileName: stillFileName(f, aspect, atSec),
          props: {
            component: f.component,
            props: parsed.data as Record<string, unknown>,
            layout,
            ...(f.graphicRect ? { graphicRect: f.graphicRect } : {}),
            theme,
            frame: { ...STILL_ASPECTS[aspect] },
            background,
            durationSec,
            ...stand,
          },
        });
      }
    }
  }
  return jobs;
}
