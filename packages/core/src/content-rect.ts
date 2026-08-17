
/**
 * Letterbox detection (PLAN 2026-07-28 Task 7).
 *
 * A source file's frame is not always its picture. A screen-recorded or
 * re-exported clip can carry black bars baked into the pixels — one real case
 * probed as 1440×2560 portrait while the actual shot was a landscape strip
 * with bars above and below. Every geometric consumer then reasoned about the
 * wrong frame: `video-top` showed mostly bar, `blurred-behind` blurred black
 * into more black, the face detector searched an area two-thirds empty, and
 * `sourceAspect` described the container instead of the picture.
 *
 * The fix is one measurement, made early and consumed everywhere: the CONTENT
 * RECT — the largest area that is ever non-black across sampled frames. It is
 * a property of the source, cached beside `face.json`, and each downstream
 * ffmpeg pass prepends a `crop` to it so the rest of the pipeline never sees
 * the bars at all.
 *
 * Detection is ffmpeg's own `cropdetect` (parsed from stderr exactly the way
 * `detectSilences` reads `silencedetect`), not hand-rolled pixel scanning.
 * The union across samples is what keeps a dark shot honest: a bar has to be
 * black in EVERY sampled frame, so a night scene that ever shows anything at
 * its edges keeps its full frame.
 */

/** Pixel rect inside the source frame. */
export interface ContentRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** True when the rect IS the frame — nothing to trim, no crop pass runs. */
  full: boolean;
}

/** One cropdetect measurement, with the source time it was taken at. */
export interface CropSample {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Source seconds, from cropdetect's own `t:` field. */
  tSec: number;
}

/**
 * Per-frame `crop=W:H:X:Y` lines from cropdetect's stderr, with timestamps.
 *
 * The timestamp is not decoration: a source whose framing changes mid-take
 * needs to know WHEN it changed, not merely that two different rects were seen.
 * ffmpeg prints `t:` on the same line, so this costs nothing.
 */
export function parseCropdetect(stderr: string): CropSample[] {
  const out: CropSample[] = [];
  for (const line of stderr.split("\n")) {
    const m = line.match(/crop=(\d+):(\d+):(\d+):(\d+)/);
    if (!m) continue;
    const t = line.match(/\bt:(-?[\d.]+)/);
    out.push({
      w: Number(m[1]),
      h: Number(m[2]),
      x: Number(m[3]),
      y: Number(m[4]),
      tSec: t ? Number(t[1]) : 0,
    });
  }
  return out;
}

/**
 * A bar thinner than this fraction of its dimension is treated as not there.
 * Encoder padding and edge vignetting produce a few dark rows on perfectly
 * ordinary footage; trimming them would change every geometry downstream to
 * chase two invisible pixels.
 */
const SNAP_FRAC = 0.02;

/**
 * Below this share of the frame the measurement is refused. A clip dark
 * enough to "detect" a content rect this small is a clip cropdetect cannot be
 * trusted on — a fade-from-black or a genuinely dim shot — and cropping a
 * video to a sliver on bad evidence is far worse than leaving bars alone.
 */
const MIN_CONTENT_FRAC = 0.25;

/**
 * The stable rect from per-frame measurements: the UNION of everything any
 * sample considered content, snapped per side so hairline bars don't trigger
 * a crop, and refused outright when the result is implausibly small.
 */
