import React from "react";
import {
  AbsoluteFill,
  Sequence,
  continueRender,
  delayRender,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  captionAnchorOf,
  captionsNeedNastaliq,
  lineDirection,
  NASTALIQ_FONT_NAME,
  NASTALIQ_FONT_REL,
  type CaptionLine,
  type CaptionPhraseRole,
  type CaptionThemeId,
  type FaceCrop,
  type SceneCue,
  type Theme,
} from "@ossclip/core/browser";
import {
  activeCueAt,
  captionFontSizeFor,
  DEFAULT_FACE,
  freeBands,
  headBand,
  safeAreaFor,
  type FrameSize,
} from "./stage";
import { frameWindow } from "./frames";
import { captionAnchorAvoiding, regionsDuring, type OccupiedRegion } from "./source-fit";
import { CAPTION_POP_SEC, easeOutQuad } from "./motion";
import { captionThemeFor, resolveCaptionThemeSpec } from "./caption-themes";

export interface CaptionTrackProps {
  lines: CaptionLine[];
  /** Scene cues, for layout-aware anchoring/visibility. Empty = always visible. */
  cues?: SceneCue[];
  /** Vertical center of the caption block, as a fraction of frame height. */
  verticalAnchor?: number;
  /** Explicit size wins outright; unset = frame-derived (`captionFontSizeFor`). */
  fontSizePx?: number;
  activeColor?: string;
  /**
   * Design tokens for the caption type (F6, 2026-08-16): `fontDisplay` and
   * `fg` replace the historical literals so a config theme reaches the
   * captions. Optional and absent-means-the-old-literals (`captionTypography`)
   * so pre-theme callers and render-props render unchanged.
   */
  theme?: Theme;
  /**
   * The comment-CTA word: at the moment it is ASKED FOR, the caption word
   * renders quoted and capitalized — reinforcing the ask for muted viewers
   * (FINDINGS §16).
   */
  ctaKeyword?: string;
  /**
   * When the ask is on screen, in output seconds — the CTA cue's own window.
   * Required for the treatment to apply at all: quoting marks *the word you
   * type in the comments*, so styling every ordinary use of it (nine times in
   * one take) inverts the meaning and devalues the real ask (FINDINGS §22).
   */
  ctaWindow?: { startSec: number; endSec: number };
  /**
   * Bands where the SOURCE already has burned-in text. Captions relocate to
   * clear them but are NEVER hidden — they are the accessibility layer, so a
   * crowded caption still beats a missing one (FINDINGS §26).
   */
  sourceTextRegions?: OccupiedRegion[];
  /**
   * Output-time windows in which NO caption line renders — a full-screen
   * overlay card's (overlay-library spec §Rendering, card look). The card is
   * the one look allowed to hide the captions, and hiding beats drawing them
   * on top of a black card that exists to be the whole frame. Optional and
   * absent-means-none, so every existing caller renders unchanged.
   */
  hideDuring?: { start: number; end: number }[];
  /** Visual caption theme preset (--caption-theme). Absent or "default" = historical styling. */
  captionTheme?: CaptionThemeId;
  /** Measured speaker face box, for hook/impact safe-zone placement. */
  face?: FaceCrop | null;
  /** Whether the top-right watermark is rendered, so hook captions clear its top band. */
  watermark?: boolean;
}

/** The anchor a caption block centres on when no cue says otherwise. */
export const DEFAULT_CAPTION_ANCHOR = 0.76;

/**
 * A caption word may sit slightly outside the cue that carries the ask — the
 * cue starts at its anchor's first word, and speech runs on either side. The
 * window is narrow enough that a near miss is glaring and the next occurrence
 * of the word is seconds away, so a small pad is free insurance.
 */
const CTA_WINDOW_PAD_SEC = 0.4;

/** `agents.` → `"AGENTS".` — quote-and-caps the word, punctuation kept outside. */
export function ctaDisplay(text: string, keyword: string | undefined): string {
  if (!keyword) return text;
  const core = text.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  if (core.toLowerCase() !== keyword.toLowerCase()) return text;
  return text.replace(core, `"${core.toUpperCase()}"`);
}

