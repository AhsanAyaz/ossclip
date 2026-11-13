# Stage 8: Intermediate Zoom Out Review Report (`egm-zoom-out`)

## High-Level Architectural Cohesion Summary (Stages 5–7)

The overall architectural split between deterministic **Caption Themes** (`CaptionThemeId` / `resolveCaptionThemeSpec`) and source-anchored **AI Caption Choreography** (`CaptionChoreography` keyed by `srcStart` and consumed by [`buildCaptionLines`](file:///home/ahsanayaz/code/ossclip/packages/core/src/captions.ts#L244-L314)) remains sound and well-aligned with `ossclip`'s offline-first editor model.

Below is the consolidated set of architectural and simplicity findings verified across Stages 5–8 before implementation.

---

### Finding 1 (Unresolved from Stage 5 & Stage 6): Inconsistent Safe-Zone Hook Data Flow (`CaptionLine.anchorY` vs. Render-Time `CaptionLine.role`) and Missing/Misplaced [`overlayGeometryFor`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts#L21-L35) Plumbing

1. **Severity**: Major
2. **Affected Scope**: `## Goals` (lines 34–35), `## Critical User Journeys` (lines 64, 73), `### 3. Source-Anchored AI Choreography Model` (lines 208–233), `### 4. FaceBox-Aware Safe-Zone Placement & Overlay Collision Geometry` (lines 236–249), and `## Detailed Implementation Plan` (Sections 11, 12, 13, 15; lines 421–469).
3. **Simplicity Rationale**:
   * **Internal Contradiction on Where Safe-Zone Anchors Live**: Goal G6 (line 35), CUJ 2 (line 64), and CUJ 3 (line 73) state that [`buildCaptionLines`](file:///home/ahsanayaz/code/ossclip/packages/core/src/captions.ts#L244-L314) attaches `anchorY` directly to [`CaptionLine`](file:///home/ahsanayaz/code/ossclip/packages/core/src/captions.ts#L23-L27) and that [`applyCaptionWordHides`](file:///home/ahsanayaz/code/ossclip/packages/core/src/overrides.ts#L2283) preserves `line.anchorY`. In contrast, Technical Plan Sections 3–4 (lines 220–249) and Target File 2 (line 344) omit `anchorY` from `CaptionLine` and instead attach only `role?: CaptionPhraseRole`, deferring safe-zone calculation (`resolveChoreographedAnchor`) to render time inside [`CaptionTrack.tsx`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/CaptionTrack.tsx#L196-L216).
   * **Wrong Target File & Missing Editor Plumbing for `overlayGeometryFor`**:
     * Target File 12 (lines 433–439) targets [`packages/scenes/src/overlay-rect.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-rect.ts) to add `captionTheme`, `face`, and `watermark` to `overlayGeometryFor`. In the codebase, [`overlayGeometryFor`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts#L21-L35) actually lives in [`packages/scenes/src/overlay-room.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts#L21-L35).
     * Because render-time safe-zone calculation requires threading `captionTheme`, `face`, and `watermark` into every `overlayGeometryFor` call site so [`overlaysWithoutRoom`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts#L49-L61) agrees between CLI and editor, Target File 14 ([`produce.ts:4888`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L4888)) and Target File 15 ([`App.tsx:1732`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L1732-L1738)) must also pass those options into `overlayGeometryFor`.
   * **Recommendation**: Update G5/G6 and CUJ 2/3 to consistently reference `line.role` (resolved to a safe-zone anchor at render time), change Target File 12 from `overlay-rect.ts` to [`packages/scenes/src/overlay-room.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts), and explicitly include the `overlayGeometryFor` argument updates in [`produce.ts`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L4888) (Section 14) and [`App.tsx`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L1732-L1738) (Section 15).

---

### Finding 2 (Unresolved from Stage 5 & Stage 6): YAGNI & Second-System Drift in Permanent Standalone HTML Mock Page (`packages/scenes/caption-themes-mock.html`)

1. **Severity**: Major
2. **Affected Scope**: `## Overview` (line 13), `## Goals` (G1, lines 30–31), `### CUJ 4` (lines 75–79), `#### 1. packages/scenes/caption-themes-mock.html` (lines 325–336), and `### Verification Plan` (line 479).
3. **Simplicity Rationale**:
   * **Implementing a Rejected `dynamic-reflow` Strategy**: Technical Plan Section 5 (line 256) and Target File 11 (line 431) explicitly commit to `slot-reserved` progressive word build-in (keeping all word `<span>`s mounted for the full `<Sequence>` with `opacity: 0` when unspoken so flex layout coordinates and editor `data-caption-src` DOM hit-targets never shift mid-line). Yet G1, CUJ 4, and Target File 1 require building an interactive toggle for a rejected `dynamic-reflow` strategy (without defining the term at first mention in G1).
   * **Duplicating Rendering & Geometry Logic in a Production Package**: Committing a hand-written vanilla HTML/CSS/JS re-implementation of the 5 themes, `headBand(face)`, `easeOutQuad`, and Nastaliq RTL rules inside `packages/scenes/caption-themes-mock.html` creates a parallel, untested copy of `caption-themes.ts` and [`CaptionTrack.tsx`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/CaptionTrack.tsx) inside a shipped package.

---

### Finding 3 (Unresolved from Stage 5 & Stage 6): Duplicate Precedence Resolver Across Package Boundaries (`resolveProductionCaptionTheme` in `overrides.ts` vs. `resolveCaptionTheme` in `produce.ts`)

1. **Severity**: Major
2. **Affected Scope**: `### 6. CLI Flags, Config, Overrides, and Cache Key` (line 264), `#### 7. packages/core/src/overrides.ts` (line 396), `#### 9. packages/core/src/browser.ts` (line 409), and `#### 14. apps/cli/src/produce.ts` (line 456).
3. **Simplicity Rationale**:
   * Target File 7 (line 396) proposes defining `resolveProductionCaptionTheme(overrideTheme, flagTheme, configTheme)` in [`packages/core/src/overrides.ts`](file:///home/ahsanayaz/code/ossclip/packages/core/src/overrides.ts) and re-exporting it through [`@ossclip/core/browser`](file:///home/ahsanayaz/code/ossclip/packages/core/src/browser.ts) (line 409), while Technical Plan Section 6 (line 264) and Target File 14 (line 456) simultaneously propose implementing `resolveCaptionTheme(overrideTheme, cliFlag, configVal)` in [`apps/cli/src/produce.ts`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts).
   * Remove `resolveProductionCaptionTheme` from `overrides.ts` / `browser.ts` and keep the single resolver in `produce.ts` alongside `resolveProductionColorGrade`.

---

### Finding 4 (Unresolved from Stage 5): Unspecified Purpose for Persisting `captionTheme` and `captionChoreography` in `ProductionSchema` (`production.json`)

1. **Severity**: Nit
2. **Affected Scope**: `### CUJ 1` (line 55), `### 3. Source-Anchored AI Choreography Model` (line 166), `#### 6. packages/core/src/schema.ts` (lines 381–387), and `#### 14. apps/cli/src/produce.ts` (line 459).
3. **Simplicity Rationale**:
   * Specify that `production.captionChoreography` is persisted in `production.json` specifically to support `priorCaptionChoreography(work)` carry-forward on `--scenes` replay (matching `priorSfxPlan` and `priorOverlayPlan`), and omit `captionTheme` from `ProductionSchema` (matching `colorGrade`, which lives in `render-props.json` and `overrides.json`) or clarify its consumer.
