import { MIN_FRAMING_CLASS_FRAC, type ContentRectSegment } from "./content-rect";
import type { WindowFace } from "./face";

/**
 * Framing normalization for a mixed-framing source (option (a), chosen with
 * the author 2026-07-28).
 *
 * A source that alternates a letterboxed landscape strip with full-bleed
 * portrait has no single framing — and rendering each segment's own framing
 * cover-filled produced a ~3× apparent zoom jump at every boundary, nine
 * times a minute on the motivating clip ("weird zoom-outs and zoom-ins").
 * Smoothing the boundaries cannot fix that; the output would still alternate
 * between two shots.
 *
 * The fix is editorial: pick ONE field of view — the tightest the source ever
 * shows, i.e. the strip, since the strip's pixels are all those stretches
 * have — and crop every other segment down to a window of that same shape,
 * placed on the measured face. One consistent apparent framing, by choice.
 *
 * The plan used to be BAKED into a re-encoded file. That ended with the
 * 2026-08-16 incident: an over-eager plan destroyed 55% of a screen
 * recording's picture and the only undo was deleting the baked mp4 — the
 * editor could not even see the crop had happened. The plan is now emitted
 * into render-props.json as `framingTimeline` and applied at render time as a
 * transform (packages/scenes/src/content-crop.ts), fully visible to and
 * counteractable from the editor. The plan's GEOMETRY is unchanged by that
 * move: every window shares one aspect, so per-segment render-time cover
 * shows the same apparent framing on both sides of every boundary — the
 * invariant the bake existed to enforce (144bbfb).
 *
 * When even the strip cannot cover the output frame without excessive
 * upscaling — or the plan would discard too much picture — normalization
 * refuses (`ok: false`) and the caller falls back to render-time FIT — the
 * strip shown at its natural size rather than fake-zoomed (option (b)).
 */

/** One planned stretch: this window of the source, covering the slot. */
export interface NormalizeSegment {
  startSec: number;
  endSec: number;
  /** Crop window in SOURCE pixels — always the canvas's aspect. */
  window: { x: number; y: number; w: number; h: number };
}

export interface NormalizePlan {
  /** The common frame every segment is cropped+scaled to. */
  canvas: { width: number; height: number };
  segments: NormalizeSegment[];
  /**
   * Per segment, the face's height as a fraction of the CANVAS after baking —
   * what the framing actually achieved, as opposed to what it aimed for. This
   * is the input to `assessCueFraming`, and eventually to telling the producer
   * which windows can host which layouts.
   */
  faceFracOfCanvas: number[];
  /**
   * The upscale a full-bleed cover of the OUTPUT implies. The quality gate:
   * past `MAX_NORMALIZE_UPSCALE` the picture would be visibly soft, and a
   * soft fake is worse than an honest fit.
   */
  coverUpscale: number;
  /**
   * Duration-weighted mean of the picture area each window discards from its
   * segment's rect (`1 - windowArea / rectArea`). The other half of the
   * quality gate, and the number the refusal log reports: coverUpscale alone
   * measured softness, never loss (2026-08-16 incident).
   */
  areaDiscardWeighted: number;
  /**
   * Per timeline segment, what the window is anchored on. "face" means the
   * segment passed `segmentIsFaceOnly` and its window is sized and placed on
   * the measured face; "screen" means the window is the segment's own rect,
   * centered and clipped to the shared aspect — the picture, not the person,
   * is the subject there (2026-08-16 incident: the PiP was not the subject).
   */
  subject: ("face" | "screen")[];
  /**
   * Per timeline segment, where the subject sits INSIDE its window, both axes
   * in 0..1. For a face segment this is the measured face centre relative to
   * the final window, so a render-time cover crop can keep the head where the
   * plan put it; a screen segment's subject is the whole picture, so 0.5/0.5.
   */
  bias: { x: number; y: number }[];
  ok: boolean;
}

/**
 * Ceiling on how far the canvas may be upscaled when a full-bleed layout
 * covers the output with it. The motivating clip sits at 1920/808 ≈ 2.38 —
 * soft but within reel norms; a strip much shorter than that is not worth
 * faking a full-frame shot from.
 */
export const MAX_NORMALIZE_UPSCALE = 2.6;

