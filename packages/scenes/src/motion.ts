/**
 * The layer's motion constants and the one curve every animated thing in the
 * render shares. One module rather than per-file literals so the entrance,
 * the exit, and the caption pop cannot drift onto different curves — the
 * design's "reads as designed" claim (R16 §69) depends on them agreeing.
 */

/** Seconds a graphic spends arriving. Mirrors EXIT_SEC — one number, both ends. */
export const ENTER_SEC = 0.3;

/** Seconds a graphic spends leaving. Matches LAYOUT_TRANSITION_SEC's order of
 * magnitude so the graphic departs WITH the video slot's morph — the reported
 * failure was the split view closing first and the card then blinking out. */
export const EXIT_SEC = 0.3;

/**
 * Seconds the caption's active word takes to reach its 1.08 emphasis. Four
 * frames at 30fps: the original CSS transition said 60ms, which is 1.8
 * frames — honouring it exactly would still read as a step.
 */
export const CAPTION_POP_SEC = 0.133;

/** The exit's existing ease — fast start, soft landing. */
export const easeOutQuad = (p: number): number => p * (2 - p);

/**
 * The entrance and exit seconds for a cue, shrunk proportionally when the cue
 * is too short to hold both. Resolved together rather than clamped
 * independently: two independent clamps can still sum past the duration, and
 * the failure that produces — entrance and exit overlapping, their opacities
 * multiplying into a dip halfway through a graphic's life — is invisible in
 * a still and obvious in motion.
 */
export function entranceExitSec(
  durationSec: number,
  enterSec: number = ENTER_SEC,
  exitSec: number = EXIT_SEC,
): { enterSec: number; exitSec: number } {
  if (durationSec <= 0) return { enterSec: 0, exitSec: 0 };
  const total = enterSec + exitSec;
  if (total <= durationSec) return { enterSec, exitSec };
  const k = durationSec / total;
  return { enterSec: enterSec * k, exitSec: exitSec * k };
}

// ---------------------------------------------------------------------------
// The explainer look's motion (§161). Everything below is a pure function of
// `t`, seconds since the item's own start, and nothing here is a spring or a
// hook: a component computes `t` from its one `useCurrentFrame()` and passes
// it in, so a still at frame N is the same pixels on every run (the stills
// harness and the "byte-identical classic frames" check in plan Task 8 both
// rest on that). Components use these only under `theme.motion ===
// "explainer"`; the classic look keeps anim.ts's springs unchanged.
// ---------------------------------------------------------------------------

const clamp01 = (p: number): number => (p <= 0 ? 0 : p >= 1 ? 1 : p);

/**
 * easeOutBack: 0→0, 1→1, peaking about 10% past 1 around 70% of the way.
 * The same curve as anim.ts's private `overshoot`, restated here rather than
 * imported because anim.ts pulls in remotion and this module is the
 * dependency-free one the tests read without a Remotion runtime.
 */
const easeOutBack = (p: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const q = p - 1;
  return 1 + c3 * q ** 3 + c1 * q ** 2;
};

/**
 * The playbook's pop entrance as a scale: 0 at `t ≤ 0`, overshooting on the
 * way, and EXACTLY 1 from `durSec` on. The two ends are returned as literals,
 * not computed: easeOutBack(1) is 1 only up to float error, and a settled
 * card drawn at scale(0.9999999) is a re-rasterised, faintly soft card.
 */
export function popScale(t: number, durSec = 0.35): number {
  if (t <= 0) return 0;
  if (t >= durSec) return 1;
  return easeOutBack(t / durSec);
}

/**
 * Symmetric ease (in-out quad), 0 at `t ≤ 0` and 1 at `t ≥ durSec`. A zero
 * duration is "already arrived", not a division by zero — the
 * `entranceExitSec` posture: a degenerate input renders static, never NaN.
 */
export function easeInOut(t: number, durSec: number): number {
  if (durSec <= 0) return t >= 0 ? 1 : 0;
  const p = clamp01(t / durSec);
  if (p === 0 || p === 1) return p;
  return p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
}

/**
 * Characters of a typed line visible at `t`: an integer from 0 to `total`,
 * at `cps` characters a second (the playbook's terminal speed). The epsilon
 * is for frame times: `t` arrives as frame / fps, and a quotient that lands a
 * hair under a whole character would drop that character for a frame.
 */
export function typedChars(t: number, total: number, cps = 32): number {
  if (t <= 0 || total <= 0) return 0;
  return Math.min(total, Math.floor(t * cps + 1e-9));
}

/** The block caret's blink: on for the first 0.5 s of every second. */
export function caretOn(t: number): boolean {
  const phase = ((t % 1) + 1) % 1;
  return phase < 0.5;
}

/**
 * A slow vertical drift in px, a sine of `amplitude` over `periodSec`, so an
 * idle phone frame or sticker reads as alive rather than frozen. 0 at t = 0,
 * so the item lands where its entrance put it.
 */
export function bobPx(t: number, amplitude = 7, periodSec = 2.4): number {
  return amplitude * Math.sin((2 * Math.PI * t) / periodSec);
}

/**
 * A one-shot emphasis scale, 1 → 1.15 → 1 over `durSec` (a button press, a
 * highlighted card). Exactly 1 outside the window, for popScale's reason.
 */