/** Is this caption word inside the CTA moment? No window ⇒ no treatment. */
export function inCtaWindow(
  startSec: number,
  window: { startSec: number; endSec: number } | undefined,
): boolean {
  if (!window) return false;
  return (
    startSec >= window.startSec - CTA_WINDOW_PAD_SEC &&
    startSec <= window.endSec + CTA_WINDOW_PAD_SEC
  );
}

/** The size a line renders at: an explicit prop wins outright, else the frame default. */
export function resolveCaptionFontSize(
  fontSizePx: number | undefined,
  frame: FrameSize,
): number {
  return fontSizePx ?? captionFontSizeFor(frame);
}

/**
 * Stroke width for a caption font size. The historical 10px stroke was tuned
 * against 64px portrait type; fixed at 10 it swallows the smaller landscape
 * letterforms (44px default, 2026-08-16), so it rides the font instead.
 * Portrait output is byte-identical: 64 → 10.
 */
export function captionStrokePx(fontSizePx: number): number {
  return (fontSizePx * 10) / 64;
}

/**
 * Caption typography from the theme (F6, 2026-08-16). The fallbacks ARE the
 * historical literals, so a themeless caller (pre-theme render-props, the
 * editor before it passes one) renders byte-identically — and the default
 * theme differs from them only in spelling white as #FFFFFF, the same color.
 * The stroke's rgba is deliberately NOT themed: it is an outline for
 * contrast against arbitrary video, not a palette color, and a light theme
 * fg with a theme-matched light stroke would erase caption legibility.
 * Pure — the theme prop's honored/absent matrix is testable without Remotion.
 */
export function captionTypography(theme: Theme | undefined): {
  fontFamily: string;
  color: string;
} {
  return {
    fontFamily:
      theme?.fontDisplay ?? "'Inter', 'Helvetica Neue', 'Arial Black', Arial, sans-serif",
    color: theme?.fg ?? "white",
  };
}

/**
 * Per-line font stack (bundled Nastaliq, 2026-08-17). An RTL line leads with
 * the bundled Noto Nastaliq Urdu; an LTR line keeps the resolved base stack
 * BYTE-IDENTICAL, so Latin captions cannot change appearance. PREPENDED, not
 * replacing: a config theme's `fontDisplay` (F6) stays the rest of the stack,
 * so an RTL line still falls back to the user's own fonts for anything
 * Nastaliq lacks. Within an RTL line, embedded Latin loanwords and digits DO
 * render in Nastaliq's own Latin glyphs (verified against the v3.007 TTF's
 * cmap: A–z and 0–9 are covered) — accepted, since one face per line keeps
 * the weight consistent through a code-switched Urdu line.
 */
export function captionFontFamilyFor(
  direction: "rtl" | "ltr",
  baseFontFamily: string,
): string {
  return direction === "rtl" ? `'${NASTALIQ_FONT_NAME}', ${baseFontFamily}` : baseFontFamily;
}

/**
 * Per-line line-height. Nastaliq's diagonal stacking runs far above and below
 * the Latin baseline — the bundled face declares ascender−descender = 2.5×
 * its em (read from the v3.007 TTF's hhea table; Inter is ~1.2×) — so at the
 * historical 1.15 a wrapped Urdu line's stacks collide with the row beneath.
 * RTL lines get 1.9: glyphs are never CLIPPED (nothing here sets
 * overflow:hidden — the box is just spacing), and most caption lines are a
 * single ≤3-word row, so going all the way to the font's own 2.5 would only
 * push a rare two-row line out of its safe-area band. LTR lines keep 1.15,
 * the byte-identical historical value.
 */
export function captionLineHeightFor(direction: "rtl" | "ltr"): number {
  return direction === "rtl" ? 1.9 : 1.15;
}

