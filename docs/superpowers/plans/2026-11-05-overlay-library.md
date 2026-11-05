# Overlay Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Logos, images and GIFs from a global library pop on screen at the spoken word (overlay above captions, or a full-screen card), with a pop sound, editable in an editor lane + tray.

**Architecture:** "SFX for pictures":
- **Placement and edits.** Placements are word-indexed and stored in `production.json.overlays`. The user's layer goes in `overrides.json.overlays`, shaped like `sfx`.
- **Resolve and render.** A pure resolver turns placements into `OverlayCue`s in output time. An `OverlayTrack` layer in the composition renders them.
- **Library and matching.** The global library (`~/.ossclip/library/`) is matched deterministically: first mention, no LLM.
- **Snapshots.** Every used file is snapshotted into `<workdir>/library/`, so a render never depends on the library again.

**Tech Stack:** TypeScript, zod/v4, vitest, Remotion 4 (+ new `@remotion/gif`), React editor, Node http edit server, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-05-overlay-library-design.md` — the binding authority. Read it before any task.

## Global Constraints

- **User values** (library.json, overrides, POST bodies) are parsed with zod, never coerced. Loaders never throw; problems come back as `issues[]` (the `loadSfxLibrary` / `loadLutLibrary` posture).
- **Test isolation.** The library dir is an injectable default parameter (`dir = userLibraryDir()`), the same as `lut-library.ts:51` and `sfx-pack.ts:191`. Tests use `mkdtempSync` dirs and never touch `~/.ossclip`. The edit server's tests inject a library loader / dir through its opts, the same as `loadSfx` / `loadLuts` (`edit.ts:789`).
- **Served paths** are POSIX-literal (`library/<id>.<ext>`), built with `/` and never `join()`. This is the `sfxStagedFile` / `sideImageDestRel` rule.
- **Browser-safe modules** (anything exported from `packages/core/src/browser.ts`) import no node built-ins. `overlay-match.ts` and `overlay-cues.ts` must be browser-safe. `overlay-library.ts` is node-only.
- **Ids:**
  - Library entry id: `/^[a-z0-9][a-z0-9-]*$/`.
  - User-added placement id: `/^[A-Za-z0-9_-]+$/` (no `@`, which is the `SfxAddedPlacementSchema` reasoning).
  - Matched placement id: `${entryId}@${word}`.
- **Defaults:**
  - `durationSec`: overlay **1.5**, card **2.0**, clamped to **0.5–6**.
  - `sound`: `entry.sound ?? "pop"`; `null` means silent.
  - Planned sfx within **0.5s** of an overlay sound are dropped with reason `"overlay"`.
  - Short-name rule: a single-word name of **≤3 letters** matches only on an exact-case match.
  - Upload cap **20 MB**, URL fetch timeout **15s**, at most **5** redirects.
- **Formats:** png, jpg/jpeg, webp, svg, gif, detected by magic bytes (svg by an `<svg` root after an optional XML prolog/whitespace/comments). Edit-server MIME table gains `.gif image/gif`, `.webp image/webp`, `.svg image/svg+xml`.
- **Back-compat.** Every new field is optional. A production without a library, or with an empty one, writes `production.json` / `render-props.json` byte-identical to today (no `overlays` key, no `overlayCues` key).
- **House style:**
  - Comments explain why and cite the spec section.
  - Run tests from the repo root: `pnpm vitest run <path>`. `pnpm --filter … test` is a no-op.
  - `pnpm typecheck` must be green at the end of every task.
- **No version bump** in this plan. Releases are separate.

## Review Focus

1. **Library file replaced or deleted after a project used it.**
   - Expected: a re-render uses `<workdir>/library/<id>.<ext>` unchanged; with both copies gone, it skips the overlay with a ⚠ line, never a broken box.
   - Pinned in Task 5.
2. **Punctuation around the name.**
   - Expected: "GDE," / "GDE." / "GDE's" match; "GDEs" / "gde" (lowercase, for a ≤3-letter name) don't; "clean edit" matches across two words, "clean, edit" too (edge punctuation per word).
   - Pinned in Task 2.
3. **First mention was cut by the user in the editor.**
   - Expected: the logo moves to the next kept mention; with no kept mention, it's dropped and reported, not silently lost.
   - Pinned in Task 3.
4. **Hostile adds:**
   - URL that redirects to HTML
   - a 25 MB file
   - a path to `/etc/passwd`
   - a name of `../../x`
   - an SVG

   Expected: the first four are rejected with a readable 400, and nothing is written outside the library dir. The SVG is accepted, rendered through `<img>` only, never inlined.
   - Pinned in Task 6.
5. **Overlay while captions are hand-moved high, or during a `graphic-only` scene.**
   - Expected: it never overlaps the caption block; it falls back to the top safe area.
   - Pinned in Task 4.

---

### Task 1: Library loader and add (core, node)

**Files:**
- Create: `packages/core/src/overlay-library.ts`
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/test/overlay-library.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const LIBRARY_INDEX_FILE = "library.json";
  export type OverlayKind = "logo" | "image" | "gif";
  export type OverlayLook = "overlay" | "card";
  export type ImageFormat = "png" | "jpg" | "webp" | "svg" | "gif";
  export const LibraryEntrySchema: z.ZodType<LibraryEntry>; // spec "Library on disk"
  export interface LibraryEntry { id: string; file: string; names: string[]; kind: OverlayKind; look?: OverlayLook; sound?: string | null }
  export interface LoadedLibraryEntry extends LibraryEntry { absPath: string; format: ImageFormat }
  export function userLibraryDir(): string;            // join(CONFIG_DIR, "library")
  export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null;
  export function loadOverlayLibrary(dir?: string): { entries: LoadedLibraryEntry[]; issues: { file: string; message: string }[] };
  export function slugifyEntryId(name: string, taken: ReadonlySet<string>): string;
  export async function addLibraryEntry(
    bytes: Uint8Array,
    meta: { name: string; aliases?: string[]; kind?: OverlayKind },
    dir?: string,
  ): Promise<LoadedLibraryEntry>;  // throws LibraryAddError (message is user-readable)
  export class LibraryAddError extends Error {}
  export const LIBRARY_MAX_BYTES = 20 * 1024 * 1024;
  ```

