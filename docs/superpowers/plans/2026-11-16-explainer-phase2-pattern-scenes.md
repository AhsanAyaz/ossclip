# Explainer Phase 2: Pattern Scenes and the Explainer Look — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ossclip draws the repeatable explainer shots itself: four new scene components (`CardRow`, `CtaCard`, `BugCard`, `PhoneDemo`), a typed `TerminalMock`, a counting `StatCard`, and an `explainer` look with its own colours, fonts and motion.

**Architecture:** New components are offered to the planner only in script mode, through a second id list beside the frozen planner list. They draw on the whole frame over the speaker with no scrim, like the hand-made clips they replace. The look is a theme preset selected by `--look explainer`; two new theme fields (`fonts`, `motion`) gate font loading and the new motion, so every other run renders as before.

**Tech Stack:** TypeScript, zod 4, Remotion 4.0.499 (pinned), React, vitest, pnpm workspace.

**Spec:** `docs/designs/explainer-video-patterns.md`, sections "Phase 2" and "Compatibility". The style source is the author's Video Playbook; every value this plan needs from it is copied below.

## Global Constraints

- **G6, the hard rule.** A run without `--script` and without `--look` sends the planner the same prompts and schemas and renders the same pixels as before. `packages/core/test/planner-prompt-frozen.test.ts` and `packages/core/test/reveal-props.test.ts` must pass **without editing their snapshots or the fixture `llm-props-schemas.pre-reveal.json`**. If one fails, the code is wrong.
- `PRODUCER_PROMPT_VERSION` stays `"v3"`. `MomentSchema` and `BeatSheetSchema` do not change.
- Every `@remotion/*` dependency stays at exactly `4.0.499`. Do not add `@remotion/google-fonts`.
- Values that come from a user are parsed with zod, never coerced (repo `CLAUDE.md`).
- Pure logic is separate from I/O. Animation helpers are pure functions of the frame number, so a still at frame N is deterministic.
- Comments explain why, and cite `§161` (this phase's FINDINGS section, written in Task 9) where a choice was forced.
- `pnpm test` and `pnpm typecheck` are green at the end of every task. `apps/cli/test/plan-sees-cut-words.test.ts` can time out under load; re-run it alone before treating it as a failure.
- Commit at the end of every task. Do not push.
- Minimum text sizes at 1920×1080: 34 px on pills, 26 px in terminals, 20 px for small tags. Keep 100 px clear on all sides of the frame.

## Decisions in this plan that differ from the design (author to check)

1. **New components draw full-frame over the speaker, with no scrim.** They are `fullFrame: true`, `scrim: false`, like `ClipScene`. The design listed "full-frame card and full-frame overlay" as layouts; one overlay mode covers the 20 pattern shots, which were all transparent overlays.
2. **No `logo` prop on `CtaCard`.** A file-path prop needs the staging and safety checks `ScreenshotFrame` has. The card shows the channel name and a plain icon.
3. **Three hard-coded colours stay:** the terminal's traffic-light dots, `RuleCard`'s `#55555E` and `ScreenshotFrame`'s `#22222B`. The explainer look does not need them changed.
4. **Typing and count-up are switched by the look (`theme.motion`), not by props.** A new prop on `StatCard` would change the frozen planner schema.
5. **The editor's swap menu offers the new components for every project.** The planner still never sees them outside script mode.
6. **Reference stills are for the author to look at, not a pixel test.** Font rendering differs between machines.

## Review Focus

1. **A project made before this change** (render-props with no `fonts`, `motion` or new colour roles) opens and renders with identical pixels. Test: Task 1.
2. **A user config `theme` with only `accent` set, plus `--look explainer`**: the user's accent wins, the other explainer colours apply. Test: Task 1.
3. **Text at the schema's maximum length in every slot of a new component, in 9:16**: nothing overflows the 100 px margin or overlaps. Test: each component task's `fit.test.ts` `DENSE` entry and a dense still.
4. **A script cue with `[CardRow]` in a run of an older cached script plan** (`s1`): the cache is not reused. Test: Task 4.
5. **The font files fail to load** (missing from the public folder): the render continues on the fallback stack and does not hang on `delayRender`. Test: Task 2.

---

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `packages/core/src/scene-schema.ts` | theme roles, `fonts`, `motion`, `ScriptComponentIdSchema` | 1, 4 |
| `packages/core/src/look.ts` (new) | `LookSchema`, `lookTheme()`, `EXPLAINER_THEME` | 1 |
| `packages/core/src/scene-registry.ts` | props schemas, registry entries, `scriptOnly`, `scriptComponentIds()` | 4–8 |
| `packages/core/assets/fonts/` | Inter 800/900, DejaVu Sans Mono, licences | 2 |
| `packages/scenes/src/BundledFonts.tsx` (new) | loads the bundled fonts when `theme.fonts === "bundled"` | 2 |
| `packages/scenes/src/motion.ts` | pure motion helpers (file exists; extended) | 3 |
| `packages/scenes/src/primitives/` (new) | `Pill`, `Card`, `Sticker`, `NumberBadge`, `PhoneFrame`, `Icon`, `shadow` | 3 |
| `packages/renderer/src/Root.tsx`, `SceneStillComposition.tsx` (new) | one-scene composition for stills | 3 |
| `scripts/render-scene-stills.ts` (new), `packages/scenes/test/stills.fixtures.ts` (new) | `pnpm stills` | 3 |
| `packages/scenes/src/components/{CardRow,CtaCard,BugCard,PhoneDemo}.tsx` (new) | the components | 4–7 |
| `packages/scenes/src/components/{TerminalMock,StatCard}.tsx` | typed line, badge, count-up | 8 |
| `packages/core/src/producer/script-plan.ts`, `apps/cli/src/script-mode.ts` | script menu, hint check, `"s2"` | 4 |
| `apps/editor/src/Overlay.tsx`, `Inspector.tsx` | element ids for the new arrays | 4–7 |

---

### Task 1: Theme roles, `fonts`, `motion` and the `explainer` look

**Files:**
- Modify: `packages/core/src/scene-schema.ts` (`ThemeSchema`, lines 295-313)
- Create: `packages/core/src/look.ts`, `packages/core/test/look.test.ts`
- Modify: `packages/core/src/config.ts` (`OssclipConfig`, `resolveConfig`), `packages/core/src/index.ts` (export)
- Modify: `apps/cli/src/program.ts` (flag beside `--caption-theme`, line 583), `apps/cli/src/produce.ts` (`ProduceOptions`, `configuredBaseTheme` call at 2944)
- Modify: `apps/cli/src/replay-argv.ts` (pin `--look` like `--caption-theme`, lines 81-82 and 241-245)
- Test: `packages/core/test/look.test.ts`, `apps/cli/test/` (the existing test file that covers `configuredBaseTheme`; add cases there)

**Interfaces:**
- Produces:
  - `ThemeSchema` gains, all with defaults: `accent2: "#FFE14D"`, `highlight: "#FFE14D"`, `info: "#9A9AA3"`, `ink: "#0B0B0E"`, `terminalBg: "#15151B"`, `terminalBar: "#15151B"`, `fonts: z.enum(["system","bundled"]).default("system")`, `motion: z.enum(["classic","explainer"]).default("classic")`.
  - `LookSchema = z.enum(["default","explainer"])`, `type Look`.
  - `EXPLAINER_THEME: Partial<Theme>` and `lookTheme(look: Look): Partial<Theme>` (`{}` for `"default"`).
  - `ProduceOptions.look?: Look`; config key `look`.

- [ ] **Step 1: Failing tests** in `look.test.ts`:

```ts
it("defaults reproduce today's theme", () => {
  expect(ThemeSchema.parse({})).toMatchObject({
    bg: "#0B0B0E", accent: "#FFE14D", cardBg: "#15151B",
    accent2: "#FFE14D", highlight: "#FFE14D", info: "#9A9AA3", ink: "#0B0B0E",
    terminalBg: "#15151B", terminalBar: "#15151B", fonts: "system", motion: "classic",
  });
});
it("the explainer look carries the playbook palette", () => {
  expect(lookTheme("explainer")).toEqual({
    bg: "#3A4A5C", fg: "#FFFFFF", accent: "#FF8D41", accent2: "#7CACF8",
    highlight: "#FFE14D", success: "#3DDC84", danger: "#FF4D4D",
    cardBg: "#14161C", cardBorder: "#2B3140", muted: "#7C86A6", info: "#5FD7FF",
    ink: "#0F1013", terminalBg: "#0F1320", terminalBar: "#1A2034",
    fontDisplay: "'Inter', 'Helvetica Neue', Arial, sans-serif",
    fontMono: "'DejaVu Sans Mono', 'SF Mono', 'Cascadia Code', Consolas, monospace",
    fonts: "bundled", motion: "explainer",
  });
});
it("the default look changes nothing", () => expect(lookTheme("default")).toEqual({}));
it("rejects an unknown look", () => expect(() => LookSchema.parse("explainr")).toThrow());
```

Plus, where `configuredBaseTheme` is tested: precedence is defaults < look < config `theme`. With look `explainer` and config `{accent: "#00FF00"}`, the result has `accent: "#00FF00"` and `accent2: "#7CACF8"`. With no look and no config theme, the result deep-equals `defaultTheme`.

- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/look.test.ts`. Expected: FAIL, `look.ts` missing.
- [ ] **Step 3: Implement.** `configuredBaseTheme(cfgTheme: unknown, look: Look = "default")` layers `lookTheme(look)` under the config theme. The look comes from `opts.look ?? cfg.look`, parsed with `LookSchema` at the consumer; an invalid config value is an error naming the key. `--look <name>` uses an `InvalidArgumentError` parser like `captionThemeFlag`. The result feeds both `theme` and `baseTheme` in render-props (produce.ts 6705 and 6718), so the editor's theme reset keeps the look.
- [ ] **Step 4: Run** the two test files, then `pnpm test && pnpm typecheck`. Expected: PASS, frozen tests untouched.
- [ ] **Step 5: Commit** `feat: theme roles and the explainer look`.

---

### Task 2: Bundle Inter and DejaVu Sans Mono

**Files:**
- Create: `packages/core/assets/fonts/Inter-ExtraBold.woff2`, `Inter-Black.woff2`, `DejaVuSansMono.woff2`, `DejaVuSansMono-Bold.woff2`, `Inter-OFL.txt`, `DejaVu-LICENSE.txt`
- Modify: `packages/core/assets/fonts/README.md`, `packages/core/src/fonts.ts`, `packages/core/test/packaging.test.ts`
- Create: `packages/scenes/src/BundledFonts.tsx`
- Modify: `packages/renderer/src/ProductionComposition.tsx` (mount the loader), `apps/cli/src/produce.ts` (copy beside the Nastaliq copy, lines 6372-6392)
- Modify: `apps/editor/test/scene-layer-structure.test.ts` only if a new Remotion import needs mocking

**Interfaces:**
- Consumes: `theme.fonts` from Task 1.
- Produces:
  - `BUNDLED_FONTS: readonly {family: string; weight: string; rel: string}[]` in `packages/core/src/fonts.ts`: `Inter` 800 and 900, `DejaVu Sans Mono` 400 and 700, with `rel` under `fonts/`.
  - `bundledFontFiles(): {rel: string; abs: string}[]` (uses `new URL("../assets/…", import.meta.url)`).
  - `<BundledFonts theme={theme} />`, which renders nothing.

- [ ] **Step 1: Get the files.** In the scratch directory run `npm pack @fontsource/inter @fontsource/dejavu-mono`, unpack, and copy the `latin` `woff2` files for those four weights plus each package's licence file. Record the package versions in `README.md`. If a package or weight is missing, stop and report; do not substitute another font.
- [ ] **Step 2: Failing tests.** `packaging.test.ts`: every `bundledFontFiles()` path exists and both licence files exist. A new `packages/scenes/test/bundled-fonts.test.ts` for a pure helper `fontsToLoad(theme): typeof BUNDLED_FONTS`: empty when `fonts` is `"system"`, all four when `"bundled"`.
- [ ] **Step 3: Implement** `BundledFonts` on the pattern of `NastaliqFontLoader` (`packages/scenes/src/CaptionTrack.tsx:486-510`): one `delayRender` handle, `Promise.allSettled` over `new FontFace(...).load()`, then `continueRender` whether or not a font failed. Produce copies the files into the render public folder and the workdir only when `theme.fonts === "bundled"`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: bundle Inter and DejaVu Sans Mono for the explainer look`.

---

### Task 3: Motion helpers, shared primitives and the stills harness

**Files:**
- Modify: `packages/scenes/src/motion.ts` (exists: `CAPTION_POP_SEC`, `easeOutQuad`; add to it). Create: `packages/scenes/test/motion.test.ts` (or add to the existing test file for `motion.ts`)
- Create: `packages/scenes/src/primitives/{Pill,Card,Sticker,NumberBadge,PhoneFrame,Icon}.tsx`, `packages/scenes/src/primitives/shadow.ts`
- Create: `packages/renderer/src/SceneStillComposition.tsx`; modify `packages/renderer/src/Root.tsx`, `packages/renderer/src/index.ts`
- Create: `scripts/render-scene-stills.ts`, `packages/scenes/test/stills.fixtures.ts`; modify root `package.json` (`"stills"` script)

**Interfaces:**
- Produces, in `motion.ts` (all pure, `t` in seconds from the item's start):
  - `popScale(t: number, durSec = 0.35): number` — 0 at `t ≤ 0`, overshoots, exactly 1 at `t ≥ durSec`.
  - `easeInOut(t: number, durSec: number): number` — 0..1.
  - `typedChars(t: number, total: number, cps = 32): number` — integer 0..total.
  - `caretOn(t: number): boolean` — block caret, on for the first 0.5 s of every second.
  - `bobPx(t: number, amplitude = 7, periodSec = 2.4): number`.
  - `bump(t: number, durSec = 0.3): number` — 1 → 1.15 → 1.
  - `beatStarts(count: number, gapSec = 0.7, firstSec = 0.25): number[]`.
  - `parseCount(value: string): {prefix: string; number: number; decimals: number; suffix: string; grouped: boolean} | null` — accepts an optional `+` or `-`, digits with optional `,` groups and one optional `.` part, and an optional `%`, `x`, `×`, `k`, `K`, `M` or `s` suffix. Anything else returns `null`.
  - `countAt(parsed, t: number, durSec = 1.0): string` — eased, formatted like the source string, equal to it at `t ≥ durSec`.
- Produces, primitives (props are the builder's to finalise, minimum given):
  - `Pill({text, border, theme, sizePx = 34, mark?: "tick" | "cross"})` — dark rounded label, 3 px coloured border.
  - `Card({theme, border, children, widthPx?})` — `theme.cardBg`, 5 px border, `theme.radiusPx`.
  - `Sticker({text, theme, color, tiltDeg = -4})` — tilted tag with a white rim.
  - `NumberBadge({n, theme, sizePx})` — `theme.danger` circle, white numeral.
  - `PhoneFrame({theme, heightPx, children})` — 9:16 gradient panel with a plain person silhouette.
  - `Icon({name, sizePx, color})` with `ICON_NAMES = ["none","chat","doc","search","terminal","code","check","bolt","user","robot"] as const`, drawn as inline SVG paths.
  - `SHADOW = "0 12px 32px rgba(0,0,0,0.45)"`.
- Produces, stills:
  - `SCENE_STILL_ID = "scene-still"`; composition props `{component, props, layout, theme, frame: {width, height}, background: string}`. It renders `SceneLayer` with one cue over a solid `background`, with `<BundledFonts>` mounted.
  - `renderSceneStill(props, {publicDir, outPath, atSec})` in `packages/renderer/src/index.ts`, PNG output.
  - `STILL_FIXTURES: {component: SceneComponentId; name: string; props: unknown; atSec: number[]}[]`.
  - `pnpm stills [Component]` writes `packages/scenes/test/__stills__/<Component>-<name>-<16x9|9x16>-<atSec>.png` with the explainer theme on background `#3A4A5C`.

- [ ] **Step 1: Failing tests** in `motion.test.ts`:

```ts
expect(popScale(0)).toBe(0); expect(popScale(0.35)).toBe(1); expect(popScale(9)).toBe(1);
expect(Math.max(...[0.2, 0.25, 0.3].map((t) => popScale(t)))).toBeGreaterThan(1);
expect(typedChars(0, 40)).toBe(0); expect(typedChars(0.5, 40)).toBe(16); expect(typedChars(9, 40)).toBe(40);
expect(beatStarts(3)).toEqual([0.25, 0.95, 1.65]);
expect(parseCount("4,494")).toEqual({ prefix: "", number: 4494, decimals: 0, suffix: "", grouped: true });
expect(parseCount("+242%")).toMatchObject({ prefix: "+", number: 242, suffix: "%" });
expect(parseCount("×3")).toBeNull(); expect(parseCount("5 min")).toBeNull();
const p = parseCount("4,494")!;
expect(countAt(p, 0)).toBe("0"); expect(countAt(p, 1)).toBe("4,494"); expect(countAt(p, 5)).toBe("4,494");
expect(countAt(parseCount("+1.5k")!, 2)).toBe("+1.5k");
```

- [ ] **Step 2: Run** `pnpm vitest run packages/scenes/test/motion.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `motion.ts`, the primitives, the composition and the script. Add one fixture for an existing component (`StatCard`) so the harness has something to render.
- [ ] **Step 4: Verify the harness.** Run `pnpm stills StatCard`. Expected: two PNG files. Open both with the Read tool and confirm the card is drawn and the text is in Inter (compare the letter shapes against Arial: Inter's `1` has a flag and no foot).
- [ ] **Step 5: Run** `pnpm test && pnpm typecheck`, then commit `feat: motion helpers, primitives and a scene stills harness`. Commit the two stills.

---

### Task 4: Script-only components, and `CardRow`

This task builds the plumbing every later component reuses, so it lists every touchpoint. Tasks 5 to 7 refer back to this list as "the Task 4 checklist".

**Files:**
- Modify: `packages/core/src/scene-schema.ts`, `packages/core/src/scene-registry.ts`
- Modify: `packages/core/src/producer/script-plan.ts` (schema line 77, menu 115-117, hint check 159-172, version line 30), `apps/cli/src/script-mode.ts` (hint check 117-121)
- Modify: `packages/core/src/producer/scene-props.ts` (accept the wider moment type), `packages/core/src/producer/mock.ts` (canned props)
- Modify: `packages/core/src/reveal-match.ts` (`revealItemTexts`, `entryTexts`)
- Create: `packages/scenes/src/components/CardRow.tsx`; modify `packages/scenes/src/SceneLayer.tsx` (`COMPONENTS`), `packages/scenes/src/fit.ts`
- Modify: `apps/editor/src/Overlay.tsx` (`DYNAMIC_ID`, `buildArrayPatch`, `elementTextOf`), `apps/editor/src/Inspector.tsx` (regex at 1072, `componentSwapOptions` at 626, multiline rule at 986)
- Modify tests: `packages/core/test/scene-registry.test.ts`, `packages/core/test/script-plan.test.ts`, `packages/core/test/reveal-match.test.ts`, `apps/cli/test/script-mode.test.ts`, `packages/scenes/test/fit.test.ts`, `packages/scenes/test/stage.test.ts`, `apps/editor/test/Inspector.test.ts`, `apps/editor/test/scene-props.test.ts`
- Modify: `packages/scenes/test/stills.fixtures.ts`

**Interfaces:**
- Produces:
  - `ScriptOnlyComponentIdSchema = z.enum(["CardRow"])` (Tasks 5 to 7 append to it).
  - `ScriptComponentIdSchema = z.enum([...PlannerComponentIdSchema.options, ...ScriptOnlyComponentIdSchema.options])`, `type ScriptComponentId`.
  - `SceneComponentIdSchema = z.enum([...ScriptComponentIdSchema.options, "ClipScene"])`.
  - `SceneComponentMeta.scriptOnly?: boolean`.
  - `plannerComponentIds()` excludes `scriptOnly` entries and stays exactly the nine. `scriptComponentIds(): ScriptComponentId[]` returns the nine plus the script-only ones, in registry order.
  - `type ScriptMoment = Omit<Moment, "sceneKind"> & { sceneKind: ScriptComponentId | "none" }`. `generateScenes` and `generateScenePropsBatch` take `readonly (Moment | ScriptMoment)[]`.
  - `SCRIPT_PLAN_PROMPT_VERSION = "s2"`. One bump covers Tasks 4 to 8, because none of them ships separately.
  - `CardRowProps`:

```ts
export const CardRowProps = z.object({
  cards: z.array(z.object({
    text: z.string().min(1).max(18),
    sub: z.string().max(24).optional(),
    icon: z.enum(ICON_NAMES).default("none"),
  })).min(2).max(4),
  highlight: z.number().int().min(0).max(3).optional(),
  ...RevealPropsShape,
});
```

  `ICON_NAMES` moves to `packages/core/src/scene-registry.ts` and the scenes primitive imports it, because core cannot import from scenes.
  - Registry entry: `defaultProps: { cards: [{ text: "ONE" }, { text: "TWO" }, { text: "THREE" }] }`, `defaultLayout: "full-bleed"`, `altLayouts: []`, `scriptOnly: true`, `scrim: false`, `fullFrame: true`, `whenToUse: "The line lists two to four parallel things (steps, tools, options). One card per item, in spoken order; set highlight to the chosen one."`

**The Task 4 checklist** (every new component):

1. Id in `ScriptOnlyComponentIdSchema`; props schema; registry entry with `scriptOnly`, `scrim: false`, `fullFrame: true`, and `defaultProps` that pass the schema (the editor's swap depends on it).
2. `COMPONENTS` entry in `SceneLayer.tsx`.
3. `fit.ts`: add the id to `SELF_FITTING`. The component sizes itself from `widthPx` and `heightPx`. `estimateHeightPx` still needs a case because the switch is exhaustive; return `heightPx`.
4. `entryTexts` case (compiler-enforced). If items build one per beat: a `revealItemTexts` case, `...RevealPropsShape` in the schema, and `componentRevealFrames(count, legacyStepFrames, fps, props, timing)` in the component, with index i equal to drawn item i. When there are no word timings, items start at `beatStarts(count)`.
5. `CHECKED_FIELDS` (`packages/core/src/grounding.ts:36`) and `COPY_FIELDS` (`packages/core/src/producer/repair.ts:418`): list only top-level plain-string fields. Leave out any field that holds objects, because the two `stringsOf` helpers would read enum values such as an icon name as copy. Add a comment at each list saying so.
6. Mock provider: a `<Id>_props` entry in `canned` (`producer/mock.ts:157-177`).
7. Editor: element ids on every text element (`data-edit-id`). For an array, add its kind to `DYNAMIC_ID` and to both field maps in `Overlay.tsx`, and to the copied regex in `Inspector.tsx:1072`. Replace that copy with an import of the one regex while here.
8. Tests: `SPARSE` and `DENSE` entries in `fit.test.ts` (`DENSE` uses every field at its maximum length and count); the id lists in `scene-registry.test.ts`, `stage.test.ts`, `Inspector.test.ts` and `scene-props.test.ts`.
9. Stills: one sparse and one dense fixture, at the busiest moment and at the settled state. Run `pnpm stills <Id>`, open all files with the Read tool, and fix anything that overlaps, clips, or enters the 100 px margin. Commit the stills.

**Layout of `CardRow`.** 16:9: cards in one centred row, equal width, 40 px gap, vertically centred. 9:16: one column. Each card is a `Card` primitive with the icon above (omitted for `"none"`), `text` in `theme.fontDisplay` weight 900, `sub` in `theme.fontMono` and `theme.muted`. Border `theme.accent2`; the highlighted card uses `theme.accent` and a `bump`. With `theme.motion === "explainer"` a card enters with `popScale`; with `"classic"` it uses `entranceStyle`. Element ids: `card-N`, edited as `text` on the first line and `sub` on the second.

- [ ] **Step 1: Failing tests.**

```ts
// scene-registry.test.ts
expect(plannerComponentIds()).toEqual(PlannerComponentIdSchema.options);   // still the nine
expect(scriptComponentIds()).toEqual([...PlannerComponentIdSchema.options, "CardRow"]);
expect(CardRowProps.safeParse({ cards: [{ text: "A" }] }).success).toBe(false);          // needs 2
expect(CardRowProps.parse({ cards: [{ text: "A" }, { text: "B" }] }).cards[0].icon).toBe("none");
// script-plan.test.ts
expect(buildScriptPlanUserPrompt(input)).toContain("- CardRow:");
expect(buildScriptPlanUserPrompt(input)).not.toContain("ClipScene");
// script-mode.test.ts: a `[CardRow]` hint is accepted; `[CardRows]` is an error listing CardRow among the valid names; the cache key uses "s2"
// reveal-match.test.ts
expect(revealItemTexts("CardRow", { cards: [{ text: "Draft", sub: "one" }, { text: "Review" }] }))
  .toEqual([["Draft", "one"], ["Review"]]);
// Inspector.test.ts
expect(componentSwapOptions("TitleCard")).toEqual(scriptComponentIds());
expect(componentSwapOptions("ClipScene")).toBeNull();
```

Check the exact shape `revealItemTexts` returns for `TerminalMock` (alternatives per item) and match it. Also assert that `planScriptMoments` with a mock answer of `sceneKind: "CardRow"` yields a scene whose component is `CardRow`, and that `produceScenes` without a script never offers it (the frozen test already proves the second).

- [ ] **Step 2: Run** the changed test files. Expected: FAIL on the new assertions only.
- [ ] **Step 3: Implement** the plumbing and `CardRow`, following the checklist.
- [ ] **Step 4: Stills** (checklist item 9).
- [ ] **Step 5: Run** `pnpm test && pnpm typecheck`. Expected: PASS with the frozen snapshots untouched.
- [ ] **Step 6: Commit** `feat: script-only scene components, and CardRow`.

---

### Task 5: `CtaCard`

**Files:** Create `packages/scenes/src/components/CtaCard.tsx`; otherwise the Task 4 checklist.

**Interfaces:**
- Consumes: the Task 4 plumbing, `typedChars`, `caretOn`, `popScale`, `bump`, `Icon`, `Card`.
- Produces:

```ts
export const CtaCardProps = z.object({
  action: z.enum(["comment", "subscribe", "link"]),
  text: z.string().min(1).max(40),
  keyword: z.string().max(16).optional(),
  channel: z.string().max(24).optional(),
});
```

  `defaultProps: { action: "subscribe", text: "Subscribe for more" }`. `whenToUse: "The line asks the viewer to do something: comment a word, subscribe or follow, or open a link. Put the asked-for word in keyword."`

**Behaviour.** One centred card, the action performed on screen:
- `comment`: a comment box. `keyword` (or `text` when there is no keyword) is typed with a block caret, then a send button bumps. `text` sits above as the headline.
- `subscribe`: `channel` beside a button that reads "Subscribe", which bumps and switches to "Subscribed" with a tick in `theme.success` at 60% of the scene.
- `link`: `text` as the headline and `keyword` in a mono URL bar with `theme.info`.

Under `theme.motion === "classic"` the text appears whole and nothing bumps. Element ids: `text`, `keyword`, `channel`. `CHECKED_FIELDS` and `COPY_FIELDS`: `["text", "keyword"]`. `entryTexts`: `text`, `keyword`. No reveal items.

- [ ] **Step 1: Failing tests:** schema (`action: "share"` rejected, `text` over 40 rejected), `entryTexts("CtaCard", …)`, `scriptComponentIds()` now ends `"CardRow", "CtaCard"`, plus the checklist tests.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Stills:** one fixture per action, sparse and dense, at 30% and 90% of a 6 s scene.
- [ ] **Step 5:** `pnpm test && pnpm typecheck`; commit `feat: CtaCard scene`.

---

### Task 6: `BugCard`

**Files:** Create `packages/scenes/src/components/BugCard.tsx`; otherwise the Task 4 checklist.

**Interfaces:**
- Consumes: `NumberBadge`, `Sticker`, `Card`, `popScale`, `bump`.
- Produces:

```ts
export const BugCardProps = z.object({
  number: z.number().int().min(1).max(9),
  headline: z.string().min(1).max(40),
  sub: z.string().max(40).optional(),
  mock: z.enum(["none", "caption", "lines"]).default("none"),
  mockLines: z.array(z.string().max(32)).max(4).default([]),
  mockWrong: z.number().int().min(0).max(3).optional(),
  mockFault: z.enum(["struck", "clipped"]).default("struck"),
  sticker: z.string().max(14).optional(),
});
```

  `defaultProps: { number: 1, headline: "The problem" }`. `whenToUse: "The line names one specific problem or bug, often numbered. headline says it in a few words; sub is the consequence. Use mock 'caption' or 'lines' only with words the speaker says."`

**Behaviour.** 16:9: the badge and the two-line text on the left (headline in `theme.fg`, `sub` in `theme.danger`), the mock on the right. 9:16: the mock is not drawn. `mock: "caption"` draws `mockLines` as caption words in a row with the word at `mockWrong` struck through or cut off at the panel edge, per `mockFault`. `mock: "lines"` draws them as mono lines with the line at `mockWrong` marked in `theme.danger`. With `mock` other than `"none"` and no `mockLines`, the mock is not drawn. The sticker lands in the last third of the scene with a `bump`. Order: badge, headline, sub, mock, sticker. The flat schema is deliberate: the editor builds a dropdown and a slider for the scalar fields for free, and `mockLines` edits as `mock-N` elements.

Element ids: `headline`, `sub`, `sticker`, `mock-N`. `CHECKED_FIELDS` and `COPY_FIELDS`: `["headline", "sub", "sticker"]`. `entryTexts`: `headline`, `sub`. No reveal items.

- [ ] **Step 1: Failing tests:** schema (`number: 0` rejected, five `mockLines` rejected, defaults filled), `entryTexts`, the id lists, and a pure helper `bugMockVisible(props, aspect): boolean` covering the three "not drawn" cases above.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Stills:** `none`, `caption` with `clipped`, `lines`; sparse and dense; both aspects.
- [ ] **Step 5:** `pnpm test && pnpm typecheck`; commit `feat: BugCard scene`.

---

### Task 7: `PhoneDemo`

**Files:** Create `packages/scenes/src/components/PhoneDemo.tsx`; otherwise the Task 4 checklist.

**Interfaces:**
- Consumes: `PhoneFrame`, `Pill`, `popScale`, `beatStarts`.
- Produces:

```ts
export const PhoneDemoProps = z.object({
  caption: z.array(z.object({
    text: z.string().min(1).max(14),
    emphasis: z.enum(["none", "yellow", "orange"]).default("none"),
  })).min(1).max(8),
  pills: z.array(z.object({
    text: z.string().min(1).max(22),
    state: z.enum(["ok", "bad", "plain"]).default("ok"),
  })).max(4).default([]),
  ...RevealPropsShape,
});
```

  `defaultProps: { caption: [{ text: "YOUR" }, { text: "CAPTIONS", emphasis: "yellow" }] }`. `whenToUse: "The line explains how captions or a vertical video look or behave. caption holds the words shown on the phone; pills are short checklist labels, one per point the speaker makes."`

**Behaviour.** 16:9: the phone frame on the left at 80% of the frame height, pills building on the right, one per beat. 9:16: the frame on top at 50% height, pills below. Caption words sit in the lower third of the phone frame in `theme.fontDisplay` 900, white with a `theme.cardBg` outline; an emphasised word is `theme.ink` on a `theme.highlight` (yellow) or `theme.accent` (orange) box tilted 3 degrees. Words wrap to at most three lines. Pill borders: `ok` is `theme.success` with a tick, `bad` is `theme.danger` with a cross, `plain` is `theme.accent2`. Reveal items are the pills; the caption is visible from the start.

Element ids: `word-N` (patches `.text`), `pill-N` (patches `.text`). No control exists for `emphasis` and `state` in the editor; record that in §161 as a known gap. `CHECKED_FIELDS` and `COPY_FIELDS`: none (all copy is inside objects); add the comment from checklist item 5. `entryTexts`: caption texts joined as one entry, then the pill texts. `revealItemTexts`: pill texts.

- [ ] **Step 1: Failing tests:** schema (zero caption words rejected, five pills rejected), `revealItemTexts("PhoneDemo", …)` returns the pill texts in order, `entryTexts`, the id lists.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Stills:** sparse (two words, no pills) and dense (eight words at 14 characters, four pills at 22 characters); both aspects; mid-build and settled.
- [ ] **Step 5:** `pnpm test && pnpm typecheck`; commit `feat: PhoneDemo scene`.

---

### Task 8: Typed `TerminalMock`, counter badge, counting `StatCard`

**Files:**
- Modify: `packages/scenes/src/components/TerminalMock.tsx`, `packages/scenes/src/components/StatCard.tsx`
- Modify: `packages/core/src/scene-registry.ts` (`TerminalMockProps`, `llmPropsSchema`), `packages/scenes/src/fit.ts` (TerminalMock height and width with a badge)
- Modify: `packages/core/src/producer/scene-props.ts` and `script-plan.ts` callers of `llmPropsSchema`
- Test: `packages/scenes/test/terminal-typing.test.ts` (new), `packages/core/test/reveal-props.test.ts` (add cases, change nothing existing), `packages/scenes/test/reveal-wiring.test.ts`, `packages/scenes/test/fit.test.ts`

**Interfaces:**
- Consumes: `typedChars`, `caretOn`, `parseCount`, `countAt`, `theme.motion`, `theme.terminalBg`, `theme.terminalBar`, `theme.info`.
- Produces:
  - `TerminalMockProps` gains `badge: z.string().max(16).optional()`.
  - `SCRIPT_ONLY_PROP_KEYS: Partial<Record<SceneComponentId, readonly string[]>> = { TerminalMock: ["badge"] }`.
  - `llmPropsSchema(component, mode: "auto" | "script" = "auto")`. In `"auto"` it also omits the component's `SCRIPT_ONLY_PROP_KEYS`. For a component with neither reveal keys nor script-only keys it still returns the registry schema object itself (`reveal-props.test.ts:117-119`). Script-mode prop calls pass `"script"`.
  - `isTypedLine(line: string): boolean` — true when the line starts with `$ ` or `> `.
  - `typedLineText(line: string, tSec: number): string` — the prompt mark is whole from the start; the rest follows `typedChars`.

**Behaviour.**
- `TerminalMock`, only when `theme.motion === "explainer"`: in each window the first line that `isTypedLine` types out after the window has entered, with a block caret in `theme.info` while typing; the following lines appear after the typing ends, 0.12 s apart. Under `"classic"` the frames are exactly today's (`reveal-wiring.test.ts` must pass unchanged).
- Window background becomes `theme.terminalBg` and the title bar `theme.terminalBar`; both default to today's `cardBg` value, so classic pixels do not change.
- `badge` draws a pill at the top-right corner of the last window, entering with the tail. Element id `badge`. Add it to the `fit.ts` model.
- `StatCard`, only when `theme.motion === "explainer"` and `parseCount(props.value)` is not null: the value counts up over 1.0 s after the card's entrance, in tabular figures so the width does not jump. Otherwise it renders as today.

- [ ] **Step 1: Failing tests.**

```ts
expect(isTypedLine("$ ossclip produce")).toBe(true); expect(isTypedLine("▸ cutting…")).toBe(false);
expect(typedLineText("$ run tests", 0)).toBe("$ "); expect(typedLineText("$ run tests", 9)).toBe("$ run tests");
// reveal-props.test.ts, new cases only
expect(JSON.stringify(z.toJSONSchema(llmPropsSchema("TerminalMock")))).not.toContain("badge");
expect(JSON.stringify(z.toJSONSchema(llmPropsSchema("TerminalMock", "script")))).toContain("badge");
expect(llmPropsSchema("StatCard", "script")).toBe(SCENE_REGISTRY.StatCard.propsSchema);
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Stills:** `TerminalMock` mid-typing and settled with a badge; `StatCard` with `4,494` at 0.5 s after entrance and settled. Also render one `TerminalMock` and one `StatCard` still with the **default** theme before and after this task's change (use `git stash` for the before) and confirm with `cmp` that the files are byte-identical.
- [ ] **Step 5:** `pnpm test && pnpm typecheck`; commit `feat: typed terminal, counter badge and counting stat in the explainer look`.

---

### Task 9: Offline proof and FINDINGS

**Files:**
- Modify: `packages/core/src/producer/mock.ts` (`scriptPlan`, lines 128-135)
- Modify: the `verify-ossclip` skill's fixture script and its expected output (`.claude/skills/verify-ossclip/`)
- Modify: `docs/PHASE1-FINDINGS.md` (new §161)

- [ ] **Step 1:** The mock `scriptPlan` answers `TitleCard` unless the cue line carries a fixed component, in which case it answers that component. Test in `packages/core/test/script-plan.test.ts`.
- [ ] **Step 2:** The verify fixture script gains one cue per new component, written with a hint (`🎬 [CardRow] three steps`). Run the skill's command with `--look explainer` and confirm that `script-report.json` lists each as placed with the hinted component, and that `production.json` validates.
- [ ] **Step 3:** Write §161: what was built, the six decisions listed at the top of this plan with their reasons, the known gaps (no editor control for `emphasis`, `state` and card `icon`; no `logo`; `TerminalMock`, `TitleCard` and `StatCard` still use the slot layouts in 16:9), and the stills location.
- [ ] **Step 4:** `pnpm test && pnpm typecheck`; commit `test: offline script fixture for the pattern scenes; FINDINGS §161`.

---

### Task 10: Acceptance on the EGM script (main session, not delegated)

- [ ] Write a copy of `packages/core/test/fixtures/egm-script.md` in the scratch directory with the 20 pattern shots as plain cues (no `clip:`), and a table of the intended component per cue.
- [ ] Run `ossclip produce <raw footage> --script <copy> --look explainer --aspect 16:9 --no-captions --no-watermark` on a copy of the project. Acceptance: all 20 placed, at least 17 with the intended component.
- [ ] Tile one frame per placed scene into a contact sheet and compare each against the matching frame of `EGM_V2.mov`.
- [ ] Run the same footage without `--script` and without `--look` and confirm the plan equals the one from before this branch.
- [ ] Record the numbers in FINDINGS §161 and show the author the contact sheet and the stills.