/**
 * Ceiling on the duration-weighted mean fraction of picture area a plan may
 * throw away. coverUpscale 0.77 passed while 37% of the frame area was being
 * thrown away — the gate measured softness, never loss (2026-08-16 incident).
 */
export const MAX_MEAN_AREA_DISCARD = 0.5;

/**
 * Ceiling on the picture area a SCREEN-subject segment's window may discard
 * from its own rect. A screen segment's window is its rect clipped to the
 * shared aspect — losing more than this means the shared aspect is genuinely
 * fighting that segment's shape, and cropping screen content slides text and
 * UI out of frame. Face segments are exempt: a face crop discards area by
 * design. Applies to MATERIAL segments only, mirroring the aspect vote — a
 * sliver class gets no vote on the aspect, so it cannot veto the plan for
 * being clipped to it either (the 1.1% dark segment of the 2026-08-16
 * incident loses ~16% to the shared aspect; the duration-weighted mean gate
 * is what bounds slivers).
 */
export const MAX_SCREEN_AREA_DISCARD = 0.1;

/**
 * Smallest face (box height over segment-rect height) that makes a segment
 * "just a face". Equals DEFAULT_FACE.sizeFrac (stage.ts): a face smaller than
 * the assumed arm's-length selfie box is not the frame's subject. 2026-08-16
 * incident: the camera PiP measured 0.119 and the crop chased it, discarding
 * the screen content that WAS the subject; a real talking head measures 0.28+.
 */
export const FACE_ONLY_MIN_FRAC = 0.22;

/**
 * Below this fraction of sampled frames with a detection, the measurement is
 * not confident enough to reframe on — a face seen in under half the looks is
 * as likely a false positive or an occasional glance at a webcam.
 */
export const FACE_MIN_DETECTION_RATIO = 0.5;

/**
 * Extra breathing room, as a fraction of the window height, kept above the
 * crown and below the chin when the window slides to contain the head. The
 * user's rule (2026-08-16): the ENTIRE head including hair stays in frame,
 * with ~1% of margin — touching the frame edge reads as a crop even when
 * nothing is technically cut.
 */
export const HEAD_WINDOW_MARGIN = 0.01;

/**
 * A head is about 1.55x the detector's face box tall — the box bounds eyes,
 * nose and mouth, and `stage.ts` models the crown at 0.35x above it and the
 * chin at 0.2x below (FINDINGS §19).
 */
const HEAD_PER_FACE = 1.55;
const HEAD_ABOVE = 0.85;
const HEAD_BELOW = 0.7;

/**
 * The tightest the framing may ever get, as face-box height over frame height.
 *
 * Derived, not tuned: the head must survive the idle zoom with margin left, so
 * `HEAD_PER_FACE x F x ZOOM_MAX_SCALE <= 1 - 2 x margin`. At a 6% margin top
 * and bottom that is `1.55 x F x 1.05 <= 0.88`, i.e. F <= 0.54.
 *
 * This is a CEILING on cropping in, never a target to reach. A segment whose
 * face is already larger than this is left at its own framing rather than
 * cropped further — there is no version of "consistent framing" worth cutting
 * someone's forehead off for, which is exactly what the previous round did.
 */
export const MAX_FACE_FRACTION = 0.54;

const even = (v: number): number => 2 * Math.floor(v / 2);
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Is this segment essentially JUST a face — the only case where a
 * face-anchored reframe is allowed (user decision, 2026-08-16)?
 *
 * Classified on the representative `sizeFrac`, not `sizeFracMax`: a segment
 * is face-only by what it looks like most of the time, not at its one biggest
 * lean-in (sizing, once classified, still uses the max — see planNormalization).
 * The detection ratio guards against reframing on a face the detector barely
 * ever saw.
 */
export function segmentIsFaceOnly(face: WindowFace | null): boolean {
  if (!face) return false;
  if (face.sizeFrac < FACE_ONLY_MIN_FRAC) return false;
  return (
    face.framesSampled > 0 &&
    face.framesDetected / face.framesSampled >= FACE_MIN_DETECTION_RATIO
  );
}