- [ ] **Step 1: Write failing tests**, in `overlay-library.test.ts`, with a `mkdtempSync` dir:
  - `loads indexed entries with absPath and sniffed format`: write a 1×1 PNG plus `library.json` with `{id:"gde", file:"gde.png", names:["Google Developers Expert","GDE"], kind:"logo"}`. Expect one entry, `format: "png"`, `absPath === join(dir,"gde.png")`.
  - `unindexed file loads with stem name`: `google-cloud.png` and no index gives `{id:"google-cloud", names:["google cloud"], kind:"logo"}`. `party.gif` gives `kind:"gif"`.
  - `indexed file is not loaded twice`.
  - `bad JSON → issues, unindexed files still load`.
  - `entry whose file is missing or not an image → issue, skipped`.
  - `sniffImageFormat`: PNG / JPEG / GIF87a / GIF89a / RIFF…WEBP / `<?xml …?><svg` / leading-whitespace `<svg` are recognised; `<html>` and random bytes give `null`.
  - `addLibraryEntry`:
    - writes `<slug>.<ext>` and the index atomically (no `.tmp` left behind)
    - a second add named "GDE" gets id `gde-2`
    - a `../../x` name slugs to `x`; the file is always inside `dir`
    - a non-image throws `LibraryAddError`
    - more than `LIBRARY_MAX_BYTES` throws
    - `kind` defaults to `gif` for gif bytes, otherwise `logo`
    - an existing index's other entries are preserved
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/overlay-library.test.ts`. Expect FAIL (module missing).
- [ ] **Step 3: Implement.**
  - Unindexed names: the stem with `[-_]+` turned into spaces.
  - Atomic write: temp file in the same dir, then `rename`.
  - The extension comes from the sniffed format (`jpg` for JPEG), never from the source name.
- [ ] **Step 4: Run** the tests. Expect PASS. Then run `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(core): overlay library loader and add`.

### Task 2: First-mention matcher (core, browser-safe)

**Files:**
- Create: `packages/core/src/overlay-match.ts`
- Modify: `packages/core/src/browser.ts`, `packages/core/src/index.ts` (export)
- Test: `packages/core/test/overlay-match.test.ts`

**Interfaces:**
- Consumes: `LibraryEntry` (type only; re-declare a minimal `{id, names}` structural type to stay browser-safe).
- Produces:
  ```ts
  export interface MatchablePlacement { id: string; entryId: string; word: number; source: "match" }
  export interface MatchDrop { entryId: string; word: number; reason: "overlap" }
  export function normalizeMatchToken(text: string): string;  // trim, strip edge punctuation, strip trailing 's/’s
  export function matchLibrary(
    words: readonly { text: string; start: number; end: number }[],
    entries: readonly { id: string; names: readonly string[] }[],
    opts?: { kept?: (wordIndex: number) => boolean; minGapSec?: number; skipEntryIds?: ReadonlySet<string> },
  ): { placements: MatchablePlacement[]; dropped: MatchDrop[] };
  /** Every kept index where any of the entry's names starts, ascending — the resolver's fall-forward uses it. */
  export function mentionsOf(words: ..., names: readonly string[], kept?: (i: number) => boolean): number[];
  ```
  - `minGapSec` defaults to 1.5, the overlay default duration.
  - `skipEntryIds` is for "Find library matches": entries already placed or removed.

- [ ] **Step 1: Write failing tests**, one per rule from spec §Matching:
  - `first mention only`: "GDE" spoken at words 3 and 9 gives one placement at 3, id `gde@3`.
  - `multi-word name as a contiguous sequence`: "clean edit" over words `["a","clean,","edit."]` matches at index 1. `["clean","and","edit"]` doesn't.
  - `case-insensitive for longer names`: "firebase" matches "Firebase".
  - `≤3-letter single word needs exact case`: name "Go" doesn't match "go"; it matches "Go". "GDE" matches "GDE," and "GDE's". It doesn't match "GDEs".
  - `no stemming`: name "Firebase" doesn't match "Firebased".
  - `longest name wins on overlap`: entries `google:["Google"]` and `gde:["Google Developers Expert"]`, spoken "Google Developers Expert" first, give only `gde` at that index. `google` places at its next standalone mention, if any.
  - `cut words ignored`: with `kept` false for index 3, the match falls on the next kept mention.
  - `overlap drop`: two entries whose first mentions start within 1.5s of each other. The later one goes into `dropped` with reason `"overlap"`.
  - `skipEntryIds` honoured.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/overlay-match.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - Tokenize each name on whitespace and normalize every token.
  - Scan words in order.
  - For every start index, try the entry names longest first (by token count, then by character length).
  - Claimed word indices can't be reused by a shorter name.
  - This is a stricter matcher than `reveal-match.ts`: share nothing beyond, at most, an edge-punctuation regex.
- [ ] **Step 4: Run** the tests, then `pnpm typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `feat(core): first-mention library matcher`.

