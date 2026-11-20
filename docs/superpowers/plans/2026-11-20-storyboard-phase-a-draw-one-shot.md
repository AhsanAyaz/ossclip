# Storyboard Phase A (draw and steer one shot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An experimental command draws one shot from a one-sentence idea as LLM-written React code, checks it, renders stills and a preview, and redraws it from a typed note.

**Architecture:** A pure static check and the draw/repair loop live in core. The drawing kit is a new entry point of the scenes package. The renderer gains a per-scene bundle (generated entry, module resolve rule, content security policy) and drawn-scene still, preview and clip renders. The CLI holds the type check, the files on disk and the command.

**Tech Stack:** TypeScript, zod (`zod/v4`), vitest, Remotion 4.0.499, the `typescript` compiler API.

**Spec:** `docs/designs/storyboard-drawn-scenes.md` (sections 3 to 7, 9, Phase A). Read it before any task.

## Spike results (2026-11-20, main thread; these are facts, not tasks)

*   **A scene file in a workdir renders through a bundle.** `bundle({entryPoint, webpackOverride})` with an entry file in the workdir, `resolve.modules: [<packages/renderer>/node_modules, "node_modules"]` and an alias for `@ossclip/scenes/draw`. Bundle 2.4 s, one still 1.0 s on the author's machine. So: **one bundle per scene version**, never per batch.
*   **A content security policy blocks the network.** `bundle()` returns a directory; a `<meta http-equiv="Content-Security-Policy">` inserted after `<head>` in its `index.html` stopped `fetch`, `<img>`, `new Image()` and CSS `url()` to another origin (4 requests reached a probe server without it, 0 with it). Policy used:
    `default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:; connect-src 'self'; img-src 'self' blob: data:; media-src 'self' blob: data:; font-src 'self' data:; frame-src 'none'; object-src 'none'`
*   **The editor server trusts every loopback origin** (`apps/cli/src/edit-origin.ts`), and the render page is served from a loopback origin. Without the policy, drawn code could call the editor's write endpoints. The policy closes this (`connect-src 'self'` is the bundle's own port). A policy does not stop page navigation, so the static check also rejects `location` and `open`.

## Global Constraints

*   Runs without the new command are unchanged: no existing prompt, schema, cache key or export changes.
*   LLM-written code runs only in the headless browser Remotion starts. Never `import()` or evaluate it in Node.
*   A drawn scene may import only `react`, `@ossclip/scenes/draw`, and from `remotion`: `useCurrentFrame`, `useVideoConfig`, `interpolate`, `interpolateColors`, `spring`, `Easing`, `AbsoluteFill`, `Sequence`.
*   Scene file: at most 400 lines, no run of three backticks.
*   Repairs: at most 2 per version.
*   Stills: three frames, at 25% and 60% of the duration and the last frame.
*   Values from users are parsed with zod, never coerced. Pure logic is separated from I/O. Comments say why and cite `§167` (the FINDINGS section this phase writes).
*   The command's help text starts with `experimental:`.
*   Commit after each task. Do not push.

## Review Focus

1.  **Code that hides a name from the parser** (`globalThis["fe"+"tch"]`, `[].constructor.constructor`). Expected: `constructor` and computed access on a rejected global are rejected; the policy is the second guard. Test in Task 1.
2.  **A scene that never finishes rendering** (infinite loop in render). Expected: the still fails at its time limit and the version is marked failed, the command exits normally. Test in Task 4.
3.  **A reply cut off at the token limit or timed out.** Expected: counted as one failed attempt and repaired with a request for a shorter scene; not a crash. Test in Task 5.
4.  **A shot id or asset name with path characters** (`../x`). Expected: rejected by zod before any path is built. Test in Task 6.
5.  **An interrupted draw** (version file present, no result). Expected: discarded on the next load; version numbers are not reused. Test in Task 6.

---

### Task 1: Static check (core, pure)