/**
 * Decide the canvas and each segment's crop window.
 *
 * `faces` is parallel to `timeline` — each face in ITS segment rect's own
 * fractions (`measureFaceInWindows`).
 *
 * The window is sized by the FACE, not by a constant rect. Equalizing the
 * canvas alone is not enough, and the author's clip proved it: its two
 * framings are the same camera shot presented differently — the letterboxed
 * strip is the whole landscape frame, the full-bleed stretches are a zoomed
 * crop of it. So the face measures 0.28-0.44 of the frame in one state and
 * 0.48-0.57 in the other, and cropping both to a constant-height window put
 * the face at 108% of output height in the full-bleed stretches (head taller
 * than the frame) against 57% in the strips. Same subject, wildly different
 * size, at every boundary.
 *
 * Sizing each window as `faceHeight / targetFraction` makes the SUBJECT the
 * constant instead, which is what "one consistent framing" has to mean. The
 * target is the MEDIAN measured fraction: a segment whose face is smaller
 * than the target crops in to match, and one whose face is larger can only
 * zoom out as far as its own rect — clamping there rather than inventing
 * pixels. The median (not the max) is what keeps that clamping rare and the
 * upscale inside the quality gate.
 *
 * All of that applies ONLY to segments that are essentially just a face
 * (`segmentIsFaceOnly`). Anything else — a screen share, a face-and-screen
 * mix, a PiP — keeps its whole rect, centered and clipped to the shared
 * aspect: the 2026-08-16 incident chased a 0.119 PiP and cropped away the
 * screen content that was the actual subject.
 */
