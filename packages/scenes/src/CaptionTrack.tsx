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
  type SceneCue,
  type Theme,
} from "@ossclip/core/browser";
import { safeAreaFor, activeCueAt, captionFontSizeFor, type FrameSize } from "./stage";
import { frameWindow } from "./frames";
import { captionAnchorAvoiding, regionsDuring, type OccupiedRegion } from "./source-fit";
import { CAPTION_POP_SEC, easeOutQuad } from "./motion";

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
}

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
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
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
          // Ramp from the word's OWN start, then hold — frame-driven, because
          // the CSS transition this replaces only ever animated in the
          // editor's real-time <Player>; the render seeks and screenshots,
          // so no wall-clock time passes and the scale snapped (spec
          // 2026-08-04). Same ease as the layer's entrance and exit.
          const p = inWindow ? Math.min(1, (t - w.start) / CAPTION_POP_SEC) : 0;
          const pop = easeOutQuad(p);
          return (
            <span
              key={i}
              // The editor double-click retypes a word in place; the RAW text
              // rides along because the rendered text may be CTA-decorated,
              // and the retype's stale-guard must compare against the truth.
              data-caption-word={wordOffset + i}
              data-caption-text={w.text}
              // The word's SOURCE start, which is what the edit is keyed on
              // (§137). These attributes are the whole contract between this
              // file and the editor's Overlay — it hit-tests the Player's DOM
              // and holds no caption lines of its own — so the anchor has to
              // travel the same channel as the text. OMITTED when the word has
              // no usable anchor (`captionAnchorOf` is core's single definition
              // of that, so this cannot drift from the apply side): a pre-§137
              // render-props.json has no `srcStart` at all, and the editor
              // treats the missing attribute as "this word cannot be retyped".
              // Never `NaN` — a shared garbage anchor is the failure §137
              // exists to remove.
              data-caption-src={captionAnchorOf(w) === null ? undefined : w.srcStart}
              style={{
                display: "inline-block",
                // Words are individually hit-testable for the editor (the
                // parent layer stays pointer-events: none); harmless in the
                // render, where nothing dispatches events.
                pointerEvents: "auto",
                transform: pop > 0 ? `scale(${1 + 0.08 * pop})` : "scale(1)",
                // Colour stays keyed to the window, not the ramp: colour has
                // no in-between worth animating, and lerping it would fight
                // the stroke.
                color: inWindow ? activeColor : textColor,
              }}
            >
              {/* Per WORD, not per line: a line straddling the cue boundary
                  styles only the word actually inside the ask. */}
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
  verticalAnchor = 0.76,
  fontSizePx,
  activeColor = "#FFE14D",
  theme,
  ctaKeyword,
  ctaWindow,
  sourceTextRegions = [],
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
        const active = cues.length > 0 ? activeCueAt(cues, line.start) : null;
        // ONE rect-aware path for every line (R11 Task 2b). The old split —
        // `captionAnchorAvoiding` only when the source had burned-in text,
        // the pure layout anchor otherwise — meant a hand-moved graphic box
        // silently sat on top of the captions on a clean source, the common
        // case. With no regions and no moved rect this resolves to exactly
        // the layout anchor the old branch returned.
        // A hand-set per-scene anchor (R15 §56) wins over the automatic
        // chain outright — like every other hand edit, the user's placement
        // is a decision, not an input to the avoidance search.
        const anchor =
          active?.captionY !== undefined
            ? active.captionY
            : cues.length > 0 || sourceTextRegions.length > 0
              ? captionAnchorAvoiding(
                  active?.layout ?? "full-bleed",
                  regionsDuring(sourceTextRegions, line.start, line.end),
                  active?.graphicRect,
                  frame,
                )
              : verticalAnchor;
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
              fontSizePx={resolvedFont * (active?.captionScale ?? 1)}
              activeColor={activeColor}
              fontFamily={fontFamily}
              textColor={textColor}
              ctaKeyword={ctaKeyword}
              ctaWindow={ctaWindow}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