**Files:**
- Create: `packages/core/src/draw/static-check.ts`
- Modify: `packages/core/src/index.ts` (export; not `browser.ts`), `packages/core/package.json` (`typescript` as a dependency)
- Test: `packages/core/test/draw-static-check.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const DRAW_MAX_LINES = 400;
  export const DRAW_ALLOWED_REMOTION = ["useCurrentFrame","useVideoConfig","interpolate","interpolateColors","spring","Easing","AbsoluteFill","Sequence"] as const;
  export const DRAW_KIT_MODULE = "@ossclip/scenes/draw";
  export interface DrawIssue { line: number; rule: DrawRule; message: string }
  export type DrawRule = "import" | "dynamic-import" | "element" | "name" | "string" | "size" | "fence" | "syntax" | "export" | "type" | "render"; // "type" and "render" are produced by later tasks
  export function checkDrawnScene(code: string, kitExports: readonly string[]): DrawIssue[];
  ```

- [ ] **Step 1: Write the failing tests.** One test per rule, each asserting the `rule` and the `line`:
  - allowed: a scene importing `react`, the kit and `useCurrentFrame` from `remotion`, using `div`, `span`, `svg`, `g`, `path`, `circle`, `text`, `AbsoluteFill` and a kit part, returns `[]`;
  - `import`: `import fs from "node:fs"`; `import { Img } from "remotion"`; `import * as R from "remotion"`; a kit name not in `kitExports`;
  - `dynamic-import`: `import("x")`;
  - `element`: each of `image`, `foreignObject`, `script`, `a`, `use`, `style`, `iframe`, `img`, `video`, `audio`, `link`, `object`, `embed`; an unknown capitalised component that is neither imported from the kit or `remotion` nor declared in the file. A component declared in the file is allowed;
  - `name`: each of `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `eval`, `Function`, `constructor`, `window`, `document`, `globalThis`, `self`, `top`, `parent`, `frames`, `location`, `open`, `localStorage`, `sessionStorage`, `navigator`, `process`, `require`, `setTimeout`, `setInterval`, `createElement`, as an identifier and as a property name (`x.constructor`, `x["constructor"]`). A local variable or prop named `top` used as an object key in a style (`{ top: 10 }`) is allowed;
  - `string`: literals and template parts containing `url(`, `http:`, `https:`, `//`, `data:`. `"M0 0 L10 10"`, `"#fff"` and a local reference `"url(#grad)"` are allowed;
  - `size`: 401 lines; `fence`: three backticks anywhere;
  - `syntax`: unbalanced JSX returns one issue with the parser's line;
  - `export`: no default export.
- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/draw-static-check.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** with `ts.createSourceFile(…, ScriptKind.TSX)` and one tree walk. No filesystem, no type information. Allowed SVG elements are a fixed list in the file (drawing, gradient, clip, mask, filter and text elements), exported as `DRAW_ALLOWED_ELEMENTS`.
- [ ] **Step 4: Run the test.** Expected: PASS. Run `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat: static check for LLM-drawn scenes (pure)`.

### Task 2: The drawing kit

**Files:**
- Create: `packages/scenes/src/draw/index.ts`, `packages/scenes/src/draw/context.tsx`, `packages/scenes/src/draw/parts.tsx`, `packages/scenes/src/draw/reference.ts`
- Modify: `packages/scenes/package.json` (exports: `"./draw": "./src/draw/index.ts"`), `packages/scenes/src/motion.ts` (add `fadeIn`, `riseIn`)
- Test: `packages/scenes/test/draw-kit.test.ts`

**Interfaces:**
- Produces, all from `@ossclip/scenes/draw`:
  ```ts
  export const DRAW_KIT_VERSION = 1;
  export interface DrawContextValue { theme: Theme; width: number; height: number; assets: Record<string, string> } // name -> staticFile path
  export const DrawProvider: React.FC<{ value: DrawContextValue; children: React.ReactNode }>;
  export function useSceneTime(): number;            // seconds: useCurrentFrame() / fps
  export function useTheme(): Theme;
  export function useFrameSize(): { width: number; height: number };
  export function useSafeArea(): { x: number; y: number; width: number; height: number }; // px rect, from safeAreaFor. Not left/top/right/bottom: `top` is a rejected name in the static check
  export { popScale, easeInOut, typedChars, caretOn, bobPx, bump, beatStarts, parseCount, countAt, fadeIn, riseIn } from "../motion";
  export const Card, Pill, Sticker, NumberBadge, PhoneFrame, Icon; // same props as the primitives, minus `theme`
  export const Asset: React.FC<{ name: string; width?: number; height?: number; style?: React.CSSProperties }>;
  export const DRAW_KIT_EXPORTS: readonly string[];  // every name a drawn scene may import
  export const DRAW_KIT_REFERENCE: string;           // the declarations text given to the LLM
  ```
  `fadeIn(t: number, startSec: number, durSec = 0.3): number` returns opacity 0 to 1; `riseIn(t: number, startSec: number, durSec = 0.35, px = 26): number` returns a y offset from `px` to 0. Both clamp.

- [ ] **Step 1: Write the failing tests:** `fadeIn` and `riseIn` at before, mid and after; every name in `DRAW_KIT_EXPORTS` is exported by the module and appears in `DRAW_KIT_REFERENCE`, and the module exports no name outside `DRAW_KIT_EXPORTS` except `DrawProvider`, `DRAW_KIT_VERSION`, `DRAW_KIT_EXPORTS`, `DRAW_KIT_REFERENCE` and types; a hook used outside `DrawProvider` throws an error naming `DrawProvider`; `Asset` with an unknown name renders nothing and does not throw.
- [ ] **Step 2: Run** the test file. Expected: FAIL.
- [ ] **Step 3: Implement.** Wrappers read `useTheme()` and pass it to the existing primitive. `Asset` uses Remotion's `Img` with `staticFile(assets[name])`; this is kit code, so the import rule for drawn scenes does not apply to it. `DRAW_KIT_REFERENCE` is hand-written TypeScript declarations with one comment line per export; `Theme`'s colour and font fields are listed in it.
- [ ] **Step 4: Run** the test and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: drawing kit entry point for drawn scenes`.

### Task 3: Per-scene bundle, stills, preview and clip (renderer)

**Files:**
- Create: `packages/renderer/src/drawn/entry-source.ts` (pure), `packages/renderer/src/drawn/csp.ts` (pure), `packages/renderer/src/drawn/DrawnSceneHost.tsx`, `packages/renderer/src/drawn/render.ts` (I/O), `packages/renderer/src/drawn/blank.ts` (pure)
- Modify: `packages/renderer/src/index.ts` (exports)
- Test: `packages/renderer/test/drawn-pure.test.ts`, `packages/renderer/test/drawn-render.test.ts` (starts a browser; follow how the existing renderer tests that render are tagged and timed)

**Interfaces:**
- Consumes: `DrawProvider`, `DrawContextValue` (Task 2).
- Produces:
  ```ts
  export const DRAWN_COMPOSITION_ID = "drawn-scene";
  export const DRAW_CSP: string; // the policy in "Spike results", verbatim
  export function injectCsp(indexHtml: string): string; // throws if there is no <head>
  export function drawnEntrySource(a: { scenePath: string; hostPath: string }): string;
  export interface DrawnRenderProps { durationSec: number; width: number; height: number; fps: number; theme: Theme; assets: Record<string, string> }
  export function drawnStillFrames(durationSec: number, fps: number): [number, number, number]; // 25%, 60%, last
  export async function bundleDrawnScene(a: { scenePath: string; workDir: string; publicDir: string }): Promise<string>; // serveUrl
  export async function renderDrawnStills(a: { serveUrl: string; props: DrawnRenderProps; outDir: string; timeoutMs: number; browserExecutable?: string }): Promise<string[]>; // 3 PNG paths
  export async function renderDrawnPreview(a: { serveUrl: string; props: DrawnRenderProps; outPath: string; browserExecutable?: string }): Promise<void>; // quarter size
  export async function renderDrawnClip(a: { serveUrl: string; props: DrawnRenderProps; outPath: string; browserExecutable?: string; cancelSignal?: CancelSignal }): Promise<void>; // ProRes 4444, alpha
  export function isBlankRgba(pixels: Uint8Array | Uint8ClampedArray): boolean; // every alpha byte is 0
  ```

- [ ] **Step 1: Write the failing pure tests:** `injectCsp` puts the meta tag directly after `<head>` and throws without one; `drawnEntrySource` output contains both paths as JSON-escaped string literals (a path with a quote or a backslash stays one literal), `registerRoot`, and the id `drawn-scene`; `drawnStillFrames(4, 30)` is `[30, 72, 119]`; `drawnStillFrames(2, 30)` is `[15, 36, 59]`; `isBlankRgba` true for all-zero alpha, false when one alpha byte is non-zero.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement the pure files.** The generated entry registers one composition whose component is `DrawnSceneHost` wrapping the scene's default export; duration, size and fps come from input props through `calculateMetadata`.
- [ ] **Step 4: Implement `DrawnSceneHost.tsx`:** `AbsoluteFill` > `BundledFonts` + `DrawProvider` + an error boundary + the scene. The error boundary rethrows through Remotion's render error path so a throwing scene fails the still (it must not draw an empty frame and pass).
- [ ] **Step 5: Implement `render.ts`.** `bundleDrawnScene` writes the entry into `<workDir>/.draw-entry/<hash of scenePath>.tsx`, bundles with `webpackOverride` setting `resolve.modules` to the renderer package's `node_modules` then `"node_modules"`, and an alias from `@ossclip/scenes/draw` to the kit's source file; then rewrites `index.html` with `injectCsp`. Stills are PNG with alpha. The preview is a quarter of the frame size in each dimension, VP8 WebM. The clip reuses `clipRenderOptions` and the `.partial.mov` rename from `scene-clip.ts`.
- [ ] **Step 6: Write the browser tests** with scene fixtures under `packages/renderer/test/fixtures/drawn/`: (a) a scene with one circle gives three non-blank PNGs with a transparent corner pixel; (b) a scene that throws in render rejects; (c) a scene with `while (true) {}` in render rejects within `timeoutMs` (use 15000) (Review Focus 2); (d) a scene that calls `fetch` and renders `<img>` to a probe server started by the test: the probe receives 0 requests. Fixtures (b) to (d) bypass the static check on purpose; say so in a comment.
- [ ] **Step 7: Run** both test files and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 8: Commit** `feat: bundle and render a drawn scene with a content security policy`.

### Task 4: Type check (CLI)

**Files:**
- Create: `apps/cli/src/draw/typecheck.ts`
- Modify: `apps/cli/package.json` (`typescript` as a dependency)
- Test: `apps/cli/test/draw-typecheck.test.ts`

**Interfaces:**
- Consumes: `DrawIssue` (Task 1).
- Produces: `export function typecheckDrawnScene(scenePath: string): DrawIssue[]` with `rule: "type"`.

- [ ] **Step 1: Write the failing tests** on fixture files: a correct scene returns `[]`; `<Card titel="x" />` returns one issue with its line and the compiler's message; a wrong hook argument returns an issue; an error inside the kit's own source is not reported (only diagnostics of the scene file are).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with `ts.createProgram` on the one file: `jsx: react-jsx`, `strict: true`, `noEmit`, `skipLibCheck`, `paths` mapping `@ossclip/scenes/draw` to the kit source, module resolution from the renderer package so `react` and `remotion` types resolve. Print the elapsed time at debug level; the gate records it.
- [ ] **Step 4: Run** the test and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: type check a drawn scene against the drawing kit`.

### Task 5: Draw call, repair loop, redraw (core)

**Files:**
- Create: `packages/core/src/draw/prompt.ts`, `packages/core/src/draw/draw-shot.ts`, `packages/core/src/draw/examples.ts`
- Modify: `packages/core/src/producer/mock.ts` (route `schemaName === "drawn_scene"`), `packages/core/src/index.ts`
- Test: `packages/core/test/draw-shot.test.ts`

**Interfaces:**
- Consumes: `LlmProvider.complete`, `DrawIssue`.
- Produces:
  ```ts
  export const DRAW_MAX_REPAIRS = 2;
  export const DRAW_PROMPT_VERSION = 1;
  export const DrawReplySchema = z.object({ code: z.string().min(1), said: z.string().max(300) });
  export interface DrawRequest { idea: string; spokenLine: string; durationSec: number; width: number; height: number; kitReference: string; assets: { name: string; width: number; height: number; note?: string }[] }
  export interface DrawNote { text: string }
  export interface DrawAttempt { code: string | null; said: string | null; issues: DrawIssue[]; error?: string } // error: provider failure text
  export interface DrawResult { ok: boolean; code: string | null; said: string | null; attempts: DrawAttempt[] }
  export type DrawCheck = (code: string) => Promise<DrawIssue[]>; // all checks, injected
  export function drawPrompt(req: DrawRequest): { system: string; user: string };
  export function redrawPrompt(req: DrawRequest, a: { code: string; notes: DrawNote[]; note: DrawNote }): { system: string; user: string };
  export function repairPrompt(req: DrawRequest, a: { code: string | null; issues: DrawIssue[]; error?: string }): { system: string; user: string };
  export async function drawShot(a: { provider: LlmProvider; req: DrawRequest; check: DrawCheck; redraw?: { code: string; notes: DrawNote[]; note: DrawNote } }): Promise<DrawResult>;
  ```

- [ ] **Step 1: Write the failing tests** with a scripted provider (an array of replies or thrown errors):
  - first reply passes the check: 1 call, `ok: true`, 1 attempt;
  - first reply has issues, second passes: 2 calls; the second call's user text contains the issue's line number and message and the first code;
  - three failing replies: 3 calls, `ok: false`, 3 attempts, no throw;
  - the provider throws (cut-off reply or timeout) on the first call: counted as an attempt; the repair prompt asks for a shorter scene and contains the error text (Review Focus 3);
  - with `redraw`: the first call's user text contains the current code, every earlier note in order and the new note;
  - `drawPrompt` contains the idea, the spoken line, the duration, the frame size, `kitReference`, each asset name, both examples and each rule of spec section 3 (transparent background, pure function of time, beats as fractions, fonts, safe area, 400 lines, no three backticks);
  - both examples in `examples.ts` pass `checkDrawnScene`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `schemaName: "drawn_scene"`, `tier: "editorial"`. Write two examples by hand: one built from kit parts with timed beats, one with a small character drawn in SVG paths that moves. The mock route returns the first example.
- [ ] **Step 4: Run** the test, then `pnpm test` for core (prompt drift tests of other modes must be untouched). Expected: PASS.
- [ ] **Step 5: Commit** `feat: draw call with repair and redraw for drawn scenes`.

### Task 6: Shot files on disk

**Files:**
- Create: `packages/core/src/draw/shot-record.ts` (pure, zod), `apps/cli/src/draw/shot-store.ts` (I/O)
- Test: `packages/core/test/draw-shot-record.test.ts`, `apps/cli/test/draw-shot-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ShotIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
  export const AssetNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(png|jpe?g|svg|webp)$/i);
  export const ShotVersionSchema = z.object({ n: z.number().int().positive(), result: z.union([z.literal("ok"), z.object({ failed: z.string() })]).optional(), kitVersion: z.number().int(), said: z.string().optional() });
  export const ShotHistorySchema = z.object({ id: ShotIdSchema, idea: z.string(), spokenLine: z.string(), durationSec: z.number().positive(), versions: z.array(ShotVersionSchema), draft: z.number().int().positive().nullable(), nextVersion: z.number().int().positive(), notes: z.array(z.object({ onVersion: z.number().int(), text: z.string() })), runs: z.array(z.object({ version: z.number().int(), provider: z.string(), model: z.string().optional(), calls: z.number().int(), seconds: z.number() })) });
  export function discardUnfinished(h: ShotHistory): ShotHistory; // drops versions without a result; nextVersion unchanged
  // cli
  export function shotDir(workdir: string, id: string): string; // <workdir>/storyboard/<id>
  export function loadShot(workdir: string, id: string): ShotHistory | null; // parses, applies discardUnfinished, deletes the discarded versions' files
  export function saveShot(workdir: string, h: ShotHistory): void; // temp file then rename
  export function versionPaths(workdir: string, id: string, n: number): { code: string; stillsDir: string; preview: string };
  export function stageAssets(assetsDir: string, publicDir: string): { name: string; width: number; height: number; note?: string; staticPath: string }[];
  ```

- [ ] **Step 1: Write the failing tests:** `ShotIdSchema` rejects `../x`, `a/b`, an empty string and upper case; `AssetNameSchema` rejects `../logo.png`, `a/b.png` and `x.exe` (Review Focus 4); `discardUnfinished` drops a version with no `result`, keeps `nextVersion`, and sets `draft` to the latest remaining `ok` version or null (Review Focus 5); `loadShot` on a directory with `v3.tsx` and no result removes `v3.tsx` and its stills; `saveShot` then `loadShot` round-trips; `stageAssets` reads one line per file from `assets.md` (`<name>: <text>`), skips files whose names fail the schema with a returned warning, and copies into `<publicDir>/storyboard-assets/`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** File layout as spec section 9 (`history.json` holds `ShotHistory`). Image sizes come from `ffprobe`, which the CLI already requires.
- [ ] **Step 4: Run** the tests and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: drawn shot versions and history on disk`.

### Task 7: The experimental command

**Files:**
- Create: `apps/cli/src/draw/draw-command.ts` (orchestration, dependencies injected), `apps/cli/src/draw/checks.ts` (builds the `DrawCheck`)
- Modify: `apps/cli/src/program.ts` (register `draw` after `kit`)
- Test: `apps/cli/test/draw-command.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```
  ossclip draw <workdir> --shot <id> --idea "<text>" [--line "<spoken line>"] [--duration <sec>]
               [--assets <dir>] [--llm <provider>] [--llm-model <id>]
  ossclip draw <workdir> --shot <id> --note "<text>"
  ossclip draw <workdir> --shot <id> --preview
  ```
  `--duration` default 4, zod-parsed, 2 to 15. The frame size, fps and theme come from the workdir's `production.json`. `--idea` on an existing shot is an error that names `--note`.
  ```ts
  export function buildDrawCheck(a: { scenePathFor: (code: string) => string; kitExports: readonly string[]; typecheck: (p: string) => DrawIssue[]; renderStills: (p: string) => Promise<string[]>; isBlank: (png: string) => Promise<boolean> }): DrawCheck;
  export async function runDraw(args: DrawArgs, deps: DrawDeps): Promise<{ ok: boolean; version: number | null; stills: string[]; calls: number; seconds: number }>;
  ```

- [ ] **Step 1: Write the failing tests** with the mock provider and fake render deps: a first draw writes `v1.tsx`, three stills and a history with one `ok` version, `draft: 1` and one `runs` entry; the check stops at the first failing stage (a static issue means the type check and the render are not called); `--note` writes `v2.tsx`, keeps `v1.tsx`, records the note on version 1 and sets `draft: 2`; a draw that fails three times writes a version with `failed`, leaves `draft` unchanged, returns `ok: false` and does not throw (the process exit code is 1); a still check with three blank frames is an issue with the text "every frame is fully transparent"; `--duration 1` and `--shot ../x` are rejected before any call.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** The command prints, per attempt, one line (`attempt 2: 1 issue (type, line 14)`), then the still paths, the calls and the seconds. Still time limit 30 s. A blank check reads the PNG's alpha through `ffmpeg` raw output.
- [ ] **Step 4: Run** the tests, then `pnpm test` and `pnpm typecheck`. Expected: PASS, and no existing test changed.
- [ ] **Step 5: Real check.** `pnpm ossclip draw <a real workdir> --shot probe --idea "a red ball bounces twice and a label pops in" --llm mock`, then open one still. Expected: three PNGs with the mock example drawn.
- [ ] **Step 6: Commit** `feat: experimental ossclip draw (one drawn shot, notes, preview)`.

### Task 8: The gate (main thread, with the author; not delegated)

- [ ] Draw five shots that fit no pattern from the author's next video (a 68 s vertical short about the Elephant-Goldfish Model), one-sentence ideas, the EGM logo as the only asset. Ideas are proposed from its transcript and the author confirms or replaces them.
- [ ] The author judges each from stills and preview, with at most two notes per shot.
- [ ] Record in FINDINGS §167: per shot, usable at first draft / after notes / not; provider and model; calls and minutes; bundle, type check and still times; which providers returned a whole scene.
- [ ] **Pass:** three of five usable after notes. On fail: build the look step of Phase C and run the gate once more, then revisit the design.
