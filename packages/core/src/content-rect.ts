
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
