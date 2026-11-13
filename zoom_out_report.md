# Stage 5: Initial Zoom Out Review Report

## Part 1: Zoom-Out Architectural Audit (`egm-zoom-out`)

### Finding 1: Inconsistent Safe-Zone Hook Data Flow (`CaptionLine.anchorY` vs. Render-Time `CaptionLine.role`) and Missing/Misplaced `overlayGeometryFor` Plumbing
1. **Severity**: Major
2. **Affected Scope**: `## Goals` (lines 34–35), `## Critical User Journeys` (lines 64, 73), `### 3. Source-Anchored AI Choreography Model` (lines 208–233), `### 4. FaceBox-Aware Safe-Zone Placement & Overlay Collision Geometry` (lines 236–249), and `## Detailed Implementation Plan` (Sections 11, 12, 13, 15; lines 421–469).
3. **Simplicity Rationale**:
   * **Internal Contradiction on Where Safe-Zone Anchors Live**: Goal G6 (line 35), CUJ 2 (line 64), and CUJ 3 (line 73) state that [`buildCaptionLines`](file:///home/ahsanayaz/code/ossclip/packages/core/src/captions.ts#L244-L314) attaches `anchorY` directly to [`CaptionLine`](file:///home/ahsanayaz/code/ossclip/packages/core/src/captions.ts#L23-L27) and that [`applyCaptionWordHides`](file:///home/ahsanayaz/code/ossclip/packages/core/src/overrides.ts#L2283) preserves `line.anchorY`. However, Technical Plan Sections 3–4 (lines 220–249) omit `anchorY` from `CaptionLine` and instead attach only `role?: CaptionPhraseRole`, deferring safe-zone calculation (`resolveChoreographedAnchor`) to render time inside [`CaptionTrack.tsx`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/CaptionTrack.tsx).
   * **Non-Minimal Data Flow & Wrong Target File**: Computing safe-zone placement inside `captionAnchorForLine` requires threading three new environmental props (`captionTheme`, `face`, `watermark`) through `CaptionTrackProps`, `CaptionGeometryOpts`, `captionBlockExtent`, `captionTopAtFor`, `captionBottomAtFor`, and [`overlayGeometryFor`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts#L21-L35) across every consumer: [`produce.ts`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L4888), [`ProductionComposition.tsx`](file:///home/ahsanayaz/code/ossclip/packages/renderer/src/ProductionComposition.tsx#L215), and [`App.tsx`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L1732). Because of this wide fan-out, Section 15 ([`App.tsx`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx), lines 462–469) forgets to pass `captionTheme`, `face`, and `watermark` to `overlayGeometryFor` at [`App.tsx:1732`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L1732-L1738), which will cause the editor's `overlayNoRoom` preview check to diverge from CLI renders. Additionally, Section 12 (lines 433–438) targets [`packages/scenes/src/overlay-rect.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-rect.ts) for `overlayGeometryFor`, whereas `overlayGeometryFor` actually lives in [`packages/scenes/src/overlay-room.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts#L21-L35).
   * **Recommendation**: Align the Goals/CUJs with the Technical Plan on a single mechanism, target [`packages/scenes/src/overlay-room.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts) instead of `overlay-rect.ts`, and ensure [`App.tsx`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L1732-L1738) passes the same options to `overlayGeometryFor` as `ProductionComposition.tsx` and `produce.ts`.

---

### Finding 2: YAGNI & Second-System Drift in Permanent Standalone HTML Mock Page (`packages/scenes/caption-themes-mock.html`)
1. **Severity**: Major
2. **Affected Scope**: `## Overview` (line 13), `## Goals` (G1, lines 30–31), `### CUJ 4` (lines 75–79), `#### 1. packages/scenes/caption-themes-mock.html` (lines 325–336), and `### Verification Plan` (line 479).
3. **Simplicity Rationale**:
   * **Building a Rejected `dynamic-reflow` Strategy**: Section 5 (line 256) and Section 11 (line 431) explicitly settle on `slot-reserved` word build-in (all word `<span>`s mounted for the full `<Sequence>`) so flex coordinates and editor `data-caption-src` DOM hit-targets never shift mid-line. Yet G1, CUJ 4, and Target File 1 require implementing a toggleable `dynamic-reflow` mode in the HTML mock page that will never ship in `CaptionTrack.tsx`.
   * **Duplicating Rendering & Geometry Logic in a Committed Package File**: Checking in a hand-written vanilla HTML/CSS/JS re-implementation of the 5 themes, `headBand(face)`, `easeOutQuad`, and Nastaliq RTL rules inside `packages/scenes/caption-themes-mock.html` creates a second, untested copy of `caption-themes.ts` and [`CaptionTrack.tsx`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/CaptionTrack.tsx) inside a production package. Keep throwaway visual prototyping in scratch (or drop the dead `dynamic-reflow` toggle and avoid maintaining duplicate CSS/geometry logic in `packages/scenes`).

---

### Finding 3: Duplicate Resolver Definitions Across Package Boundaries (`resolveProductionCaptionTheme` in `overrides.ts` vs. `resolveCaptionTheme` in `produce.ts`)
1. **Severity**: Major
2. **Affected Scope**: `#### 7. packages/core/src/overrides.ts` (line 396), `#### 9. packages/core/src/browser.ts` (line 409), and `#### 14. apps/cli/src/produce.ts` (line 456).
3. **Simplicity Rationale**:
   * Target File 7 (line 396) proposes defining `resolveProductionCaptionTheme(overrideTheme, flagTheme, configTheme)` in [`packages/core/src/overrides.ts`](file:///home/ahsanayaz/code/ossclip/packages/core/src/overrides.ts) and exporting it through [`@ossclip/core/browser`](file:///home/ahsanayaz/code/ossclip/packages/core/src/browser.ts) (line 409), while Target File 14 (line 456) simultaneously proposes implementing `resolveCaptionTheme(overrideTheme, cliFlag, configVal)` in [`apps/cli/src/produce.ts`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts).
   * In the existing codebase, [`resolveProductionColorGrade`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L1035-L1063), [`resolveWatermark`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L951-L956), [`resolveCoverInVideo`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L993-L998), and [`resolveSfxLevel`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L1097-L1109) all live exclusively in [`apps/cli/src/produce.ts`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts) because CLI flags and `~/.ossclip/config.json` do not exist in the browser editor. The editor simply resolves `edits.doc.captionTheme ?? renderProps.captionTheme` (line 468). Remove `resolveProductionCaptionTheme` from `overrides.ts` / `browser.ts` and keep the single 3-layer resolver in `produce.ts` alongside `resolveProductionColorGrade`.

---

### Finding 4: Unspecified Purpose for Persisting `captionTheme` and `captionChoreography` in `ProductionSchema` (`production.json`)
1. **Severity**: Nit
2. **Affected Scope**: `### CUJ 1` (line 55), `### 3. Source-Anchored AI Choreography Model` (line 166), `#### 6. packages/core/src/schema.ts` (lines 381–387), and `#### 14. apps/cli/src/produce.ts` (line 459).
3. **Simplicity Rationale**:
   * In `ossclip`, resolved visual switches like `colorGrade`, `watermark`, and `coverInVideo` are written to `render-props.json` and `overrides.json`, *not* [`ProductionSchema`](file:///home/ahsanayaz/code/ossclip/packages/core/src/schema.ts#L268-L412) (`production.json`), while raw mechanical LLM responses are cached in `<workdir>/<feature>-<hash>.json` (e.g., [`logo-flags-<key>.json`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L4969)).
   * Writing `captionTheme` and `captionChoreography` to `production.json` in addition to `render-props.json` and `caption-choreography-<hash>.json` duplicates state across three files without specifying any consumer of `production.captionTheme` or `production.captionChoreography` (such as `--scenes` replay carry-forward). Either omit `captionTheme` from `ProductionSchema` (matching `colorGrade`) and specify whether `production.captionChoreography` is read back on `--scenes` replay, or keep them solely in `render-props.json` and the workdir cache.

---

## Part 2: Inventive Catalyst Review (`egm-inventive-catalyst`)

No false compromise detected.
