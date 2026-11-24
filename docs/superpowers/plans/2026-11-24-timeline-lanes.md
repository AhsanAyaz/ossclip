# Timeline Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The editor timeline draws graphic blocks on a top lane (V2) and take blocks over a passive footage strip on a bottom lane (V1).

**Architecture:**
- One track container (`trackRef`) holds both lanes as vertical offsets. All seek and drag maths reads only the track's width, so no gesture code changes.
- New elements are pointer-inert children of the track: a divider, a footage strip, and a hatch under each `graphic-only` graphic.
- Editor-only: no change to `packages/*`, `overrides.json`, `App.tsx`, `timing.ts` or render output.

**Tech Stack:** TypeScript, React (inline style objects), vitest + jsdom, Playwright e2e.

**Spec:** `docs/designs/timeline-lanes.md` (approved; draft 6 adds the UI design-loop fixes and the author's label option A). The spec's §1-§7, Risks and Test plan are the authority. Every value below is copied from it.

## Global Constraints

- **Geometry:** `V2_BOX = { top: 3, height: 28 }`, divider `top: 34, height: 1`, `V1_BOX = { top: 38, height: 36 }`, track `height: 77`.
- **Stacking:**
  - footage strip and divider: z 0
  - block: z 1
  - hatch: z 2
  - cut band and selected block: z 3
  - dragging block and seam: z 4
  - playhead: z 5
  - snap tick and readout: z 6
- **DOM invariants (spec §2):**
  - The playhead, cut bands, seams, readout and snap tick stay direct children of the `trackRef` div.
  - The track stays the ruler's next element sibling.
  - New elements are track children, with no lane wrapper divs.
  - Each `cues.map` iteration returns `<React.Fragment key={`${cue.id}:${cue.startSec.toFixed(3)}`}>`.
- **Test ids:** `timeline-block-<id>` (unchanged), `timeline-lane-divider`, `timeline-footage`, `timeline-hatch-<cue.id>` with `data-piece-start={cue.startSec.toFixed(3)}`. `data-lane` is `"graphics"` or `"footage"`.
- **Colours:**
  - **Graphic:** bg `#2c1828`, image `linear-gradient(#3a1f33, #2c1828)`, border `1px solid #F472B6`.
    - Id label `#FBCFE8`, or `#dbe4ff` when selected.
    - Component label `#C9A3BA`, or `#9fb0d8` when selected.
  - **Selected (unchanged):** `2px solid #5b8cff`, bg `#1c2333`, no image.
  - **Footage strip:** `#1a1a21`, `1px solid #2e2e38`.
  - **Hatch:** `repeating-linear-gradient(45deg, #15151b 0 5px, #2a2a33 5px 10px)`, border `1px solid #26262e`. Label `#9A9AA3` on a `#15151bcc` pill. Text `audio only`, or `no picture · muted` at volume 0.
  - **Dashed borders** mean KEPT only.
  - **Divider:** `#22222a`.
  - **Grip:** `#F472B6`, or `#dbe4ff` on a selected block (`.is-selected`).
- **Container queries:** blocks and hatches get `containerType: "inline-size"`. `index.css` hides `.ossclip-lane-label` under 40 px and `.ossclip-hatch-label` under 56 px.
- **Cut strikes:** two lines, `top` 12 and 51, derived from the lane constants (spec §6a).
- **Inline styles:** use longhand properties (`backgroundColor` / `backgroundImage`), never the `background` shorthand next to them (`Timeline.tsx:2149-2151`). Grip opacity lives in CSS only.
- **Comments:** explain why, and cite `timeline-lanes §N`.
- **Machine:** 7 GB RAM. Run one heavy command at a time. The full suite is `pnpm test --maxWorkers=2 --minWorkers=1`.
- **Release:** editor-only. No version bump in this plan.

## Review Focus

1. **A selected graphic must show no pink.** If `backgroundImage` is left set when selected, the gradient paints over `#1c2333`. Task 2's assertion 16 pins this.
2. **The hatch must stay inside the block's lane during a drag.** If it takes its id or key from the preview, it remounts on every mousemove. Task 1 asserts that `data-piece-start` comes from `cue.startSec`, and its test 12 checks the hatch's identity mid-drag.
3. **The strip must not overflow at zoom 1.** A 2 px overflow arms `pageAtEdge` and wheel hijack. Task 1 asserts `boxSizing: border-box` and `left/right: 0`. Task 3 adds a zoom-1 assertion that `scrollWidth <= clientWidth`.
4. **Look-mode carved pieces share an id.** The Fragment key must include `startSec`, or React drops one piece. Task 1 adds a test with two plain cues sharing `take-1` at different starts: both blocks render.
5. **A short `graphic-only` graphic's hatch label must not spill onto the next take.** Task 1 asserts that the hatch has `overflow: hidden`, `containerType` and the hatch-label class. The by-eye check in Task 4 confirms that the container query hides the label (jsdom does not evaluate `@container`).

---

### Task 1: Lane geometry, footage strip and hatches

**Files:**
- Modify: `apps/editor/src/Timeline.tsx`. This covers:
  - the `track` style (`:1972-1980`);
  - the `block` style (`:1982-1992`);
  - the `cues.map` loop (`:1583-1709`);
  - the stacking comment (`:1636-1641`);
  - the `takeThumbTimes` comment (`:565-568`), adding a pointer to `timeline-lanes §4`;
  - `cutStrike` (`:2045-2052`), replaced by `cutStrikeV2`/`cutStrikeV1` and rendered twice in the unapplied-cut band (`:1758`).
- Modify: `apps/editor/src/index.css`, for the two container-query rules.
- Test: `apps/editor/test/Timeline.test.ts`, new `describe("Timeline — lanes")`.

**Interfaces:**
- Produces (exported from `Timeline.tsx`): `export function pictureHidden(layout: Layout | undefined): boolean`, which returns `layout === "graphic-only"`. `Layout` is imported as a type from `@ossclip/core/browser`, or from wherever `SceneCue["layout"]` resolves. Module constants: `V2_BOX`, `V1_BOX` (`{ top: number; height: number }`), `LANE_DIVIDER_TOP = 34` and `TRACK_HEIGHT = 77`.
- Produces (DOM): the test ids and `data-lane` listed in Global Constraints.

- [ ] **Step 1: Add the lanes fixture and write the failing tests.**

  Fixture `lanesCues: SceneCue[]`:

  | id | start-end | kind | layout | other |
  | --- | --- | --- | --- | --- |
  | `take-0` | 0-2 | plain | full-bleed | `video: { volume: 0.5 }` |
  | `scene-a` | 2-6 | graphic | pip-bubble | `component: "BulletList"`, `pinned: true`, `props: {}` |
  | `scene-b` | 6.05-10 | graphic | graphic-only | `component: "TitleCard"`, `video: { volume: 0 }`, `props: {}` |
  | `scene-c` | 10-13 | graphic | graphic-only | `component: "ClipScene"`, `props: {}` |
  | `take-1` | 13-20 | plain | graphic-only | |

  Render with `durationSec: 20`. The tests are `it(...)` blocks asserting:
  1. `scene-a`, `scene-b` and `scene-c`: `dataset.lane === "graphics"`, `style.top === "3px"`, `style.height === "28px"`.
  2. The takes: `dataset.lane === "footage"`, `style.top === "38px"`, `style.height === "36px"`.
  3. The track (`ruler.nextElementSibling`): `style.height === "77px"`.
  4. `timeline-lane-divider` and `timeline-footage` exist, with `style.pointerEvents === "none"`. The footage strip has:
     - `boxSizing === "border-box"` and `top === "38px"`;
     - `left` and `right` each `"0"` or `"0px"` (jsdom reads React's numeric 0 as `"0"`);
     - a border matching `/1px solid/`.
  5. Exactly two `[data-testid^="timeline-hatch-"]`:
     - `timeline-hatch-scene-b`, with `textContent === "no picture · muted"` and `dataset.pieceStart === "6.050"`;
     - `timeline-hatch-scene-c`, with `"audio only"` and `"10.000"`.

     Each has:
     - `pointerEvents "none"`, `zIndex "2"`, top `38px`, height `36px`, `overflow "hidden"` and `containerType "inline-size"`;
     - `backgroundImage` containing `45deg`;
     - a label span with classes `ossclip-lane-label` and `ossclip-hatch-label`;
     - `style.left` and `style.width` equal to its block's.
  6. No hatch for `scene-a` or `take-1`. `take-1`'s block text contains `take-1`.
  7. With `cues = [lanesCues[0]]` (no graphics), the divider and the strip still render.
  8. `getByTestId("playhead").parentElement` is the track. The track is `ruler.nextElementSibling`.
  9. For each `l of LayoutSchema.options`, `pictureHidden(l) === (layoutSlots(l).video.opacity === 0)`. `LayoutSchema` comes from `@ossclip/core/browser`, and `layoutSlots` from `@ossclip/scenes/geometry`.
  10. Two plain cues `{ id: "take-1", startSec: 13 }` and `{ id: "take-1", startSec: 16 }` both render: two `timeline-block-take-1` elements with distinct `data-piece-start` (Review Focus 4).
  11. With Harness `cuts: [{ startSec: 7, endSec: 8 }]`, the cut band (`timeline-cut-7-8`) contains exactly two strike divs, with `style.top` `"12px"` and `"51px"` (spec §6a).
  12. **Dragged hatch (spec assertion 18).** Reuse the drag pattern at `Timeline.test.ts:930-966`, mocking `getBoundingClientRect` to 100 px per second over 20 s.
      - Dispatch `mousedown` on `scene-c`'s block, then a `window` `mousemove` of +40 px, without `mouseup`.
      - Assert that `timeline-hatch-scene-c`'s `style.left` equals the block's and has changed from its pre-drag value.
      - Assert `dataset.pieceStart === "10.000"`.
      - Then dispatch `mouseup`.

- [ ] **Step 2: Run** `pnpm vitest run apps/editor/test/Timeline.test.ts -t "lanes"`. Expected: FAIL (missing `data-lane`, test ids and the `pictureHidden` export).

- [ ] **Step 3: Implement the lane geometry.**
  - `track.height` becomes `TRACK_HEIGHT`.
  - Remove `top/bottom` from `block`. Each block spreads `isPlain ? V1_BOX : V2_BOX`.
  - Add `data-lane`.
  - Wrap each iteration in the keyed Fragment, moving the key off the block div.
  - Render the divider, then the footage strip, as the track's first two children, with the spec §4 styles (draft 6 values).
  - Replace `cutStrike` with `cutStrikeV2`/`cutStrikeV1`, whose `top` is computed from `V2_BOX`/`V1_BOX` as in spec §6a. Render both inside the unapplied-cut band.
  - Add the two container-query rules to `index.css`. Give the block and hatch divs `containerType: "inline-size"`.
  - In the iteration, after a graphic block where `pictureHidden(cue.layout)` holds, render the hatch:
    - `left` and `width` from the preview-aware `left`/`width` locals;
    - the V1 box;
    - box style per spec §4: 45° stripes, a solid `#26262e` border, flex, `overflow: hidden`, `containerType: "inline-size"`, z 2, `pointerEvents: none`;
    - one label span, `className="ossclip-lane-label ossclip-hatch-label"`, styled as `blockLabel`, then `color: #9A9AA3`, `fontWeight: 400`, `textTransform: "none"`, `background: "#15151bcc"`, `borderRadius: 2`, `marginLeft: 4`, `padding: "0 4px"`;
    - text `cue.video?.volume === 0 ? "no picture · muted" : "audio only"`.
  - Rewrite the stacking comment to the Global Constraints levels ("ghost 2" becomes "hatch 2").

- [ ] **Step 4: Run** the step-2 command, then the whole `Timeline.test.ts`. Expected: PASS, and every pre-existing suite unchanged.

- [ ] **Step 5: Commit.**

  ```bash
  git add apps/editor/src/Timeline.tsx apps/editor/src/index.css apps/editor/test/Timeline.test.ts
  git commit -m "feat(editor): timeline lanes — footage strip, lane boxes, picture-hidden hatch"
  ```

### Task 2: Graphic block look — accent, label, grips, badges, cursors

**Files:**
- Modify: `apps/editor/src/Timeline.tsx`. This covers:
  - the block style branch (`:1647-1672`);
  - the label (`:1675-1685`);
  - the badges (`:1689-1694`);
  - the `edgeHandle` children (`:1695-1706`).
- Modify: `apps/editor/src/index.css`. Add next to the hover rule at `:66`:
  - `.ossclip-grip { background: #F472B6; opacity: .8 }`
  - `.ossclip-edge:hover > .ossclip-grip { opacity: 1 }`
  - `.ossclip-edge.is-selected > .ossclip-grip { background: #dbe4ff }`
- Test: `apps/editor/test/Timeline.test.ts`. Extend the lanes suite. `Harness` gains an optional `selection?: Selection | null` prop (default `null`), passed through to Timeline.

**Interfaces:**
- Consumes: Task 1's lane boxes, `data-lane` and the lanes fixture.
- Produces: class names `ossclip-edge` and `ossclip-grip`.

- [ ] **Step 1: Write the failing tests (spec assertions 4-8 and 16).**
  - `scene-a`'s block: `title === "scene-a"`. Its label span has class `ossclip-lane-label`.
    - Its first child span: `textContent === "scene-a"`, `style.fontWeight === "600"`, `style.textTransform === "none"`.
    - The second: `textContent === "BulletList"`, `style.marginLeft === "6px"`, colour matching `/#c9a3ba|rgb\(201, 163, 186\)/i`, and no inline `opacity`.
  - `scene-c` (ClipScene): the label has exactly one child span, `scene-c`.
  - Each graphic has exactly two `.ossclip-edge > .ossclip-grip`, and no grip has an inline `style.opacity`. Takes have zero `.ossclip-grip`.
  - Cursors: graphic `style.cursor === "grab"`, take `"default"`.
  - Badges:
    - the span with text `PIN` inside `timeline-block-scene-a` has `style.right === "8px"`;
    - `scene-a`'s and `scene-b`'s label spans have `style.paddingRight === "44px"` (one badge each), and `scene-c`'s has none;
    - `volume-badge-scene-b` (`MUTE`) has `"8px"`;
    - `volume-badge-take-0` (`50%`) has `"3px"`.
  - Unselected `scene-a`: `style.border` matches `/1px solid (#f472b6|rgb\(244, 114, 182\))/i`, and `backgroundImage` contains `linear-gradient`.
  - With `selection = { sceneId: "scene-a", elementId: null }`:
    - the border matches `/2px solid/` and `backgroundImage === ""`;
    - the id span's colour matches `/#dbe4ff|rgb\(219, 228, 255\)/i`;
    - both `.ossclip-edge` elements have class `is-selected`.

    Unselected, neither has the class.

- [ ] **Step 2: Run** `pnpm vitest run apps/editor/test/Timeline.test.ts -t "lanes"`. Expected: FAIL on the new assertions only.

- [ ] **Step 3: Implement.**
  - **Graphic branch:** `backgroundColor`, `backgroundImage` and `border` as in Global Constraints. When selected, keep today's border and colour, and set `backgroundImage: undefined`. The take and kept branches are unchanged.
  - **Label (graphics, option A):** the label span gets `className="ossclip-lane-label"`, with two child spans.
    - The id span comes first: `fontWeight: 600`, `textTransform: "none"`, colour `#FBCFE8`, or `#dbe4ff` when selected.
    - The component span: `marginLeft: 6`, `textTransform: "none"`, colour `#C9A3BA`, or `#9fb0d8` when selected.
    - Omit the component span when `cue.component` is `"ClipScene"` or absent.
  - **`title={cue.id}`:** set it on graphic block divs.
  - **Cursor:** `grab` on graphics, `default` on takes.
  - **Badges:** PIN and volume badges on graphics spread `{ ...pinBadge, right: 8 }`. Takes keep `pinBadge`. The graphic label span gets `paddingRight` of 44 with one badge, 76 with two, and none with no badge (spec §3).
  - **Edge handles:** each gets `className={isSelected ? "ossclip-edge is-selected" : "ossclip-edge"}` and the child `<span className="ossclip-grip" style={{ position: "absolute", top: 5, bottom: 5, width: 3, borderRadius: 2, pointerEvents: "none", left|right: 2 }} />`.

- [ ] **Step 4: Run** the whole `Timeline.test.ts`, then `pnpm typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.**

  ```bash
  git add apps/editor/src/Timeline.tsx apps/editor/src/index.css apps/editor/test/Timeline.test.ts
  git commit -m "feat(editor): graphic blocks read as graphics — accent, component label, visible grips"
  ```

### Task 3: E2E — fix two fixed-y checks, add the lanes specs

**Files:**
- Modify: `apps/editor/e2e/interactions.spec.ts`:
  - the scrub at `:215-221`;
  - the stacking check at `:470-497`;
  - a new `describe("timeline lanes")`.
- Modify: `apps/editor/playwright.config.ts:153-157`, the comment only.

**Interfaces:**
- Consumes: the Task 1 and Task 2 test ids. Helpers already in the spec file: `settle`, `playheadFrac`, `selectBlockAt`. Fixture cues: scene-0 (0.09-5.09 s), then take-0 (5.09-12.1 s), scene-2, scene-3 and scene-5.

- [ ] **Step 1: Build the editor.** Run `pnpm build`. Expected: success. E2E serves the built page.

- [ ] **Step 2: Fix the existing checks.**
  - **Scrub at `:215-221`:** aim the y at the take block's own box centre instead of the track's mid-y.
  - **Stacking at `:470-497`:** keep the computed-z assertion. Replace the single `elementFromPoint` probe with two:
    - at `(box.x - 30, scene-2's box y centre)`, the closest block is `timeline-block-scene-2`;
    - at `(box.x - 30, take-0's box y centre)`, the closest block is `timeline-block-take-0`.
  - **Comment:** say why, citing timeline-lanes Risks: the two lanes no longer share a row.

- [ ] **Step 3: Add `describe("timeline lanes")` with two `test()`s.**

  Each test starts with `page.goto("/")` and `settle(page)`.

  **Baseline rule:** after any ruler park, wait with `await expect.poll(() => playheadFrac(page)).toBeCloseTo(parkFrac, 1)` (within 0.02) before reading `before`.

  **Oracles:** "seeked" is `expect.poll` until `Math.abs(playheadFrac - before) >= 0.02`. "Not selected" is `getByTestId("timing-range")` not visible.

  1. **`press on V1 under a graphic seeks and does not select`.**
     - Park on the ruler at scene-3's x + 0.2 width.
     - `mouse.click` at scene-3's x + 0.7 width, at the y centre of the `timeline-footage` box.
     - Assert: seeked, and not selected.
  2. **`press on bare V2 seeks`.**
     - Park at take-0's x + 0.2 width.
     - Click at take-0's x + 0.7 width, at y = track box y + 1 + 3 + 14.
     - Assert: seeked.
     - Also assert at zoom 1: `timeline-scroller` has `scrollWidth <= clientWidth` (Review Focus 3).
  The dragged-hatch check is Task 1's component test 12 (spec assertion 18), not an e2e test.

- [ ] **Step 4: Rewrite the `playwright.config.ts:153-157` comment.**
  - The stage is ≈643px (676 minus 33, `timeline-lanes` Risks).
  - Drop "the timeline sits below the fold". The shell is 100vh with `overflow: hidden`, so a smaller viewport shrinks the stage instead.
  - Keep the reason the viewport is tall: raw `page.mouse` needs both the stage and the timeline at real size.

- [ ] **Step 5: Run** `pnpm --filter @ossclip/editor e2e -- interactions.spec.ts`, then `pnpm --filter @ossclip/editor e2e` once. Expected: all green. If headless Chromium is missing, use the cached revision at `~/.cache/ms-playwright`, as `playwright.config.ts` documents.

- [ ] **Step 6: Commit.**

  ```bash
  git add apps/editor/e2e/interactions.spec.ts apps/editor/playwright.config.ts
  git commit -m "test(editor): e2e for timeline lanes; re-aim two single-row checks"
  ```

### Task 4: Full verification, by-eye check, FINDINGS §175

**Files:**
- Modify: `docs/PHASE1-FINDINGS.md`. Append §175, "Timeline lanes", after §174 (`:2174`).

- [ ] **Step 1: Run** `pnpm test --maxWorkers=2 --minWorkers=1`, then `pnpm typecheck`, then `pnpm build`. Expected: all green, with the test count above the 6715 baseline.

- [ ] **Step 2: Hand the by-eye check to the author.** This needs the author and is not delegable. Restart the editor on FE Loop:

  `pnpm ossclip edit "$HOME/ossclip-work/fe-loop/work/FE Loop-116d3cbc" --no-open --port 5180`

  The author checks, at zoom 1× and 8×:
  - a hatch under a `graphic-only` graphic;
  - a selected graphic shows no pink, including its grips;
  - the cut band's two strike lines sit one in each lane;
  - label truncation on short graphics and short hatches;
  - grips on narrow blocks, including a pinned graphic at 1024 wide with its id fully visible left of PIN;
  - take filmstrips still in V1;
  - the 640×560 landscape run.

  Record what they report.

- [ ] **Step 3: Write §175.** Cover:
  - the problem (spec Overview);
  - the chosen shape: one track, vertical offsets, and why not B2;
  - the declared press-rule change;
  - the known limit: takes set to `graphic-only` keep their filmstrip;
  - the by-eye results;
  - the round-1 lesson: the computed underlay was dropped for a passive strip, because a run of back-to-back graphics has no take under it.

- [ ] **Step 4: Commit.**

  ```bash
  git add docs/PHASE1-FINDINGS.md
  git commit -m "docs: FINDINGS §175, timeline lanes"
  ```
