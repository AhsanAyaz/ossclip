# Storyboard: scenes the AI plans and draws

*   **Author:** Muhammad Ahsan Ayaz (drafted with Claude)
*   **Status:** Approved by the author (2026-11-20), all seven decisions as recommended. Draft 2, revised after three reviews (design, code accuracy, build readiness); the changes are listed at the end
*   **Builds on:** `explainer-video-patterns.md` (script cues, clip scenes, pattern components, clip kit), FINDINGS §158 (clip scenes), §162 (clip kit), §163 (backdrop choice)

--------------------------------------------------------------------------------

## Overview

The EGM explainer was made in a chat: Claude wrote one drawing script per shot, the author looked at each result and typed corrections, and 24 transparent clips came out in about 3 hours. The author then placed the clips by hand.

`ossclip produce --script` now places such clips, and seven pattern components cover the shots that repeat. Two things are still manual:

*   **Deciding the shots.** The author writes every cue.
*   **Drawing a shot that fits no pattern.** The goldfish tearing a draft apart was drawn in the chat. ossclip cannot draw it.

This design moves both into ossclip. A new run mode, `--storyboard`, plans the shots from the recording, lets the author review the plan as a table, draws each kept shot as code, shows still frames and a small preview, takes a typed note per shot and redraws, and renders a full clip only for a shot the author approved.

The drawing is free: the AI writes the scene's code and draws its own SVG characters, props and shapes. Fonts, palette and motion feel come from shared code, so shots look like one video.

**How strong the evidence is.** The chat proves that an LLM can draw these shots when a person steers each one. It used Python, not the code this design asks for, and the person saw every frame. Nobody has measured how good a draft is in React, or without steering. Phase A ends with a test on five EGM shots that decides whether the rest is built.

## Terms

*   **Shot.** One planned graphic: a span of spoken words, an idea, and (later) code, stills and a clip.
*   **Plan table.** The list of shots the planner proposes, before anything is drawn.
*   **Drawn scene.** A shot's code: one React component, written by the LLM.
*   **Drawing kit.** The module a drawn scene imports: fonts, colours, motion helpers, shared parts, and the author's assets. (Not the clip kit that `ossclip kit` writes.)
*   **Storyboard.** The plan table plus, for each drawn shot, its stills, its notes and its versions.
*   **Version.** One draft of a shot's code. A redraw makes a new version; old versions are kept.
*   **Storyboard project.** A project whose `production.json` holds a storyboard record (section 9), as a script project holds a script record.

## Goals

*   **G1.** From a recording and no cues, ossclip proposes the shots: where each sits and what it shows.
*   **G2.** The author reviews the plan before any drawing: drop a shot, reword its idea, move it, add one.
*   **G3.** The AI draws each kept shot as code. It may draw any shape, character or prop in SVG. It is not limited to the pattern components.
*   **G4.** All shots share fonts, palette and motion feel, because they import them from one place.
*   **G5.** The author sees still frames, and on request a small moving preview, of a drawn shot before any full clip is rendered.
*   **G6.** The author types a note on a shot and the AI redraws that shot. Earlier versions stay available.
*   **G7.** An approved shot becomes a transparent clip, placed as a clip scene. The editor, `ossclip kit` and the Resolve timeline handle it as they handle a hand-made clip today.
*   **G8.** A shot whose code fails never fails the run or another shot. It is repaired, or reported in the table with the reason.
*   **G9.** Runs without `--storyboard` on a project that is not a storyboard project are unchanged: same prompts, same caches, same output.
*   **G10.** Work the author steered survives cut edits and later runs. A shot is never drawn again or planned again unless the author asks.

## Non-goals

*   **NG1.** Sound in drawn scenes. Scene sound is phase 4 of the explainer design and is still open.
*   **NG2.** Editing a drawn scene's text or shapes in the Inspector. Changes go through a note. (Decision 1.)
*   **NG3.** Combining `--storyboard` with `--script`, `--scenes` given by hand, or `--clip` in the first version. (Decision 3.)
*   **NG4.** Generated raster images or video (image models). Drawing is code only.
*   **NG5.** A frame-perfect final video. As for script runs, the target is a rough cut plus a graphics kit; Resolve does the finishing.
*   **NG6.** Pattern components (`BugCard`, `CardRow` and the others) inside a drawn scene. They take registry props and timing that a free scene does not have. A drawn scene builds from the smaller parts.