/**
 * Where one caption line's block centres, and the size multiplier it renders
 * at — the anchor chain CaptionTrack runs per line, pulled out so the overlay
 * track places itself against the caption's ACTUAL position rather than a
 * second, drifting copy of the chain (overlay-library spec §Rendering: plain
 * `captionAnchorAt` ignores hand moves and would cover captions).
 *
 * The chain, resolved from the cue the line STARTS under:
 * - a hand-set per-scene anchor (R15 §56) wins outright — like every other
 *   hand edit, the user's placement is a decision, not an input to the
 *   avoidance search;
 * - otherwise ONE rect-aware path for every line (R11 Task 2b). The old
 *   split — `captionAnchorAvoiding` only when the source had burned-in text,
 *   the pure layout anchor otherwise — meant a hand-moved graphic box
 *   silently sat on top of the captions on a clean source, the common case.
 *   With no regions and no moved rect this resolves to exactly the layout
 *   anchor the old branch returned;
 * - with neither cues nor regions, the caller's `verticalAnchor`.
 *
 * `scale` is the per-scene size multiplier (R16 §64), resolved per line like
 * the anchor.
 */
/** Minimum vertical band height (in frame fractions) required to place a hook/impact caption. */
const MIN_HOOK_BAND_H = 0.14;

/**
 * Resolve a safe-zone anchor for a choreographed `"hook"` or `"impact"` line
 * using the measured speaker `FaceCrop`, `headBand`, and `freeBands`.
 * Returns `null` whenever choreography cannot safely place the line (no face,
 * screen subject, graphic cue, or no free band >= 0.14), falling through to
 * standard `captionAnchorAvoiding`.
 */
export function resolveChoreographedAnchor(
  line: { start: number; end: number; role?: CaptionPhraseRole },
  activeCue: SceneCue | null,
  face: FaceCrop | null | undefined,
  sourceTextRegions: readonly OccupiedRegion[],
  frame: FrameSize,
  watermark?: boolean,
): number | null {
  if (line.role !== "hook" && line.role !== "impact") return null;
  if (!face || face.subject === "screen") return null;
  if (activeCue !== null && !(activeCue.kind === "plain" && activeCue.layout === "full-bleed")) {
    return null;
  }

  const safe = safeAreaFor(frame);
  const head = headBand({
    centerYFrac: face.centerYFrac,
    sizeFrac: face.sizeFrac ?? DEFAULT_FACE.sizeFrac,
  });

  const activeRegions = regionsDuring(sourceTextRegions, line.start, line.end);
  const blocked: Array<{ y: number; h: number }> = [
    { y: head.start, h: Math.max(0, head.end - head.start) },
    ...activeRegions.map((r) => ({ y: r.y, h: r.h })),
  ];
  if (watermark === true) {
    blocked.push({ y: safe.top, h: 0.06 });
  }

  const bands = freeBands({ start: safe.top, end: 1 - safe.bottom }, blocked);
  const clampAnchor = (a: number): number =>
    Math.min(1 - safe.bottom - 0.06, Math.max(safe.top + 0.06, a));

  if (line.role === "hook") {
    const upper = bands.find(
      (b) => b.end <= head.start + 1e-4 && b.end - b.start >= MIN_HOOK_BAND_H,
    );
    if (upper) return clampAnchor((upper.start + upper.end) / 2);
  }

  const lower = bands.find(
    (b) => b.start >= head.end - 1e-4 && b.end - b.start >= MIN_HOOK_BAND_H,
  );
  if (lower) return clampAnchor((lower.start + lower.end) / 2);

  return null;
}

