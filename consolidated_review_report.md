# Consolidated Goldfish Review Report: AI-Choreographed Captions & Caption Themes

*   **Status**: `resolved`
*   **Target Document**: [`docs/designs/ai-choreographed-captions.md`](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md)
*   **Semantic Split**: `FeatureRange` = lines `1..320` | `DetailedRange` = lines `321..486`
*   **Individual Stage Reports**:
    *   Stage 5 (Initial Zoom Out & Inventive Catalyst): [`zoom_out_report.md`](file:///home/ahsanayaz/code/ossclip/zoom_out_report.md)
    *   Stage 6 (Comprehension Test): [`comprehension_report.md`](file:///home/ahsanayaz/code/ossclip/comprehension_report.md)
    *   Stage 7 (Critic Review — Design, Structural, Style): [`critic_report.md`](file:///home/ahsanayaz/code/ossclip/critic_report.md)
    *   Stage 8 (Intermediate Zoom Out): [`intermediate_zoom_out_report.md`](file:///home/ahsanayaz/code/ossclip/intermediate_zoom_out_report.md)
    *   Stage 9 (Implementation Readiness, Codebase Details, Style): [`implementation_readiness_report.md`](file:///home/ahsanayaz/code/ossclip/implementation_readiness_report.md)

---

## Executive Summary

Across 8 specialized Goldfish reviewers spanning all 5 review stages, 29 raw findings were surfaced and deduplicated into **15 consolidated action items**:
*   **🔴 4 Blockers** (must be resolved before implementation so Phase 5 file write allowlists, module dependencies, editor live recuts, and CLI replay contracts hold)
*   **🟡 6 Majors** (architectural completeness, zero-decision CSS/projection specifications, and edge-case guards)
*   **🟢 5 Nits** (terminology alignment, markdown formatting, and editorial brevity)

---

## Consolidated Action Items by Priority

### 🔴 Blockers

#### B1. Wrong Target File for `overlayGeometryFor` (`overlay-rect.ts` vs. `overlay-room.ts`) and Missing Caller Updates
*   **Sources**: Stage 5 (`ZO-1`), Stage 7 (`D-5`), Stage 8 (`IZO-1`), Stage 9 (`IR-1`, `IR-2`, `CD-1`, `CD-5`)
*   **Affected Scope**: Section 1 Mermaid diagram ([line 100](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L100)), Section 4 ([line 249](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L249)), Target File #12 ([lines 433–440](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L433-L440)), Target File #14 ([lines 449–460](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L449-L460)), and Target File #15 ([lines 462–469](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L462-L469)).
*   **Problem**:
    1. Target File #12 lists [`packages/scenes/src/overlay-rect.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-rect.ts) as the home of `overlayGeometryFor`. In the codebase, `overlayGeometryFor` is defined in [`packages/scenes/src/overlay-room.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts#L21-L35), which is missing from the Target Files list. Under a Phase 5 file write allowlist, modifying `overlay-room.ts` would be blocked.
    2. `overlayGeometryFor` already accepts `face?: FacePoint | null` at [`overlay-room.ts:25`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts#L25) (currently passed only to `videoRectAtFor`), and is called in three places that must agree on overlay room: [`ProductionComposition.tsx:306`](file:///home/ahsanayaz/code/ossclip/packages/renderer/src/ProductionComposition.tsx#L306-L313), [`produce.ts:4888`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L4888-L4894), and [`App.tsx:1732`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L1732-L1738) (`overlayNoRoom`). Target Files #14 and #15 omit updating `overlayGeometryFor` in `produce.ts` and `App.tsx`.
*   **Action Required**:
    *   Replace `packages/scenes/src/overlay-rect.ts` with [`packages/scenes/src/overlay-room.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts) in Target File #12 (and Section 1/Section 4).
    *   In `overlay-room.ts`, add `captionTheme?: CaptionThemeId` and `watermark?: boolean` to `overlayGeometryFor`'s input options and forward `{ captionTheme: opts.captionTheme, face: opts.face, watermark: opts.watermark }` into `captionTopAtFor` and `captionBottomAtFor`.
    *   In Target File #14 (`produce.ts:4888`) and Target File #15 (`App.tsx:1732`), instruct passing `captionTheme` and `watermark` (`face` is already passed) into `overlayGeometryFor`.

#### B2. Circular Dependency and Parameter Type Mismatch for `captionKeyFor` in `packages/core/src/captions.ts`
*   **Sources**: Stage 9 (`CD-3`)
*   **Affected Scope**: Section 3 ([line 230](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L230)) and Target File #2 ([lines 338–348](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L338-L348)).
*   **Problem**:
    1. Line 230 writes `choreography.words[captionKeyFor(w)]?.emphasisScale`. In [`packages/core/src/overrides.ts:1539`](file:///home/ahsanayaz/code/ossclip/packages/core/src/overrides.ts#L1539-L1547), `captionKeyFor(srcStart: number): string` accepts a `number` (`srcStart`), not a word object `w`.
    2. [`packages/core/src/overrides.ts`](file:///home/ahsanayaz/code/ossclip/packages/core/src/overrides.ts#L22) imports from `./captions`. Importing `captionKeyFor` from `./overrides` into `captions.ts` creates a circular module dependency.
*   **Action Required**:
    *   Move `captionKeyFor(srcStart: number): string` into [`packages/core/src/captions.ts`](file:///home/ahsanayaz/code/ossclip/packages/core/src/captions.ts) and re-export it from [`packages/core/src/overrides.ts`](file:///home/ahsanayaz/code/ossclip/packages/core/src/overrides.ts) so both modules share the single `` `w${Math.round(srcStart * 1000)}` `` implementation without a cycle.
    *   Update all call sites in the spec to pass `captionKeyFor(w.srcStart)`.

#### B3. `buildCaptionLines` Phrase-Flushing Failure When Editor Revives Cut Words
*   **Sources**: Stage 7 (`D-2`)
*   **Affected Scope**: Section 3 ([lines 229–233](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L229-L233)) and Target File #2 ([lines 338–348](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L338-L348)).
*   **Problem**:
    *   When a user vetoes a silence/filler removal in `ossclip edit`, [`rebuildCaptionTrack`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/liveCaptionTrack.ts#L113-L147) re-runs `buildCaptionLines` with revived words that were not present when `generateCaptionChoreography` ran.
    *   Under the rule *"flush when `w.srcStart > activePhrase.endSrcSec + 1e-6`"*, revived words falling in the gap between `phrase[0]` and `phrase[1]` satisfy `w.srcStart <= phrase[1].endSrcSec` after `phrase[0]` flushes, causing them to merge into `phrase[1]` (and inherit `phrase[1].role`). Furthermore, if revived words inside a phrase cause the safety ceiling to split a `"hook"` or `"impact"` phrase into multiple lines, every sub-line would inherit `role: "hook"` or `"impact"`.
*   **Action Required**:
    *   Define a word `w` as inside `phrase` iff `w.srcStart >= phrase.startSrcSec - 1e-6 && w.srcStart <= phrase.endSrcSec + 1e-6`.
    *   Flush the current line both when exiting a choreographed phrase (`w.srcStart > activePhrase.endSrcSec + 1e-6`) **and** when entering the next choreographed phrase from an unchoreographed gap (`w.srcStart >= nextPhrase.startSrcSec - 1e-6`).
    *   Pack unchoreographed gap words using standard unchoreographed limits (`3` words / `1.2s` portrait; `6` words / `2.4s` landscape) with `role: undefined`.
    *   If a choreographed phrase is split into multiple lines (by `breakpoints`, `maxGap`, or the safety ceiling), only the **first** sub-line of a `"hook"` phrase retains `role: "hook"`, and any split `"impact"` phrase drops `role` (`undefined`).

#### B4. `produce.ts` Lifecycle: `needsLlm` Gate, Pre-Override Cutlist Cache Key, and `--scenes` Replay Carry-Forward
*   **Sources**: Stage 7 (`D-3`), Stage 9 (`IR-3`, `CD-2`, `CD-6`)
*   **Affected Scope**: Section 6 ([lines 260–270](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L260-L270)), Target File #7 ([line 396](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L396)), Target File #9 ([line 409](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L409)), and Target File #14 ([lines 449–461](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L449-L461)).
*   **Problem**:
    1. **Contradictory Theme Resolver**: Target Files #7 and #9 define `resolveProductionCaptionTheme` in `packages/core/src/overrides.ts`, whereas Section 6 and Target File #14 define `resolveCaptionTheme` in `apps/cli/src/produce.ts`.
    2. **`needsLlm` Gate Without `--produce`**: In [`produce.ts:3088`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L3088), `provider` is only created when `opts.produce === true || resolveYoutube(...)`. Running `--choreograph-captions` without `--produce` leaves `provider === null` unless gated in, and naively setting `needsLlm = true` would also trigger `repairTranscript` at [`produce.ts:3197`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L3197).
    3. **Cache Invalidation & Replay Drift on User Cuts**: Keying the cache on post-override `keptWords` with output `start`/`end` timestamps means that cutting words in `ossclip edit` and clicking **Render** (which runs `produce` with `--scenes scenes-reviewed.json`) changes `keptWords` and has no LLM provider during replay.
*   **Action Required**:
    *   Consolidate on a single `resolveProductionCaptionTheme(overrideTheme, flagTheme, configTheme)` in [`apps/cli/src/produce.ts`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts) (matching `resolveProductionColorGrade`), removing the duplicate from `overrides.ts` and `browser.ts`.
    *   In `produce.ts`, instantiate `provider` when `opts.produce === true || resolveYoutube(...) || (choreographCaptions && !opts.scenes)`, while keeping `repairTranscript` gated on `opts.produce === true || resolveYoutube(...)`.
    *   Run `generateCaptionChoreography` before `usage.json` is written ([`produce.ts:3902`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L3902)) against the base-cutlist surviving words (prior to `overrideDoc.cuts` / `overrideDoc.cleanup`, keyed by `{ version, aspect, provider: providerName, model: fastModel, words: survivingWords.map(w => ({ text: w.text, srcStart: Math.round(w.start * 1000) })) }`), and carry `priorCaptionChoreography(work)` forward from `production.json` when `opts.scenes` is set on editor Render replay.

---

### 🟡 Majors

#### M1. Add Mandatory `## Risks & Mitigations` Section to Feature Specification
*   **Sources**: Stage 7 (`D-1`)
*   **Affected Scope**: [`docs/designs/ai-choreographed-captions.md` (lines 294–304)](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L294-L304)
*   **Action Required**: Add an explicit `## Risks & Mitigations` section covering: (1) preview-vs-render choreography stability across editor cuts/replays, (2) static `FaceBox` vs. speaker movement / per-scene framing overrides, (3) multi-row wrapping and overflow under compounded `fontScale` + `emphasisScale`, and (4) `Noto Nastaliq Urdu` RTL pill/box vertical padding.

#### M2. Specify `CaptionOptions` & `captionPackingFor(landscape)` Contract for Choreographed vs. Unchoreographed Lines
*   **Sources**: Stage 7 (`D-4`)
*   **Affected Scope**: Section 3 ([lines 229–232](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L229-L232)) and Target File #2 ([lines 338–348](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L338-L348)).
*   **Action Required**: Specify how `buildCaptionLines` knows whether to apply portrait (`5` words / `2.2s`) vs. landscape (`8` words / `3.2s`) safety ceilings when `opts.choreography` is present (e.g., add `maxChoreographedWords?: number` and `maxChoreographedDuration?: number` to `CaptionOptions` and return `{ maxWordsPerLine: 3, maxLineDuration: 1.2, maxChoreographedWords: 5, maxChoreographedDuration: 2.2 }` from `captionPackingFor(false)` and `{ maxWordsPerLine: 6, maxLineDuration: 2.4, maxChoreographedWords: 8, maxChoreographedDuration: 3.2 }` from `captionPackingFor(true)`).

#### M3. Scope `applyCaptionRangeEdits` `emphasisScale` Preservation and Specify `App.tsx` `RawRenderProps` / `baseCaptionTheme`
*   **Sources**: Stage 7 (`D-5`), Stage 9 (`IR-2`, `IR-5`, `CD-4`, `CD-7`)
*   **Affected Scope**: Goal G6 ([line 35](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L35)), Section 3 ([line 188](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L188)), Target File #7 ([line 395](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L395)), Target File #15 ([lines 462–469](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L462-L469)), and Target File #16 ([line 472](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L472)).
*   **Action Required**:
    *   Clarify that `applyCaptionRangeEdits` preserves `line.role` on all range edits and preserves per-word `emphasisScale` on equal-token-count range edits (while count-changing range edits mint unscaled replacement words via `retimeCaptionTokens`).
    *   In Target File #15 (`apps/editor/src/App.tsx`), specify adding `captionTheme?: CaptionThemeId; baseCaptionTheme?: CaptionThemeId; captionChoreography?: CaptionChoreography;` to `RawRenderProps` ([`App.tsx:147`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L147-L163)), passing `choreography: renderProps.captionChoreography` to **both** `rebuildCaptionTrack` call sites ([`App.tsx:1502`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L1502-L1510) and [`App.tsx:1522`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L1522-L1529)), and resolving `edits.doc.captionTheme ?? renderProps.baseCaptionTheme ?? renderProps.captionTheme` (with `produce.ts` writing `baseCaptionTheme` when CLI/config sets a non-default theme).

#### M4. Specify Exact CSS Values in `CaptionThemeSpec`, Inner Wrapper for `boxed`, and `resolveChoreographedAnchor` Edge Cases
*   **Sources**: Stage 7 (`D-6`), Stage 9 (`IR-4`)
*   **Affected Scope**: Section 2 ([lines 105–158](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L105-L158)), Section 4 ([lines 236–249](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L236-L249)), Target File #10 ([lines 413–420](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L413-L420)), and Target File #11 ([lines 421–432](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L421-L432)).
*   **Action Required**:
    *   Provide concrete CSS values for `shadowStyle`, `lineBoxStyle` (`boxed` inner fit-content wrapper so the dark pill hugs the text rather than spanning 100% of `LineView`'s `left: 0, right: 0` container), and `activeWordPill` (`founder` and `punch` padding, border radius, and `rotate(-1.5deg)` threshold).
    *   In `resolveChoreographedAnchor`:
        1. Require `face != null && face.subject !== "screen"`, normalizing `sizeFrac: face.sizeFrac ?? DEFAULT_FACE.sizeFrac`, and use `headBand({ centerYFrac: face.centerYFrac, sizeFrac: face.sizeFrac ?? DEFAULT_FACE.sizeFrac })` directly in `[0, 1]` frame fractions (matching [`coverTextRect` in `stage.ts:484`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/stage.ts#L484-L485)); when `face == null`, fall through to Priority 3 (`captionAnchorAvoiding`).
        2. Gate eligibility strictly on `(activeCue === null || (activeCue.kind === "plain" && activeCue.layout === "full-bleed"))` so graphic cues using `FULL_BLEED_GRAPHIC_SLOT` are never overlapped.
    *   In `validateCaptionChoreography`, specify deterministic tie-breaking when capping the 25% emphasis budget (`scale` descending, then word index ascending).

#### M5. Specify Prompt Formatting Contract Between `buildCaptionChoreographyPrompt` and `MockProvider`
*   **Sources**: Stage 9 (`CD-8`)
*   **Affected Scope**: Target File #3 ([lines 356–369](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L356-L369)) and Target File #5 ([lines 376–380](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L376-L380)).
*   **Action Required**: Specify the exact line format emitted by `buildCaptionChoreographyPrompt` (e.g., `[${i}|${w.start.toFixed(2)}s-${w.end.toFixed(2)}s] ${w.text}`) and how `MockProvider` parses word indices from the prompt string (`/\[(\d+)\|/g`, matching [`mock.ts:28`](file:///home/ahsanayaz/code/ossclip/packages/core/src/producer/mock.ts#L28)) so mock responses always emit valid in-bounds word indices regardless of transcript length.

#### M6. Trim `dynamic-reflow` YAGNI Scope and Define Terms in the Stage 1 HTML Mock Page
*   **Sources**: Stage 5 (`ZO-2`), Stage 6 (`C-3`), Stage 8 (`IZO-2`)
*   **Affected Scope**: Goal G1 ([line 30](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L30)), CUJ 4 ([line 78](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L78)), and Target File #1 ([lines 325–336](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L325-L336)).
*   **Action Required**: Clearly define `slot-reserved` (all word `<span>`s mounted for the full line duration with unspoken words at `opacity: 0` so flex positions never shift) vs. `dynamic-reflow` (only spoken words laid out, re-centering the line as each word appears) at first mention in G1, and note that `packages/scenes/caption-themes-mock.html` is a self-contained Stage 1 visual verification harness with zero runtime imports or build impact on `@ossclip/scenes`.

---

### 🟢 Nits

#### N1. Align `CaptionLine.role` vs. `anchorY` Terminology in Goals and CUJs
*   **Sources**: Stage 5 (`ZO-1`), Stage 6 (`C-1`), Stage 8 (`IZO-1`)
*   **Affected Scope**: Goals `G5` & `G6` ([lines 34–35](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L34-L35)) and `CUJ 2` & `CUJ 3` ([lines 64, 73](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L64)).
*   **Action Required**: Update `G5`, `G6`, `CUJ 2`, and `CUJ 3` to state that `buildCaptionLines` attaches `role?: "hook" | "impact"` to `CaptionLine` (which `CaptionTrack` resolves to a safe-zone vertical `anchor` at render time), and that `applyCaptionWordHides` preserves `line.role`.

#### N2. Clarify Purpose of `ProductionSchema` Fields (`captionChoreography` Carry-Forward vs. `captionTheme`)
*   **Sources**: Stage 5 (`ZO-4`), Stage 8 (`IZO-4`)
*   **Affected Scope**: CUJ 1 ([line 55](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L55)), Section 3 ([line 166](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L166)), and Target File #6 ([lines 381–387](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L381-L387)).
*   **Action Required**: State explicitly that `captionChoreography` is stored in `ProductionSchema` (`production.json`) so `priorCaptionChoreography(work)` can carry it forward during `--scenes` editor Render replays (matching `sfxPlan` and `overlayPlan`).

#### N3. Fix Markdown Inline Code Escaping and Closing Section Heading Hierarchy
*   **Sources**: Stage 7 (`ST-1`, `ST-2`)
*   **Affected Scope**: [Line 253](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L253) and [lines 307, 315](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L307-L315).
*   **Action Required**: Wrap `` `` fontSize: `${w.emphasisScale}em` `` `` in double backticks on line 253, and promote `### Additional Resources` (line 307) and `### Future Improvements` (line 315) to `##` (H2).

#### N4. Clarify Existing `CaptionGeometryOpts` Interface in `CaptionTrack.tsx`
*   **Sources**: Stage 9 (`CD-9`)
*   **Affected Scope**: Target File #11 ([line 426](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L426)).
*   **Action Required**: Note that `CaptionGeometryOpts` at [`CaptionTrack.tsx:332`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/CaptionTrack.tsx#L332) already has `face?: FaceCrop | null` and `watermark?: boolean`, so only `captionTheme?: CaptionThemeId` needs to be added to `CaptionGeometryOpts` (while `CaptionTrackProps` adds `captionTheme`, `face`, and `watermark`).

#### N5. Editorial Style Cleanup (`Open Questions`, `CUJ 4`, `Alternatives Considered`, and Terminology)
*   **Sources**: Stage 7 (`SY-1`, `SY-2`, `SY-3`), Stage 9 (`SY-4`, `SY-5`)
*   **Affected Scope**: Lines [47](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L47), [79](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L79), [278–290](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L278-L290), [359](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L359), and [430](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L430).
*   **Action Required**: Replace line 47 with `"None."`; replace `"so visual polish can be verified in seconds"` on line 79 with `"without running a Remotion render"`; strip `"Rejected by author:"` after `**Reason for Rejection**:` on lines 278, 284, 290; replace `"natural spoken chunks"` with `"semantic phrases"` on line 359; and replace `"fast byte-identical rendering branch"` with `"pre-existing byte-identical rendering branch"` on line 430.

---

## Traceability Matrix

| Stage & Reviewer | Raw Finding ID | Summary of Raw Finding | Consolidated Action Item | Priority |
| :--- | :--- | :--- | :--- | :--- |
| Stage 5 (`egm-zoom-out`) | `ZO-1` | `CaptionLine.anchorY` vs `role` mismatch; `overlayGeometryFor` in `overlay-room.ts` & missing in `App.tsx` | **B1**, **N1** | 🔴 Blocker / 🟢 Nit |
| Stage 5 (`egm-zoom-out`) | `ZO-2` | `dynamic-reflow` toggle & mock page scope in `packages/scenes/caption-themes-mock.html` | **M6** | 🟡 Major |
| Stage 5 (`egm-zoom-out`) | `ZO-3` | Duplicate `resolveProductionCaptionTheme` (`overrides.ts`) vs `resolveCaptionTheme` (`produce.ts`) | **B4** | 🔴 Blocker |
| Stage 5 (`egm-zoom-out`) | `ZO-4` | Unspecified purpose for `captionTheme` / `captionChoreography` in `ProductionSchema` | **N2** | 🟢 Nit |
| Stage 5 (`egm-inventive-catalyst`) | `IC-0` | No false compromise detected | — | — |
| Stage 6 (`egm-comprehension`) | `C-1` | `G5`/`G6`/`CUJ 2`/`CUJ 3` mention `anchorY` on `CaptionLine`, but Technical Plan stores `role` | **N1** | 🟢 Nit |
| Stage 6 (`egm-comprehension`) | `C-2` | `resolveProductionCaptionTheme` vs `resolveCaptionTheme` naming discrepancy | **B4** | 🔴 Blocker |
| Stage 6 (`egm-comprehension`) | `C-3` | `slot-reserved` vs `dynamic-reflow` referenced in `G1` before definition | **M6** | 🟡 Major |
| Stage 7 (`egm-design`) | `D-1` | Missing mandatory `## Risks & Mitigations` section per `feature-spec-standard.md` | **M1** | 🟡 Major |
| Stage 7 (`egm-design`) | `D-2` | `buildCaptionLines` phrase-flushing merges revived gap words into next phrase | **B3** | 🔴 Blocker |
| Stage 7 (`egm-design`) | `D-3` | Editor cuts bust `captionChoreographyCacheKey` & `needsLlm` gate missing without `--produce` | **B4** | 🔴 Blocker |
| Stage 7 (`egm-design`) | `D-4` | `captionPackingFor(landscape)` limits conflict with choreographed phrase ceilings | **M2** | 🟡 Major |
| Stage 7 (`egm-design`) | `D-5` | `applyCaptionRangeEdits` drops `emphasisScale` on count change; `App.tsx` `overlayGeometryFor` | **B1**, **M3** | 🔴 Blocker / 🟡 Major |
| Stage 7 (`egm-design`) | `D-6` | `resolveChoreographedAnchor` `null` face, `FULL_BLEED_GRAPHIC_SLOT`, and dual-clock words | **M4** | 🟡 Major |
| Stage 7 (`egm-structural`) | `ST-1` | Broken nested single backticks on line 253 | **N3** | 🟢 Nit |
| Stage 7 (`egm-structural`) | `ST-2` | `### Additional Resources` and `### Future Improvements` should be `##` (H2) | **N3** | 🟢 Nit |
| Stage 7 (`egm-style` — Feature) | `SY-1` | Drop workflow meta-commentary in `## Open Questions` (line 47) | **N5** | 🟢 Nit |
| Stage 7 (`egm-style` — Feature) | `SY-2` | Replace promotional phrasing `"visual polish... in seconds"` in `CUJ 4` (line 79) | **N5** | 🟢 Nit |
| Stage 7 (`egm-style` — Feature) | `SY-3` | Strip redundant `"Rejected by author:"` prefix in `## Alternatives Considered` | **N5** | 🟢 Nit |
| Stage 8 (`egm-zoom-out`) | `IZO-1` | Re-verified `ZO-1` + `C-1` (`CaptionLine.role` & `overlay-room.ts` / `App.tsx` plumbing) | **B1**, **N1** | 🔴 Blocker / 🟢 Nit |
| Stage 8 (`egm-zoom-out`) | `IZO-2` | Re-verified `ZO-2` + `C-3` (`dynamic-reflow` & mock page scope) | **M6** | 🟡 Major |
| Stage 8 (`egm-zoom-out`) | `IZO-3` | Re-verified `ZO-3` + `C-2` (single resolver in `produce.ts`) | **B4** | 🔴 Blocker |
| Stage 8 (`egm-zoom-out`) | `IZO-4` | Re-verified `ZO-4` (`ProductionSchema` carry-forward purpose) | **N2** | 🟢 Nit |
| Stage 9 (`egm-implementation-readiness`) | `IR-1` | Wrong target file `overlay-rect.ts` instead of `overlay-room.ts` in Target File #12 | **B1** | 🔴 Blocker |
| Stage 9 (`egm-implementation-readiness`) | `IR-2` | Missing `overlayGeometryFor` update and `baseCaptionTheme` fallback in `App.tsx` | **B1**, **M3** | 🔴 Blocker / 🟡 Major |
| Stage 9 (`egm-implementation-readiness`) | `IR-3` | `needsLlm` gate and `--scenes` replay carry-forward in `produce.ts` | **B4** | 🔴 Blocker |
| Stage 9 (`egm-implementation-readiness`) | `IR-4` | Missing exact CSS values in `CaptionThemeSpec` and `headBand(face)` projection math | **M4** | 🟡 Major |
| Stage 9 (`egm-implementation-readiness`) | `IR-5` | `applyCaptionRangeEdits` behavior on `emphasisScale` when word count changes | **M3** | 🟡 Major |
| Stage 9 (`egm-codebase-details`) | `CD-1` | `overlayGeometryFor` lives in `overlay-room.ts` (not `overlay-rect.ts`); `face` already on `opts` | **B1** | 🔴 Blocker |
| Stage 9 (`egm-codebase-details`) | `CD-2` | Contradictory `resolveProductionCaptionTheme` vs `resolveCaptionTheme` location/signature | **B4** | 🔴 Blocker |
| Stage 9 (`egm-codebase-details`) | `CD-3` | Circular dependency & wrong argument type for `captionKeyFor(w)` in `captions.ts` | **B2** | 🔴 Blocker |
| Stage 9 (`egm-codebase-details`) | `CD-4` | `applyCaptionRangeEdits` drops `emphasisScale` when token count changes | **M3** | 🟡 Major |
| Stage 9 (`egm-codebase-details`) | `CD-5` | Missing `overlayGeometryFor` call-site updates in `produce.ts:4888` and `App.tsx:1732` | **B1** | 🔴 Blocker |
| Stage 9 (`egm-codebase-details`) | `CD-6` | `produce.ts` `needsLlm` gate, pre-`usage.json` ordering, and `priorCaptionChoreography` | **B4** | 🔴 Blocker |
| Stage 9 (`egm-codebase-details`) | `CD-7` | Missing `RawRenderProps` fields, dual `rebuildCaptionTrack` calls, and `baseCaptionTheme` | **M3** | 🟡 Major |
| Stage 9 (`egm-codebase-details`) | `CD-8` | Prompt format contract between `buildCaptionChoreographyPrompt` and `MockProvider` | **M5** | 🟡 Major |
| Stage 9 (`egm-codebase-details`) | `CD-9` | `CaptionGeometryOpts` already exists at `CaptionTrack.tsx:332` with `face` and `watermark` | **N4** | 🟢 Nit |
| Stage 9 (`egm-codebase-details`) | `CD-10` | Ensure `--choreograph-captions` in `replay-argv.ts` never triggers LLM calls when `opts.scenes` is set | **B4** | 🔴 Blocker |
| Stage 9 (`egm-style` — Detailed) | `SY-4` | Standardize `"natural spoken chunks"` to `"semantic phrases"` on line 359 | **N5** | 🟢 Nit |
| Stage 9 (`egm-style` — Detailed) | `SY-5` | Replace `"fast byte-identical rendering branch"` with `"pre-existing..."` on line 430 | **N5** | 🟢 Nit |