## Anti-goals

*   **AG1.** LLM-written code runs in Node, or in the editor page. It runs only inside the headless browser that renders stills, previews and clips.
*   **AG2.** Frames the author has not approved reach the video.
*   **AG3.** The author pays for drawing shots they would have dropped at the table.

## Approaches

**A. The AI writes a React scene per shot (chosen by the author).** The code imports the drawing kit and draws with inline SVG. ossclip checks it, renders stills, and sends failures back for repair. Drawing is free, and the shared kit keeps one look. Remotion renders it, so no second render stack is needed. Cost: ossclip runs LLM-written code, which needs the guards in section 5.

**B. The AI writes a scene description (shapes and keyframes as data), played by one fixed component.** Safe, and every value could be edited in the Inspector. Rejected: the format is the ceiling. A shot the format cannot say cannot be drawn, which is the limit the author asked to avoid.

**C. A Python script per shot, as in the chat.** Proven on the EGM video. Rejected: a second render stack with its own fonts and colours to keep in sync, and the project decided to stay on Remotion.

**How a drawn scene enters the video.** Two ways were considered inside approach A:

*   *Live code:* the editor and the final render load the scene's code and play it. The author could resize it freely, but LLM-written code would run in the editor page, next to the editor's own API (AG1).
*   *Rendered clip (chosen):* an approved shot is rendered once to a transparent clip and placed as a `ClipScene`. The scene has a fixed length; a new length is a new render of the same code, with no LLM call.

## Design

### 1. The flow

```
ossclip produce <input> --storyboard [--assets <dir>] [--intent "<text>"]
```

1.  **Cut.** Transcribe, analyse and cut as today.
2.  **Plan.** One LLM call writes the plan table. The run stops here and opens the editor on the storyboard (the existing review path that implies `--no-render`).
3.  **Review the table.** The author drops, rewords, moves or adds shots.
4.  **Draw.** For each kept shot: the LLM writes the code, ossclip checks it and renders stills, and failures go back for repair.
5.  **Review the stills.** Per shot the author approves, drops, asks for a preview, or types a note. A note redraws that shot.
6.  **Render clips.** Each approved shot is rendered to a transparent clip and placed as a clip scene.

Steps 3 to 6 happen in the editor. Nothing after step 2 runs without the author asking for it.

**What else the run does.** A `--storyboard` run makes no beat-sheet call and plans no template graphics. Captions and the other options behave as in a script run. It uses the explainer look unless the author names another.

**Flags.** `--storyboard` implies `--produce`. It cannot be combined with `--script`, `--clip`, or a hand-given `--scenes`; these are thrown errors in `produce()`, as the existing conflicts are.

**Later runs on the same workdir** follow the rules a script project follows today:

| Run | Storyboard scenes |
|---|---|
| `--storyboard` again | Kept. The stored storyboard is loaded; no plan call is made. |
| A replay from the editor (Render, kit refresh; these pin `--scenes`) | Kept, through the storyboard record. |
| Plain `--produce`, no `--storyboard` | Not included. The run plans from nothing, as a plain run of a script project does today. The storyboard files stay on disk. |

### 2. The plan