export function bump(t: number, durSec = 0.3): number {
  if (t <= 0 || t >= durSec) return 1;
  return 1 + 0.15 * Math.sin(Math.PI * (t / durSec));
}

/**
 * Start times of `count` items built one per beat, for a component with no
 * word timings to sync them to: the first at `firstSec`, then every `gapSec`.
 */
export function beatStarts(count: number, gapSec = 0.7, firstSec = 0.25): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => firstSec + i * gapSec);
}

/** A stat string split into what counts up and what stays put. */
export interface ParsedCount {
  /** "+", "-" or "" — kept whole through the count, never counted. */
  prefix: string;
  /** The magnitude, without sign, groups or suffix. */
  number: number;
  /** Digits after the point in the source, kept on every frame. */
  decimals: number;
  /** "%", "x", "×", "k", "K", "M", "s" or "". */
  suffix: string;
  /** The source wrote thousands groups ("4,494"), so every frame does. */
  grouped: boolean;
}

/**
 * Integer part with no leading zero (bare "0" allowed), or comma groups of
 * exactly three after a 1-3 digit head. Narrower than "digits and commas" on
 * purpose: `countAt` must END on the source string, and "007" or "1,23" would
 * count up to "7" and "123" — a stat that changes on its last frame.
 */
const COUNT_RE = /^([+-]?)((?:[1-9]\d{0,2}(?:,\d{3})+)|0|[1-9]\d*)(?:\.(\d+))?(%|x|×|k|K|M|s)?$/;

/**
 * `value` as a count-up, or null when it is not one: a leading symbol
 * ("×3"), a unit word ("5 min"), or anything `countAt` could not reproduce
 * exactly. Null is the caller's cue to draw the string as written — the
 * StatCard renders as today (plan Task 8).
 */
export function parseCount(value: string): ParsedCount | null {
  const m = COUNT_RE.exec(value);
  if (!m) return null;
  const [, prefix = "", intPart = "", frac, suffix = ""] = m;
  const digits = intPart.replace(/,/g, "") + (frac ? `.${frac}` : "");
  return {
    prefix,
    number: Number(digits),
    decimals: frac ? frac.length : 0,
    suffix,
    grouped: intPart.includes(","),
  };
}

const formatCount = (n: number, decimals: number, grouped: boolean): string => {
  const fixed = n.toFixed(decimals);
  if (!grouped) return fixed;
  const [int = "", frac] = fixed.split(".");
  const withGroups = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac === undefined ? withGroups : `${withGroups}.${frac}`;
};

/**
 * The count at `t`: 0 up to the parsed number over `durSec`, on the layer's
 * shared `easeOutQuad` (fast, then settling — the same curve as the exit, the
 * header's one-curve rule), formatted with the source's sign, groups,
 * decimals and suffix. Mid-count values are FLOORED at the source's
 * precision so the display never shows the target early and never steps
 * back; from `durSec` on it is the parsed number itself, which `COUNT_RE`
 * guarantees formats back to the source string.
 */
export function countAt(parsed: ParsedCount, t: number, durSec = 1.0): string {
  const { prefix, number, decimals, suffix, grouped } = parsed;
  let n = number;
  if (t < durSec) {
    const scale = 10 ** decimals;
    const eased = easeOutQuad(clamp01(durSec <= 0 ? 1 : t / durSec));
    n = Math.min(number, Math.floor(number * eased * scale + 1e-9) / scale);
  }
  return `${prefix}${formatCount(n, decimals, grouped)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Entrances for drawn scenes (§167). A drawn scene gets seconds from the
// kit's `useSceneTime()` and places each element's entrance at its own
// `startSec`; anim.ts's `fade`/`rise` take a spring progress the scene has
// no frame-based spring to produce, so these restate them in seconds. Both
// ride the layer's shared `easeOutQuad` (the header's one-curve rule) and
// clamp, so the last state holds to the end of the scene at any length.
// ---------------------------------------------------------------------------

/**
 * Progress 0→1 over `durSec` from `startSec`, with both ends returned as
 * literals (popScale's reason: a settled element must be exactly settled).
 * A zero duration is "already arrived" at `startSec`, easeInOut's posture.
 */
const entranceAt = (t: number, startSec: number, durSec: number): number => {
  const local = t - startSec;
  if (durSec <= 0) return local >= 0 ? 1 : 0;
  if (local <= 0) return 0;
  if (local >= durSec) return 1;
  return easeOutQuad(local / durSec);
};

/** Opacity 0 → 1 from `startSec` over `durSec` seconds; by default the
 * layer's own ENTER_SEC, so a drawn fade arrives as fast as a graphic does. */
export function fadeIn(t: number, startSec: number, durSec = ENTER_SEC): number {
  return entranceAt(t, startSec, durSec);
}

/**
 * A y offset in px, from `px` below its place to exactly 0, from `startSec`
 * over `durSec` seconds. 26 px is anim.ts's `rise` default, so a drawn
 * scene's rise travels as far as a pattern scene's. Returned as a number,
 * not anim.ts's style object: the scene composes it into its own transform.
 */
export function riseIn(t: number, startSec: number, durSec = 0.35, px = 26): number {
  const p = entranceAt(t, startSec, durSec);
  return p === 1 ? 0 : px * (1 - p);
}