### Task 3: Schemas, overrides layer, resolver (core, browser-safe)

**Files:**
- Modify: `packages/core/src/schema.ts` (add `ProductionOverlaysSchema`, `overlays` on `ProductionSchema` beside `sfx`), `packages/core/src/overrides.ts` (add the `overlays` slot + `applyOverlayOverrides`), `packages/core/src/browser.ts`
- Create: `packages/core/src/overlay-cues.ts`
- Test: `packages/core/test/overlay-cues.test.ts`, `packages/core/test/overlay-overrides.test.ts`

**Interfaces:**
- Consumes: `mentionsOf` (Task 2), `TimeMap` (`timemap.ts`, `mapWord`), `SfxCue` / `sfxStagedFile` / `SFX_PUBLIC_SUBDIR` (`assemble.ts`).
- Produces:
  ```ts
  // schema.ts — browser-safe (schema.ts already is)
  export const OverlayEntrySnapshotSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), name: z.string().min(1), names: z.array(z.string().min(1)).min(1),
    kind: z.enum(["logo","image","gif"]), ext: z.enum(["png","jpg","webp","svg","gif"]),
    look: z.enum(["overlay","card"]).optional(), sound: z.string().min(1).nullable().optional(),
  });
  export const OverlayPlacementSchema = z.object({
    id: z.string().regex(/^[A-Za-z0-9_@-]+$/), entryId: z.string(), word: z.number().int().nonnegative(),
    look: z.enum(["overlay","card"]).optional(), durationSec: z.number().min(0.5).max(6).optional(),
    sound: z.string().min(1).nullable().optional(), source: z.enum(["match","user"]),
  });
  export const ProductionOverlaysSchema = z.object({
    entries: z.array(OverlayEntrySnapshotSchema), placements: z.array(OverlayPlacementSchema),
  });
  // ProductionSchema gains: overlays: ProductionOverlaysSchema.optional()

  // overrides.ts — OverrideDocSchema gains:
  overlays: z.object({
    edits: z.record(z.string(), z.object({ entryId: z.string().optional(), word: z.number().int().nonnegative().optional(),
      look: z.enum(["overlay","card"]).optional(), durationSec: z.number().min(0.5).max(6).optional(),
      sound: z.string().min(1).nullable().optional(), removed: z.boolean().optional() })).default({}),
    added: z.array(OverlayPlacementSchema.extend({ id: z.string().regex(/^[A-Za-z0-9_-]+$/) })).default([]),
    entries: z.array(OverlayEntrySnapshotSchema).default([]),
  }).optional()
  export function applyOverlayOverrides(
    plan: { entries: OverlayEntrySnapshot[]; placements: OverlayPlacement[] } | undefined,
    layer: OverrideDoc["overlays"],
  ): { entries: OverlayEntrySnapshot[]; placements: OverlayPlacement[]; dropped: { key: string; reason: "stale key" }[] };
  // An edit keyed by an `added` id applies to that added placement too.
  // Override entries win over plan entries with the same id (a tray swap re-snapshots).

  // overlay-cues.ts
  export const OVERLAY_PUBLIC_SUBDIR = "library";
  export function overlayStagedFile(e: { id: string; ext: string }): string; // `library/<id>.<ext>`
  export interface OverlayCue { id: string; file: string; kind: "logo"|"image"|"gif"; look: "overlay"|"card"; atSec: number; endSec: number }
  export interface OverlayIssue { placement: string; reason: "unknown entry" | "cut word" | "moved forward" | "outside transcript" | "missing file" | "unknown sound"; issue: string }
  export function resolveOverlayCues(
    resolved: { entries: OverlayEntrySnapshot[]; placements: OverlayPlacement[] },
    words: readonly Word[], map: TimeMap, outputDurationSec: number,
    opts?: { exists?: (stagedRel: string) => boolean; soundFile?: (soundId: string) => { soundFile: string; gain: number; durationSec?: number } | undefined },
  ): { cues: OverlayCue[]; soundCues: SfxCue[]; issues: OverlayIssue[] };
  export function dropSfxNearOverlays(sfx: readonly SfxCue[], overlaySounds: readonly SfxCue[], windowSec?: number /* 0.5 */):
    { kept: SfxCue[]; dropped: SfxCue[] };
  ```