export function planNormalization(
  timeline: readonly ContentRectSegment[],
  faces: ReadonlyArray<WindowFace | null>,
  output: { width: number; height: number },
): NormalizePlan {
  const boxed = timeline.filter((s) => !s.rect.full);
  // Callers only reach here for a mixed source, but refuse rather than crash.
  if (boxed.length === 0 || timeline.length < 2) {
    return {
      canvas: { width: 0, height: 0 },
      segments: [],
      faceFracOfCanvas: [],
      coverUpscale: Infinity,
      // Nothing was planned, so nothing was discarded; `ok: false` is the
      // refusal signal, not this number.
      areaDiscardWeighted: 0,
      subject: [],
      bias: [],
      ok: false,
    };
  }

  // Face-anchored sizing and placement ONLY where the frame is essentially
  // just a face (user decision, 2026-08-16). Everything else is a "screen"
  // subject: its window is its own rect, centered and clipped to the shared
  // aspect — the incident's PiP (sizeFrac 0.119) must never drag the crop
  // to the bottom-right corner of a screen recording again.
  const faceOnly = timeline.map((_, i) => segmentIsFaceOnly(faces[i] ?? null));

  /**
   * The LARGEST face fraction in each segment, not the median. A window sized
   * on the median is correct only at the median moment: the author's clip
   * moves 29%-48% inside one 12s stretch, and sizing on 34% put the head past
   * the frame edge whenever they leaned in — which is precisely the frame they
   * flagged. Sizing on the maximum makes the tightest moment the safe one and
   * every other moment merely roomier.
   *
   * Only FACE-ONLY segments contribute a measurement: a PiP-sized face must
   * not drag the target down for the real talking heads (2026-08-16 incident).
   */
  const measured = timeline.map((_, i) =>
    faceOnly[i] ? (faces[i]!.sizeFracMax ?? faces[i]!.sizeFrac) : null,
  );
  const known = measured.filter((v): v is number => v !== null);

  // ---- Window heights ------------------------------------------------------
  // Without a single face-only segment there is no subject to hold constant,
  // and the whole plan degrades to rect-shaped windows: the tightest field of
  // view, uniformly, with nothing anchored on a face.
  const target = known.length > 0 ? Math.min(median(known), MAX_FACE_FRACTION) : null;
  const canvasRect = boxed.reduce((a, b) => (b.rect.h < a.rect.h ? b : a)).rect;
  const canvasRectAspect = canvasRect.w / canvasRect.h;
  /** The tallest window of the tightest rect's shape that fits in `s.rect`. */
  const rectShapedHeight = (s: ContentRectSegment): number =>
    even(Math.min(s.rect.w, s.rect.h * canvasRectAspect) / canvasRectAspect);
  const windowHeights = timeline.map((s, i) =>
    target === null || !faceOnly[i]
      ? rectShapedHeight(s)
      : even(clamp((measured[i]! * s.rect.h) / target, 16, s.rect.h)),
  );

  // ---- Canvas --------------------------------------------------------------
  // The widest aspect every MATERIAL window can actually hold. Wider than the
  // output's own aspect leaves the stage some horizontal freedom for the face
  // bias; narrower simply means the output crops height, which cover already
  // does.
  //
  // Material = the segment's framing class (same rect within 2px) totals at
  // least
  // MIN_FRAMING_CLASS_FRAC of the runtime — the constant content-rect's
  // materiality filter uses, belt-and-braces with it. A sliver class still gets a
  // window — the rect clamp below bounds it — it just gets no vote here: one
  // 15.4s segment (1.1% of a 1435s take, rect 2848x2234) set canvas aspect
  // 1.2748 for the whole video and baked away 28% of source width
  // (2026-08-16 incident).
  const totalDur = timeline.reduce((a, s) => a + Math.max(0, s.endSec - s.startSec), 0);
  const classDur = timeline.map((s) =>
    timeline.reduce(
      (a, o) =>
        Math.abs(o.rect.w - s.rect.w) <= 2 && Math.abs(o.rect.h - s.rect.h) <= 2
          ? a + Math.max(0, o.endSec - o.startSec)
          : a,
      0,
    ),
  );
  const material = classDur.map((d) => totalDur > 0 && d / totalDur >= MIN_FRAMING_CLASS_FRAC);
  // If every class is a sliver there is no majority to defer to — all vote.
  const votes = material.some(Boolean) ? material : material.map(() => true);
  const aspect = timeline.reduce(
    (a, s, i) => (votes[i] ? Math.min(a, s.rect.w / windowHeights[i]!) : a),
    Number.POSITIVE_INFINITY,
  );
  // The smallest window, so baking never upscales — the tightest segment sets
  // the resolution and every other one is downscaled into it.
  const canvasHeight = even(Math.min(...windowHeights));
  const canvas = { width: even(canvasHeight * aspect), height: canvasHeight };

  // ---- Face placement inside the window ------------------------------------
  // Taken from the FACE-ONLY segments whose window IS their rect: their
  // framing is the author's own and survives untouched, so it is the one to
  // reproduce. Screen segments get no say — the incident's PiP at 0.88/0.76
  // would anchor every window bottom-right.
  let wx = 0;
  let wy = 0;
  let weight = 0;
  timeline.forEach((seg, i) => {
    const f = faces[i];
    if (!f || !faceOnly[i] || windowHeights[i]! < seg.rect.h - 2) return;
    const dur = Math.max(1e-6, seg.endSec - seg.startSec);
    wx += f.centerXFrac * dur;
    wy += f.centerYFrac * dur;
    weight += dur;
  });
  const targetX = weight > 0 ? wx / weight : 0.5;
  const targetY = weight > 0 ? wy / weight : 0.45;

  const segments: NormalizeSegment[] = timeline.map((seg, i) => {
    const r = seg.rect;
    const wH = windowHeights[i]!;
    const wW = even(Math.min(r.w, wH * aspect));

    // Screen subject: no face math at all. The window is the segment's own
    // rect clipped to the shared aspect, centered on BOTH axes — the picture
    // is the subject, and a centered clip is the only placement that does not
    // pick a corner of it to sacrifice (2026-08-16 incident).
    if (!faceOnly[i]) {
      return {
        startSec: seg.startSec,
        endSec: seg.endSec,
        window: {
          x: even(r.x + (r.w - wW) / 2),
          y: even(r.y + (r.h - wH) / 2),
          w: wW,
          h: wH,
        },
      };
    }

    const f = faces[i]!;
    // Face position in source px.
    const faceX = r.x + f.centerXFrac * r.w;
    const faceY = r.y + f.centerYFrac * r.h;
    const x = even(clamp(faceX - targetX * wW, r.x, r.x + r.w - wW));

    let y = clamp(faceY - targetY * wH, r.y, r.y + r.h - wH);
    // Then slide — never resize — so the whole HEAD is inside the window at
    // the segment's largest face, since the aesthetic anchor above is about
    // where the face sits, and this is about not amputating it. The margin is
    // the user's ~1% rule (2026-08-16): the entire head including hair stays
    // in frame with a hair of breathing room — a crown touching the edge
    // reads as cropped. Bounded by the rect: if the head genuinely runs past
    // the source's own edge there is nothing to slide toward, and the clamp
    // leaves it where it was.
    const maxFace = (f.sizeFracMax ?? f.sizeFrac) * r.h;
    const headTop = faceY - HEAD_ABOVE * maxFace;
    const headBottom = faceY + HEAD_BELOW * maxFace;
    const margin = HEAD_WINDOW_MARGIN * wH;
    if (headBottom - headTop + 2 * margin <= wH) {
      y = clamp(y, headBottom + margin - wH, headTop - margin);
    } else if (headBottom - headTop <= wH) {
      // Head fits but its margin does not: keep the head, split the shortfall.
      y = clamp(y, headBottom - wH, headTop);
    } else {
      // Head taller than the window: centre it, so what is lost is shared
      // between crown and chin instead of taking the whole bite off one end.
      y = (headTop + headBottom) / 2 - wH / 2;
    }
    y = clamp(y, r.y, r.y + r.h - wH);
    return {
      startSec: seg.startSec,
      endSec: seg.endSec,
      window: { x, y: even(y), w: wW, h: wH },
    };
  });

  const subject = timeline.map((_, i): "face" | "screen" => (faceOnly[i] ? "face" : "screen"));
  // Where the subject sits inside its FINAL window (post-clamp, post-even):
  // the render-time cover crop uses this to keep the head where the plan put
  // it. Clamped to 0..1 because a rect-bounded window can leave the face
  // centre outside it in the degenerate edge cases the clamps above allow.
  const bias = timeline.map((seg, i) => {
    if (!faceOnly[i]) return { x: 0.5, y: 0.5 };
    const f = faces[i]!;
    const w = segments[i]!.window;
    const faceX = seg.rect.x + f.centerXFrac * seg.rect.w;
    const faceY = seg.rect.y + f.centerYFrac * seg.rect.h;
    return {
      x: clamp(w.w > 0 ? (faceX - w.x) / w.w : 0.5, 0, 1),
      y: clamp(w.h > 0 ? (faceY - w.y) / w.h : 0.5, 0, 1),
    };
  });

  // Cover the output with the canvas: for a canvas wider than the output's
  // aspect the height binds, otherwise the width does.
  const coverUpscale =
    canvas.width / canvas.height > output.width / output.height
      ? output.height / canvas.height
      : output.width / canvas.width;

  // What each segment actually achieved once its window is scaled to the
  // canvas — measured from the plan, never assumed to equal the target: a
  // segment clamped at its own rect lands wherever its rect put it. A screen
  // segment reports 0: it has no face SUBJECT, and downstream framing advice
  // (assessCueFraming, framing.ts) rightly skips zeros rather than warning
  // about the head of a PiP nobody is framing on.
  const faceFracOfCanvas = timeline.map((seg, i) => {
    const frac = measured[i];
    if (frac === null || frac === undefined) return 0;
    return (frac * seg.rect.h) / segments[i]!.window.h;
  });

  /** Picture area the window throws away from its segment's rect. */
  const discardFrac = (i: number): number => {
    const r = timeline[i]!.rect;
    const w = segments[i]!.window;
    return r.w * r.h > 0 ? 1 - (w.w * w.h) / (r.w * r.h) : 0;
  };

  // How much of each segment's picture the windows throw away, weighted by
  // how long the viewer looks at it. coverUpscale 0.77 passed while 37% of
  // the frame area was being thrown away — the gate measured softness, never
  // loss (2026-08-16 incident).
  const areaDiscardWeighted = timeline.reduce((acc, seg, i) => {
    const dur = Math.max(0, seg.endSec - seg.startSec);
    return acc + (totalDur > 0 ? dur / totalDur : 0) * discardFrac(i);
  }, 0);

  // Per-segment bound for SCREEN subjects: their window is meant to be
  // (essentially) their whole rect, so a material screen segment losing more
  // than MAX_SCREEN_AREA_DISCARD means the plan is cropping content nobody
  // asked it to reframe — refuse and let render-time fit show it honestly.
  // Face segments are exempt (a face crop discards area by design); sliver
  // segments are exempt for the same reason they get no aspect vote.
  const screenLossOk = timeline.every(
    (_, i) => faceOnly[i] || !material[i] || discardFrac(i) <= MAX_SCREEN_AREA_DISCARD,
  );

  return {
    canvas,
    segments,
    faceFracOfCanvas,
    coverUpscale,
    areaDiscardWeighted,
    subject,
    bias,
    ok:
      coverUpscale <= MAX_NORMALIZE_UPSCALE &&
      areaDiscardWeighted <= MAX_MEAN_AREA_DISCARD &&
      screenLossOk,
  };
}

