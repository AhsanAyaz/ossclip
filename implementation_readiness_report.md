# Stage 9: Implementation Readiness Test Report (`DetailedRange`: Lines 321–486)

## Part 1: Implementation Readiness Review (`egm-implementation-readiness`)

### Finding 1: Wrong target file named for `overlayGeometryFor` in Target File #12
- **Severity**: Blocker
- **Affected Scope**: Target File #12 ([`ai-choreographed-captions.md`](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L433-L440)), [`packages/scenes/src/overlay-rect.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-rect.ts), and [`packages/scenes/src/overlay-room.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts#L21-L35)
- **Finding & Guidance**: Target File #12 instructs the implementer to modify [`packages/scenes/src/overlay-rect.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-rect.ts) to *"Add optional `captionTheme`, `face`, and `watermark` to `overlayGeometryFor`'s input options in `overlay-rect.ts` and forward them to `captionTopAtFor` / `captionBottomAtFor`."* However, `overlayGeometryFor` does **not** live in `overlay-rect.ts` — it is defined in [`packages/scenes/src/overlay-room.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts#L21-L35), which is missing from the Target Files list entirely. Under a strict Phase 5 file write allowlist, an implementer would be blocked from editing `packages/scenes/src/overlay-room.ts`.
  - **Fix**: Replace `packages/scenes/src/overlay-rect.ts` with [`packages/scenes/src/overlay-room.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts) in Target File #12 (or list `overlay-room.ts` explicitly as the file where `overlayGeometryFor` is modified).

### Finding 2: `App.tsx` `overlayGeometryFor` call site and `baseCaptionTheme` editor reset semantics omitted in Target File #15
- **Severity**: Major
- **Affected Scope**: Target File #15 ([`ai-choreographed-captions.md`](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L462-L469)), [`apps/editor/src/App.tsx`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L1729-L1740), and [`apps/cli/src/produce.ts`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L4886-L4897)
- **Finding & Guidance**:
  1. In [`apps/editor/src/App.tsx`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L1732-L1738), `overlayNoRoom` calls `overlayGeometryFor` directly to determine which overlays lack room beside captions in the live preview. Target File #15 only mentions passing `choreography` to `rebuildCaptionTrack` and setting `captionTheme` on `ProductionCompProps`, omitting the update to `overlayGeometryFor` in `App.tsx` (and in [`produce.ts`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L4888-L4894)) to pass `captionTheme`, `face`, and `watermark`. Without forwarding those props at all three `overlayGeometryFor` call sites (`ProductionComposition.tsx`, `produce.ts`, and `App.tsx`), the editor preview and CLI `produce` will disagree with `CaptionTrack` on overlay room whenever a non-default theme or hook safe-zone anchor is active.
  2. In `produce.ts`, `render-props.json` bakes overrides into `props.captionTheme`. If `overrides.json` had `captionTheme: "punch"` during `produce` and the user later removes `captionTheme` from `overrides.json` in the editor, `edits.doc.captionTheme ?? renderProps.captionTheme` in `App.tsx` will still evaluate to `"punch"` unless `produce.ts` also writes `baseCaptionTheme` (the CLI flag / config resolution prior to `overrides.json`, mirroring `baseTheme` and `captionsHiddenByFlag` in [`App.tsx`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L147-L163)) or resolves `edits.doc.captionTheme ?? renderProps.baseCaptionTheme ?? renderProps.captionTheme`. Specify this explicitly so the implementer does not have to invent the fallback field.

### Finding 3: `needsLlm` gate and replay carry-forward behavior for `--choreograph-captions` in `produce.ts` are underspecified
- **Severity**: Major
- **Affected Scope**: Target File #14 ([`ai-choreographed-captions.md`](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L449-L461)) and [`apps/cli/src/produce.ts`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L3088-L3105)
- **Finding & Guidance**:
  1. In [`produce.ts`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L3088), `provider` is only instantiated when `const needsLlm = opts.produce === true || resolveYoutube(opts.youtube, cfg.youtube);` is true. Because Goal G4 states `--choreograph-captions` must work *with or without `--produce`*, Target File #14 must explicitly instruct the implementer to include `choreographCaptions` in `needsLlm` (or instantiate `provider` when `choreographCaptions` is enabled); otherwise `provider` is `null` on a `--choreograph-captions` run without `--produce`.
  2. When the editor's Render button replays `command.json` (which passes `--scenes <workdir>/scenes.json` or runs after user cuts), how does `produce.ts` handle `captionChoreography` if no LLM provider is available or if `production.json` already has `captionChoreography`? Specify where in `produce.ts`'s timeline `generateCaptionChoreography` runs.

### Finding 4: Missing exact visual/CSS values in `CaptionThemeSpec` and `resolveChoreographedAnchor` projection math
- **Severity**: Major
- **Affected Scope**: Target File #10 ([`ai-choreographed-captions.md`](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L413-L420)), Target File #11 ([`ai-choreographed-captions.md`](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L421-L432)), and Technical Plan §2 & §4
- **Finding & Guidance**: To satisfy the Zero-Decision Rule, concrete CSS values (`shadowStyle`, `lineBoxStyle` inner pill sizing, `activeWordPill` padding/rotation) and the exact `headBand(face)` projection formula in `resolveChoreographedAnchor` need to be stated explicitly rather than left to the implementer's discretion.

### Finding 5: `applyCaptionRangeEdits` behavior on `emphasisScale` when word count is unchanged
- **Severity**: Nit
- **Affected Scope**: Target File #7 ([`ai-choreographed-captions.md`](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L389-L397)), Target File #16 ([`ai-choreographed-captions.md`](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L472)), and [`packages/core/src/overrides.ts`](file:///home/ahsanayaz/code/ossclip/packages/core/src/overrides.ts#L2108-L2192)
- **Finding & Guidance**: Clarify in Target File #7 / #16 that `applyCaptionRangeEdits` preserves `line.role` on all range edits and preserves per-word `emphasisScale` on equal-count range edits (while count-changing range edits mint unscaled replacement words).

---

## Part 2: Codebase Details Audit (`egm-codebase-details`)

### Finding 1: 🔴 Blocker — Non-Existent Reference in `overlay-rect.ts` and Missing Target File `packages/scenes/src/overlay-room.ts` for `overlayGeometryFor`
- **Severity**: Blocker
- **Affected Scope**: Target File #12 ([`ai-choreographed-captions.md`](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L433-L440)), [`packages/scenes/src/overlay-rect.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-rect.ts#L1-L245), and [`packages/scenes/src/overlay-room.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts#L21-L35)
- **Discrepancy Description & Rationale**: `overlayGeometryFor` does not exist in `overlay-rect.ts` — it is defined in `packages/scenes/src/overlay-room.ts`. Additionally, `face?: FacePoint | null` is already present on `overlayGeometryFor`'s `opts` (`overlay-room.ts:25`), currently passed to `videoRectAtFor` but not forwarded to `captionTopAtFor` / `captionBottomAtFor`. Replace `packages/scenes/src/overlay-rect.ts` with `packages/scenes/src/overlay-room.ts`, add `captionTheme?: CaptionThemeId` and `watermark?: boolean` to `overlayGeometryFor`'s `opts`, and forward `{ captionTheme: opts.captionTheme, face: opts.face, watermark: opts.watermark }` to both `captionTopAtFor` and `captionBottomAtFor`.

### Finding 2: 🔴 Blocker — Contradictory Function Name, Module Location, and Precedence Contract (`resolveProductionCaptionTheme` in `overrides.ts` vs. `resolveCaptionTheme` in `produce.ts`)
- **Severity**: Blocker
- **Affected Scope**: Technical Plan §6 ([line 264](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L264)), Target File #7 ([line 396](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L396)), Target File #9 ([line 409](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L409)), Target File #14 ([line 456](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L456)), and [`apps/cli/src/produce.ts`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L1035-L1063)
- **Discrepancy Description & Rationale**: Item 7 and Item 9 define and re-export `resolveProductionCaptionTheme` from `packages/core/src/overrides.ts`, whereas line 264 and Item 14 instruct implementing `resolveCaptionTheme` in `apps/cli/src/produce.ts`. In the codebase, `resolveProductionColorGrade` and `resolveSfxLevel` live in `apps/cli/src/produce.ts`. Unify all references on one function name, module location, and exact signature.

### Finding 3: 🔴 Blocker — Circular Dependency & Wrong Parameter Type for `captionKeyFor(w)` in `packages/core/src/captions.ts`
- **Severity**: Blocker
- **Affected Scope**: [`docs/designs/ai-choreographed-captions.md`](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L229-L231) and Target File #2 ([line 343](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L343-L348))
- **Discrepancy Description & Rationale**: In `packages/core/src/overrides.ts:1539`, `captionKeyFor(srcStart: number): string` takes a `number` (`srcStart`), not a `CaptionWord` (`w`). Moreover, `overrides.ts` imports from `./captions`, so importing `captionKeyFor` from `./overrides` into `captions.ts` creates a circular dependency. Move `captionKeyFor(srcStart: number): string` into `packages/core/src/captions.ts` and re-export it from `packages/core/src/overrides.ts`, and call `captionKeyFor(w.srcStart)`.

### Finding 4: 🟡 Major — `applyCaptionRangeEdits` Drops `emphasisScale` When a Range Edit Changes Token Count
- **Severity**: Major
- **Affected Scope**: [`docs/designs/ai-choreographed-captions.md`](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L188), [line 472](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L472), and [`packages/core/src/overrides.ts`](file:///home/ahsanayaz/code/ossclip/packages/core/src/overrides.ts#L2112-L2187)
- **Discrepancy Description & Rationale**: `applyCaptionRangeEdits` only spreads `{ ...w, text }` on the equal-word-count fast path (`tokens.length === slice.length`). When a range edit merges or splits words, `retimeCaptionTokens` constructs fresh `{ text, start, end, srcStart }` objects and drops `emphasisScale`. Explicitly scope `emphasisScale` preservation to equal-count `applyCaptionRangeEdits` (while `line.role` is preserved on all range edits).

### Finding 5: 🟡 Major — Missing `overlayGeometryFor` Call-Site Updates in `apps/cli/src/produce.ts` and `apps/editor/src/App.tsx`
- **Severity**: Major
- **Affected Scope**: Items 13, 14, and 15 ([`ai-choreographed-captions.md`](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L446-L469))
- **Discrepancy Description & Rationale**: `overlayGeometryFor` is called in `ProductionComposition.tsx:306`, `produce.ts:4888`, and `App.tsx:1732`. Update Items 14 and 15 to pass `captionTheme` and `watermark` (`face` is already passed) at `produce.ts:4888` and `App.tsx:1732`.

### Finding 6: 🟡 Major — Incomplete `apps/cli/src/produce.ts` Lifecycle Specification (`needsLlm` Gate, Cutlist/Usage Ordering, and `--scenes` Replay Carry-Forward)
- **Severity**: Major
- **Affected Scope**: Item 14 ([`ai-choreographed-captions.md`](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L450-L460))
- **Discrepancy Description & Rationale**: Specify (1) adding `(choreographOn && !opts.scenes)` to `needsLlm` at `produce.ts:3088`, (2) running `generateCaptionChoreography` before `usage.json` is written at `produce.ts:3902` on automatic-cutlist-filtered words so `"caption_choreography"` usage is recorded in `usage.json` and editor user cuts do not invalidate the cache, and (3) `priorCaptionChoreography(work)` carry-forward when `opts.scenes` is set during editor Render replay.

### Finding 7: 🟡 Major — Missing `RawRenderProps` Fields, Dual `rebuildCaptionTrack` Call Sites, and `baseCaptionTheme` Reset Fallback in `apps/editor/src/App.tsx`
- **Severity**: Major
- **Affected Scope**: Item 15 ([`ai-choreographed-captions.md`](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L462-L469)) and [`apps/editor/src/App.tsx`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L147-L163)
- **Discrepancy Description & Rationale**: Specify adding `captionTheme?: CaptionThemeId; baseCaptionTheme?: CaptionThemeId; captionChoreography?: CaptionChoreography;` to `RawRenderProps` in `App.tsx`, passing `choreography: renderProps.captionChoreography` to both `rebuildCaptionTrack` call sites (`App.tsx:1502` and `App.tsx:1522`), and resolving `doc.captionTheme ?? renderProps.baseCaptionTheme ?? renderProps.captionTheme`.

### Finding 8: 🟡 Major — Underspecified Prompt Format Contract Between `buildCaptionChoreographyPrompt` and `MockProvider` (`packages/core/src/producer/mock.ts`)
- **Severity**: Major
- **Affected Scope**: Items 3 & 5 ([`ai-choreographed-captions.md`](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L356-L379)) and [`packages/core/src/producer/mock.ts`](file:///home/ahsanayaz/code/ossclip/packages/core/src/producer/mock.ts#L16-L62)
- **Discrepancy Description & Rationale**: Specify how `buildCaptionChoreographyPrompt` formats word timestamps/tokens and how `MockProvider` extracts valid `srcStart` timestamps from the prompt so `validateCaptionChoreography` matches them against `words`.

### Finding 9: 🟢 Nit — Clarify `CaptionGeometryOpts` in `packages/scenes/src/CaptionTrack.tsx`
- **Severity**: Nit
- **Affected Scope**: Item 11 ([`ai-choreographed-captions.md`](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L426))
- **Discrepancy Description & Rationale**: Note that `CaptionGeometryOpts` already exists at `CaptionTrack.tsx:332` (`interface CaptionGeometryOpts { face?: FaceCrop | null; watermark?: boolean; }`) and only needs `captionTheme?: CaptionThemeId` added to it.

### Finding 10: 🟢 Nit — Clarify `--choreograph-captions` Replay Semantics in `apps/cli/src/replay-argv.ts`
- **Severity**: Nit
- **Affected Scope**: Item 14 ([`ai-choreographed-captions.md`](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L460))
- **Discrepancy Description & Rationale**: Ensure that when `opts.scenes` is set on editor Render replay, `--choreograph-captions` only enables reading cached/prior choreography (`priorCaptionChoreography(work)`) and never triggers a fresh LLM call.

---

## Part 3: Style Review (`egm-style` — `DetailedRange`)

1. **Severity**: Nit
   - **Affected Scope**: `#### 3. packages/core/src/producer/caption-choreography.ts` ([line 359](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L359))
   - **Style Rationale**: Terminology consistency—uses `"natural spoken chunks"` where the rest of the specification uses `"semantic phrases"`. Standardize on `"semantic phrases"`.

2. **Severity**: Nit
   - **Affected Scope**: `#### 11. packages/scenes/src/CaptionTrack.tsx` ([line 430](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L430))
   - **Style Rationale**: Subjective adjective—`"Keep the fast byte-identical rendering branch"` uses `"fast"` where the architectural intent is preserving the `"pre-existing byte-identical rendering branch"`.