- [ ] **Step 1: Write failing tests.**
  - **overlay-cues:**
    - `resolves word start to output seconds; default duration 1.5 overlay / 2.0 card; entry.look default`.
    - `match placement on a cut word falls forward to the next kept mention`. Issue `"moved forward"`; the cue is at the new word.
    - `no kept mention → dropped with "cut word"`.
    - `user placement on a cut word moves to the next kept word`.
    - `endSec clamped to outputDurationSec`.
    - `sound default "pop"; null → no soundCue; unknown sound → cue kept, issue "unknown sound"`.
    - `exists false → cue dropped, "missing file"`.
    - `cues sorted by atSec`.
    - `dropSfxNearOverlays drops planned sfx within 0.5s either side, keeps 0.6s away`.
  - **overlay-overrides:**
    - `edit patches look/duration/sound`.
    - `removed true drops a match and survives a re-produce` (same plan → still removed).
    - `added placements appended`.
    - `override entry snapshot wins over plan entry`.
    - `stale edit key reported`.
    - `OverrideDocSchema.parse({})` has no `overlays` key.
    - `ProductionSchema` without `overlays` parses unchanged.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/overlay-cues.test.ts packages/core/test/overlay-overrides.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - The fall-forward calls `mentionsOf(words, entry.names, kept)` and picks the first mention after the placement's word.
  - `kept` is `map.mapWord(words[i]) !== null`.
- [ ] **Step 4: Run** the tests, `pnpm vitest run packages/core` (the full core suite, to check nothing else regressed), and `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(core): overlay placements, overrides and resolver`.

### Task 4: Rendering — OverlayTrack, caption-aware placement, card hides captions

