# Phase 1 — The Stage, the Scene Library, and the Producer Brain

*Companion to `BRAINSTORM.md` (§4.4, §4.6, §8 Phase 1) and `docs/PHASE0.md`. Phase 0 proved the cut; this phase makes the frame do something. Reference screenshots live in `reference/` — they are the acceptance target for the look.*

## Goal

Turn a cut, captioned take into a **produced** video: title cards, stat cards, rule cards, diagrams and mockups, with the speaker demoted into a slot when a graphic owns the frame — planned by an LLM against a hand-built component library.

```
ossclip produce input.mp4 --cleanup standard --produce -o out.mp4
ossclip produce input.mp4 --scenes my-scenes.json -o out.mp4   # no LLM, hand-authored
```

## Acceptance criteria

1. A `scenes[]` array on the Production doc drives the frame. Rendering a hand-written `scenes.json` produces the right visuals **with no LLM in the loop** — the whole phase is testable offline.
2. At least these layouts render correctly and hold the speaker's audio continuous across every scene boundary: `full-bleed`, `video-top`, `pip-bubble`, `graphic-only`, `blurred-behind`.
3. Eight scene components exist, are art-directed once by hand, and cover the observed Opus grammar (table in §3). Each validates its props with zod and renders from JSON alone.
4. `ossclip produce --produce` calls an LLM that emits a beat sheet + scene props, every scene zod-parses, and an invalid scene degrades to a `TitleCard` (or is dropped) rather than failing the render.
5. Scene timings live in **output time** and survive a re-cut: change `--cleanup` and the scenes still land on the words they belong to (they are anchored to transcript ranges, not raw seconds — §5).
6. `props` and `overrides` are stored separately from day one; re-running the producer replaces `props` and leaves `overrides` untouched.
7. `ossclip studio` shows the composition with scenes for visual debugging.

## 1. The architectural change: the frame is a stage

Phase 0 assumed graphics are overlays on full-bleed video. **The reference contradicts that.** In `reference/Screenshot 2026-07-26 at 21.08.10.png` the speaker is a small circle at the bottom while a screenshot and two rule cards own the frame; in `21.07.30.png` the video is cropped to a top block with a stat card beneath it; in `21.08.28.png` it is a top half with a title card below.

So the composition is not `video + overlays`. It is a **stage with slots**, and the talking head is one occupant competing for space:

```
ProductionComposition
└─ Stage (resolves the active scene's layout → slot rects)
   ├─ videoSlot   → <EdlVideo> (rect, cornerRadius, mask: none | circle, blur)
   ├─ graphicSlot → <SceneComponent {...props} />   (the scene library)
   └─ CaptionTrack (own slot, layout-aware safe area)
```

`EdlVideo` must stop owning the frame: it takes a rect (and optional circular mask / blur) and renders inside it. Its EDL playback, punch-in and audio fades are unchanged — critically, **the base audio track is continuous and independent of scenes**. A scene never cuts the audio; it only changes what is on screen.

Layouts, all 1080×1920:

| Layout | Video slot | Graphic slot |
|---|---|---|
| `full-bleed` | whole frame | none (captions only) |
| `video-top` | top block, ~0–45% height | below, ~48–92% |
| `pip-bubble` | circle, ~Ø300 px, lower third | most of the frame above |
| `graphic-only` | hidden (audio continues) | whole safe area |
| `blurred-behind` | whole frame, blurred + dimmed | centered over it |

## 2. Schema additions (`packages/core/src/schema.ts`)

```ts
export const LayoutSchema = z.enum([
  "full-bleed", "video-top", "pip-bubble", "graphic-only", "blurred-behind",
]);

/** Where a scene sits, anchored to the transcript so it survives a re-cut. */
export const SceneAnchorSchema = z.object({
  /** Indices into transcript.words — the authoritative anchor. */
  startWord: z.number().int().nonnegative(),
  endWord: z.number().int().nonnegative(),
});

export const SceneSchema = z.object({
  id: z.string(),
  anchor: SceneAnchorSchema,
  /** Resolved from the anchor via the TimeMap at assembly time. */
  startSec: z.number().nonnegative().optional(),
  endSec: z.number().nonnegative().optional(),
  layout: LayoutSchema,
  component: SceneComponentIdSchema,          // "TitleCard" | "StatCard" | …
  props: z.record(z.unknown()),               // LLM-owned, validated per component
  overrides: z.record(z.unknown()).default({}), // user-owned, never clobbered
  /** Why the producer chose this — shown in the report, useful for debugging taste. */
  rationale: z.string().optional(),
});

// ProductionSchema gains:
scenes: z.array(SceneSchema).optional(),
theme: ThemeSchema.optional(),   // tokens: fonts, colors, radius, card styles
```