*   **Input:** the kept words with their indices, `--intent`, the frame shape, the list of assets (section 4), and a short description of what the drawing kit offers.
*   **Which cut.** The first run plans on the automatic cut. "Plan again" in the editor plans on the cut as the author edited it. (FINDINGS §158: planning on a cut the author later changed misplaced half the cues.)
*   **Output:** a list of shots. Each has: first and last word index, a one or two sentence idea (what is on screen and how it moves), one line on why this moment earns a graphic, a priority from 1 to 3, and the assets it uses.
*   **Limits.** Shot lengths use the limits scenes have today (the existing minimum, `MAX_SCENE_SEC`, and the gap between scenes). Total coverage is at most 60% of the kept runtime. (Decision 2.) The prompt states the limits. After the call ossclip enforces them in a fixed order and reports each change: a shot that overlaps an earlier one is moved to start after it; a shot then under the minimum is dropped; while coverage is over the limit, the lowest-priority shot is dropped, the latest one first among equals. It does not ask again.
*   **Anchoring.** A shot is anchored to a word range of the raw transcript, as every scene is (`SceneAnchorSchema`). Word indices do not change when the cut changes.
*   **Planning again.** "Plan again" keeps every shot that is drawn, approved or was added or reworded by the author. It replaces only untouched planned shots, and it proposes new shots only for spans no kept shot covers. A `--storyboard` run never plans again on its own (G10).
*   The planner prompt is new and is used only in this mode (G9).

### 3. The drawn scene

One file per version: a TypeScript React module with a default export.

```tsx
import { useSceneTime, useTheme, useFrameSize, popScale, Card } from "@ossclip/scenes/draw";

export default function Scene({ durationSec }: { durationSec: number }) {
  const t = useSceneTime(); // seconds since the scene started
  const theme = useTheme();
  …
}
```

Rules, given to the LLM and checked where a machine can check them:

*   The background is transparent. The scene draws over the video or over the backdrop the author chose (§163).
*   The frame is a pure function of time: no random values without a seed, no clocks, no state that depends on render order. (Remotion renders frames out of order.)
*   Beats are placed as fractions of `durationSec` or with the kit's beat helper, and the last state holds to the end, so the scene can be rendered again at another length.
*   Text uses the theme's fonts only. Interface elements use the theme's palette. Illustrations (characters, props) may use their own colours.
*   Content stays inside the safe area the kit exposes.
*   The file has at most 400 lines and contains no run of three backticks. (The command-line provider strips such runs from a reply before parsing it.)

**The draw call.** One LLM call per shot through the existing `complete` interface. Input: the shot's idea, its spoken line, its duration, the frame shape, the kit's type declarations, the asset list, and two worked examples (one built from kit parts, one with a character drawn in SVG). Output: an object with the code as one string and one line saying what was drawn. `editorial` tier.

**Providers.** The API providers stop at 16,000 output tokens and throw on a cut-off reply; the Antigravity command line has a 90-second limit. A cut-off or timed-out reply counts as a failed draft and is repaired with a request for a shorter scene. Phase A records which providers can draw; the others are refused for `--storyboard` with a message that names one that works.

### 4. The drawing kit and assets