**Files:**
- Create: `packages/scenes/src/overlay-track.tsx`, `packages/scenes/src/overlay-rect.ts`
- Modify:
  - `packages/scenes/src/CaptionTrack.tsx`: extract the anchor chain into an exported pure `captionAnchorForLine(...)`, and add an optional `hideDuring?: {start:number; end:number}[]` prop.
  - `packages/scenes/src/index.ts`
  - `packages/scenes/package.json`: add `@remotion/gif` pinned to the exact installed `remotion` version.
  - `packages/renderer/src/ProductionComposition.tsx`: add the `overlayCues?: OverlayCueProps[]` prop. It renders `<OverlayTrack>` after `CaptionTrack`, and passes card windows to `CaptionTrack.hideDuring`.
- Test: `packages/scenes/test/overlay-rect.test.ts`, `packages/scenes/test/overlay-track.test.ts`

**Interfaces:**
- Consumes: `OverlayCue` (Task 3; re-declared structurally in scenes with a zod `overlayCuesFor` parse-and-drop, the same as `sfxCuesFor`), `captionAnchorAvoiding`, `regionsDuring` (`source-fit.ts`), `activeCueAt`, `layoutSlots`, `SAFE_AREA` (`stage.ts`), `enterFrames` / `enterProgress` (`anim.ts`).
- Produces:
  ```ts
  export function captionAnchorForLine(cues, sourceTextRegions, line: {start:number; end:number}, frame, verticalAnchor): { anchor: number; scale: number };
  export interface Rect { x: number; y: number; w: number; h: number } // fractions of frame
  export function overlayRect(args: {
    frame: FrameSize; aspect: number;              // image w/h
    captionTop: number | null;                     // fraction; null = no caption on screen
    graphicRect?: Rect;                            // active scene graphic, if any
  }): Rect;
  export function overlayCuesFor(raw: unknown): OverlayCueProps[];
  export const OverlayTrack: React.FC<{ cues: OverlayCueProps[]; captionTopAt: (tSec: number) => number | null; graphicRectAt: (tSec: number) => Rect | undefined }>;
  ```

- [ ] **Step 1: Write failing tests** (`overlay-rect.test.ts`, pure):
  - `centred, ~1/3 width, bottom edge above captionTop with a gap`.
  - `aspect preserved; tall images capped by height inside SAFE_AREA`.
  - `captionTop high (0.3) → no room → top safe area`.
  - `graphicRect between → avoids it; neither fits → may overlap graphic, never captions` (assert `rect.y + rect.h <= captionTop`).
  - `null captionTop → above the default caption anchor`.

  `overlay-track.test.ts`:
  - `overlayCuesFor drops malformed entries`.
  - `captionAnchorForLine reproduces CaptionTrack's prior anchors` (captionY wins; avoiding path; plain anchor).
- [ ] **Step 2: Run** `pnpm vitest run packages/scenes/test/overlay-rect.test.ts packages/scenes/test/overlay-track.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - **CaptionTrack refactor:** behaviour must stay identical. The existing scenes tests stay green.
  - **Caption top:** `captionTop = anchor − (lineCount × lineHeightFrac × scale)/2`. Use the line-height math CaptionTrack already uses; don't invent a constant.
  - **`OverlayTrack`, per cue:**
    - One `<Sequence>` per cue.
    - `look:"overlay"` gives an `Img` (or a `Gif` from `@remotion/gif` for `kind:"gif"`), positioned by `overlayRect`. Scale + opacity come from `enterProgress`; it fades out over the last 0.25s.
    - `look:"card"` gives a full-frame black `AbsoluteFill` that fades in over 0.15s, with the image centred at 50% of the frame's shorter side.
  - **`src`:** `staticFile(file)` unless it starts with `/` or `http`. This is the ProductionComposition cover rule, so the editor can pass `/media/library/...`.
  - **`hideDuring`:** a caption line renders nothing for frames inside any window.
- [ ] **Step 4: Run** `pnpm vitest run packages/scenes packages/renderer` and `pnpm typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `feat(scenes): overlay track with caption-aware placement`.

### Task 5: Produce — match, carry forward, snapshot, stage, resolve, report

**Files:**
- Modify: `apps/cli/src/produce.ts`
- Test: `apps/cli/test/overlay-produce.test.ts` (pure helpers), plus a verify-ossclip drive

