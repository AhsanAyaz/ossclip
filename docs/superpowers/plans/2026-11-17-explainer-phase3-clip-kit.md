# Explainer Phase 3: Clip Kit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ossclip kit [workdir]` writes one transparent ProRes 4444 clip per visible scene of a produced project, plus an FCPXML 1.10 timeline that opens in DaVinci Resolve with the cut source footage on the main track and the scene clips on the track above.

**Architecture:** Pure planning in core (which cues, clip names, reuse keys, frame arithmetic, the XML string). A new one-scene Remotion composition in the renderer draws a scene alone on a transparent frame. The CLI command resolves the project, refreshes its render props when the editor changed them, stages assets, renders the clips one at a time, and writes the files.

**Tech Stack:** TypeScript, zod 4, Remotion 4.0.499 (pinned), vitest, ffmpeg/ffprobe (already required by ossclip).

**Spec:** `docs/designs/explainer-video-patterns.md`, section "Phase 3: clip kit" (3.1 to 3.4 and its acceptance). The Resolve import spike it records is the reference for the XML shape.

## Global Constraints

- A run of `produce`, `edit`, `analyze` or `cover` behaves exactly as before. `SceneLayer` gains one optional prop whose default keeps today's output; `packages/core/test/planner-prompt-frozen.test.ts` and `reveal-props.test.ts` are not edited.
- Every `@remotion/*` dependency stays at exactly `4.0.499`.
- Pure logic is separate from I/O (repo `CLAUDE.md`): exporters are "data in, string out"; the CLI owns files, processes and the clock. I/O reaches the command through a seams object, as in `apps/cli/src/cover.ts` and `apps/cli/test/cover-command.test.ts`.
- User input (flags, the JSON files the command reads) is parsed with zod.
- Comments explain why and cite `§162` (this phase's FINDINGS section, written in Task 4).
- This machine has 7 GB of RAM. Run one heavy command at a time (`pnpm test`, a render, `pnpm stills`), never two together.
- `pnpm test` and `pnpm typecheck` are green at the end of every task. `apps/cli/test/plan-sees-cut-words.test.ts` can time out under load; re-run it alone before treating it as a failure.
- Commit at the end of every task. Do not push.
- Telemetry property names must not contain `path`, `file`, `transcript`, `intent`, `prompt` or `key`; `assertSafeProps` in `apps/cli/src/telemetry.ts` silently drops such events.

## Decisions in this plan (author to check)

1. **A stale project is refreshed automatically.** When `overrides.json` is newer than `render-props.json`, the kit first replays the recorded `produce` command with `--no-render`, the same replay the editor's Render uses. `--no-refresh` skips it.
2. **Every scene that is not full-frame gets a flat dark panel** behind its slot in a kit clip (the scrim without its blur, at 85% opacity). Several layouts put a solid or blurred backdrop behind the graphic in the normal render; a transparent clip has none, and bare text on footage is unreadable.
3. **Clips are named by scene id**, `<sceneId>-<component>.mov`, so hiding one scene does not rename the others and Resolve keeps its links.
4. **The timeline runs at the source's frame rate and the output's frame size.** Scene clips are 30 fps; the spike showed Resolve conforms a 30 fps clip on a 60 fps timeline.
5. **A folder of takes points track 1 at `source-concat.mp4`** in the work folder, the re-encoded join ossclip already makes. Linking the original takes is left for later.
6. **Clips are silent** until scene sound (phase 4) exists.

## Review Focus

1. **A scene whose list items land on spoken words** (`reveal.itemAtSec`, absolute output seconds): in the clip the items still land at the same moment relative to the scene start. Test: Task 1 (`rebaseCue`).
2. **A scene clip that starts in one cut span and ends several spans later**: it is attached once, to the span it starts in, and keeps its full length. Test: Task 1.
3. **Two exports in a row with one scene edited between them**: exactly one clip re-renders, and a clip whose file was deleted re-renders too. Test: Task 3.
4. **A project under WSL on `/mnt/c`**: every path in the timeline is `file:///C:/...`; a path inside the Linux filesystem is written as a `wsl.localhost` URL and reported as a warning. Test: Task 1.
5. **A `clip:` scene whose original file has moved**: the kit does not fail; that scene is skipped in the timeline and listed in the report. Test: Task 3.

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/core/src/kit-plan.ts` (new) | which cues become clips, rebasing, names, reuse keys, frame plan | 1 |
| `packages/core/src/kit-paths.ts` (new) | file URLs, WSL mapping | 1 |
| `packages/core/src/export-fcpxml-kit.ts` (new) | the timeline XML string | 1 |
| `packages/scenes/src/SceneLayer.tsx` | optional `flatPanel` prop | 2 |
| `packages/renderer/src/SceneClipComposition.tsx`, `scene-clip.ts` (new), `Root.tsx`, `render-options.ts`, `index.ts` | transparent one-scene render | 2 |
| `apps/cli/src/kit.ts` (new), `apps/cli/src/program.ts` | the command | 3 |
| `README.md`, `docs/site/index.html`, `docs/PHASE1-FINDINGS.md` | docs, §162 | 3, 4 |

---

### Task 1: Kit planning and the timeline exporter (core, pure)

**Files:**
- Create: `packages/core/src/kit-plan.ts`, `packages/core/src/kit-paths.ts`, `packages/core/src/export-fcpxml-kit.ts`
- Modify: `packages/core/src/index.ts` (exports; check whether `browser.ts` needs `rebaseCue` for the renderer and export it there if so)
- Test: `packages/core/test/kit-plan.test.ts`, `kit-paths.test.ts`, `export-fcpxml-kit.test.ts` (parse the XML with jsdom, as `export-fcpxml.test.ts` does)

**Interfaces:**
- Consumes: `SceneCue` (`startSec`/`endSec` are output seconds; `kind?: "graphic" | "plain"`; `reveal?.itemAtSec` and `entryAtSec?` are absolute output seconds), `KeptSpan {srcIn, srcOut, outIn, outOut}`, `Theme`, `SCENE_REGISTRY`, `fpsToFrameDuration`, `quantizeToFrame` and `FrameDuration` from `export-fcpxml.ts`, `frameWindow(startSec, endSec, fps)` (it lives in `packages/scenes/src/frames.ts`; core cannot import scenes, so move the function to core and re-export it from scenes, or duplicate nothing).
- Produces:

```ts
export const KIT_VERSION = 1;                       // part of every reuse key

export interface KitClipPlan {
  sceneId: string;
  component: SceneComponentId;
  kind: "render" | "source";                        // "source": a clip: cue, not re-rendered
  fileName: string;                                 // "<sceneId>-<component>.mov" for "render"
  startFrame: number;                               // on the 30 fps output timeline
  durationInFrames: number;                         // frameWindow(...) of the original cue
  cue: SceneCue;                                    // rebased; for "render" only
  reuseKey: string;                                 // sha256 hex of {KIT_VERSION, cue, theme, settings}
  notes: string[];                                  // e.g. "speaker not reframed (split-left)"
}

export function kitClipPlans(input: {
  cues: readonly SceneCue[]; theme: Theme;
  settings: { width: number; height: number; fps: number };
}): KitClipPlan[];

export function rebaseCue(cue: SceneCue, fps: number): SceneCue;
export function kitFileName(sceneId: string, component: string): string;
export function needsRender(plan: KitClipPlan, previous: KitReport | null, fileExists: boolean, force: boolean): boolean;

export const KitReportSchema: z.ZodType<KitReport>;  // version, createdAt, clips[], warnings[]
```

  - `kitClipPlans` keeps cues whose `kind` is not `"plain"`. `ClipScene` cues are `kind: "source"`. Order is by `startSec`.
  - `rebaseCue`: `startSec` 0, `endSec` `durationInFrames / fps`, `reveal.itemAtSec` and `entryAtSec` shifted by the old `startSec` (nulls stay null), everything else untouched (`graphicRect`, `elements`, `layout`, `props`).
  - `kitFileName` keeps `[A-Za-z0-9_-]`, replaces anything else with `-`, and never returns an empty stem.
  - Notes: `split-left`, `split-right`, `video-top`, `pip-bubble` → `"speaker not reframed (<layout>)"`; `graphic-only`, `blurred-behind` → `"backdrop replaced by a flat panel (<layout>)"`.

```ts
// kit-paths.ts
export function kitFileUrl(absPath: string, env: { wsl: boolean; distro?: string }): { url: string; warning?: string };
export function isWslEnv(platform: string, env: Record<string, string | undefined>, procVersion: string | null): boolean;
```

  - Not WSL: `pathToFileURL(absPath).href`.
  - WSL and `/mnt/<letter>/rest`: `file:///<LETTER>:/<rest, each segment percent-encoded>`.
  - WSL and any other path: `file://wsl.localhost/<distro>/<path>` with the warning `"<path> is inside the Linux filesystem; Resolve may ask you to relink it"`.

```ts
// export-fcpxml-kit.ts
export interface KitTimelineInput {
  name: string;
  sequence: { width: number; height: number; fps: number };       // output size, SOURCE fps
  source: { url: string; name: string; fps: number; width: number; height: number;
            durationSec: number; hasAudio: boolean };
  spans: readonly KeptSpan[];
  clips: readonly { url: string; name: string; fps: number; width: number; height: number;
                    durationSec: number; hasAudio: boolean;
                    startSec: number; lengthSec: number }[];        // startSec on the output timeline
}
export function kitTimelineFrames(input: KitTimelineInput): KitTimelineFrames;  // all integers, sequence frames
export function buildFcpxmlKit(input: KitTimelineInput): string;
```

  - **Spans.** Boundary i on the timeline is `round(outIn_i × fps)`; a span's length is the next boundary minus its own, so spans never gap or overlap. A span's source start is `round(srcIn × fps)`. A span that comes out zero frames long is dropped.
  - **Clips.** Start frame `round(startSec × fps)`, length `max(1, round(lengthSec × fps))`. A clip is attached to the span that contains its start frame (the last span when it starts at or after the end), as an `<asset-clip lane="1">` child whose `offset` is the parent's source start plus (clip start minus parent timeline start). A clip is never split.
  - **XML shape** (the form the spike proved in Resolve 21): `<fcpxml version="1.10">`; one `<format>` per distinct (fps, width, height), named `FFVideoFormat<height>p<fps>` for integer rates; one `<asset>` per distinct file with `<media-rep kind="original-media" src="…"/>`, `hasVideo="1"`, `hasAudio`, and `audioSources="1" audioChannels="2" audioRate="48000"` when it has audio; `<library><event><project><sequence format tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine>`; one `<asset-clip>` per span with `offset`, `start`, `duration`, `format`, `tcFormat="NDF"`. All times are `"<frames × num>/<den>s"` from `fpsToFrameDuration`. Output is pure ASCII; names and URLs are XML-escaped.

- [ ] **Step 1: Failing tests.** At least:

```ts
// rebaseCue
const cue = { id: "c1", layout: "full-bleed", component: "CardRow", props: P, startSec: 62.2255, endSec: 66.8,
  reveal: { itemAtSec: [62.5, null, 64.1] }, entryAtSec: 62.3 };
const r = rebaseCue(cue, 30);
expect(r.startSec).toBe(0);
expect(r.endSec).toBe(137 / 30);                       // frameWindow(62.2255, 66.8, 30).durationInFrames === 137
expect(r.reveal!.itemAtSec[0]).toBeCloseTo(0.2745, 6);
expect(r.reveal!.itemAtSec[1]).toBeNull();
expect(r.entryAtSec).toBeCloseTo(0.0745, 6);
// kitClipPlans: a plain cue is left out; a ClipScene cue is kind "source"; order by start;
//   reuseKey changes when a prop, the theme or the size changes, and not when another cue changes
// kitFileName("3-a1b2c3", "CardRow") === "3-a1b2c3-CardRow.mov"; kitFileName("a/b c", "X") === "a-b-c-X.mov"
// needsRender: true when force, when the file is missing, when there is no previous report,
//   when the previous key differs; false otherwise; never true for kind "source"
// kitFileUrl
expect(kitFileUrl("/mnt/c/Users/me/My Video.mp4", { wsl: true }).url).toBe("file:///C:/Users/me/My%20Video.mp4");
expect(kitFileUrl("/home/me/x.mov", { wsl: true, distro: "Ubuntu" })).toEqual({
  url: "file://wsl.localhost/Ubuntu/home/me/x.mov",
  warning: "/home/me/x.mov is inside the Linux filesystem; Resolve may ask you to relink it" });
// kitTimelineFrames with the spike's numbers: fps 60, spans (src 10..16, 30..33, 60..66) at out 0, 6, 9;
//   clips at 0.5 s and 5.5 s, 4.5667 s long:
//   spans → offsets 0, 360, 540; starts 600, 1800, 3600; durations 360, 180, 360
//   clips → both attached to span 0, offsets 630 and 930, duration 274
// a clip starting at 7.0 s attaches to span 1 with offset 1800 + (420 - 360) = 1860
// buildFcpxmlKit: parses as XML; 3 spine asset-clips; lane="1" children as above; two assets;
//   every src starts with "file://"; no non-ASCII characters
```

- [ ] **Step 2: Run** the three test files. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: kit planning and an FCPXML timeline exporter with scene clips`.

---

### Task 2: Render one scene as a transparent clip

**Files:**
- Modify: `packages/scenes/src/SceneLayer.tsx` (optional prop), `packages/renderer/src/Root.tsx`, `packages/renderer/src/render-options.ts`, `packages/renderer/src/index.ts`
- Create: `packages/renderer/src/SceneClipComposition.tsx`, `packages/renderer/src/scene-clip.ts`
- Test: `packages/renderer/test/scene-clip.test.ts`, `packages/renderer/test/render-options.test.ts` (add cases), `apps/editor/test/scene-layer-structure.test.ts` (add a case for the new prop)

**Interfaces:**
- Consumes: `rebaseCue`, `KitClipPlan` from Task 1; `bundleRenderEntry(publicDir)`; `BundledFonts`.
- Produces:
  - `SceneLayer` prop `flatPanel?: boolean` (default false). When true: a cue whose component is not `fullFrame` and whose registry entry does not set `scrim: false` gets the scrim element in every layout, with no `backdropFilter` and alpha 0.85 (`KIT_PANEL_ALPHA`), and the same content inset the scrim uses today. When false, nothing changes.
  - `SCENE_CLIP_ID = "scene-clip"`; `interface SceneClipProps { cue: SceneCue; theme: Theme; settings: { width: number; height: number; fps: number } }`. The composition draws `<AbsoluteFill>` with no background, `<BundledFonts>`, and `<SceneLayer cues={[cue]} theme flatPanel />`. Its duration is `round(cue.endSec × fps)`.
  - `clipRenderOptions({ composition, serveUrl, inputProps, opts })`: `codec: "prores"`, `proResProfile: "4444"`, `pixelFormat: "yuva444p10le"`, `imageFormat: "png"`, `muted: true`, `hardwareAcceleration: "disable"` on every platform (the alpha path must not go through a hardware encoder), plus `concurrency`, `scale`, `cancelSignal`, `onProgress` as `renderMediaOptions` passes them.
  - `renderSceneClip(props: SceneClipProps, opts: { publicDir: string; outPath: string; serveUrl?: string; browserExecutable?: string; concurrency?: number; scale?: number; cancelSignal?; onProgress? }): Promise<void>`. It writes to `outPath + ".partial"` and renames on success.

- [ ] **Step 1: Failing tests.** `clipRenderOptions` returns exactly the values above and never `"jpeg"`. The composition's metadata for a 137-frame cue at 30 fps is 137 frames at the settings' size. `SceneLayer` with `flatPanel` draws a panel for a `StatCard` in `video-top` and none for a `CardRow`; without the prop the structure equals today's (existing assertions unchanged).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Check in Remotion 4.0.499's types that `proResProfile`, `pixelFormat` and `muted` are spelled this way; if an option differs, use the real name and say so in the report.
- [ ] **Step 4: One real render** (not a unit test; nothing else heavy running). Write a small script in the scratch directory that renders two cues with the explainer theme at 1920×1080: a `CardRow` (three cards) and a `StatCard` in `video-top`. Then check each file:

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,pix_fmt,r_frame_rate,nb_frames -of default=nw=1 clip.mov
# expect codec_name=prores, a 4444 profile, pix_fmt=yuva444p10le (or 12le), r_frame_rate=30/1, the planned frame count
ffmpeg -v error -ss 2 -i clip.mov -frames:v 1 -vf "format=rgba,crop=1:1:5:5" -f rawvideo - | xxd -p      # corner: alpha byte 00
ffmpeg -v error -ss 2 -i clip.mov -frames:v 1 -vf "format=rgba,crop=1:1:960:540" -f rawvideo - | xxd -p  # centre of a card: alpha byte ff
```

  Also extract one frame of each over a red background (`ffmpeg … -filter_complex "color=red:s=1920x1080[b];[b][0:v]overlay"`), open the PNGs with the Read tool, and confirm the cards have clean edges, the `StatCard` sits on a flat panel, and no black box surrounds the scene. Report the render time per clip.
- [ ] **Step 5:** `pnpm test && pnpm typecheck`; commit `feat: render a single scene as a transparent ProRes clip`.

---

### Task 3: The `ossclip kit` command

**Files:**
- Create: `apps/cli/src/kit.ts`, `apps/cli/test/kit-command.test.ts`
- Modify: `apps/cli/src/program.ts` (register beside `cover`, line ~1211), `README.md` (command table ~138-150, telemetry list ~288-300), `docs/site/index.html` (a section like the other commands')

**Interfaces:**
- Consumes: Task 1 and Task 2 exports; `resolveWorkdirArgument(typed, command)` (`program.ts:122`, module-private, call it as `cover` does); `renderReplayArgs` (`apps/cli/src/render-replay-args.ts`) and the way `apps/cli/src/edit.ts:1855-2003` spawns a replay from `command.json`; `stageBundledFonts(theme, dirs)`; `storedScriptFrom(productionJson)` and `resolveClipPath(scriptPath, clipPath)`; `probe()` from core; `loadConfig().browserExecutable`; `resolveRenderConcurrency`.
- Produces:
  - `parseKitFlags(raw): KitFlags` (zod; `out?: string`, `clipsOnly: boolean`, `force: boolean`, `refresh: boolean`).
  - `KitRenderPropsSchema`: a zod parse of the fields the kit needs from `render-props.json` (`sceneCues: SceneCueSchema[]`, `spans`, `theme: ThemeSchema`, `settings`, `outputDurationSec`), ignoring the rest.
  - `runKit(workdir: string, flags: KitFlags, seams: KitSeams): Promise<KitResult>` where `KitSeams` carries every side effect (read/write/exists/stat/mkdir/rename, `probe`, `renderClip`, `bundle`, `replayProduce`, `now`, `log`, `platform`, `env`, `procVersion`).
  - Telemetry: `kit_completed { clips, rendered, reused, skipped, timeline }` (numbers and a boolean) and `kit_failed { error_class }`.

**Behaviour.**
1. Resolve the project. Read `render-props.json` and `production.json`. No project: the existing resolver's error.
2. **Refresh.** If `refresh` is on and `overrides.json` exists and is newer than `render-props.json`: print `▸ the project changed since it was last produced; refreshing…`, replay the recorded command with `--no-render` appended (and without opening the editor), then re-read. No `command.json`: stop with an error that names `ossclip produce`. A failed replay stops the kit with the replay's exit code and last lines.
3. **Kit folder.** `--out`, else `<dir of source>/<source name without extension>-kit`; for a folder source, `<folder>-kit` beside it. Create `clips/` inside.
4. **Plan** with `kitClipPlans`. Read the previous `kit-report.json` if there is one (a file that does not parse counts as none).
5. **Stage.** Render from the work folder as the public directory, so `clips/<hash>.webm`, `fonts/` and `side-images/` resolve; run `stageBundledFonts(theme, [workdir])`. A `ScreenshotFrame` whose `side-images/…` file is not in the work folder is skipped with a note.
6. **Render** each `"render"` plan that `needsRender`, one at a time, one bundle for the whole run, printing `▸ [3/18] 5-ab12cd-CardRow.mov  4.6s` and a percentage; SIGINT cancels the current render and leaves no partial file. Remove `.mov` files in `clips/` that no current plan names (they belong to scenes since hidden), and say so.
7. **Source clips.** For each `"source"` plan, find the original through `production.script.clips` (match `src`) and `resolveClipPath(production.script.sourcePath, entry.path)`. Missing record, missing `sourcePath` or missing file: skip with a note. Otherwise probe it and reference it in the timeline, trimmed to the cue's length.
8. **Timeline** (unless `--clips-only`): sequence at the source's fps and the output's size; track 1 from `spans`; the source asset is `production.source.path`, or `<workdir>/source-concat.mp4` when the source is a folder (with a note that it is the re-encoded join). Write `timeline.fcpxml`. Print every path warning from `kitFileUrl`.
9. **Report.** Write `kit-report.json` (`KitReportSchema`): per clip the scene id, component, file, kind, start and length in seconds, reuse key, `rendered | reused | skipped`, notes; plus warnings and the timeline's file name. Print a summary: clips rendered, reused, skipped; the kit folder; and the one-line Resolve instruction `File → Import → Timeline…, then pick timeline.fcpxml`.

- [ ] **Step 1: Failing tests** with fake seams (no Remotion, no ffmpeg), in the style of `cover-command.test.ts`:
  - flags: an unknown flag value is an error naming the flag;
  - a fresh run renders every `"render"` plan once, in order, and writes the report and the timeline;
  - a second run with the same inputs renders nothing; after one cue's prop changes, exactly that clip renders; after a clip file is deleted, that clip renders (Review Focus 3);
  - `--force` renders all; `--clips-only` writes no timeline;
  - stale props trigger exactly one replay containing `--no-render`; `--no-refresh` triggers none; no `command.json` gives the error naming `ossclip produce`;
  - a `clip:` scene with a moved original is skipped with a note and the run succeeds (Review Focus 5);
  - a folder source points the timeline at `source-concat.mp4`;
  - under WSL seams, every `src` in the written XML starts with `file:///C:/` for `/mnt/c` inputs;
  - a stray `.mov` in `clips/` is removed; other files are left alone;
  - `kit` is registered in `program.commands`, and the tests that walk all commands (`bare-path.test.ts`, `produce-flag-forwarding.test.ts`, `cover-in-video.test.ts`) still pass.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement**, then the README and docs-site entries.
- [ ] **Step 4: One real run** (nothing else heavy running). Produce the offline fixture with the pattern script (the recipe is in `.claude/skills/verify-ossclip/features/produce.md`, "pattern scenes" section; add `--aspect 16:9`), then `pnpm ossclip kit <that workdir> --out <scratch>/kit`. Confirm: one `.mov` per graphic scene; `ffprobe` shows ProRes 4444 with an alpha pixel format for each; `timeline.fcpxml` parses and has one spine clip per kept span; a second run prints every clip as reused and finishes in seconds. Add this recipe and its expected output to the verify skill's `features/` as a `kit.md`, following the neighbouring files.
- [ ] **Step 5:** `pnpm test && pnpm typecheck`; commit `feat: ossclip kit exports scene clips and a Resolve timeline`.

---

### Task 4: Acceptance on the EGM project (main session, not delegated)

- [ ] Run `ossclip kit` on the EGM pattern project with `--out` on the Windows drive, so Resolve can reach the files.
- [ ] Machine checks: one clip per kept scene; each clip's corner pixel is transparent and a pixel inside the graphic is opaque; the four `clip:` scenes reference the author's original files; a second run re-renders nothing; after editing one scene, one clip re-renders.
- [ ] Write FINDINGS `§162`: what was built, the six decisions above with reasons, measured render times, known gaps.
- [ ] Hand the author the kit folder to import into Resolve. Their check (design, phase 3 acceptance): the cut matches the editor's cut, and each clip starts within one frame of its planned time.