A new entry point, `@ossclip/scenes/draw` (the package's exports map has room for it). It is the only project code a drawn scene may import. It is new code over existing pieces, because today's parts take the theme as a prop and no drawn scene has one to pass:

*   **Context hooks, new:** `useSceneTime()` (seconds, from the frame and the frame rate), `useTheme()`, `useFrameSize()`, `useSafeArea()` (from the existing `safeAreaFor`).
*   **Motion, existing and already in seconds:** `popScale`, `easeInOut`, `typedChars`, `caretOn`, `bobPx`, `bump`, `beatStarts`, `parseCount`, `countAt`. New seconds-based `fadeIn` and `riseIn`; the existing `pop`, `rise` and `fade` take a spring progress and are not exported.
*   **Parts, as wrappers that read the theme from context:** `Card`, `Pill`, `Sticker`, `NumberBadge`, `PhoneFrame`, `Icon`.
*   **`Asset`:** draws one of the author's files by name, as an image.

**The kit is a contract.** It has its own version number. A scene version records the kit version it was drawn for. Exports are only added, never renamed or removed.

**The theme is fixed at approval.** A clip is rendered with the project's theme at that moment. A later theme change does not change approved clips; the storyboard marks them, and the author can render them again (section 8).

**Assets.** `--assets <dir>` names a folder of images (PNG, JPEG, SVG, WebP), for example a logo. An optional `assets.md` in it gives one line per file. The planner and the draw call see file names, pixel sizes and those lines. The files are copied into the workdir. `Asset` shows a file as an image and never inlines it, so an SVG asset cannot run script. Assets are extra material: the AI is expected to draw what it has no asset for.

### 5. Checking and running the code

In order, for every version:

1.  **Static check (pure, in core).** Parse the code and reject, with the line:
    *   any import other than `react`, `@ossclip/scenes/draw`, and these names from `remotion`: `useCurrentFrame`, `useVideoConfig`, `interpolate`, `interpolateColors`, `spring`, `Easing`, `AbsoluteFill`, `Sequence`. (`Img`, `IFrame`, `staticFile`, `delayRender` and the media components can load from the network.)
    *   dynamic `import()`;
    *   any JSX element that is not `div`, `span`, a kit part, an allowed `remotion` component, or an SVG drawing element. `image`, `foreignObject`, `script`, `a`, `use`, `style`, `iframe`, `img`, `video`, `audio`, `link`, `object` and `embed` are rejected;
    *   these names: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `eval`, `Function`, `constructor`, `window`, `document`, `globalThis`, `self`, `top`, `parent`, `frames`, `localStorage`, `sessionStorage`, `navigator`, `process`, `require`, `location`, `open`, `setTimeout`, `setInterval`, `createElement`;
    *   string literals that contain `http:`, `https:`, `//`, `data:`, or a `url(` that is not a local reference such as `url(#gradient)`.
2.  **Type check** against the kit's types. A wrong prop name is the most likely mistake, and the compiler's message is the best repair hint. `typescript` becomes a runtime dependency of the CLI for this; packages ship their source, so the types are there.
3.  **Render stills.** Three frames: at 25% and 60% of the duration, and the last frame. Each still has a time limit; a render that exceeds it fails.
4.  **Still checks, no AI.** Reject a version whose render throws, or whose three frames are all fully transparent.

A failure at any step goes back to the LLM with the code and the error, at most two times. (The command-line providers already retry a failed call once on their own; that is inside one of these attempts.) After that the version is marked failed with the last error, and the author can retry the shot or drop it (G8).

**New renderer pieces.** The existing still and clip compositions draw only registry components through `SceneLayer`, which would also add its own fit scale, exit fade and panel. Drawn scenes get their own:

*   a still composition and a clip composition that mount the drawn component inside the theme, time and frame-size providers, with the bundled fonts, and nothing else;
*   a generated entry file per bundle that imports the scene files and registers them;
*   `bundleRenderEntry` takes an entry path and a resolve rule, so `react`, `remotion` and the kit resolve from the renderer's own modules (a workdir has none).

`renderStill`, the ProRes 4444 clip options, the partial-file rename and the font staging are reused as they are.

**Where the code runs, and what protects it.** Only in the headless browser Remotion starts (AG1). The static check is a filter, not a sandbox: code that hides a name from the parser passes it. The transcript and `assets.md` are text the LLM reads, so a recording or a file can try to steer what it writes. Two further guards are Phase A requirements:

*   **The render browser cannot reach the network or the editor's server.** Found on 2026-11-20: a content security policy written into the bundle's `index.html` does this. In a test, a scene's `fetch`, `<img>`, `new Image()` and CSS `url()` reached a probe server 4 times without the policy and 0 times with it. Remotion's own browser options offer no such switch. (Decision 4 is settled by this.)
*   **The editor server trusts every loopback origin, and the render page is one.** Checked on 2026-11-20. Without the policy, drawn code could call the editor's write endpoints. The policy allows connections only to the bundle's own port, which closes this. A policy does not stop page navigation, so the static check also rejects `location` and `open`.

**Bundles (measured 2026-11-20).** A bundle of one scene file in a workdir takes 2.4 s and a still 1.0 s on the author's machine. So each scene version gets its own bundle, and one bad scene cannot affect another.

### 6. Notes and redraw

*   A note is free text on one shot. A redraw is one LLM call with: the idea, the current code, every earlier note on this shot, and the new note. Its output passes the same checks as a first draft.
*   Each redraw is a new version. The storyboard lists a shot's versions, and the author can make an earlier one the draft again.
*   A redraw never touches other shots or the approved clip.

### 7. Preview

"Preview" renders the current draft at a quarter of the frame size to a small clip the editor plays. No LLM call. It exists because three stills cannot show whether the motion works, and a full clip is slow.

### 8. Approval and the clip

**Approve** does this for the current draft version:

1.  Reads the shot's length from the cut as it is now: from its first kept word to its last kept word, within the scene limits.
2.  Renders the clip at that length and the output frame rate (ProRes 4444, alpha), with the stills at that length.
3.  Imports it through the existing clip import, which writes the VP9 preview copy under `clips/` that the editor and the render play.
4.  Records the approval in `storyboard.json` and runs the editor's existing replay, so `produce` writes the scene into `production.json`. `produce` stays the only writer of that file.

The scene is a `ClipScene` anchored to the shot's word range, with the clip's own length, in the clip scene's default layout. It behaves as any clip scene: assembly starts it at its first kept word, pushes it later if the scene before it overlaps, and drops it when all its words are cut. The backdrop choice of §163 applies; storyboard projects are treated as script projects are there.

**The clip key.** A clip is rendered again only when one of these changes: the code, the kit version, the theme, the frame size, the frame rate, the length.

**After approval:**

| Event | What happens |
|---|---|
| A note on the shot | A new draft version. The approved clip stays in the video until the draft is approved. |
| The cut changes the span's length | The clip keeps its length, as a hand-made clip does. The storyboard shows both lengths and offers "Render at the new length". That renders new stills and needs approval again (AG2). |
| All the shot's words are cut | The scene leaves the video (existing behaviour). The storyboard shows the shot as "cut away" and keeps its work. |
| The theme or the kit version changes | The clip stays as it is. The storyboard marks it and offers a new render, which needs approval again. |
| The author removes the scene in the editor | The storyboard shows the shot as "not in the video" and offers to put it back. |
| The author drops the shot | The scene leaves the video at the next replay. Its files stay until the author clears them. |

### 9. What is stored

In the workdir:

```
storyboard.json           every shot: id, words, idea, why, priority, assets, versions, draft, approval
storyboard/<shot-id>/
  v1.tsx  v2.tsx  …       code, one file per version
  v1/still-1.png …        stills per version
  v2/preview.webm         the small preview, when asked for
  approved.mov            the clip of the approved version (one per shot)
  history.json            notes, errors, what the AI said it drew, kit version
```

**The shot record** (zod-parsed). Shot ids are stable and never reused.

*   `kept`: true or false (dropped).
*   `versions`: each with a number, a result (`ok`, or `failed` with the error) and the kit version.
*   `draft`: the version number the author is looking at, or none.
*   `approval`: none, or the version number, the length, the clip key and the clip's two file paths.

Work in progress is not a stored state. A draw or a render that was interrupted leaves a version without a result; such a version is discarded on the next load. What the storyboard shows ("drawing", "in the video", "cut away", "needs a new render") is computed from this record, the running jobs, the cut and `production.json`, on every load.

**The storyboard record in `production.json`.** A new optional field beside the script record: for each approved shot, its id, its word range and its clip's original file and preview copy. It is written by a `--storyboard` run and carried forward by a replay, as the script record is. Three places read it:

*   `produce` builds the clip scenes from it on a `--storyboard` run and on a replay;
*   `ossclip kit` finds a clip's original file through it (today the kit knows only the script record and skips any other clip);
*   the backdrop rule of §163 treats a project with this record as it treats a script project.

**Disk.** Only the approved version keeps a ProRes clip. Other versions keep code and stills.

**Durable workdir.** The workdir holds work the author steered. The run warns when it is under a temp directory.

### 10. The editor

A storyboard panel:

*   **Table view:** one row per shot with time, spoken line, idea and state. Row actions: drop, edit the idea, set the span from the selected words. An action to add a shot from a word selection. "Draw" for one row or for all kept rows. "Plan again".
*   **Shot view:** the three stills, "Preview", the idea, the note history, a note box with "Redraw", the versions, and "Approve".
*   **Progress and cost:** one job runs at a time. The panel shows which shot is running, lets the author cancel, and shows the calls used so far.

Editing the idea or the span of a shot that is already drawn does not redraw it; the panel marks the draft as older than the idea and offers "Draw again".

The editor's server gains endpoints for these actions, built as `/api/youtube/generate` is: a busy flag that answers 409, the server's provider factory, a normal reply with `ok: false` when the provider fails, and an entry in `usage.json`. Every path is derived on the server. The endpoints call core functions that a test can call without a server.

### 11. The AI looks at its own stills (Phase C)

After the still checks pass, and before the author sees the shot, one more call shows the LLM its three stills with the idea and asks for faults: text cut off, elements overlapping, an empty frame, the idea not shown. If it reports a fault it also returns corrected code, once; that code passes all the checks and counts as one of the two repairs. A redraw likewise attaches the current stills.

This needs image input, which the provider interface does not have. The interface gains an optional image list on a call. A provider that cannot take images skips the step, and the storyboard says so.

### 12. Cost and time

Per video: one plan call, then per kept shot one draw call, up to two repair calls (the look step is one of them), and one call per note. For 24 shots with no notes that is 25 to 73 calls. A clip takes as long as a kit clip does today. The table review (G2) exists to keep this spend on shots the author wants (AG3).

## Phases

Each phase ships on its own. All packages are released together, so a phase that is not ready for users ships behind a command marked experimental in its help text.

**Phase A: draw and steer one shot, from the command line.** The drawing kit; the checks; the new compositions and bundle entry; the draw call with repair; notes and redraw; versions on disk; `--assets`; stills and preview. An experimental command draws a shot from an idea, and redraws it from a note. No planner, no editor panel.

*   **First tasks, before the rest:** prove that a scene file in a workdir renders through a bundle; find the network block; check the editor server's endpoints.
*   **Gate.** Five shots that fit no pattern are drawn from one-sentence ideas, with the EGM logo as the only asset. (Changed 2026-11-20 at the author's request: the shots come from the author's next video, a 68-second vertical short on the same subject, so the gate measures new work and not shots that already exist.) The author judges each from its stills and preview, and may give at most two notes. A shot is **usable** when the author would put it in the video. The record states, per shot: usable at first draft, usable after notes, or not; the provider and model; calls and minutes. **Pass:** three of five usable after notes. If the gate fails, the look step of Phase C is built and the gate is run once more before the design is revisited.
*   **Also recorded:** bundle time and still time on the author's machine; which providers can return a scene.

**Phase B1: plan and table.** The planner, `--storyboard`, `storyboard.json`, the panel's table view, "Plan again".

**Phase B2: draw, steer and approve in the editor.** The shot view, the endpoints, approval, the storyboard record, the kit and backdrop changes, the after-approval table of section 8.

**Phase C: the AI sees stills.** Image input on the provider interface, the look step, stills attached to a redraw.

## Verification

*   **Unit tests (pure):** the static check, one test per rejected construct and one per allowed import; plan limits in their fixed order, with the reported changes; "Plan again" keeps drawn, approved and author-touched shots; the shot record and each row of the after-approval table; discarding an interrupted version; the clip key; the all-transparent still check on fixture images.
*   **Pipeline tests with the mock provider** (it needs routes for the new schema names): a canned scene goes through the checks, stills and clip, and becomes a clip scene after a replay. A canned scene with a type error is repaired by the second canned reply. A scene that fails three times is marked failed, and the other shots complete. One bad scene in a batch does not stop the batch.
*   **Unchanged output:** a run without `--storyboard` gives the same prompts and the same `production.json` as before (existing tests).
*   **Kit:** `ossclip kit` on a storyboard project writes a clip for every approved shot.
*   **Alpha, automated (new; today this check exists only as a manual step):** an approved clip has a transparent corner pixel and an opaque pixel inside the graphic.
*   **Real runs:** the Phase A gate; then one full `--storyboard` run on the EGM recording, reviewed by the author in the editor.

## Risks

*   **Drafts are poor.** Nothing measures this yet. The Phase A gate does. Notes, the preview and the look step reduce it.
*   **The model draws blind until Phase C.** In the chat a person saw every frame. The gate may fail for this reason alone, which is why it is run once more with the look step.
*   **Cost.** Up to about 73 calls for a 4-minute video, more with notes. The table and per-row drawing let the author stop early.
*   **The same look, less variety.** The kit can pull every shot toward cards and pills. The examples and the prompt say that drawing new shapes is expected.
*   **LLM-written code.** See section 5 and decision 4.
*   **Kit changes break stored scenes.** Versioned kit, exports only added, clips keyed on the kit version.
*   **Bundle and type-check time** on a machine with 7 GB of memory. Measured in Phase A.
*   **A provider cannot return a whole scene.** Measured in Phase A; refused with a clear message.

## Left to the builder

*   The parser used by the static check.
*   How the bundle resolves modules for a scene file in a workdir.
*   The names of the experimental Phase A command and of the endpoints.
*   The storyboard panel's layout.
*   The time limit of a still render.

## Decisions for the author

1.  **An approved shot is a rendered clip, not live code.** You cannot retype its text in the Inspector; you type a note and it is redrawn. This keeps LLM-written code out of the editor page and reuses the clip path. Recommended.
2.  **The planner covers at most 60% of the runtime**, the EGM video's share. A flag can change it later.
3.  **`--storyboard` and `--script` are separate in the first version.** Later, a script cue could say "draw this" and join the same storyboard. Recommended: separate first.
4.  **If the render browser's network cannot be blocked,** you decide before Phase B whether the static check alone is enough. Blocking is a Phase A requirement, not an option.
5.  **The Phase A gate:** five free-drawn EGM shots, three usable after at most two notes each, one more attempt with the look step if it fails. Recommended.
6.  **A plain `--produce` run on a storyboard project plans from nothing** and leaves the storyboard scenes out, as it does for a script project today. The storyboard files stay. Recommended, because it is the existing rule.
7.  **Clips keep the theme they were approved with.** A theme change marks them and offers a new render; it does not redraw them without you. Recommended.

## What the reviews changed

*   **Cut edits.** Draft 1 cached the plan on the kept words, so any cut edit would have planned again and orphaned drawn shots. Now the storyboard is loaded, never planned again without the author, and "Plan again" keeps the author's work. The after-approval table is new.
*   **Guards.** The name list missed everything declarative (images, frames, CSS URLs) and the whole of `remotion` was allowed. Now elements and `remotion` names are allow-listed, URL strings are rejected, stills have a time limit, and the network block is a Phase A requirement.
*   **The shot record.** One state per shot could not say "version 2 is in the video, version 3 is the draft". Draft and approval are now separate, and work in progress is not stored.
*   **Renderer.** The existing still and clip compositions cannot draw a file outside the registry. New compositions, a generated entry and a bundle resolve rule are stated.
*   **Storyboard projects.** `ossclip kit` and the backdrop rule know only the script record. The storyboard record and its three readers are new, and `produce` stays the only writer of `production.json`.
*   **Later runs.** "A later produce keeps the scenes" was wrong for a plain run. The table in section 1 states each case.
*   **The kit.** `useSceneTime`, `palette` and `fonts` did not exist, and parts take the theme as a prop. The kit is now context hooks plus wrappers. Pattern components are out (NG6). It is renamed from "scene kit", which collided with `ossclip kit`.
*   **The gate.** It allowed notes that Phase A did not build, and two of its five shots were pattern shots. Notes, assets and preview moved into Phase A; all five shots are free-drawn; "usable" and the pass mark are defined.
*   **Preview.** Added, because stills cannot show motion.
*   **Providers.** Output limits, the 90-second limit and the stripped backticks are stated, with what happens on each.
*   **Phase B** is split into the plan and table, then drawing and approval.
*   **Length.** The clip is rendered at the length the cut gives at approval, and a later length change needs approval again.