/** A cue's video slot, in output pixels — `layoutSlots(cue.layout).video.rect`. */
export interface CueSlot {
  id: string;
  layout: string;
  /** SOURCE seconds, so this intersects the content timeline directly. */
  startSec: number;
  endSec: number;
  slot: { width: number; height: number };
}

export interface FramingIssue {
  cueId: string;
  layout: string;
  /** Face height over the SLOT's height, after cover crops the canvas to it. */
  faceFracOfSlot: number;
  /** The whole head, under the idle zoom. Above 1 it does not fit. */
  headFracOfSlot: number;
}

/**
 * How each scene's slot actually frames the speaker (plan step D).
 *
 * A slot WIDER than the canvas gets cover-cropped vertically, so it shows only
 * `canvasAspect / slotAspect` of the canvas height — and the face grows by the
 * inverse of that. `video-top` is a 1080x806 band against a portrait canvas:
 * it shows ~42% of the canvas height, so a face occupying 44% of the canvas
 * occupies 105% of the band. That is the crown trimming, and it is a property
 * of the LAYOUT, not of the source or of any global constant.
 *
 * This reports it per cue rather than fixing it, deliberately. It is not
 * fixable by cropping: the pixels a wide band wants do not exist in a portrait
 * close-up. It is fixable by not putting a wide band on that moment — which is
 * a producer decision, and this is the evidence it needs.
 */