export function stableContentRect(
  rects: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
  width: number,
  height: number,
): ContentRect {
  const whole: ContentRect = { x: 0, y: 0, w: width, h: height, full: true };
  if (rects.length === 0 || width <= 0 || height <= 0) return whole;

  // A measurement that does not FIT the frame was taken in a different
  // coordinate space than the one we are reconciling it against, so nothing it
  // says can be trusted (R27 §119). This is how a portrait take read as
  // landscape used to produce a "letterbox": cropdetect measured the rotated
  // 2160x3840 frame, the caller believed 3840x2160, and clamping the union of
  // the two orientations yielded a 2160x2160 square that was never on screen.
  // Refuse, exactly as MIN_CONTENT_FRAC refuses an implausibly small rect —
  // cropping on bad evidence is far worse than leaving bars alone.
  const fits = rects.every(
    (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= width && r.y + r.h <= height,
  );
  if (!fits) return whole;

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.x);
    top = Math.min(top, r.y);
    right = Math.max(right, r.x + r.w);
    bottom = Math.max(bottom, r.y + r.h);
  }

  // Snap each side independently: a real top bar must survive even when the
  // left and right edges are content to the pixel.
  if (left / width < SNAP_FRAC) left = 0;
  if (top / height < SNAP_FRAC) top = 0;
  if ((width - right) / width < SNAP_FRAC) right = width;
  if ((height - bottom) / height < SNAP_FRAC) bottom = height;

  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return whole;
  if ((w * h) / (width * height) < MIN_CONTENT_FRAC) return whole;
  if (left === 0 && top === 0 && w === width && h === height) return whole;
  // Even offsets/sizes keep yuv420 encoders happy; expand outward so the
  // rounding never shaves a row of picture (a black hairline would).
  const x = left - (left % 2);
  const y = top - (top % 2);
  return {
    x,
    y,
    w: Math.min(width - x, w + (w % 2)),
    h: Math.min(height - y, h + (h % 2)),
    full: false,
  };
}

/** A stretch of source time over which the framing does not change. */
export interface ContentRectSegment {
  /** Source seconds. */
  startSec: number;
  endSec: number;
  rect: ContentRect;
}

/**
 * One stretch of the RENDER-TIME framing plan — the props-based successor to
 * the destructive normalization bake (2026-08-16 incident: the bake's crop
 * could only be undone by deleting the re-encoded file; expressed as data,
 * the same window renders as a transform the editor can see and counteract).
 * Emitted into render-props.json as `framingTimeline`; absent means "no plan"
 * and every pre-existing render-props renders unchanged.
 */
export interface FramingSegment {
  /** Source seconds — intersects the content timeline and kept spans directly. */
  startSec: number;
  endSec: number;
  /** Crop window in SOURCE pixels, all windows sharing one aspect. */
  window: { x: number; y: number; w: number; h: number };
  /** What the window is anchored on; "screen" windows are centered clips. */
  subject: "face" | "screen";
  /** The subject's anchor point inside the window, 0..1 both axes. */
  bias: { x: number; y: number };
}

/**
 * Rescale framing windows from TRUE source pixels into the pixel space of a
 * display-sized mezzanine (2026-08-17 render-speed pass). `planNormalization`
 * keeps working in true source pixels — analysis runs on the source — and
 * the render-props emission scales the windows so window space === the space
 * of the file the render actually plays. Per-axis factors, not one scalar:
 * yuv420 even-rounding makes the two axes' ratios differ by a fraction of a
 * percent, and scaling both by one axis's factor could push a right-edge
 * window past the scaled file's width. Times, subject and bias are
 * scale-invariant and pass through untouched.
 */
export function scaleFramingWindows(
  timeline: readonly FramingSegment[],
  factor: { x: number; y: number },
): FramingSegment[] {
  return timeline.map((s) => ({
    ...s,
    window: {
      x: s.window.x * factor.x,
      y: s.window.y * factor.y,
      w: s.window.w * factor.x,
      h: s.window.h * factor.y,
    },
  }));
}

/**
 * The same rescale for the fit-fallback's content timeline — its rects are
 * source pixels too, and they reach the renderer only alongside a
 * `sourceSize` that must describe the played file (see the render-props
 * emission in produce.ts). `full` survives the scale: it means "this rect IS
 * the whole frame", which a uniform resample does not change.
 */
export function scaleContentTimeline(
  timeline: readonly ContentRectSegment[],
  factor: { x: number; y: number },
): ContentRectSegment[] {
  return timeline.map((s) => ({
    ...s,
    rect: {
      ...s.rect,
      x: s.rect.x * factor.x,
      y: s.rect.y * factor.y,
      w: s.rect.w * factor.x,
      h: s.rect.h * factor.y,
    },
  }));
}

/**
 * A framing run must survive BOTH of these to be believed. Together they are
 * what replaces the union rule's protection (PLAN Task C, step C2).
 *
 * The union existed because a genuinely dim frame can "detect" a false crop;
 * measuring per segment reintroduces that risk at segment granularity, where a
 * single dark frame in the middle of a good run could carve out a bogus crop.
 * A run of one is therefore never a framing change — it is an anomaly, and it
 * is absorbed into its neighbours. The wall-time floor covers the same failure
 * on a densely-sampled source, where three consecutive odd frames can still
 * span a third of a second.
 */