export function captionAnchorForLine(
  cues: readonly SceneCue[],
  sourceTextRegions: readonly OccupiedRegion[],
  line: { start: number; end: number; role?: CaptionPhraseRole },
  frame: FrameSize,
  verticalAnchor: number,
  face?: FaceCrop | null,
  watermark?: boolean,
): { anchor: number; scale: number } {
  const active = cues.length > 0 ? activeCueAt(cues, line.start) : null;
  if (active?.captionY !== undefined) {
    return { anchor: active.captionY, scale: active.captionScale ?? 1 };
  }
  const choreoAnchor = resolveChoreographedAnchor(
    line,
    active,
    face,
    sourceTextRegions,
    frame,
    watermark,
  );
  if (choreoAnchor !== null) {
    return { anchor: choreoAnchor, scale: active?.captionScale ?? 1 };
  }
  const anchor =
    cues.length > 0 || sourceTextRegions.length > 0
      ? captionAnchorAvoiding(
          active?.layout ?? "full-bleed",
          regionsDuring(sourceTextRegions, line.start, line.end),
          active?.graphicRect,
          frame,
        )
      : verticalAnchor;
  return { anchor, scale: active?.captionScale ?? 1 };
}

/**
 * Whether an ABSOLUTE frame falls inside any hide window. In frames, not
 * seconds, and through `frameWindow`'s own rounding: the card that asked for
 * the window is a `<Sequence>` built from the same `frameWindow`, so a
 * seconds comparison could leave one frame with the caption drawn over the
 * card's first (or after its last) frame — §115's off-by-one, here as a
 * caption flash.
 */
export function hiddenAtFrame(
  absFrame: number,
  windows: readonly { start: number; end: number }[],
  fps: number,
): boolean {
  return windows.some((w) => {
    const { from, durationInFrames } = frameWindow(w.start, w.end, fps);
    return absFrame >= from && absFrame < from + durationInFrames;
  });
}

/**
 * Average advance of a caption glyph, in ems — an ESTIMATE, deliberately on
 * the wide side. The render has no text measurement this side of the DOM
 * (and a measured layout would need a second render pass per frame), so the
 * row count is estimated. The only consumer is the overlay's "sit above the
 * caption block" rule, where over-counting rows just lifts the overlay a
 * little higher and under-counting would put it ON the captions — so the
 * error is pushed to the harmless side: Inter at weight 900 averages well
 * under this for mixed case.
 */
const CAPTION_CHAR_EM = 0.66;
/** The word gap LineView lays out with (`gap: "0.28em"`). */
const CAPTION_WORD_GAP_EM = 0.28;

/**
 * How many rows a caption line wraps to inside the safe-area padding, by a
 * greedy fill like `flex-wrap`'s. Always ≥ 1 — an empty line still owns its
 * line box.
 */
export function estimateCaptionRows(
  words: readonly string[],
  fontSizePx: number,
  availableWidthPx: number,
  wordScales?: readonly number[],
  uppercase?: boolean,
): number {
  let rows = 1;
  let used = 0;
  const caseMult = uppercase ? 1.12 : 1;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const scale = wordScales?.[i] ?? 1;
    const w = word.length * CAPTION_CHAR_EM * fontSizePx * scale * caseMult;
    const next = used === 0 ? w : used + CAPTION_WORD_GAP_EM * fontSizePx + w;
    if (used > 0 && next > availableWidthPx) {
      rows += 1;
      used = w;
    } else {
      used = next;
    }
  }
  return rows;
}

export interface CaptionGeometryOpts {
  cues?: readonly SceneCue[];
  sourceTextRegions?: readonly OccupiedRegion[];
  frame: FrameSize;
  verticalAnchor?: number;
  fontSizePx?: number;
  captionTheme?: CaptionThemeId;
  face?: FaceCrop | null;
  watermark?: boolean;
}

/**
 * One line's caption block as `{top, bottom}` fractions of frame height:
 * `anchor ∓ rows × lineHeight / 2`. The block is centred on its anchor
 * (`translateY(-50%)`), and the line height is the one LineView renders with
 * — `captionLineHeightFor(direction)` × the resolved, scene-scaled font — so
 * this cannot disagree with the caption's own box except through the row
 * estimate above (which errs tall, so both edges err outward — the harmless
 * side for an overlay dodging either one).
 */