Resolution order at render: `{...componentDefaults, ...props, ...overrides}`.

**Anchor to words, not seconds.** Seconds break the moment `--cleanup` changes; word indices survive, and the TimeMap already maps word → output time (`mapWord`). Resolve `startSec`/`endSec` during assembly and never persist them as the source of truth.

## 3. The scene library (`packages/scenes/src/scenes/`)

Eight components, each a pure function of JSON props, each with an exported zod schema and a `defaultProps`. Taste lives here and is hand-tuned once — the LLM never writes CSS.

| Component | Covers (reference) | Core props |
|---|---|---|
| `TitleCard` | "CODE CHURN", "VERIFICATION FIRST" | `eyebrow?`, `title`, `emphasis?`, `checkbox?` |
| `StatCard` | "TASKS SHIPPED +34%" | `label`, `value`, `caption?`, `inverted?` |
| `RuleCard` | "CAPACITY RULE / CAP ACTIVE AGENTS" | `kicker`, `text`, `struck?` |
| `StrikethroughReveal` | "~~NOT: LAUNCH LIMIT~~" | `lines: {text, struck}[]` |
| `FlowDiagram` | TEAM → AI AGENTS → CHURN | `nodes: string[]`, `arrows`, `stagger` |
| `TerminalMock` | "5 TERMINALS", terminal-01…05 | `windows: {title, lines[]}[]`, `fanOut?` |
| `ChatMock` | `"agents"` bubble + avatar | `messages: {from, text}[]`, `avatarSrc?` |
| `ScreenshotFrame` | code-review screenshot + label chip | `src`, `label?`, `kenBurns?` |

Shared requirements:

- **Entrance animation** via Remotion `spring()`/`interpolate`, driven by frames *relative to the scene's own start* (wrap each scene in a `<Sequence>` so `useCurrentFrame()` is scene-local). Staged reveals stagger children by ~4–6 frames.
- **Theme tokens only** — no hardcoded colors/fonts in components; read from the `theme` prop.
- **Numbers get the emphasis treatment** — the grammar in BRAINSTORM §4.5 is a component-level responsibility, not an LLM instruction.
- Every component renders acceptably from `defaultProps` alone, so a partial LLM response still produces something.

## 4. The producer brain (`packages/core/src/producer/`)

Framework-free, provider-agnostic, schema-constrained. **Two calls, not one:**

1. **Beat sheet** — input: transcript (word-indexed), cut report, user intent string, target duration. Output: moments `{startWord, endWord, purpose, onScreenCopy, sceneKind}`, ~5–10 s each, plus the hook choice. This is the editorial call.
2. **Scene props** — per moment, given the chosen component's zod schema, emit props. Batched per moment so one bad scene can't poison the rest.

Rules:

- **Tier 1 only this phase.** JSON against the library's schemas. No freeform TSX (that is Phase 4).
- **Validation loop:** zod parse → on failure, one retry with the error text appended → on second failure, fall back to `TitleCard` with the moment's `onScreenCopy`, and record the failure in the report. Bounded retries, accepted residuals — the policy Opus's own logs show.
- **Providers:** `AnthropicProvider` and `GeminiProvider` behind one `LlmProvider` interface (`complete(messages, schema) → parsed`). Keys from env (`ANTHROPIC_API_KEY` / `GEMINI_API_KEY`) or `~/.ossclip/config.json`. Default to the newest Claude model.
- **Offline path is first-class:** `--scenes file.json` skips the brain entirely. Build and test the whole render path this way before wiring any provider.

Cache the beat sheet in the workdir keyed by (transcript hash + intent + cleanup level), like every other stage.

## 5. Assembly & timing

`assembleScenes(production, timeMap)`:

1. For each scene, resolve `anchor` → output time via `timeMap.mapWord()` on the anchor words; drop scenes whose anchor words were entirely cut.
2. Clamp to the neighbours; enforce a minimum on-screen duration (~1.2 s) and merge or drop shorter ones.
3. Sort, assert non-overlap (scenes are exclusive — one stage state at a time), fill gaps with `full-bleed`.
4. Emit plain-JSON render props, exactly as Phase 0 does: the composition stays dumb, output-time only.

## 6. Preview