**Interfaces:**
- Consumes: Tasks 1–3, plus the existing `priorSfxPlan` pattern (`produce.ts:513`), `loadSfxLibrary`, `sfxStagedFile`, the staging loop (`produce.ts:4589`), and the `production` object (`:4610+`).
- Produces (exported from produce.ts for tests):
  ```ts
  export function priorOverlayPlan(work: string): ProductionOverlays | undefined; // tolerant, zod-parsed, like priorSfxPlan
  export function snapshotEntry(e: LoadedLibraryEntry): OverlayEntrySnapshot;
  export function stageOverlayFiles(
    entries: readonly OverlayEntrySnapshot[], library: readonly LoadedLibraryEntry[],
    work: string, publicDir: string,
  ): { staged: Set<string>; issues: string[] }; // copies library → <work>/library/<id>.<ext> only when the workdir copy is MISSING; always mirrors workdir → publicDir
  ```
  - `opts.libraryDir?: string` is an injectable library dir (a hidden CLI option is fine; tests and the verify drive use it).

- [ ] **Step 1: Write failing tests** (`overlay-produce.test.ts`, temp dirs):
  - `priorOverlayPlan: missing/garbage file → undefined; valid → parsed`.
  - `stageOverlayFiles: workdir copy wins even when library file changed` (write different bytes to the library after the first stage, stage again, and check the workdir bytes are unchanged and publicDir equals the workdir).
  - `library file deleted → workdir copy still staged`.
  - `both missing → issue, not staged`.
- [ ] **Step 2: Run** `pnpm vitest run apps/cli/test/overlay-produce.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** in `produce.ts`:
  - **Plan source.**
    - When `opts.scenes` is set (a replay), `overlayPlan = priorOverlayPlan(work)`. Log `▸ overlays carried forward (N)`.
    - Otherwise (a fresh produce, or `--produce`), load the library and run `matchLibrary` over the repaired transcript words, with `kept` from the final map. Then snapshot the used entries.
  - **Then, in the resolve section:**
    1. `applyOverlayOverrides(overlayPlan, overrideDoc.overlays)`.
    2. Stage.
    3. `resolveOverlayCues`, with `exists` checking the staged workdir file.
  - **Sounds, regardless of `sfxOn`:**
    - Load `loadSfxLibrary({includeBundled: true})` lazily whenever any placement has a sound. The bundled pack is always included for overlay sounds (spec).
    - Stage the used sounds with the existing sfx staging logic, refactored into a shared helper rather than copied.
    - Run `dropSfxNearOverlays` against the planned `sfxCues`, and log dropped ones as `⚠ sfx: dropped near overlay`.
  - **Write:**
    - `production.overlays` only when `overlayPlan` has placements, so back-compat stays byte-identical.
    - `render-props.overlayCues` only when there are cues.
    - Append the sound cues to `sfxCues`.
  - **Report** (console and report.txt): `overlays: N placed (GDE, Firebase), M skipped`, plus a ⚠ line per issue.
- [ ] **Step 4: Verify.**
  - Run `pnpm vitest run apps/cli` and `pnpm typecheck`.
  - Run the verify-ossclip fixture drive twice.
    - **Plain:** the baseline is unchanged (22 words, 4 cuts, 6.32s removed, output 11.58s), and `production.json` has no `overlays` key.
    - **With a temp library** holding entry `{id:"clean-edit", names:["clean edit"], …}` plus a 1×1 PNG, passed via `--library-dir`:
      - `production.json.overlays.placements[0]` is `{entryId:"clean-edit", word:19, source:"match"}`.
      - `render-props.overlayCues` has one cue.
      - `render-props.sfxCues` has a `sfx/pop.mp3` cue at the same `atSec`, even without `--sfx`.
      - `<WD>/…/library/clean-edit.png` exists.
  - Save the evidence to `docs/verification/2026-11-05-overlay-library/`.
- [ ] **Step 5: Commit** `feat(cli): produce places and stages library overlays`.

### Task 6: Edit server — library, stage, match endpoints

**Files:**
- Modify: `apps/cli/src/edit.ts`
- Create: `apps/cli/src/library-fetch.ts` (pure-ish: URL fetch with caps, an injectable `fetch`)
- Test: `apps/cli/test/edit-library.test.ts`, `apps/cli/test/library-fetch.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3, plus `stageOverlayFiles` / `snapshotEntry` (Task 5).
- Produces:
  - **`GET /api/library`** → `{entries: {id,names,kind,look?,sound?,format}[]}`. No paths. No workdir guard, the same as `/api/sfx/library`.
  - **`GET /api/library/file?id=`** → bytes, looked up by id with the correct MIME. 404 for an unknown id.
  - **`POST /api/library`**:
    - Body: zod `{name: string.min(1).max(80), aliases?: string[] (max 10), kind?: kind, source: {url} | {path} | {data, mimeType}}`.
    - `url`: http(s) only, via `fetchLibraryBytes(url, {fetch, maxBytes, timeoutMs:15000, maxRedirects:5})`.
    - `path`: absolute, `statSync().isFile()`, size checked before reading.
    - `data`: base64, size checked after decode.
    - Returns 201 with the entry, or 400 `{error}` with a readable message.
  - **`GET /api/overlays/plan`** → `{overlays: ProductionOverlays | null, words}`. The repaired words are the same space as `/api/sfx/plan`.
  - **`POST /api/overlays/stage`**, body `{entryId}`: copies the library entry into `<workdir>/library/`, returns `{entry: OverlayEntrySnapshot}` (tray add and swap).
  - **`POST /api/overlays/match`**: runs `matchLibrary` against the current library. Skips entry ids already placed or removed (plan + current overrides from the body `{overlays}`). Stages the new matches' files. Returns `{placements, entries, skipped: number}`.
  - **MIME table:** add gif / webp / svg.
  ```ts
  // library-fetch.ts
  export async function fetchLibraryBytes(url: string, o: { fetch?: typeof fetch; maxBytes: number; timeoutMs: number; maxRedirects: number }): Promise<Uint8Array>; // throws LibraryAddError
  ```

