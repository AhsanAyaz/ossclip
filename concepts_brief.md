# AI Choreographed Captions & Caption Themes

* **Author:** Muhammad Ahsan Ayaz
* **Date:** 2026-11-11

## Overview

Short-form launch videos and product demos rely on captions that hold viewer attention on mute without obscuring the speaker or the product interface. Today, `ossclip` packs captions into fixed 3-word lines (portrait) or 6-word lines (landscape) with a single hard-coded visual style: bold Inter text, a black stroke, a drop shadow, and an active-word color highlight. Every line sits at the same default vertical anchor unless a graphic scene pushes it away.

This feature introduces two independent capabilities for `ossclip produce` and the web editor (`ossclip edit`), preceded by an interactive HTML mock page for visual verification:

1. **Caption Themes (`--caption-theme <preset>` / config `captionTheme`)**: A deterministic styling system with five presets (`default`, `founder`, `punch`, `boxed`, `minimal`) that control font weight and tracking, background pills or boxes, text strokes and shadows, color accents derived from the active [`Theme`](file:///home/ahsanayaz/code/ossclip/packages/core/src/scene-schema.ts#L276-L291), and word reveal mode (`full-line` vs. progressive `word-build`). Caption themes work on every run without calling an LLM.
2. **AI Caption Choreography (`--choreograph-captions` / config `choreographCaptions`)**: An optional, cached LLM pass over the transcript that groups words into semantic phrases instead of fixed word counts, assigns per-word size multipliers (`1.0x` to `1.4x`) to emphasize hook words or metrics, and places opening hook phrases (and rare high-emphasis phrases) into clear zones around the speaker's measured [`FaceBox`](file:///home/ahsanayaz/code/ossclip/packages/core/src/face.ts#L21-L32) while keeping main-body captions at a consistent anchor so viewers do not lose their reading position.

## Analysis

### 1. Eliminating the Conflict Between LLM Phrasing and Deterministic Editor Recuts

A central risk identified during codebase review is how the web editor (`ossclip edit`) handles live cuts and word retypes:
* In [`liveCaptionTrack.ts`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/liveCaptionTrack.ts#L113-L147) and [`App.tsx`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L1533-L1542), whenever a user cuts a word or toggles a cleanup removal in the browser, `rebuildCaptionTrack` calls [`buildCaptionLines`](file:///home/ahsanayaz/code/ossclip/packages/core/src/captions.ts#L244-L314) directly in the browser without calling an LLM.
* In [`overrides.ts`](file:///home/ahsanayaz/code/ossclip/packages/core/src/overrides.ts#L619-L720), per-line timing overrides (`captionLineTiming` and `captionLineWindows`) key each line by its first word's source timestamp (`srcStart`).
* Furthermore, [`applyCaptionWordHides`](file:///home/ahsanayaz/code/ossclip/packages/core/src/overrides.ts#L2283) currently constructs `{ words: kept, start, end }` without spreading `...line`, which would strip any choreography fields attached to [`CaptionLine`](file:///home/ahsanayaz/code/ossclip/packages/core/src/captions.ts#L23-L27) when a user hides a single word. Similarly, [`retimeCaptionTokens`](file:///home/ahsanayaz/code/ossclip/packages/core/src/overrides.ts#L1979) in `applyCaptionRangeEdits` constructs fresh word objects when a multi-word edit changes word count, dropping any per-word emphasis field.

**Resolution (Choreography as Source-Anchored Breakpoints and Word Metadata)**:
Instead of replacing [`buildCaptionLines`](file:///home/ahsanayaz/code/ossclip/packages/core/src/captions.ts#L244-L314) with a separate LLM line-builder that only exists at CLI render time, the LLM choreography pass outputs a source-anchored `CaptionChoreography` object stored in `production.json` and `render-props.json`:
* Semantic phrase boundaries are represented as source-timestamp (`srcStart`) break anchors.
* Per-word emphasis multipliers (`emphasisScale`) and phrase roles (`"hook" | "body" | "impact"`) are keyed by word `srcStart` (`captionKeyFor`).
* [`buildCaptionLines`](file:///home/ahsanayaz/code/ossclip/packages/core/src/captions.ts#L244-L314) accepts this optional choreography input and flushes lines at semantic phrase boundaries while still enforcing scene-cue `breakpoints`, `maxGap`, `hold`, and [`enforceLineDwell`](file:///home/ahsanayaz/code/ossclip/packages/core/src/captions.ts#L203-L223).
* Moving or deleting a graphic scene in the editor changes `breakpoints`, which splits any straddling choreographed phrase deterministically without invalidating the LLM cache or requiring a browser LLM call.
* Updating [`applyCaptionWordHides`](file:///home/ahsanayaz/code/ossclip/packages/core/src/overrides.ts#L2283) to preserve `...line` ensures choreography metadata survives word hiding in the editor.

### 2. Per-Word Emphasis Sizing Without Horizontal Overlap or Per-Frame Reflow

In [`LineView`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/CaptionTrack.tsx#L481-L529), active words currently animate via `transform: scale(${1 + 0.08 * pop})` on an `inline-block` span.
* If AI choreography scales an emphasized word to `1.35x` using CSS `transform: scale(1.35)`, the browser's flexbox layout does not allocate extra horizontal or vertical space for that word, causing it to collide with adjacent words.
* Conversely, animating `fontSize` every frame during the active-word pop would trigger DOM layout reflows on every frame of the render.

**Resolution (Spatial vs. Temporal Separation)**:
* Apply the static per-word `emphasisScale` (`1.0` to `1.4`) to the word span's `fontSize` (`fontSizePx * (w.emphasisScale ?? 1)`), so flexbox layout reserves accurate horizontal width and row height once when the line mounts.
* Keep the frame-driven active-word pop on `transform: scale(...)`, so per-frame animation stays on the compositor without reflow.
* Update [`estimateCaptionRows`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/CaptionTrack.tsx#L256-L274) and [`captionBlockExtent`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/CaptionTrack.tsx#L293-L309) to weight each word's width and row height by `w.emphasisScale ?? 1` so [`OverlayTrack`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-track.tsx) accurately dodges enlarged caption lines.

### 3. Progressive Word Build-In Without Horizontal Jitter

When a theme uses progressive word reveal (`word-build`, where words appear at `t >= w.start`), mounting word spans into a centered flex container (`justifyContent: "center"`) one by one causes already-visible words to shift left every time a new word mounts.

**Resolution**:
* Reserve layout slots for all words in the phrase from `line.start`, keeping unspoken words (`t < w.start`) at `opacity: 0` and ramping `opacity` and `transform` over [`CAPTION_POP_SEC`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/motion.ts) when `t` crosses `w.start`.
* Expose both slot-reserved build-in and dynamic-reflow build-in in the HTML mock page so the visual feel on 1–2 word punch chunks vs. 4–5 word phrases can be compared directly before locking the renderer implementation.

### 4. FaceBox Coordinate Space and Spatial Stability Budget

* [`measureFace`](file:///home/ahsanayaz/code/ossclip/packages/core/src/face.ts#L428-L519) measures `FaceBox` in cropped source fractions, while [`CaptionTrack`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/CaptionTrack.tsx#L540-L610) positions lines in output frame fractions.
* [`stage.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/stage.ts#L421-L488) already provides `headBand(face)` and `freeBands` (used by `coverTextRect`). By projecting `headBand(face)` through the active video slot's vertical offset (`objectPosYFor`), we can find free vertical bands above or below the speaker's head that also clear `SAFE_AREA`, `sourceTextRegions`, active scene graphics, and the optional watermark.
* To prevent eye fatigue, a deterministic validator (`validateCaptionChoreography`) enforces a **spatial stability budget**:
  1. **Hook Zone (`t < 4.0s`, max first 2 phrases)**: Eligible for `FaceBox`-aware upper/alternate safe-zone placement when the active layout is `full-bleed` (no graphic card or `coverInVideo` active) and a free band of sufficient height exists.
  2. **Main Body**: Locked to the standard layout anchor (`0.76` in portrait `full-bleed`) so viewers read from one predictable spot.
  3. **Impact Beats (max 1 per 15 seconds)**: Only phrases of 1–2 words with high emphasis during a plain `full-bleed` take may use an alternate safe zone.
* Precedence in [`captionAnchorForLine`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/CaptionTrack.tsx#L196-L216): user hand-set per-scene `cue.captionY` > choreographed safe-zone `line.anchorY` (re-checked against active obstacles) > standard layout anchor.

### 5. RTL / Urdu Nastaliq and Byte-Identical Default Guarantees

* When `captionTheme` is unset or `"default"` and `choreographCaptions` is off, [`CaptionTrack`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/CaptionTrack.tsx#L402-L610) must emit the exact same inline styles and DOM structure as today so existing tests and renders remain byte-identical.
* For RTL lines (`lineDirection === "rtl"`, which prepend `Noto Nastaliq Urdu` at `lineHeight: 1.9`), themes that apply `textTransform: "uppercase"`, negative `letterSpacing`, or tight vertical pill boxes must disable uppercase/negative tracking and expand vertical pill padding so Nastaliq ascenders and descenders are neither broken nor clipped.

### 6. Five Built-In Caption Theme Presets

| Preset ID | Visual Style | Typography & Case | Pill / Box Backing | Stroke & Shadow | Reveal Mode |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `default` | Classic `ossclip` karaoke | `theme.fontDisplay` (weight 900), mixed case, `1.0x` | None | `10px` (at 64px) black stroke + drop shadow | `full-line`; active word pops `1.08x` in `theme.accent` |
| `founder` | Clean launch-demo style (HeyClicky / builder aesthetic) | `theme.fontDisplay` (weight 800), `-0.02em` LTR tracking, `0.92x` base size | Active word receives a rounded accent pill (`theme.accent` fill, dark text) | `2px` subtle outline + crisp drop shadow | `full-line`; inactive words at `0.85` opacity |
| `punch` | High-contrast creator impact | Extra-bold (`900`), uppercase on LTR lines, `1.08x` base size | Optional tilted accent badge on words with `emphasisScale > 1.15` | `12px` (at 64px) black stroke + hard offset shadow | `word-build` (progressive as spoken); active word pops `1.14x` |
| `boxed` | Subtitled documentary / broadcast strip | Bold sans (`800`), mixed case, `0.95x` base size | Full-line dark rounded container (`rgba(10,10,12,0.86)`) with comfortable padding | `0px` stroke | `full-line`; active word shifts to `theme.accent` (`1.04x`) |
| `minimal` | Clean editorial / low-clutter | Bold (`700`), mixed case, `0.84x` base size | None | `0px` stroke; multi-layer ambient shadow for legibility | `word-build`; active word at `1.0` opacity, prior words at `0.6` opacity |

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * Build a standalone interactive HTML mock page first to preview and tune all 5 caption themes (`default`, `founder`, `punch`, `boxed`, `minimal`), progressive `word-build` vs. `full-line` reveal, per-word emphasis sizing, RTL Nastaliq rendering, and `FaceBox` safe-zone placement on 9:16 and 16:9 frames.
  * Add `--caption-theme <preset>` CLI option and `captionTheme` config/override support (`overrides.json > CLI flag > config.json > "default"`), pinned in `command.json` for replay determinism.
  * Add `--choreograph-captions` / `--no-choreograph-captions` tri-state CLI flags and `choreographCaptions` config key.
  * Implement a cached LLM choreography pass (`caption-choreography-<hash>.json`) using the mechanical/fast model tier that groups kept transcript words into semantic phrases, assigns bounded per-word `emphasisScale` multipliers (`1.0`–`1.4`), and marks hook/impact phrases.
  * Enforce a deterministic normalization and validation pass (`validateCaptionChoreography`) so the LLM can never alter, drop, or reorder transcript words, and so non-default positioning is restricted to the opening hook and rare impact beats inside `FaceBox`-aware free bands.
  * Preserve full compatibility with editor word retyping (`data-caption-src`), word hiding (`applyCaptionWordHides`), live cuts (`rebuildCaptionTrack`), and `OverlayTrack` collision avoidance (`captionBlockExtent`).
* **Out-of-Scope Non-Goals:**
  * Per-frame person/body segmentation or depth-matting captions behind the speaker's torso.
  * Arbitrary per-word X/Y canvas coordinates or rotated/curved text paths generated by the LLM.
  * Making live LLM calls from the browser when editing or recutting in `ossclip edit`.

## Alternatives Weighed

* **Per-frame body segmentation for placing captions around or behind the speaker's torso**: Rejected by author during brainstorming. `ossclip` only computes a static 2D `FaceBox` via the `pico` cascade (`measureFace` / `measureFaceInWindows`); adding a person-segmentation ML model and alpha-masking pipeline is unnecessary when `FaceBox`-derived safe zones (`headBand` + `freeBands`) already locate clear space around the speaker's head.
* **Merging caption choreography into the `--produce` beat-sheet LLM prompt**: Rejected because users often run `ossclip produce` without `--produce` (captions-only cuts without code-rendered scene graphics), and coupling caption choreography to the editorial beat-sheet call would bloat the beat-sheet schema and prevent running caption choreography on the fast/mechanical model tier.
* **Replacing `buildCaptionLines` with pre-baked LLM caption lines in `render-props.json`**: Rejected because `ossclip edit` rebuilds caption lines client-side in `rebuildCaptionTrack` whenever the user makes a cut or vetoes a silence removal; pre-baked lines would evaporate on the first editor cut and break `captionLineTiming` keys.

## Key Decisions & Staging for Next Steps

1. **Stage 1 — Interactive HTML Mock Validation**: Before modifying Remotion components or CLI flags, generate an interactive HTML preview page showing all 5 caption themes, both `word-build` modes (slot-reserved vs. dynamic reflow), multi-size word emphasis, and `FaceBox` hook placement so visual adjustments can be finalized rapidly.
2. **Stage 2 — Core Schema, Theme Registry & Choreography Pass (`@ossclip/core`)**: Add `CaptionThemeIdSchema`, preset tokens, `CaptionChoreographySchema`, `generateCaptionChoreography` + deterministic `validateCaptionChoreography`, update `buildCaptionLines` to consume choreography phrase breaks and word emphasis, and fix `applyCaptionWordHides` (`overrides.ts:2283`) to preserve line-level choreography fields.
3. **Stage 3 — Renderer & Scene Geometry (`@ossclip/scenes` & `@ossclip/renderer`)**: Update `CaptionTrack`, `LineView`, `captionAnchorForLine`, `estimateCaptionRows`, and `captionBlockExtent` to render the 5 themes, progressive `word-build`, `fontSize`-based word emphasis, and `FaceBox`-aware hook safe zones while keeping `default` byte-identical.
4. **Stage 4 — CLI, Config, Replay & Editor Wiring (`apps/cli` & `apps/editor`)**: Wire `--caption-theme` and `--choreograph-captions` / `--no-choreograph-captions` in `program.ts`, `produce.ts`, `config.ts`, `replay-argv.ts`, and thread `captionChoreography` + `captionTheme` through `apps/editor/src/liveCaptionTrack.ts`.
