import React from "react";
import { AbsoluteFill, Img, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Gif } from "@remotion/gif";
import { z } from "zod/v4";
import { enterProgress, pop } from "./anim";
import { frameWindow } from "./frames";
import { cardRect, containedRect, overlayBoxForCue } from "./overlay-rect";
import type { FrameSize, Rect } from "./stage";

/**
 * One library overlay as the renderer sees it — core's `OverlayCue`,
 * re-declared structurally because scenes does not depend on core's resolver
 * at runtime (the `SfxCueProps` posture).
 */
export interface OverlayCueProps {
  /** The placement id — ties a rendered overlay back to the editor's chip. */
  id: string;
  /** `library/<id>.<ext>` under the render's public dir, or a `/media/…` / http(s) URL. */
  file: string;
  /** A label only (ruling R8) — GIF-vs-still is the file's extension. */
  kind: "logo" | "image" | "gif";
  look: "overlay" | "card";
  atSec: number;
  endSec: number;
  /** A hand-placed box (core `OverlayCue.rect`); absent = automatic placement. */
  rect?: Rect;
}

const OverlayCuePropsSchema = z
  .object({
    id: z.string().min(1),
    file: z.string().min(1),
    kind: z.enum(["logo", "image", "gif"]),
    look: z.enum(["overlay", "card"]),
    // zod v4 numbers already refuse NaN and ±Infinity.
    atSec: z.number().nonnegative(),
    endSec: z.number(),
    // Core's OverlayRectSchema bounds, re-declared (scenes does not import
    // core at runtime). A mangled rect costs the cue, not the frame.
    rect: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        w: z.number().min(0.02).max(1),
        h: z.number().min(0.02).max(1),
      })
      .optional(),
  })
  .refine((c) => c.endSec > c.atSec);

/**
 * The render-props `overlayCues` gate — `sfxCuesFor`'s posture: parsed, never
 * coerced (CLAUDE.md). render-props.json is hand-editable and every
 * pre-feature file has no key at all, so an absent key is no track, and a
 * mangled entry costs that entry only — never an `undefined` src, a
 * NaN-frame Sequence, or a typo'd `look: "crad"` silently drawn as an overlay
 * when the author asked for a card.
 */