function captionBlockExtent(line: CaptionLine, opts: CaptionGeometryOpts): { top: number; bottom: number } {
  const { frame } = opts;
  const { anchor, scale } = captionAnchorForLine(
    opts.cues ?? [],
    opts.sourceTextRegions ?? [],
    line,
    frame,
    opts.verticalAnchor ?? DEFAULT_CAPTION_ANCHOR,
    opts.face,
    opts.watermark,
  );
  const baseFontPx = resolveCaptionFontSize(opts.fontSizePx, frame) * scale;
  const texts = line.words.map((w) => w.text);
  const direction = lineDirection(texts.join(" "));
  const themeSpec = resolveCaptionThemeSpec(opts.captionTheme, undefined, direction, baseFontPx);
  const fontPx = baseFontPx * themeSpec.fontScale;
  const wordScales = line.words.map((w) => w.emphasisScale ?? 1);
  const maxWordScale = wordScales.reduce((m, s) => Math.max(m, s), 1);
  const safe = safeAreaFor(frame);
  const rows = estimateCaptionRows(
    texts,
    fontPx,
    frame.width * (1 - safe.left - safe.right),
    wordScales,
    themeSpec.textTransform === "uppercase",
  );
  const half =
    (rows * ((fontPx * maxWordScale * captionLineHeightFor(direction)) / frame.height)) / 2;
  return { top: anchor - half, bottom: anchor + half };
}

/** The TOP of one line's caption block, as a fraction of frame height (`captionBlockExtent`). */
export function captionBlockTop(line: CaptionLine, opts: CaptionGeometryOpts): number {
  return captionBlockExtent(line, opts).top;
}

/**
 * The BOTTOM of one line's caption block — the mirror of `captionBlockTop`,
 * for the overlay's band below a caption hand-moved high (ruling R19).
 */
export function captionBlockBottom(line: CaptionLine, opts: CaptionGeometryOpts): number {
  return captionBlockExtent(line, opts).bottom;
}

/**
 * `tSec → the highest caption top on screen`, or null when no line is. The
 * highest, because two lines can share a frame at a cue boundary (§115) and
 * the overlay must clear both.
 */
export function captionTopAtFor(
  lines: readonly CaptionLine[],
  opts: CaptionGeometryOpts,
): (tSec: number) => number | null {
  return (tSec) => {
    let top: number | null = null;
    for (const line of lines) {
      if (tSec < line.start || tSec >= line.end) continue;
      const t = captionBlockTop(line, opts);
      top = top === null ? t : Math.min(top, t);
    }
    return top;
  };
}

/**
 * `tSec → the LOWEST caption bottom on screen`, or null when no line is —
 * `captionTopAtFor`'s mirror (ruling R19): an overlay placed below the
 * captions must clear every line sharing the frame.
 */
export function captionBottomAtFor(
  lines: readonly CaptionLine[],
  opts: CaptionGeometryOpts,
): (tSec: number) => number | null {
  return (tSec) => {
    let bottom: number | null = null;
    for (const line of lines) {
      if (tSec < line.start || tSec >= line.end) continue;
      const b = captionBlockBottom(line, opts);
      bottom = bottom === null ? b : Math.max(bottom, b);
    }
    return bottom;
  };
}

/**
 * Registers the bundled Nastaliq face for this render. FontFace + delayRender
 * rather than a <style> @font-face: the render seeks and screenshots, so a
 * lazily-fetched stylesheet font can miss the first captioned frames — the
 * same no-wall-clock reasoning as the word-pop animation above. Mounted only
 * when a line actually lays out RTL (`captionsNeedNastaliq`, the predicate
 * produce's font copy shares), so pure-Latin runs fetch nothing. A load
 * FAILURE continues the render on the fallback stack instead of cancelling:
 * captions are the accessibility layer, and a wrong font still beats a dead
 * render.
 */
const NastaliqFontLoader: React.FC = () => {
  const [handle] = React.useState(() => delayRender(`load ${NASTALIQ_FONT_NAME}`));
  React.useEffect(() => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        continueRender(handle);
      }
    };
    const face = new FontFace(
      NASTALIQ_FONT_NAME,
      `url("${staticFile(NASTALIQ_FONT_REL)}") format("truetype")`,
      // The captions render at fontWeight 900; declaring the (nominally 700)
      // Bold face AS 900 makes it the exact match there, so the browser never
      // synthetic-bolds Nastaliq's already-dense strokes on top.
      { weight: "900" },
    );
    face.load().then((loaded) => {
      document.fonts.add(loaded);
      finish();
    }, finish);
    return finish;
  }, [handle]);
  return null;
};

