# Stage 7: Critic Review Report (`FeatureRange`: Lines 1–320)

## Part 1: Design Critic Review (`egm-design`)

### Finding 1: Missing Mandatory "Risks & Mitigations" Section
* **Severity**: Major
* **Affected Scope**: [`docs/designs/ai-choreographed-captions.md` (lines 294–304)](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L294-L304) vs. [`feature-spec-standard.md` (lines 23–28, 38–39)](file:///home/ahsanayaz/.gemini/config/plugins/egm/resources/document_standards/feature-spec-standard.md#L23-L39)
* **Finding & Recommendation**:
  * **Finding**: The Feature Specification Standard requires an explicit **Risks & Mitigations** (or *Risks & Limits*) section identifying constraints, potential failure modes, scalability limits, and how they are mitigated. Lines 294–304 only provide `## Non-Functional Requirements` with happy-path token estimates and a single note on LLM failure fallback.
  * **Recommendation**: Add a dedicated `## Risks & Mitigations` section before line 305 that explicitly documents architectural constraints and mitigations, including:
    1. **Preview-vs-Render Choreography Drift**: How edits/cuts in `ossclip edit` avoid busting the choreography cache or shifting `captionLineTiming` anchors on subsequent renders.
    2. **Static `FaceBox` vs. Dynamic Speaker Movement / Idle Zoom**: How `HEAD_TOP_MARGIN` / `CHIN_BOTTOM_MARGIN` ([`stage.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/stage.ts#L76-L86)) and per-scene video framing overrides (`cue.video.scale`, `cue.video.dy`) interact with `resolveChoreographedAnchor`.
    3. **Line Wrapping & Overflow Under Compounded Scales**: How a 5-word portrait phrase with `punch` (`fontScale: 1.08`, `uppercase`) and two `1.4x` emphasized words behaves in `estimateCaptionRows` and `captionBlockExtent` so it does not overflow `SAFE_AREA` or collide with `OverlayTrack`.
    4. **Nastaliq RTL Pill/Box Geometry**: How `founder` and `punch` active-word pills avoid clipping `Noto Nastaliq Urdu` ascenders/descenders (`2.5x` em extent noted in [`CaptionTrack.tsx`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/CaptionTrack.tsx#L159-L169)).

---

### Finding 2: `buildCaptionLines` Phrase-Flushing Breaks When Editor Revives Cut Material
* **Severity**: Blocker
* **Affected Scope**: [`docs/designs/ai-choreographed-captions.md` (lines 229–233)](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L229-L233), [`packages/core/src/captions.ts` (`buildCaptionLines`)](file:///home/ahsanayaz/code/ossclip/packages/core/src/captions.ts#L244-L314), and [`apps/editor/src/liveCaptionTrack.ts` (`rebuildCaptionTrack`)](file:///home/ahsanayaz/code/ossclip/apps/editor/src/liveCaptionTrack.ts#L113-L147)
* **Finding & Recommendation**:
  * **Finding**: Line 231 specifies that when `opts.choreography` is present, `buildCaptionLines` flushes whenever `w.srcStart > activePhrase.endSrcSec + 1e-6`. However, `generateCaptionChoreography` only sees the initial `keptWords` from `produce`. In `ossclip edit`, the primary reason [`rebuildCaptionTrack`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/liveCaptionTrack.ts#L113-L147) re-runs `buildCaptionLines` in the browser is when a user **vetoes a cleanup removal** (reviving cut words; see [`App.tsx`](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L1483-L1541)). When words are revived, two failure modes occur under the proposed rule:
    1. **Revived words between two phrases**: Suppose `phrase[0]` covers `[1.0s, 2.0s]` and `phrase[1]` covers `[5.0s, 6.0s]` because `[2.0s, 5.0s]` was cut during `produce`. When the user revives `[2.0s, 5.0s]`, the first revived word at `2.5s` flushes `phrase[0]` and advances `activePhrase` to `phrase[1]`. Subsequent revived words (`3.0s, 3.5s, 4.5s`) satisfy `w.srcStart <= phrase[1].endSrcSec` (`6.0s`), so they are packed using choreographed limits and **merged into the first words of `phrase[1]`** (even inheriting `phrase[1].role` if it is `"hook"` or `"impact"`).
    2. **Revived words inside a phrase spanning a cut seam**: If the LLM grouped kept words across a removed silence/retake seam into a single `"hook"` or `"impact"` phrase `[startSrcSec, endSrcSec]`, reviving that cut inserts new words *inside* `[startSrcSec, endSrcSec]`. When the safety ceiling splits that expanded span into multiple lines, every resulting line satisfies *"all surviving words in a flushed line came from a `'hook'` or `'impact'` phrase"* (line 232), duplicating `"hook"` or `"impact"` roles across multiple lines and violating the spatial budget.
  * **Recommendation**: Tighten the phrase-matching algorithm in Section 3 (lines 229–233):
    1. Define a word `w` as belonging to `phrase` iff `w.srcStart >= phrase.startSrcSec - 1e-6 && w.srcStart <= phrase.endSrcSec + 1e-6`.
    2. Flush the current line both when leaving a choreographed phrase (`w.srcStart > activePhrase.endSrcSec + 1e-6`) **and** when transitioning from an unchoreographed gap into the next choreographed phrase (`w.srcStart >= nextPhrase.startSrcSec - 1e-6`).
    3. Pack words falling outside any `CaptionChoreographyPhrase` using standard unchoreographed limits (`3` words / `1.2s` portrait; `6` words / `2.4s` landscape) with `role: undefined`.
    4. If a choreographed phrase is split into multiple lines (whether by `breakpoints`, `maxGap`, or the safety ceiling after mid-phrase words are revived), only the **first** sub-line of a `"hook"` phrase may retain `role: "hook"`, and any split `"impact"` phrase must drop `role` (`undefined`).

---

### Finding 3: Editor Preview vs. Render Divergence on User Cuts (`captionChoreographyCacheKey` & Provider Gate)
* **Severity**: Blocker
* **Affected Scope**: [`docs/designs/ai-choreographed-captions.md` (lines 58–74, 166, 268–270)](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L58-L74) & [`apps/cli/src/produce.ts` (lines 3088, 4725–4764)](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L3088)
* **Finding & Recommendation**:
  * **Finding**:
    1. **Cache Invalidation & Preview-Render Drift on Editor Cuts**: CUJ 3 (lines 68–73) promises that cutting words or toggling silence removals in `ossclip edit` re-packs captions deterministically from the stored `CaptionChoreography`. However, Section 6 (line 269) keys `<workdir>/caption-choreography-<hash>.json` on `keptWords.map(w => ({ text: w.text, start: w.start, end: w.end }))`, and `produce.ts` never reads `captionChoreography` back from `production.json`. When a user cuts a sentence or vetoes a silence removal in `ossclip edit` and clicks **Render**, `keptWords` (and their output `start`/`end` stamps) change. This busts the cache key on Render, triggering a brand-new LLM call that regroups phrases differently from what the editor just previewed—and invalidates user `captionLineTiming` / `captionLineWindows` overrides whose line-start anchors shift.
    2. **Missing LLM Provider When Running Without `--produce`**: Goal G4 (line 33) and CUJ 2 (line 59) state that `--choreograph-captions` operates with or without `--produce`. However, in [`produce.ts` (line 3088)](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L3088), `provider` is only instantiated when `const needsLlm = opts.produce === true || resolveYoutube(opts.youtube, cfg.youtube)`. Furthermore, if `choreographCaptions` simply flips `needsLlm = true`, [`produce.ts` (line 3197)](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L3197) (`else if (provider)`) will also run the editorial-tier `repairTranscript` LLM pass and interactive confirmation prompts on runs that only asked for `--choreograph-captions`.
  * **Recommendation**:
    1. Compute `captionChoreography` (and `captionChoreographyCacheKey`) against the kept words of the **base cutlist** (before `overrideDoc.cuts` and `overrideDoc.cleanup` user overrides, using source timestamps `srcStart` rather than output `start`/`end`, plus `providerName` / `fastModel`), and carry `priorCaptionChoreography(work)` forward from `production.json` on `--scenes` replay (matching `priorSfxPlan` and `priorOverlayPlan` in [`produce.ts`](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L4797-L4803)). That way, user cuts in `ossclip edit` and subsequent editor Renders use the exact same `CaptionChoreography` with zero extra LLM calls.
    2. Explicitly specify in Section 6 how `produce.ts` instantiates `provider` when `choreographCaptions` is enabled without `--produce` (and whether `--choreograph-captions` alone should bypass or enable `repairTranscript`).

---

### Finding 4: `CaptionOptions` & `captionPackingFor(landscape)` Conflict With Choreographed Safety Ceilings
* **Severity**: Major
* **Affected Scope**: [`docs/designs/ai-choreographed-captions.md` (lines 229–232)](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L229-L232), [`packages/core/src/captions.ts` (`captionPackingFor`, `buildCaptionLines`)](file:///home/ahsanayaz/code/ossclip/packages/core/src/captions.ts#L235-L254), and [`apps/editor/src/liveCaptionTrack.ts` (line 127)](file:///home/ahsanayaz/code/ossclip/apps/editor/src/liveCaptionTrack.ts#L127-L130)
* **Finding & Recommendation**:
  * **Finding**: Both [`produce.ts` (line 4732)](file:///home/ahsanayaz/code/ossclip/apps/cli/src/produce.ts#L4732) and [`liveCaptionTrack.ts` (line 129)](file:///home/ahsanayaz/code/ossclip/apps/editor/src/liveCaptionTrack.ts#L129) call `buildCaptionLines(transcript, map, { breakpoints, ...captionPackingFor(landscape) })`. `captionPackingFor(landscape)` explicitly sets `maxWordsPerLine: 3, maxLineDuration: 1.2` (portrait) or `maxWordsPerLine: 6, maxLineDuration: 2.4` (landscape), and `CaptionOptions` has no `landscape` boolean. If `buildCaptionLines` honors `opts.maxWordsPerLine` and `opts.maxLineDuration`, it will still flush choreographed phrases at 3 words / 1.2s in portrait, defeating 4–5 word semantic phrases. If it ignores `opts.maxWordsPerLine` when `opts.choreography` is provided, it cannot distinguish portrait (`5` words / `2.2s`) from landscape (`8` words / `3.2s`).
  * **Recommendation**: Specify the exact option contract in Section 3: either add `landscape?: boolean` (or `maxChoreographedWords?: number` / `maxChoreographedDuration?: number`) to `CaptionOptions` and `captionPackingFor(landscape)`, or derive the choreographed safety ceiling relative to `maxWordsPerLine` / `maxLineDuration` while preserving standard limits for unchoreographed gap words.

---

### Finding 5: Unbacked Assertion in G6 (`applyCaptionRangeEdits` Drops `emphasisScale`) & Missing Editor `overlayGeometryFor` Plumbing
* **Severity**: Major
* **Affected Scope**: [`docs/designs/ai-choreographed-captions.md` (lines 35, 100, 247–249, 266)](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L247-L249), [`packages/core/src/overrides.ts` (`retimeCaptionTokens`, `applyCaptionRangeEdits`)](file:///home/ahsanayaz/code/ossclip/packages/core/src/overrides.ts#L1966-L1983), [`packages/scenes/src/overlay-room.ts` (`overlayGeometryFor`)](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts#L21-L35), and [`apps/editor/src/App.tsx` (line 1732)](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L1732-L1739)
* **Finding & Recommendation**:
  * **Finding**:
    1. **Count-Changed Range Edits Lose `emphasisScale`**: Goal G6 (line 35) asserts that `emphasisScale` is preserved across `applyCaptionRangeEdits`. While the equal-word-count fast path in [`applyCaptionRangeEdits` (lines 2108–2120)](file:///home/ahsanayaz/code/ossclip/packages/core/src/overrides.ts#L2108-L2120) preserves `w.emphasisScale` via `{ ...w, text }`, any range edit that changes the word count calls [`retimeCaptionTokens` (lines 1966–1983)](file:///home/ahsanayaz/code/ossclip/packages/core/src/overrides.ts#L1966-L1983), which constructs fresh `{ text, start, end, srcStart }` objects and strips `emphasisScale`.
    2. **Editor `overlayNoRoom` Missing `captionTheme`, `face`, and `watermark`**: Section 4 (lines 247–249) states that `OverlayTrack` and `overlaysWithoutRoom` in `produce.ts` automatically clear upper-zone hook captions and enlarged emphasis words via `captionBlockExtent`. However, `overlayGeometryFor` (which lives in [`packages/scenes/src/overlay-room.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts#L21-L35)) is called in **three** places: `produce.ts#L4888`, `ProductionComposition.tsx#L216`, and [`apps/editor/src/App.tsx` (line 1732)](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L1732-L1739) (`overlayNoRoom`).
  * **Recommendation**:
    1. Either specify how `retimeCaptionTokens` / `applyCaptionRangeEdits` propagates `emphasisScale` when word count changes, or narrow Goal G6 to state that equal-count retypes/range edits preserve `emphasisScale` while count-changing range rewrites reset per-word emphasis on the rewritten span while preserving `line.role`.
    2. Update Section 1 (Mermaid diagram) and Section 4 (lines 247–249) to reference [`overlay-room.ts` (`overlayGeometryFor`)](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/overlay-room.ts#L21-L35) and [`App.tsx` (`overlayNoRoom`)](file:///home/ahsanayaz/code/ossclip/apps/editor/src/App.tsx#L1732-L1739) so all three callers pass `captionTheme`, `face`, and `watermark`.

---

### Finding 6: `resolveChoreographedAnchor` & `validateCaptionChoreography` Edge Cases (`null` Face, `FULL_BLEED_GRAPHIC_SLOT`, and Dual-Clock Words)
* **Severity**: Major
* **Affected Scope**: [`docs/designs/ai-choreographed-captions.md` (lines 196–205, 239–246)](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L196-L246), [`packages/scenes/src/CaptionTrack.tsx`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/CaptionTrack.tsx#L196-L216), and [`packages/scenes/src/stage.ts`](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/stage.ts#L452-L651)
* **Finding & Recommendation**:
  * **Finding**:
    1. **Null `face` or Optional `face.sizeFrac`**: In [`FaceCropSchema`](file:///home/ahsanayaz/code/ossclip/packages/core/src/scene-schema.ts#L244), `sizeFrac` is `.optional()`, and `face` on `ProductionCompProps` can be `null` or `undefined` when no face was detected.
    2. **Graphic Cues on `full-bleed` Layout (`FULL_BLEED_GRAPHIC_SLOT`)**: Line 240 states `resolveChoreographedAnchor` is eligible when `activeCue` has `layout === "full-bleed"` with `kind === "plain"`, *"or no graphic occupying the frame"*. In `ossclip`, a graphic cue (`kind !== "plain"`) whose layout is `"full-bleed"` renders its graphic in [`FULL_BLEED_GRAPHIC_SLOT` (`y: 0.24, h: 0.36`)](file:///home/ahsanayaz/code/ossclip/packages/scenes/src/stage.ts#L635)—right where an upper hook caption would land.
    3. **Output vs. Source Clock in `validateCaptionChoreography` & Tie-Breaking**: Lines 202–204 enforce the `4.0s` hook window and `15.0s` impact spacing in **output seconds**, then convert word indices into `startSrcSec`, `endSrcSec`, and `captionKeyFor({ srcStart })` in **source seconds**.
  * **Recommendation**:
    1. In `resolveChoreographedAnchor`, require a non-null measured `face` (`face != null && face.subject !== "screen"`) and normalize `sizeFrac: face.sizeFrac ?? DEFAULT_FACE.sizeFrac`; when `face == null`, fall through to Priority 3 (`captionAnchorAvoiding`).
    2. Gate `resolveChoreographedAnchor` strictly on `(activeCue === null || (activeCue.kind === "plain" && activeCue.layout === "full-bleed"))`.
    3. Specify that `generateCaptionChoreography` and `validateCaptionChoreography` accept mapped kept words carrying both output `{ start, end }` and source `srcStart` (`{ text: string; start: number; end: number; srcStart: number }`), and define deterministic tie-breaking for the emphasis budget (e.g., sort by `scale` descending, then `word` index ascending).

---

## Part 2: Structural Review (`egm-structural`)

### Finding 1: Broken Inline Code Backtick Formatting
* **Severity**: Nit
* **Affected Scope**: [ai-choreographed-captions.md](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L253) (`### 5. Spatial vs. Temporal Word Sizing and Progressive word-build in LineView`, line 253)
* **Discrepancy Description & Rationale**: Line 253 contains unescaped nested single backticks: `` `fontSize: `${w.emphasisScale}em`` ``. Wrap the expression in double backticks with spaces (e.g., ``` `` fontSize: `${w.emphasisScale}em` `` ```) so the template literal renders inside a single code span.

### Finding 2: Heading Level Mismatch on Top-Level Closing Sections
* **Severity**: Nit
* **Affected Scope**: [ai-choreographed-captions.md](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L305-L318) (`### Additional Resources` and `### Future Improvements`, lines 307 and 315)
* **Discrepancy Description & Rationale**: `### Additional Resources` (line 307) and `### Future Improvements` (line 315) are placed after a section-dividing horizontal rule (`---` at line 305) as standalone closing sections, but use `###` (H3) instead of `##` (H2). Promote both headings to `##` (H2).

---

## Part 3: Style Review (`egm-style` — `FeatureRange`)

1. **Severity**: Nit
   - **Affected Scope**: `## Open Questions` ([line 47](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L47))
   - **Style Rationale**: Process meta-commentary (`"all initial product and architectural ambiguities were resolved during the /egm:egm-brainstorm phase"`) adds workflow noise that is not useful to a fresh reader of the specification. Editorial action: `DROP` the workflow reference and state `"None."`

2. **Severity**: Nit
   - **Affected Scope**: `### CUJ 4: Visually Validating Themes in the Interactive HTML Mock Page` ([line 79](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L79))
   - **Style Rationale**: `"so visual polish can be verified in seconds"` uses subjective/promotional phrasing (`"visual polish"`, `"in seconds"`). Replace with a factual statement of the mechanism, e.g., `"without running a Remotion render."`

3. **Severity**: Nit
   - **Affected Scope**: `## Alternatives Considered` ([lines 278, 284, 290](file:///home/ahsanayaz/code/ossclip/docs/designs/ai-choreographed-captions.md#L278-L290))
   - **Style Rationale**: Synonym redundancy—repeating `"Rejected by author:"` immediately after the bold label `**Reason for Rejection**:` adds boilerplate words without adding signal. Strip the `"Rejected by author:"` prefix.