export function overlayCuesFor(raw: unknown): OverlayCueProps[] {
  if (!Array.isArray(raw)) return [];
  const out: OverlayCueProps[] = [];
  for (const entry of raw) {
    const parsed = OverlayCuePropsSchema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * GIF vs still by the file's EXTENSION, never by `kind` (ruling R8): `kind` is
 * a library label the author can set to anything, and handing a PNG to the
 * GIF decoder (or a GIF to `<Img>`, which renders only its first frame in a
 * seeked render) is decided by the bytes the extension names.
 */
export function isGifFile(file: string): boolean {
  return /\.gif$/i.test(file.split(/[?#]/)[0] ?? "");
}

/**
 * A rooted path or a URL passes through untouched, everything else is a name
 * in the render's public dir — ProductionComposition's cover rule, widened to
 * a leading `/` so the editor can hand over its `/media/library/…` workdir
 * copy (spec §Rendering, Preview). Resolver injected so the rule is testable
 * outside a Remotion bundle.
 */
export function overlaySrc(file: string, resolve: (f: string) => string = staticFile): string {
  return /^(\/|https?:\/\/)/.test(file) ? file : resolve(file);
}

/**
 * The overlay's entrance scale for a spring progress — anim.ts `pop`'s exact
 * curve (0.9 → 1), as a number so it can be applied about the image's own
 * bottom edge rather than as a frame-level transform string.
 */
export function overlayEntranceScale(progress: number): number {
  return 0.9 + 0.1 * progress;
}

/** Spec §Rendering, Animation: "fade out over the last ~0.25s". */
const FADE_OUT_SEC = 0.25;
/** The card's black fades in this fast — a cut-like beat, not a dissolve. */
const CARD_FADE_IN_SEC = 0.15;

/** Opacity multiplier for the exit: 1 until the last 0.25s, then down to 0. */
export function overlayFadeOut(localFrame: number, durationInFrames: number, fps: number): number {
  const fadeFrames = FADE_OUT_SEC * fps;
  return Math.max(0, Math.min(1, (durationInFrames - localFrame) / fadeFrames));
}

/** The card backdrop's entrance: 0 → 1 over 0.15s. */
export function cardBackdropOpacity(localFrame: number, fps: number): number {
  return Math.max(0, Math.min(1, localFrame / (CARD_FADE_IN_SEC * fps)));
}

/**
 * The positioned element for an image rect, entrance scale included.
 *
 * The scale lives ON this element, origin its own bottom-centre, and that
 * placement is the point: scaled on a full-frame layer with `center bottom`,
 * the origin was the FRAME's bottom edge, so a 0.9 scale pulled every point
 * toward it — a box ending a gap above the captions dropped ~31px into them
 * during each entrance (task-4 review, round 1). About its own bottom edge, a
 * scale ≤ 1 can only shrink the image up and inward from where the box ends.
 * `scale` absent = no transform (the card's image, which pops on its layer
 * about the frame's centre — the box's own centre too).
 */
export function overlayImageStyle(
  r: Rect,
  scale?: number,
  origin: "center bottom" | "center" = "center bottom",
): React.CSSProperties {
  return {
    position: "absolute",
    left: `${r.x * 100}%`,
    top: `${r.y * 100}%`,
    width: `${r.w * 100}%`,
    height: `${r.h * 100}%`,
    ...(scale === undefined ? {} : { transform: `scale(${scale})`, transformOrigin: origin }),
  };
}

/**
 * The element the editor grabs (overlay-transform): tagged with the
 * placement id and the ONLY hittable node of the track. Everything around
 * it stays `pointer-events: none` (the Watermark rule), so an overlay
 * blocks clicks only inside its own picture, only while it is on screen.
 * Irrelevant to a headless render, which has no pointer.
 */
const editTag = (id: string) => ({ "data-edit-overlay": id, style: { pointerEvents: "auto" as const } });

/**
 * The image itself, inside its max box. A file that fails to load renders
 * NOTHING and warns (spec anti-goal: "a blank or broken box in the output") —
 * which also keeps Remotion's own handling, a `cancelRender` that kills the
 * whole render, from turning one missing logo into a missing video.
 */
const OverlayImage: React.FC<{
  cue: OverlayCueProps;
  box: Rect;
  align: "bottom" | "center";
  frame: FrameSize;
  /** The entrance scale, applied about the image's own bottom edge (or its
   * centre for a hand-placed box, which hugs no caption). */
  scale?: number;
}> = ({ cue, box, align, frame, scale }) => {
  const [failed, setFailed] = React.useState(false);
  // The decoded aspect, so the positioned element IS the picture rather than
  // its max box (containedRect). GIFs need it to place their bottom edge;
  // stills draw the same pixels either way (object-fit contain), but the
  // editor's selection box is measured off this element, and a box the
  // width of the frame around a small square logo is a box nobody can aim.
  const [aspect, setAspect] = React.useState<number | null>(null);
  if (failed) return null;
  const origin = align === "bottom" ? "center bottom" : "center";
  const rect = aspect === null ? box : containedRect(box, aspect, frame, align);
  const tag = editTag(cue.id);
  const src = overlaySrc(cue.file);
  const onError = () => {
    console.warn(`overlay ${cue.id}: could not load ${cue.file} — skipped`);
    setFailed(true);
  };
  if (isGifFile(cue.file)) {
    return (
      <div data-edit-overlay={tag["data-edit-overlay"]} style={{ ...overlayImageStyle(rect, scale, origin), ...tag.style }}>
        <Gif
          src={src}
          fit="contain"
          // Loops over the overlay's window (spec §Rendering, GIF).
          loopBehavior="loop"
          style={{ width: "100%", height: "100%" }}
          onLoad={(info) => setAspect(info.width / info.height)}
          onError={onError}
        />
      </div>
    );
  }
  return (
    <div data-edit-overlay={tag["data-edit-overlay"]} style={{ ...overlayImageStyle(rect, scale, origin), ...tag.style }}>
      <Img
        src={src}
        onError={onError}
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth > 0 && img.naturalHeight > 0) setAspect(img.naturalWidth / img.naturalHeight);
        }}
        style={{
          width: "100%",
          height: "100%",
          // Ruling R2: the box is the MAX; contain keeps the aspect, and the
          // overlay hugs the box's caption-side edge.
          objectFit: "contain",
          objectPosition: align === "bottom" ? "center bottom" : "center",
        }}
      />
    </div>
  );
};

const OverlayLook: React.FC<{
  cue: OverlayCueProps;
  durationInFrames: number;
  captionTopAt: (tSec: number) => number | null;
  captionBottomAt: (tSec: number) => number | null;
  graphicRectAt: (tSec: number) => Rect | undefined;
}> = ({ cue, durationInFrames, captionTopAt, captionBottomAt, graphicRectAt }) => {
  const local = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const frame = { width, height };
  const p = enterProgress(local, fps);
  const out = overlayFadeOut(local, durationInFrames, fps);
  const entrance = pop(p);
  // Memoised, and ahead of the card branch to keep the hook order: the box
  // is constant over the cue's window (overlayBoxForCue), and sampling every
  // frame of the window on every rendered frame was pure waste.
  const box = React.useMemo(
    () =>
      cue.look === "overlay" && !cue.rect
        ? overlayBoxForCue(cue, fps, { width, height }, captionTopAt, graphicRectAt, captionBottomAt)
        : null,
    // Keyed on the cue's look and timing, not the object: the parsed list is
    // rebuilt per composition render, and the box depends on nothing else.
    // The lookups must be stable for this to hold — ProductionComposition
    // memoises them (final review M3).
    [cue.look, cue.rect, cue.atSec, cue.endSec, fps, width, height, captionTopAt, captionBottomAt, graphicRectAt],
  );
  // A hand-placed box (overlay-transform) is drawn where the user put it and
  // dodges nothing: they moved it, so the caption-clearing placement no
  // longer speaks for them. Centred in its box, popping about its centre.
  if (cue.look === "overlay" && cue.rect) {
    return (
      <AbsoluteFill style={{ pointerEvents: "none", opacity: p * out }}>
        <OverlayImage
          cue={cue}
          box={cue.rect}
          align="center"
          frame={frame}
          scale={overlayEntranceScale(p)}
        />
      </AbsoluteFill>
    );
  }
  if (cue.look === "card" || box === null) {
    return (
      <AbsoluteFill style={{ pointerEvents: "none", opacity: out }}>
        <AbsoluteFill
          style={{ backgroundColor: "black", opacity: cardBackdropOpacity(local, fps) }}
        />
        <AbsoluteFill style={{ opacity: p, transform: entrance.transform }}>
          {/* The card's black stays full-frame; a hand-placed box moves
              only the picture on it (overlay-transform). */}
          <OverlayImage cue={cue} box={cue.rect ?? cardRect(frame)} align="center" frame={frame} />
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: p * out }}>
      {/* The scale goes to the image's own element (overlayImageStyle), never
          to a full-frame layer — see there for the caption overlap that cost. */}
      <OverlayImage
        cue={cue}
        box={box}
        align="bottom"
        frame={frame}
        scale={overlayEntranceScale(p)}
      />
    </AbsoluteFill>
  );
};

/**
 * Library logos, images and GIFs on cue (overlay-library spec §Rendering):
 * one `<Sequence>` per cue, mounted after the captions so an overlay is
 * painted above them — which is why its PLACEMENT, not the stacking order,
 * is what keeps it off them.
 *
 * Invisible to the editor's hit-test EXCEPT the picture itself, which is
 * tagged `data-edit-overlay` (overlay-transform: the user asked for the
 * move/resize every other on-canvas thing has, reversing the original spec's
 * "no drag-to-move" non-goal). The layers around it stay `pointer-events:
 * none`, the Watermark/CoverInVideo rule.
 */
export const OverlayTrack: React.FC<{
  cues: OverlayCueProps[];
  captionTopAt: (tSec: number) => number | null;
  /** The lowest caption bottom on screen — the band below a high caption (ruling R19). */
  captionBottomAt: (tSec: number) => number | null;
  graphicRectAt: (tSec: number) => Rect | undefined;
}> = ({ cues, captionTopAt, captionBottomAt, graphicRectAt }) => {
  const { fps, durationInFrames: total } = useVideoConfig();
  return (
    <>
      {cues.map((cue, i) => {
        // §115: the end frame from the end TIME. A cue past the last frame
        // is dropped, `visibleSfxCues`' rule.
        const { from, durationInFrames } = frameWindow(cue.atSec, cue.endSec, fps);
        if (from >= total) return null;
        return (
          <Sequence
            // Index too: ids are unique by construction upstream, but a
            // hand-edited render-props with a duplicate must not make React
            // drop one of the pair.
            key={`${cue.id}:${i}`}
            from={from} durationInFrames={durationInFrames} layout="none">
            <OverlayLook
              cue={cue}
              durationInFrames={durationInFrames}
              captionTopAt={captionTopAt}
              captionBottomAt={captionBottomAt}
              graphicRectAt={graphicRectAt}
            />
          </Sequence>
        );
      })}
    </>
  );
};