- [ ] **Step 1: Write failing tests.**
  - **library-fetch** (fake fetch):
    - `rejects non-http(s)` (`file:`, `data:`).
    - `follows ≤5 redirects, rejects the 6th`.
    - `aborts over maxBytes while streaming`.
    - `timeout → LibraryAddError`.
  - **edit-library** (the server started with an injected temp library dir and a temp workdir, the same as the existing edit-server tests):
    - `POST base64 png → 201, file in library dir, GET /api/library lists it without paths`.
    - `POST path to a text file → 400`.
    - `POST name "../../x" → file stays inside the library dir`.
    - `POST 21MB → 400`.
    - `POST svg → 201 format svg`.
    - `GET /api/library/file?id=unknown → 404`.
    - `stage copies into <workdir>/library/<id>.<ext>`.
    - `match skips placed/removed entries`.
    - `.gif served as image/gif`.
- [ ] **Step 2: Run** `pnpm vitest run apps/cli/test/edit-library.test.ts apps/cli/test/library-fetch.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - The redirect check redoes the http(s) check on every hop.
  - Content type is never trusted; bytes go through `addLibraryEntry`, which sniffs them.
- [ ] **Step 4: Run** `pnpm vitest run apps/cli` and `pnpm typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `feat(cli): edit server library and overlay endpoints`.

### Task 7: Editor — overlay lane, inspector, live preview

**Files:**
- Create: `apps/editor/src/overlayLane.ts` (pure, the `sfxLane.ts` pattern)
- Modify: `apps/editor/src/useEdits.ts`, `apps/editor/src/Timeline.tsx`, `apps/editor/src/Inspector.tsx`, `apps/editor/src/App.tsx`
- Test: `apps/editor/test/overlayLane.test.ts` (or wherever the `sfxLane` tests live; match it), `apps/editor/test/useEdits-overlays.test.ts`