Remotion `<Player>` on the same composition, fed the same props JSON, in a minimal Vite page under `apps/studio` (still not the full agent-native shell — that is the Phase 1 shell spike, and it can slip to Phase 2 without blocking anything here). `ossclip studio` continues to work off `render-props.json`.

## Test plan

- **Unit:** every scene component's zod schema (valid/invalid/partial); layout → slot-rect math; anchor→time resolution incl. anchors landing inside removed regions; overrides merge (props replaced, overrides preserved).
- **Golden:** a checked-in `fixtures/scenes.json` exercising all 8 components and all 5 layouts → `renderStill` per scene, compared as a smoke test (does it render, is the slot rect right) rather than pixel-diffed.
- **Producer:** mock `LlmProvider` returning (a) valid, (b) schema-invalid, (c) truncated JSON → assert retry then `TitleCard` fallback, and assert the render still completes.
- **Regression:** re-running assembly at `--cleanup exact` vs `standard` keeps every scene on its anchor words.

## Milestones

| # | Deliverable | Done when |
|---|---|---|
| M1.1 | Schema + Stage + layouts | `fixtures/scenes.json` renders all 5 layouts; audio continuous across boundaries |
| M1.2 | Scene library (8 components) | each renders from JSON with entrance animation and theme tokens; stills smoke-tested |
| M1.3 | Assembly + anchors | scenes survive a cleanup-level change; overrides preserved across re-plan |
| M1.4 | Producer brain | `--produce` on a real take yields a valid, watchable production; invalid scenes degrade gracefully |
| M1.5 | Preview | `<Player>` page shows the produced composition; `ossclip studio` works with scenes |

## Status — 2026-07-26

Built and verified in the dev container (M1.1–M1.4; M1.5's `ossclip studio` path carries over unchanged, the `<Player>` page spike is still open):

- **Stage + 5 layouts (M1.1):** `layoutSlots`/`videoSlotAt` pure math with eased morphs at cue boundaries; the EDL video stays mounted through every layout so the base audio is continuous (verified: full-length audio on an 8-scene render). Backdrop fade, circular pip mask, blur+dim all render.
- **Scene library (M1.2):** all 8 components render from JSON with entrance springs and theme tokens; `fixtures/scenes.json` exercises every component and every layout; frame-extracted stills match the reference grammar (pip TitleCard, emphasized FlowDiagram chip, blurred StrikethroughReveal, video-top ScreenshotFrame with in-slot captions).
- **Assembly + anchors (M1.3):** word-index anchors resolve through the TimeMap; cut anchors drop; exclusivity + min-duration enforced; overrides merge over props and survive re-plan (registry-level resolution order tested); cleanup-level regression test green.
- **Producer brain (M1.4):** two-call pipeline (beat sheet → per-moment props) behind `LlmProvider`; Claude via SDK `messages.parse` + `zodOutputFormat` (refusal/truncation handled), Gemini via REST JSON-mode + client-side zod, deterministic `MockProvider`; retry-once-then-TitleCard-fallback tested (valid / invalid-then-valid / always-failing / truncated); semantic beat normalization (clamp, de-overlap) tested. `--produce --llm mock` runs the whole path offline through the CLI.
- 59 tests green workspace-wide (23 new for Phase 1); typecheck clean.

**Pending real hardware/keys:** a live `--produce --llm claude` (and `gemini`) run on real footage — no API keys in the dev container; the provider adapters are code-complete and the mock exercises the identical pipeline. Also pending: the `<Player>` preview page (M1.5 spike, allowed to slip per §6) and a visual QA pass on real footage.

**Implementation note:** browser-bundled code must import from `@ossclip/core/browser` (scene schema/registry/types only) — importing the core barrel drags Node built-ins into the Remotion bundle and breaks webpack.

## Out of scope (resist)

Direct manipulation / editable layers (Phase 2 — but the `overrides` field ships now so it is cheap later) · SFX & BGM · image-gen B-roll · retake detection · face-tracked reframing · freeform TSX escape hatch · the full agent-native studio shell · clipper mode.

## Risks

| Risk | Mitigation |
|---|---|
| LLM scene props are valid but ugly | taste lives in the components; the LLM picks types and writes short copy only; `rationale` in the report makes bad picks visible |
| Scenes drift after a re-cut | word-index anchors + TimeMap resolution, property-tested (the Phase 0 lesson) |
| Preview jank with many scenes | one scene on stage at a time, `<Sequence>`-scoped mounting, 720p proxy |
| Component library sprawl | eight components, hard cap; anything else waits for Tier 2 |
| Provider API drift | one `LlmProvider` interface, mocked in all tests; no provider types leak into `core` |