/**
 * Face height over a SLOT's height, once cover crops the canvas into it.
 *
 * A slot WIDER than the canvas is cover-cropped vertically and shows only
 * `canvasAspect / slotAspect` of the canvas height, so the face grows by the
 * inverse; a slot no wider than the canvas crops width, and the face's height
 * fraction is unchanged. THE arithmetic behind every framing judgement —
 * per-cue assessment, the producer's brief, and the layout repair pass all
 * call this one function, so they cannot disagree.
 */
export function faceFracInSlot(
  faceFracOfCanvas: number,
  canvasAspect: number,
  slotAspect: number,
): number {
  if (canvasAspect <= 0 || slotAspect <= 0) return faceFracOfCanvas;
  return faceFracOfCanvas / Math.min(1, canvasAspect / slotAspect);
}

/** The whole head, under the idle zoom — above 1 the crop trims it. */
export function headFracInSlot(
  faceFracOfCanvas: number,
  canvasAspect: number,
  slotAspect: number,
  zoom: number,
): number {
  return HEAD_PER_FACE * faceFracInSlot(faceFracOfCanvas, canvasAspect, slotAspect) * zoom;
}

export function assessCueFraming(
  cues: readonly CueSlot[],
  segments: ReadonlyArray<{ startSec: number; endSec: number }>,
  faceFracOfCanvas: readonly number[],
  canvas: { width: number; height: number },
  zoom: number,
): FramingIssue[] {
  if (canvas.width <= 0 || canvas.height <= 0) return [];
  const canvasAspect = canvas.width / canvas.height;
  const out: FramingIssue[] = [];
  for (const cue of cues) {
    // The worst framing the cue is on screen for — a cue spanning a boundary
    // is judged by its tightest moment, not by an average of the two.
    let frac = 0;
    segments.forEach((seg, i) => {
      if (seg.startSec < cue.endSec && seg.endSec > cue.startSec) {
        frac = Math.max(frac, faceFracOfCanvas[i] ?? 0);
      }
    });
    if (frac <= 0 || cue.slot.width <= 0 || cue.slot.height <= 0) continue;
    const slotAspect = cue.slot.width / cue.slot.height;
    out.push({
      cueId: cue.id,
      layout: cue.layout,
      faceFracOfSlot: faceFracInSlot(frac, canvasAspect, slotAspect),
      headFracOfSlot: headFracInSlot(frac, canvasAspect, slotAspect, zoom),
    });
  }
  return out;
}