**Interfaces:**
- Consumes: `/api/overlays/plan`, `applyOverlayOverrides` / `resolveOverlayCues` (core/browser), `OverlayTrack` (via the composition's `overlayCues` prop).
- Produces:
  - **`useEdits` actions:**
    - `{type:"patchOverlay"; id; patch: {entryId?, word?, look?, durationSec?, sound?: string|null}; coalesce?: boolean}`
    - `{type:"removeOverlay"; id}` (match → `edits[id].removed=true`; added → splice)
    - `{type:"restoreOverlay"; id}`
    - `{type:"addOverlay"; entry: OverlayEntrySnapshot; word: number; source?: "user"|"match"}` (mints its id like `mintSfxAddedId`, upserts the entry snapshot into `overlays.entries`)
    - `{type:"addOverlayMatches"; placements; entries}`
    - The slot is removed when empty (the `withSfx` rule).
  - `overlayLaneMarkers(plan, layer, words, map) → {id, atSec, endSec, entryId, look, removed: boolean}[]`.
  - **Preview:** the App builds `overlayCues` live from plan + doc + the live map, with files re-pointed to `/media/library/<id>.<ext>`, and passes them into the Player's inputProps. Overlay sounds join the existing `useSfxPreview` cue list so the pop is heard in preview.

- [ ] **Step 1: Write failing tests:**
  - `lane markers: plan + added, removed shown as ghost, cut word falls forward` (the same rule as the resolver, which the lane calls).
  - The reducer: `patch/remove/restore/add round-trip; undo restores; empty slot removed; added id has no @`.
- [ ] **Step 2: Run** them. Expect FAIL.
- [ ] **Step 3: Implement.**
  - **Lane:** under the sfx lane. Chips show a thumbnail (`/media/library/<id>.<ext>`), are draggable to retime (snapping to word starts via the existing sfx word-anchor helper), and are selectable. Selection state is separate (`overlaySelection`).
  - **Inspector:** image (opens the tray in swap mode; Task 8), look radio, duration slider with a "default" reset (the revealSpeed pattern), sound toggle, delete.
  - **Context menu:** a transcript word or the timeline gets "Add logo/image here…", which opens the tray in add mode at that word.
- [ ] **Step 4: Run** `pnpm vitest run apps/editor` and `pnpm typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `feat(editor): overlay lane, inspector and preview`.

### Task 8: Editor — tray, Find matches, e2e

**Files:**
- Create: `apps/editor/src/OverlayTray.tsx`
- Modify: `apps/editor/src/App.tsx`, `apps/editor/src/Timeline.tsx` (the lane-header "Find library matches" button), `apps/editor/e2e/interactions.spec.ts` (or a new `overlays.spec.ts` beside it)

**Interfaces:**
- Consumes: `GET/POST /api/library`, `GET /api/library/file`, `POST /api/overlays/stage`, `POST /api/overlays/match`, the Task 7 actions.
- Produces: `<OverlayTray mode: {kind:"add"; word} | {kind:"swap"; id} onClose/>`.

- [ ] **Step 1: Write the failing e2e**, with the server started against a temp library dir and a temp HOME (see the Global Constraints; this also fixes the e2e touching the real `recent-projects.json` for this spec):
  - `add from tray via local path`: right-click a word, choose "Add logo/image here…", paste a fixture PNG path, name it "Clean Edit", and Add. A lane chip appears at that word; Save, reload, and the chip persists. `library.json` in the temp library has the entry.
  - `swap look to card`: select the chip, choose Card, and Save. `overrides.json` has `edits[id].look === "card"` (or the added placement's look).
  - `delete`: select, Delete, and the chip is gone after reload.
  - `find matches`: with a library entry named "clean edit", click Find library matches. A chip appears at word 19, and the toast says "added 1".
- [ ] **Step 2: Run** `pnpm build && cd apps/editor && pnpm e2e`. Expect the new specs to FAIL.
- [ ] **Step 3: Implement the tray.**
  - A library grid with a name search; GIF thumbnails animate (plain `<img>`).
  - A paste box that takes a URL or an absolute path, and a drop zone (base64 upload).
  - On a new item: name (pre-filled from the file name or the last URL segment), aliases (comma-separated), kind (guessed: gif → gif, else logo).
  - On a library pick or a new add, call `POST /api/overlays/stage` and dispatch `addOverlay` (add mode) or `patchOverlay {entryId}` plus the entry snapshot upsert (swap mode).
  - Errors from the server show inline.
  - Find matches posts the current `doc.overlays` and dispatches `addOverlayMatches`.
- [ ] **Step 4: Run** `pnpm vitest run` (whole workspace), `pnpm typecheck`, `pnpm build`, and `cd apps/editor && pnpm e2e`. Expect everything green.
- [ ] **Step 5: Commit** `feat(editor): overlay tray and library matches`.