const MIN_RUN_SAMPLES = 2;
const MIN_RUN_SEC = 0.75;

/** Two rects describe the same framing if every side agrees within a hair. */
function sameFraming(a: ContentRect, b: ContentRect, width: number, height: number): boolean {
  const tolX = width * SNAP_FRAC;
  const tolY = height * SNAP_FRAC;
  return (
    Math.abs(a.x - b.x) <= tolX &&
    Math.abs(a.w - b.w) <= tolX &&
    Math.abs(a.y - b.y) <= tolY &&
    Math.abs(a.h - b.h) <= tolY
  );
}

/**
 * The source's framing over time (PLAN Task C).
 *
 * Task 7 modelled framing as one rect per source, which is right for a clip
 * that was letterboxed once on export. The author's own clip is not that: it
 * alternates a landscape strip with full-bleed portrait five times, 24.0s of
 * 63.5s letterboxed. Under a single-rect model `stableContentRect` correctly
 * refused to crop — a bar has to be black in EVERY sample and here it is not —
 * so every bar rendered as a bar.
 *
 * Each sample is classified through `stableContentRect` on its own, so the
 * hairline snapping and the implausibly-small refusal still apply per frame.
 * Consecutive like-classified samples become runs; runs too small to believe
 * are absorbed. A source with uniform framing collapses to exactly one segment,
 * which is Task 7's behaviour unchanged.
 */
export function contentRectTimeline(
  samples: readonly CropSample[],
  width: number,
  height: number,
  durationSec: number,
): ContentRectSegment[] {
  const whole: ContentRect = { x: 0, y: 0, w: width, h: height, full: true };
  const wholeTimeline = [{ startSec: 0, endSec: durationSec, rect: whole }];
  if (samples.length === 0 || width <= 0 || height <= 0) return wholeTimeline;

  const sorted = [...samples].sort((a, b) => a.tSec - b.tSec);
  const classified = sorted.map((s) => ({
    tSec: s.tSec,
    rect: stableContentRect([s], width, height),
  }));

  // Group consecutive like-framed samples.
  type Run = { rect: ContentRect; from: number; to: number; count: number };
  const runs: Run[] = [];
  for (const c of classified) {
    const last = runs[runs.length - 1];
    if (last && sameFraming(last.rect, c.rect, width, height)) {
      last.to = c.tSec;
      last.count += 1;
    } else {
      runs.push({ rect: c.rect, from: c.tSec, to: c.tSec, count: 1 });
    }
  }

  // Absorb runs too small to be a real framing change. Repeat until stable:
  // dropping one run can make its neighbours adjacent and mergeable, and a
  // single pass would leave those split.
  let changed = true;
  while (changed && runs.length > 1) {
    changed = false;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i]!;
      if (r.count >= MIN_RUN_SAMPLES && r.to - r.from >= MIN_RUN_SEC) continue;
      // Absorb into the LONGER neighbour — the one more likely to be the truth.
      const prev = runs[i - 1];
      const next = runs[i + 1];
      const into = !prev ? next : !next ? prev : prev.count >= next.count ? prev : next;
      if (!into) continue;
      into.from = Math.min(into.from, r.from);
      into.to = Math.max(into.to, r.to);
      into.count += r.count;
      runs.splice(i, 1);
      changed = true;
      break;
    }
  }

  // Merge any neighbours that now agree, then lay the runs onto the timeline.
  const merged: Run[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && sameFraming(last.rect, r.rect, width, height)) {
      last.to = Math.max(last.to, r.to);
      last.count += r.count;
    } else {
      merged.push({ ...r });
    }
  }

  return merged.map((r, i) => ({
    // The change happened somewhere between the last sample of one run and the
    // first of the next; the midpoint is the least-wrong guess and keeps the
    // boundary off any sampled frame.
    startSec: i === 0 ? 0 : (merged[i - 1]!.to + r.from) / 2,
    endSec: i === merged.length - 1 ? durationSec : (r.to + merged[i + 1]!.from) / 2,
    rect: r.rect,
  }));
}