const LineView: React.FC<{
  line: CaptionLine;
  /** This line's first word's index in the WHOLE caption stream — the id the
   * editor's retype override keys on (`OverrideDoc.captions`). */
  wordOffset: number;
  verticalAnchor: number;
  fontSizePx: number;
  activeColor: string;
  /** Resolved by `captionTypography` in the parent — one resolution per track. */
  fontFamily: string;
  textColor: string;
  ctaKeyword?: string;
  ctaWindow?: { startSec: number; endSec: number };
  /** The line's Sequence start, so a hide window can be tested in absolute frames. */
  fromFrame: number;
  hideDuring?: { start: number; end: number }[];
  /** Visual caption theme preset (--caption-theme). Absent or "default" = historical styling. */
  captionTheme?: CaptionThemeId;
  theme?: Theme;
}> = ({
  line,
  wordOffset,
  verticalAnchor,
  fontSizePx,
  activeColor,
  fontFamily,
  textColor,
  ctaKeyword,
  ctaWindow,
  fromFrame,
  hideDuring,
  captionTheme,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  // A card owns the frame (overlay-library spec §Rendering, card look).
  // Checked after the hooks, so a line entering a window mid-sequence keeps
  // React's hook order.
  if (hideDuring && hiddenAtFrame(fromFrame + frame, hideDuring, fps)) return null;
  const safeArea = safeAreaFor({ width, height });
  // The parent <Sequence> starts at line.start, so local frame 0 === line.start.
  const t = line.start + frame / fps;
  // Per-line, from the text itself (first-strong, see lineDirection): Urdu
  // captions were laying out LTR (Urdu field test 2026-08-05). On the flex
  // row `direction: rtl` reverses the VISUAL order of the word spans and the
  // wrap direction; the highlight below is keyed to each word's own
  // start/end times, not to position, so it still walks in spoken order.
  // Mixed runs INSIDE a word (Latin, digits) are the browser's bidi to
  // resolve against this direction — never hand-reordered here.
  const direction = lineDirection(line.words.map((w) => w.text).join(" "));
  const resolvedThemeId = captionThemeFor(captionTheme);
  const hasEmphasis = line.words.some((w) => (w.emphasisScale ?? 1) > 1);

  // Byte-identical fast path for the default theme without word emphasis so
  // every pre-existing DOM snapshot and pixel test stays unchanged.
  if (resolvedThemeId === "default" && !hasEmphasis) {
    return (
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <div
          style={{
            position: "absolute",
            top: `${verticalAnchor * 100}%`,
            left: 0,
            right: 0,
            transform: "translateY(-50%)",
            direction,
            display: "flex",
            justifyContent: "center",
            gap: "0.28em",
            flexWrap: "wrap",
            // Keep caption text clear of the platform's right-hand action rail.
            paddingLeft: `${safeArea.left * 100}%`,
            paddingRight: `${safeArea.right * 100}%`,
            // Direction-keyed (bundled Nastaliq, 2026-08-17): RTL lines lead
            // with the bundled face and get its deeper line box; LTR lines are
            // byte-identical to before — see the two helpers for the metrics.
            fontFamily: captionFontFamilyFor(direction, fontFamily),
            fontWeight: 900,
            fontSize: fontSizePx,
            lineHeight: captionLineHeightFor(direction),
            textAlign: "center",
            color: textColor,
            WebkitTextStroke: `${captionStrokePx(fontSizePx)}px rgba(0,0,0,0.85)`,
            paintOrder: "stroke fill",
            // Shadow blur rides the font for the same reason as the stroke
            // (portrait byte-identical: 64 → 24).
            textShadow: `0 4px ${(fontSizePx * 24) / 64}px rgba(0,0,0,0.55)`,
          }}
        >
          {line.words.map((w, i) => {
            const held = Math.max(w.end, w.start + 0.12);
            const inWindow = t >= w.start && t <= held;
            const p = inWindow ? Math.min(1, (t - w.start) / CAPTION_POP_SEC) : 0;
            const pop = easeOutQuad(p);
            return (
              <span
                key={i}
                data-caption-word={wordOffset + i}
                data-caption-text={w.text}
                data-caption-src={captionAnchorOf(w) === null ? undefined : w.srcStart}
                style={{
                  display: "inline-block",
                  pointerEvents: "auto",
                  transform: pop > 0 ? `scale(${1 + 0.08 * pop})` : "scale(1)",
                  color: inWindow ? activeColor : textColor,
                }}
              >
                {ctaDisplay(w.text, inCtaWindow(w.start, ctaWindow) ? ctaKeyword : undefined)}
              </span>
            );
          })}
        </div>
      </AbsoluteFill>
    );
  }

  const themeSpec = resolveCaptionThemeSpec(
    resolvedThemeId,
    theme ?? { accent: activeColor },
    direction,
    fontSizePx,
  );
  const scaledFontPx = fontSizePx * themeSpec.fontScale;
  const isBoxed = Boolean(themeSpec.lineBoxStyle);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          top: `${verticalAnchor * 100}%`,
          left: isBoxed ? `${safeArea.left * 100}%` : 0,
          right: isBoxed ? `${safeArea.right * 100}%` : 0,
          width: isBoxed ? "fit-content" : undefined,
          maxWidth: isBoxed ? `${(1 - safeArea.left - safeArea.right) * 100}%` : undefined,
          margin: isBoxed ? "0 auto" : undefined,
          transform: "translateY(-50%)",
          direction,
          display: "flex",
          justifyContent: "center",
          alignItems: "baseline",
          gap: "0.28em",
          flexWrap: "wrap",
          paddingLeft: isBoxed ? undefined : `${safeArea.left * 100}%`,
          paddingRight: isBoxed ? undefined : `${safeArea.right * 100}%`,
          ...(themeSpec.lineBoxStyle ?? {}),
          fontFamily: captionFontFamilyFor(direction, fontFamily),
          fontWeight: themeSpec.fontWeight,
          fontSize: scaledFontPx,
          lineHeight: captionLineHeightFor(direction),
          textTransform: themeSpec.textTransform,
          letterSpacing: themeSpec.letterSpacing,
          textAlign: "center",
          color: textColor,
          WebkitTextStroke:
            themeSpec.strokePx > 0 ? `${themeSpec.strokePx}px rgba(0,0,0,0.85)` : "0px transparent",
          paintOrder: "stroke fill",
          textShadow: themeSpec.shadowStyle,
        }}
      >
        {line.words.map((w, i) => {
          const held = Math.max(w.end, w.start + 0.12);
          const inWindow = t >= w.start && t <= held;
          const p = inWindow ? Math.min(1, (t - w.start) / CAPTION_POP_SEC) : 0;
          const pop = easeOutQuad(p);
          const wordEmph = w.emphasisScale ?? 1;
          const unspoken = themeSpec.revealMode === "word-build" && t < w.start;

          const pillSpec = themeSpec.activeWordPill;
          const showPill =
            inWindow &&
            pillSpec !== undefined &&
            (!pillSpec.emphasisOnly || wordEmph >= 1.15);

          const scaleVal = unspoken ? 0.92 : 1 + themeSpec.popScaleAmp * pop;
          const rotatePart =
            showPill && pillSpec.rotateDeg !== 0 ? ` rotate(${pillSpec.rotateDeg}deg)` : "";
          const transform = unspoken
            ? "translateY(6px) scale(0.92)"
            : `${scaleVal !== 1 ? `scale(${scaleVal})` : "scale(1)"}${rotatePart}`;

          const opacity = unspoken
            ? 0
            : inWindow
              ? 1
              : themeSpec.inactiveOpacity;

          return (
            <span
              key={i}
              data-caption-word={wordOffset + i}
              data-caption-text={w.text}
              data-caption-src={captionAnchorOf(w) === null ? undefined : w.srcStart}
              style={{
                display: "inline-block",
                pointerEvents: "auto",
                ...(wordEmph > 1
                  ? {
                      fontSize: Math.round(scaledFontPx * wordEmph),
                      lineHeight: direction === "rtl" ? 1.6 : 1.05,
                    }
                  : {}),
                transform,
                opacity,
                color: showPill
                  ? pillSpec.color
                  : inWindow
                    ? activeColor
                    : textColor,
                ...(showPill
                  ? {
                      backgroundColor: pillSpec.backgroundColor,
                      borderRadius: pillSpec.borderRadius,
                      padding: pillSpec.padding,
                      ...(pillSpec.clearStroke
                        ? { WebkitTextStroke: "0px transparent", textShadow: "none" }
                        : {}),
                    }
                  : {}),
              }}
            >
              {ctaDisplay(w.text, inCtaWindow(w.start, ctaWindow) ? ctaKeyword : undefined)}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/**
 * Word-timed kinetic captions. All timings are OUTPUT time. When scene cues
 * are provided, each line is anchored per the active layout's caption slot
 * and hidden entirely while a graphic owns the frame (PHASE1 §1).
 */
export const CaptionTrack: React.FC<CaptionTrackProps> = ({
  lines,
  cues = [],
  verticalAnchor = DEFAULT_CAPTION_ANCHOR,
  fontSizePx,
  activeColor = "#FFE14D",
  theme,
  ctaKeyword,
  ctaWindow,
  sourceTextRegions = [],
  hideDuring,
  captionTheme,
  face,
  watermark,
}) => {
  const { fps, width, height } = useVideoConfig();
  const frame = { width, height };
  // Frame-derived default (2026-08-16): an explicit prop still wins outright.
  const resolvedFont = resolveCaptionFontSize(fontSizePx, frame);
  // One resolution for the whole track — every line shares the theme's type.
  const { fontFamily, color: textColor } = captionTypography(theme);
  // Each line's first-word index in the whole stream, so a word's id is
  // stable regardless of which line the layout put it on.
  const offsets: number[] = [];
  let running = 0;
  for (const line of lines) {
    offsets.push(running);
    running += line.words.length;
  }
  return (
    <AbsoluteFill>
      {/* Mounted once for the whole track, and only when some line is RTL —
          the same predicate produce keys the font copy on, so the fetch and
          the file can't disagree. */}
      {captionsNeedNastaliq(lines) ? <NastaliqFontLoader /> : null}
      {lines.map((line, i) => {
        // The whole anchor chain — hand-set captionY, the rect-aware
        // avoidance path, the plain anchor — lives in captionAnchorForLine,
        // shared with the overlay track so the two can never disagree.
        const { anchor, scale } = captionAnchorForLine(
          cues,
          sourceTextRegions,
          line,
          frame,
          verticalAnchor,
          face,
          watermark,
        );
        // End frame from the end TIME, never from a rounded duration — see
        // frameWindow. Two lines either side of a cue boundary resolve to
        // different anchors, so a one-frame overlap there renders as two
        // captions stacked at two heights (§115).
        const { from, durationInFrames } = frameWindow(line.start, line.end, fps);
        return (
          <Sequence key={i} from={from} durationInFrames={durationInFrames}>
            <LineView
              line={line}
              wordOffset={offsets[i]!}
              verticalAnchor={anchor}
              // Per-scene size multiplier (R16 §64) — resolved per line like
              // the anchor, from the cue the line starts under.
              fontSizePx={resolvedFont * scale}
              activeColor={activeColor}
              fontFamily={fontFamily}
              textColor={textColor}
              ctaKeyword={ctaKeyword}
              ctaWindow={ctaWindow}
              fromFrame={from}
              hideDuring={hideDuring && hideDuring.length > 0 ? hideDuring : undefined}
              captionTheme={captionTheme}
              theme={theme}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
