# ossclip

[![CI](https://github.com/AhsanAyaz/ossclip/actions/workflows/ci.yml/badge.svg)](https://github.com/AhsanAyaz/ossclip/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ossclip)](https://www.npmjs.com/package/ossclip)
[![docs](https://img.shields.io/badge/docs-ahsanayaz.github.io%2Fossclip-8ab4f8)](https://ahsanayaz.github.io/ossclip/)

![Before and after: the raw take beside the produced short — captions, framing and LLM-planned graphics](./docs/site/assets/demo.gif)

<p align="center"><em>Left: the raw take. Right: what <code>ossclip produce</code> returns — cuts, word-timed captions, face-aware framing and code-rendered graphics.</em></p>

**A local-first CLI that turns a talking-head take into a finished short.** It cuts silence and filler words, writes word-timed kinetic captions, frames on the measured face, and has an LLM plan **code-rendered on-screen graphics** — title cards, stat cards, diagrams, terminal and chat mockups — from what was actually said. Transcription is local (whisper.cpp), rendering is local (Remotion); the only network calls are the LLM planning ones, on your own key or your existing Claude Code subscription. Vertical 9:16 by default, landscape 16:9 with `--aspect`.

The graphics layer is the part comparable tools don't have: nine Zod-typed scene components ([`packages/core/src/scene-registry.ts`](./packages/core/src/scene-registry.ts)) each carry a `whenToUse` contract the LLM producer plans against, every planned scene validates against its schema before it renders, and a fit contract keeps every component inside the platform-safe area on real copy. Open-source alternatives stop at find → crop → caption; commercial tools gate the graphics layer behind paid tiers.

**Scope, honestly:** ossclip is at its best **polishing a take you have already cut down** — every finding in this repo came from real 30–70 s takes. For long-form input, `--clip <seconds>` selects the **single strongest window** (chosen by the producer in the same editorial call that plans the graphics, snapped to sentence boundaries) and produces only that; it is the newest part of the pipeline and has had the least real-footage mileage. It extracts one clip, not N — multi-clip is not built. Without `--clip`, feed it 20 minutes and you get a polished 20 minutes.

> **Status: working end to end, pre-1.0.** Cut, captions, zoom, scene graphics, the LLM producer, cover images and a direct-manipulation editor are all built and exercised on real footage. Interfaces still move between rounds. See [`docs/PHASE1-FINDINGS.md`](./docs/PHASE1-FINDINGS.md) for the running defect log — every fix in this repo traces to a numbered finding from a real render.

**Docs:** a single-page reference — install, concepts, keybinds, flags — is live at **[ahsanayaz.github.io/ossclip](https://ahsanayaz.github.io/ossclip/)** (source: [`docs/site/index.html`](./docs/site/index.html), self-contained).

## Install

Two commands, on macOS, Linux, or Windows (plain PowerShell — no WSL, no admin rights):

```sh
npm install -g ossclip
ossclip setup
```

`ossclip setup` provisions everything ossclip runs on, into one folder (`~/.ossclip`): a static [ffmpeg](https://ffmpeg.org) build, a prebuilt [whisper.cpp](https://github.com/ggml-org/whisper.cpp) `whisper-cli` (on macOS both come via Homebrew), and the transcription model — `small.en`, ~466 MB, the biggest piece of a ~600 MB total. It shows the plan with sizes and asks before downloading, resumes interrupted downloads, verifies checksums, and **skips anything you already have** — an ffmpeg already on your PATH stays yours. It records absolute paths in `~/.ossclip/config.json`, so nothing edits your PATH. Uninstalling is `npm rm -g ossclip` plus deleting `~/.ossclip`.

Setup also offers to save an LLM key for `--produce` (the graphics planner): a logged-in [Google Antigravity](https://antigravity.google) (`agy`) or [Claude Code](https://claude.com/claude-code) is detected automatically — no key needed — or paste an `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`. Skip it freely — cut + captions run fully local without one.

If anything looks wrong later, one command diagnoses it: `ossclip doctor` prints a line per prerequisite and the exact fix.

ossclip sends a few anonymous usage events — never footage, transcripts, file names, or paths. The complete event list and the off switches are in [Telemetry](#telemetry).

> **Never used a terminal?** That's fine. Install Node ≥ 22 from [nodejs.org](https://nodejs.org) (a normal click-through installer), open a terminal (macOS: press ⌘-space, type *terminal*; Windows: open the Start menu, type *PowerShell*), paste the two lines above, press Enter, and answer the questions. Expect the downloads to take a few minutes.

Licence note, since setup downloads binaries: the static ffmpeg builds it fetches ([BtbN](https://github.com/BtbN/FFmpeg-Builds)) are GPL, downloaded onto your machine at your request — nothing GPL ships inside the MIT npm package.

### Manual install (if you'd rather own the toolchain)

```sh
brew install ffmpeg whisper-cpp        # macOS; Linux/Windows: ffmpeg from your package manager,
                                       # whisper-cli from https://github.com/ggml-org/whisper.cpp/releases

mkdir -p ~/.ossclip/models
curl -L -o ~/.ossclip/models/ggml-small.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
```

`ossclip doctor` checks all of it — Node ≥ 22, `ffmpeg`/`ffprobe`, `whisper-cli`, the model, an LLM provider — and prints the per-platform command for anything missing. Binaries can live anywhere: point `OSSCLIP_FFMPEG` / `OSSCLIP_WHISPER` (or `config.json`) at them. Setup and manual install compose — setup only ever fills the gaps doctor would flag.

`small.en` is the default model. A mistranscribed word ends up in your captions *and* on a graphic, so accuracy matters more here than speed — which is also why `--produce` runs a repair pass over the transcript before anything is drawn. Compare models on your own footage with `--whisper-model base.en|small.en|medium.en` (~142 MB / ~466 MB / ~1.5 GB; `ossclip setup --model <name>` downloads any of them).

Non-English footage works too: drop any converted whisper.cpp GGML model (Hugging Face fine-tunes included) into `~/.ossclip/models` and it's usable by name — the wizard lists whatever is installed — with `--whisper-language ur|de|auto` so a multilingual model decodes its own language instead of being forced through English. RTL captions (Urdu, Arabic, Hebrew) lay out right-to-left with the word highlight following spoken order — field-proven on a real Urdu run.

## Quick start

```sh
# The whole thing: cut + captions + LLM-planned graphics + cover
ossclip produce input.mp4 --produce -o out.mp4

# Just the cut and captions — no LLM, no network
ossclip produce input.mp4 -o out.mp4

# See what would be cut and why, without rendering
ossclip produce input.mp4 --no-render

# Long-form in, one short out: the strongest ~60s window, chosen by the producer
ossclip produce podcast.mp4 --produce --clip 60 -o clip.mp4

# Keep your own editor: export the planned cuts as labelled markers instead of rendering
ossclip analyze input.mp4 --format premiere-xml   # Premiere Pro (File → Import)
ossclip analyze input.mp4 --format resolve-edl    # Resolve (Timeline Markers from EDL, coloured)
ossclip analyze input.mp4                         # Final Cut Pro (fcpxml)
```

![A produce run in the terminal: transcribe, analyze, cut, captions, scenes, render — each step reporting what it did](./docs/site/assets/render-example.png)

<p align="center"><em>One <code>ossclip produce</code> run, end to end — every stage says what it did and why, and the cut report is written beside the video.</em></p>

Step-by-step walkthroughs — first short, NLE marker export, long-form clipping, non-English footage — live in the docs site's [Tutorials section](https://ahsanayaz.github.io/ossclip/#tutorials).

Every run writes a **work directory** next to the input (`<input dir>/.ossclip/<name>-<hash>/`, the hash taken from the source's *content* — so the same footage reuses its cache, `--workdir` starts a separate project, and deleting the directory forces a clean run) holding the transcript, the analysis, `production.json`, `render-props.json`, `report.txt`, `usage.json`, and the cached LLM plan. It is a cache: delete it to force a clean run, keep it and re-runs are near-instant.

### Not sure what to run?

```sh
ossclip
```

Opens a menu — produce a video, open the editor on something you already
produced, set up your install, or check what's missing. Every choice prints
the equivalent command before it runs, so the menu is also how you learn the
flags.

Choose **produce a video** and the wizard's first question offers the newest
videos in your working directory, Downloads and Movies (Videos on Linux and
Windows); a **Browse…** row that opens your operating system's own file
picker; and typing a path. Over SSH on macOS or Windows, or on a Linux box
with no display or no `zenity`/`kdialog`, the Browse rows are simply not
shown — there is no window to open.

`ossclip produce` with no file name does the same thing for just the produce
options, and `ossclip <path>` — a video file or a folder of clips — jumps
straight into that wizard with the input pre-filled. `ossclip edit` with no
path opens a picker over your recent runs — you never have to know that
produce writes into `<your video's folder>/.ossclip/<name>/`.

## Editing what it produced

![The ossclip editor: preview, transform handles, inspector and timeline](./docs/site/assets/editor-preview.gif)

```sh
ossclip edit "<work directory>"     # opens http://127.0.0.1:5174
ossclip edit                        # bare: pick from recent projects, or browse
```

- **Click** an element to select it, **drag** to move, **double-click** to retype.
- **Timeline**: click a scene to select and seek to that point, press-and-drag to scrub, drag a block body to move it in time, drag its edges to retime it.
- **Cut anything**: split any take or scene at the playhead (**⌘B**), then **Delete this chunk** — struck-through until the next Render, Restore one click away. Cuts are source-anchored, so re-running produce never drifts your splits, pins, or captions.
- **Hide any graphic element** — a chat bubble, a bullet, a diagram node — and the scene panel lists what's hidden with a per-element Restore.
- A global **Show captions** toggle hides the caption track everywhere — instant in the preview, undo-able, and it survives re-produces. On a `--no-captions` run the toggle says the flag owns it.
- **SPACE** toggles playback, **⌘Z** / **⌘⇧Z** undo and redo (also in the top bar), **⌘S** saves. Press **?** for the full keybinds reference.
- **Cover** in the top bar retypes the cover headline or re-cuts its frame. **Use current playhead** takes the frame you are looking at — converted to the original take's clock when you ask for a frame from the source, and it says so when the instant you picked was cut away. **Preview** tries a frame without spending the cover you already have; the seconds field keeps what it used, so you can nudge it and go again. Rebuilds in seconds; the video itself is never touched. Same thing `ossclip cover` does from a terminal.
- **Open** in the top bar switches projects in place — recent produce runs plus a folder browser, no server restart.

Edits land in `<workdir>/overrides.json` — a file the producer never writes. Re-running `produce` re-plans the video and **keeps your edits**: each one is anchored to the words it was made against, so it follows its moment even when the new plan numbers the scenes differently. An edit whose words are gone from the plan is parked and reported — never quietly applied to whatever now occupies that slot — and it comes back if a later plan has those words again.

## The commands

| command | what it does |
| --- | --- |
| `produce <input>` | the full pipeline: transcribe → analyze → cut → captions → scenes → render (+ cover). `<input>` can be a single video file, or a folder of clips — concatenated in order (by name, or `--sort mtime`) before anything else runs |
| `edit [workdir]` | direct-manipulation editor; bare `edit` opens a project picker |
| `cover [workdir]` | rebuild the cover image — a new headline (`--text`) or a new frame (`--at <seconds>`, `--from final \| source`) — in seconds, with no video re-render. `--at` omitted re-uses the still the last cover was built from and runs no ffmpeg at all. Your headline is remembered: a later `produce` keeps it instead of the generated one (`--cover-text-reset` opts back in). Bare `cover` resolves the run under the current directory, like `edit` |
| `setup` | install ffmpeg, whisper.cpp and the model into `~/.ossclip` — the one-command onboarding (`--model <name>`, `--skip-llm`, `--force`, `--yes`) |
| `doctor` | check every prerequisite and print the exact fix for anything missing |
| `transcribe <input>` | stops after the transcript and cut report — no render |
| `analyze <input>` | the analyzer without the renderer: exports the planned cuts as labelled span markers for your own NLE (`--format premiere-xml \| resolve-edl \| fcpxml`) — no LLM, no render. `analyse` works too. See [analyze](#analyze--cut-suggestions-in-your-own-editor) |
| `studio <render-props.json>` | opens Remotion Studio on a produced composition, for visual debugging |

### `produce` flags worth knowing

| flag | |
| --- | --- |
| `--produce` | run the LLM producer brain (title cards, stat cards, diagrams, cover text). Without it you get cut + captions only |
| `--clip <seconds>` | produce only the strongest ~N-second window of a long take, sentence-snapped (requires `--produce`; a source already at or under the target is produced whole). The report says what was chosen and why |
| `--intent "<text>"` | what the video should be — steers the producer's editorial choices |
| `--speaker "<who>"` | who is on camera, e.g. `"Ahsan, host of Code with Ahsan"`. Helps the repair pass recognise a mangled name and stops grounding flagging it |
| `--cleanup <level>` | `exact` \| `light` \| `standard` \| `aggressive`. How hard to cut silence and fillers |
| `--aspect <ratio>` | `9:16` (default) or `16:9` — landscape export with landscape-native layouts |
| `--source-fit <mode>` | `cover` crops to fill; `contain` shows the whole frame inset — the landscape-source escape hatch |
| `--llm <provider>` | `antigravity` \| `claude` \| `claude-cli` \| `gemini` \| `mock` |
| `--llm-model <id>` / `--llm-fast-model <id>` | override the editorial / mechanical model. `--llm-fast-model same` disables tiering |
| `--no-repair` | skip the ASR mishearing repair; captions then show the raw transcription |
| `--whisper-model <name>` | transcription model for this run — a stock name, or any converted GGML model in `~/.ossclip/models` |
| `--whisper-language <code>` | language for a multilingual model, e.g. `ur`, `de`, `auto` (whisper defaults to `en`) |
| `--scenes <path>` | hand-authored scenes JSON — no LLM in the loop |
| `--force-component <id>` | debug: render every graphic with one component (e.g. `FlowDiagram`) to exercise it on real copy |
| `--source-is-edited` | the source is already an edited reel with burned-in text — keep ossclip's graphics off it (also what enables the source-text scan) |
| `--blooper-marker <word>` | say the word on camera and the flubbed take is cut, back to the start of the sentence it spoiled. Matching is fuzzy (edit distance), so a whisper mishearing like "looker" for "blooper" still counts — every fuzzy hit is named in the report. Off unless given |
| `--collapse-retakes` | deterministically collapse consecutive near-identical sentences, keeping only the last complete attempt — no marker needed. Off by default |
| `--sort <order>` | when `<input>` is a folder: `name` (default, plain codepoint sort, matches `ls`) or `mtime` (oldest first) — the order clips get concatenated in. Ignored for a file input |
| `--no-cover` / `--cover <path>` | skip, or redirect, the cover image written beside the video |
| `--watermark` / `--no-watermark` | opt-in credit: a small, low-opacity "made with ossclip" wordmark in the top-left safe area. Off by default for everyone; set `"watermark": true` in `~/.ossclip/config.json` to turn it on once, and `--no-watermark` still wins per run |
| `--no-captions` | turn the burned-in captions off (they are on by default). The CTA keyword styling rides the caption track, so it goes too. The editor's global Captions toggle is the same switch as a saved override — either surface can hide, neither can force them back on over the other |
| `--no-render` | stop after writing the props |
| `--workdir <dir>` | where the cache lives |

`--collapse-retakes` on a folder run only catches a retake that's back-to-back near-identical *lines* — within one clip, or across a clip boundary when each clip is essentially a single line — because the chain it looks for requires every consecutive sentence to match, not just "clip N as a whole resembles clip N − 1"; a whole clip re-recorded as a multi-sentence retake of the previous one will not collapse (R27 §128's chaining rule).

### `analyze` — cut suggestions in your own editor

For editors who already have a workflow and just want the analysis: `ossclip analyze` runs the pipeline up to the cut report — **no LLM, no render**, so it finishes in roughly transcription time — and writes a marker file your NLE imports. Every marker is a **span** covering the whole suggested cut (where it starts *and* where content resumes), named in the cut report's vocabulary: `silence −1.77s (conf 0.95)`, `retake −4.25s (conf 0.90)`. Nothing is cut for you — they are labels to review.

Each NLE reads a different dialect, so pick the format for yours (this matters: Premiere does not read modern fcpxml at all, and Resolve's fcpxml import silently drops markers):

| format | for | how to import |
| --- | --- | --- |
| `premiere-xml` | Premiere Pro | File → Import → pick the `.xml`; relink the media if it shows offline. Markers land at the sequence level *and* on the clip itself — the clip-level ones are anchored to the footage, so they stay on the right words even after your own razor cuts and ripple deletes |
| `resolve-edl` | DaVinci Resolve | import the timeline first (any way you like), then Media Pool → right-click the timeline → Timelines → Import → **Timeline Markers from EDL** → pick the `.edl`. Colour-coded by reason: silence Blue, pause Sky, filler Yellow, retake Red |
| `fcpxml` (default) | Final Cut Pro | File → Import → XML |

Pauses the analyzer *detected but kept* (below the cut bar) are exported too — `pause 0.40s (kept)`, Lavender in Resolve — so a gap you can see in your waveform is never unexplained. `--out <path>` overrides the destination (default: beside the input, e.g. `take.xml`); the analysis flags above (`--cleanup`, `--blooper-marker`, `--collapse-retakes`, `--whisper-model`, …) all apply. Everything here was shaped by a working editor's feedback on real footage — FINDINGS §142.

### Which model runs

Without `--llm`, ossclip picks in this order: **the Google Antigravity CLI (`agy`) → the Claude Code CLI → `GEMINI_API_KEY` → `ANTHROPIC_API_KEY` → the Claude Code CLI as the final fallback**. A logged-in CLI beats an API key on purpose: both CLI paths run on the subscription you already pay for (Antigravity, or Claude Pro/Max) rather than API credits — and the console always tells you which path it took. If you only have a key and no CLI installed, nothing changes for you. On the Antigravity path the editorial call runs whatever default model you configured `agy` with, reported as `antigravity-default` — tokens shown, no cost guess, unless you price it under `pricing` in `~/.ossclip/config.json`.

Calls are **tiered**: the beat sheet (the editorial judgement the video rests on) goes to the main model; mechanical calls (transcript repair aside, which is also editorial) go to a smaller sibling. Override with `--llm-fast-model`.

### What each run costs

```
▸ llm: 3 calls · 130,749 in / 8,321 out tokens · ~$0.72 of API-rate work, covered by the subscription · 92s
```

A per-call breakdown lands in `report.txt`, the raw records in `usage.json`. Two rules the output holds to: token counts a provider actually reports are exact and anything derived from text length is marked `(est)`; a model with no known price is reported with its tokens and **no cost guess**. On the subscription path the figure is what the same tokens would cost at API rates — nothing is charged, but you can still see how much work a run was.

Prices are a built-in per-family assumption. Override for your account in `~/.ossclip/config.json`:

```json
{ "pricing": { "claude-opus-5": { "inputPerMTok": 5, "outputPerMTok": 25 } } }
```

## Configuration

`~/.ossclip/config.json` — all optional:

```json
{
  "model": "small.en",
  "speaker": "Ahsan, host of the Code with Ahsan channel",
  "fastModel": "claude-haiku-4-5-20251001",
  "ffmpegPath": "ffmpeg",
  "whisperPath": "whisper-cli",
  "modelDir": "~/.ossclip/models",
  "browserExecutable": "/path/to/chrome"
}
```

Provider keys are read from the environment, and ossclip loads `.env` files before it picks a provider — first hit wins per key, and a real environment variable always beats a file:

```
$OSSCLIP_ENV_FILE   →   .env, walking up from the cwd   →   ~/.ossclip/.env
```

```sh
# .env  (gitignored)
GEMINI_API_KEY=…
```

Env vars override the file: `OSSCLIP_FFMPEG`, `OSSCLIP_FFPROBE`, `OSSCLIP_WHISPER`, `OSSCLIP_MODEL_DIR`, `OSSCLIP_MODEL`, `OSSCLIP_FAST_MODEL`, `OSSCLIP_SPEAKER`, `OSSCLIP_BROWSER`, `OSSCLIP_CLAUDE_BIN`, `OSSCLIP_AGY_BIN`.

One more that has no config-file equivalent: `OSSCLIP_NO_PICKER` — set it to a non-empty value to disable the wizard's native file picker, so the input prompt falls back to suggestions and typing. Truthiness, not presence, the same rule `CI` gets: an empty `OSSCLIP_NO_PICKER=` leaves the picker on.

## Telemetry

ossclip reports a few **anonymous usage events**, so development effort goes where the tool is actually used. It is on by default, the first run prints a notice saying so, and it is built so nothing about *your* footage can travel. This is the complete list of what is sent:

- `cli_first_run` — once, when the first-run notice is shown
- `produce_completed` — wall-clock duration, the provider *name* (or `none`), whether `--produce` / `--clip` / a render ran, the aspect, the scene count, the source length **as a bucket only** (`<1m`, `1-5m`, `5-15m`, `>15m`), which branch of the input prompt supplied the file — a suggestion, the picker, typing, or the command line, as a branch name and never a path — and a per-phase duration **bucket** (`<10s`, `10-60s`, `1-5m`, `5-15m`, `>15m`) for each pipeline phase that ran: transcription, LLM planning, render, ffmpeg
- `produce_failed` — the error's class name (e.g. `Error`), never its message
- `transcribe_completed` — for a bare `ossclip transcribe`: the `--cleanup` level by name (`exact` | `light` | `standard` | `aggressive`) and the source length as the same bucket
- `analyze_completed` — for `ossclip analyze`: the export format name (e.g. `fcpxml`), the `--cleanup` level, the source length bucket, the marker count, and the same per-phase duration buckets
- `analyze_failed` — the error's class name, never its message
- `editor_opened` — when `ossclip edit` starts its server
- `setup_completed` — how many steps `ossclip setup` planned, how many were already satisfied, and how many failed — three counts, no step names
- `doctor_run` — how many checks `ossclip doctor` ran, and how many passed and failed — again counts only, never which check or what it found
- `rating_submitted` — the 1–5 answer, if you ever give one (asked once, after your third produce; Enter skips, and two skips end the asking)

Every event also carries the ossclip version, OS name, CPU architecture, Node major version, a CI flag, and a random anonymous id.

**Never sent, ever:** footage, transcripts, file names, paths, `--intent` text, prompts, or keys. This is enforced in code, not just policy — an event property whose key so much as *contains* `path`, `file`, `transcript`, `intent`, `prompt`, or `key` is rejected by a guard the test suite pins.

Three off switches, any one of which wins:

```sh
ossclip telemetry off    # persisted in ~/.ossclip/telemetry.json
OSSCLIP_TELEMETRY=0      # per shell or per run
DO_NOT_TRACK=1           # the ecosystem-wide standard, honored too
```

`ossclip telemetry status` shows the current state, names the switch that is winning when it is off, and prints your anonymous id — a random UUID stored in `~/.ossclip/telemetry.json`, tied to nothing; delete the file and a fresh one is generated.

## What it does to your footage

- **Cuts** dead air and filler words, with every cut justified in `report.txt`.
- **Repairs** ASR mishearings before anything is drawn, so a graphic and the caption under it can never spell the same word two different ways. Strictly near-homophones only — it will refuse a rewrite and say so.
- **Frames** on the measured face rather than a constant, including sources that are letterboxed or that change framing mid-take (those get normalized to one field of view before anything else runs).
- **Plans** scenes from the transcript, then checks its own choices: a layout that would crop the speaker's head is rewritten, and copy that isn't grounded in what was actually said is flagged.
- **Captions** every word, routed around any text already burned into the source.
- **Covers** — writes `<out>.cover.jpg` sized for the platform the aspect targets. With `--produce` the cover carries the hook text; without it, the sharpness-scored face frame ships on its own.

> AI can make mistakes. The cut, the captions and every graphic are generated — review the output (the editor and `report.txt` exist for exactly that) before publishing.

## Working from a clone (contributors)

```sh
pnpm install
pnpm build             # builds the editor page; needed once before `ossclip edit`
pnpm ossclip produce input.mp4 --produce -o out.mp4

pnpm test              # vitest
pnpm typecheck
node scripts/make-fixture.mjs    # regenerates the deterministic test fixtures
```

## Repo layout

```
packages/core      framework-free pipeline: schema, ingest, transcribe, analyze, cutlist,
                   timemap, captions, framing/normalization, the LLM producer
packages/scenes    React components shared by preview & render (EdlVideo, CaptionTrack, SceneLayer)
packages/renderer  Remotion composition + programmatic render entry
apps/cli           the ossclip CLI (published to npm as `ossclip`)
apps/editor        direct-manipulation editing page over a produced workdir (`ossclip edit`)
```

## Licensing

ossclip's own code is **MIT** — see [LICENSE](./LICENSE).

Rendering uses [Remotion](https://www.remotion.dev/), which is **source-available under its own two-tier licence**, not MIT: free for individuals, non-profits, and for-profit companies up to the size stated in its terms; for-profit companies above that threshold need a paid [Remotion Company Licence](https://www.remotion.dev/license). If you use ossclip inside a company, check [Remotion's LICENSE](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md) — its terms, not this README, are authoritative.