/**
 * Materiality thresholds (2026-08-16 landscape screen-recording over-crop — a
 * 72px dark strip (2.08% inset, 1px past SNAP_FRAC's 69.1px tolerance) plus a
 * 15.4s/1435s outlier segment destroyed 55% of the picture).
 *
 * SNAP_FRAC decides whether a bar is worth TRIMMING; this bound decides
 * whether a rect difference is worth calling a FRAMING CHANGE — a far more
 * destructive claim, because a mixed-framing verdict sends the whole take
 * into normalization. The incident's jitter measured 2.0–2.3% per side, so
 * the bound sits at 3.5%: comfortably above jitter, comfortably below any
 * real letterbox (the motivating 144bbfb strip insets 34% per side).
 */
export const MATERIAL_INSET_FRAC = 0.035;

/**
 * A rect keeping at least this share of the frame's area, at (within
 * MATERIAL_ASPECT_TOL of) the frame's own aspect, is the frame minus
 * measurement noise — treating it as a distinct framing would re-crop every
 * downstream geometry to chase pixels nobody can see missing.
 */
export const MATERIAL_AREA_FRAC = 0.92;
const MATERIAL_ASPECT_TOL = 0.05;

/**
 * A framing class — every segment sharing one rect, contiguous or not —
 * totalling under this share of the runtime is an anomaly, not a framing
 * change. MIN_RUN_SEC only guards a single run; the incident's 15.4s outlier
 * (1.1% of 1435s) sailed past it and single-handedly set the canvas aspect
 * for the whole take.
 */
export const MIN_FRAMING_CLASS_FRAC = 0.05;

/**
 * Re-judge a measured timeline against what a framing change must AMOUNT TO
 * before it is believed (2026-08-16 incident above).
 *
 * Two passes. First, per segment: a rect whose every side inset is under
 * MATERIAL_INSET_FRAC, or that keeps MATERIAL_AREA_FRAC of the frame at the
 * frame's own aspect, is reclassified as the full frame — it differs from the
 * frame by less than a framing change is worth. Second, per CLASS: framing
 * classes totalling under MIN_FRAMING_CLASS_FRAC of the runtime are absorbed
 * into their longer neighbour, same shape as the run-absorption loop in
 * `contentRectTimeline` (drop one, retry until stable, then merge agreeing
 * neighbours). A uniform source comes out as exactly one segment.
 *
 * Pure — applied on top of the cached raw timeline, so an already-measured
 * source re-classifies on replay without a cache version bump.
 */
export function materializeTimeline(
  timeline: readonly ContentRectSegment[],
  width: number,
  height: number,
  durationSec: number,
): ContentRectSegment[] {
  if (timeline.length === 0 || width <= 0 || height <= 0) {
    return timeline.map((s) => ({ ...s }));
  }
  const whole: ContentRect = { x: 0, y: 0, w: width, h: height, full: true };
  const frameAspect = width / height;

  const immaterial = (r: ContentRect): boolean => {
    if (r.full) return true;
    const insets = [
      r.x / width,
      r.y / height,
      (width - (r.x + r.w)) / width,
      (height - (r.y + r.h)) / height,
    ];
    if (insets.every((f) => f < MATERIAL_INSET_FRAC)) return true;
    const areaFrac = (r.w * r.h) / (width * height);
    const aspectDelta = Math.abs(r.w / r.h - frameAspect) / frameAspect;
    return areaFrac >= MATERIAL_AREA_FRAC && aspectDelta < MATERIAL_ASPECT_TOL;
  };

  const segs = timeline.map((s) => ({
    startSec: s.startSec,
    endSec: s.endSec,
    rect: immaterial(s.rect) ? whole : s.rect,
  }));

  // Duration of each segment's whole CLASS — the outlier that motivated this
  // appeared as one contiguous run, but a strip flickering in and out would
  // split into several, and each alone dodging the threshold must not let the
  // class as a whole survive.
  const classTotals = (list: typeof segs): number[] => {
    const reps: ContentRect[] = [];
    const totals: number[] = [];
    const ids = list.map((s) => {
      let id = reps.findIndex((r) => sameFraming(r, s.rect, width, height));
      if (id === -1) {
        id = reps.length;
        reps.push(s.rect);
        totals.push(0);
      }
      totals[id]! += s.endSec - s.startSec;
      return id;
    });
    return ids.map((id) => totals[id]!);
  };

  // Absorb, then retry until stable: dropping one segment changes its
  // neighbours' class totals and can make them adjacent and mergeable.
  let changed = true;
  while (changed && segs.length > 1) {
    changed = false;
    const totals = classTotals(segs);
    for (let i = 0; i < segs.length; i++) {
      if (totals[i]! >= MIN_FRAMING_CLASS_FRAC * durationSec) continue;
      const r = segs[i]!;
      // Absorb into the LONGER neighbour — the one more likely to be the truth.
      const prev = segs[i - 1];
      const next = segs[i + 1];
      const into = !prev
        ? next
        : !next
          ? prev
          : prev.endSec - prev.startSec >= next.endSec - next.startSec
            ? prev
            : next;
      if (!into) continue;
      into.startSec = Math.min(into.startSec, r.startSec);
      into.endSec = Math.max(into.endSec, r.endSec);
      segs.splice(i, 1);
      changed = true;
      break;
    }
  }

  // Merge neighbours that now agree, so a source whose every segment was
  // reclassified collapses to the single-segment (uniform) shape callers test.
  const merged: typeof segs = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && sameFraming(last.rect, s.rect, width, height)) {
      last.endSec = Math.max(last.endSec, s.endSec);
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

/**
 * The exact framing-change instant inside a densely-sampled window
 * (NORMALIZE plan, boundary refinement).
 *
 * The coarse timeline places a boundary midway between two 2 Hz samples —
 * ±0.25s of slack, which was fine while the boundary only steered a render-
 * time crop but is not fine once segments are BAKED: every frame on the wrong
 * side of a baked boundary is cropped with the wrong window, and a quarter
 * second of bar-edged frames at each of nine boundaries is exactly the class
 * of artifact the bake exists to remove.
 *
 * Given per-frame samples spanning the coarse boundary, this finds the gap
 * between the last frame still framed like `before` and the first framed like
 * `after`, and returns its midpoint. Frames matching neither (transition
 * wipes, encoder smear) are skipped. Null — keep the coarse boundary — when
 * the window never actually straddles the change.
 */
export function pickTransition(
  samples: readonly CropSample[],
  before: ContentRect,
  after: ContentRect,
  width: number,
  height: number,
): number | null {
  let lastBefore: number | null = null;
  for (const s of [...samples].sort((a, b) => a.tSec - b.tSec)) {
    const rect = stableContentRect([s], width, height);
    if (sameFraming(rect, before, width, height)) {
      lastBefore = s.tSec;
    } else if (sameFraming(rect, after, width, height)) {
      // The first after-framed frame only counts once a before-framed frame
      // has been seen — otherwise the window started past the change and the
      // "transition" would be an artifact of where the window was cut.
      return lastBefore === null ? null : (lastBefore + s.tSec) / 2;
    }
  }
  return null;
}

/**
 * The content rect active at a SOURCE time. Half-open, so a boundary belongs to
 * the segment starting there. Times outside the timeline clamp to its ends
 * rather than falling back to the full frame — a clamp keeps a rounding error
 * at a boundary from flashing the bars back on for one frame.
 */
export function contentRectAt(
  timeline: readonly ContentRectSegment[],
  tSec: number,
  frame?: { width: number; height: number },
): ContentRect {
  if (timeline.length === 0) {
    return { x: 0, y: 0, w: frame?.width ?? 0, h: frame?.height ?? 0, full: true };
  }
  if (tSec < timeline[0]!.startSec) return timeline[0]!.rect;
  for (const seg of timeline) {
    if (tSec >= seg.startSec && tSec < seg.endSec) return seg.rect;
  }
  return timeline[timeline.length - 1]!.rect;
}

/** The ffmpeg `crop=` filter string for a rect (no-op rects return ""). */
export function cropFilter(rect: ContentRect | null | undefined): string {
  if (!rect || rect.full) return "";
  return `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`;
}
