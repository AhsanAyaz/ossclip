# ossclip

**Open, local-first AI video producer.** Raw talking-head footage in → a polished, virality-optimized vertical short out: filler words and dead air removed, word-timed kinetic captions, face-aware framing, and title cards / stat cards / diagrams planned by an LLM producer against a hand-built scene library — plus a cover image for the profile grid.

Your footage never leaves your machine. Transcription is local (whisper.cpp), rendering is local (Remotion), and the only network calls are the LLM planning ones — on your own API key, or on your existing Claude Code subscription.

> **Status: working end to end, pre-1.0.** Cut, captions, zoom, scene graphics, the LLM producer, cover images and a direct-manipulation editor are all built and exercised on real footage. Interfaces still move between rounds. See [`docs/PHASE1-FINDINGS.md`](./docs/PHASE1-FINDINGS.md) for the running defect log — every fix in this repo traces to a numbered finding from a real render.

**Docs:** a single-page reference — install, concepts, keybinds, flags — lives at [`docs/site/index.html`](./docs/site/index.html) (self-contained; open it locally or serve it via GitHub Pages).

## Requirements

- Node ≥ 22, pnpm
- `ffmpeg` and `ffprobe` on PATH
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`whisper-cli`) + a ggml model
- For `--produce`: a logged-in [Claude Code](https://claude.com/claude-code), or `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`

```sh
pnpm install
pnpm build            # builds the editor page; needed once before `ossclip edit`

mkdir -p ~/.ossclip/models
curl -L -o ~/.ossclip/models/ggml-small.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
```

`small.en` is the default. A mistranscribed word ends up in your captions *and* on a graphic, so accuracy matters more here than speed — which is also why `--produce` runs a repair pass over the transcript before anything is drawn. Compare models on your own footage with `--whisper-model base.en|small.en|medium.en`.

## Quick start

```sh
# The whole thing: cut + captions + LLM-planned graphics + cover
pnpm ossclip produce input.mp4 --produce -o out.mp4

# Just the cut and captions — no LLM, no network
pnpm ossclip produce input.mp4 -o out.mp4

# See what would be cut and why, without rendering
pnpm ossclip produce input.mp4 --no-render
```

Every run writes a **work directory** next to the input (`<input dir>/.ossclip/<name>-<hash>/`, the hash taken from the source's *content* — so the same footage reuses its cache, `--workdir` starts a separate project, and deleting the directory forces a clean run) holding the transcript, the analysis, `production.json`, `render-props.json`, `report.txt`, `usage.json`, and the cached LLM plan. It is a cache: delete it to force a clean run, keep it and re-runs are near-instant.

## Editing what it produced

```sh
pnpm ossclip edit "<work directory>"     # opens http://127.0.0.1:5174
pnpm ossclip edit                        # bare: pick from recent projects, or browse
```

- **Click** an element to select it, **drag** to move, **double-click** to retype.
- **Timeline**: click a scene to select and seek to that point, press-and-drag to scrub, drag a block body to move it in time, drag its edges to retime it.
- **SPACE** toggles playback, **⌘Z** / **⌘⇧Z** undo and redo (also in the top bar), **⌘S** saves. Press **?** for the full keybinds reference.
- **Open** in the top bar switches projects in place — recent produce runs plus a folder browser, no server restart.

Edits land in `<workdir>/overrides.json` — a file the producer never writes. Re-running `produce` re-plans the video and **keeps your edits**.

## The commands

| command | what it does |
| --- | --- |
| `produce <input>` | the full pipeline: transcribe → analyze → cut → captions → scenes → render (+ cover) |
| `edit [workdir]` | direct-manipulation editor; bare `edit` opens a project picker |
| `transcribe <input>` | stops after the transcript and cut report — no render |
| `studio <render-props.json>` | opens Remotion Studio on a produced composition, for visual debugging |

### `produce` flags worth knowing

| flag | |
| --- | --- |
| `--produce` | run the LLM producer brain (title cards, stat cards, diagrams, cover text). Without it you get cut + captions only |
| `--intent "<text>"` | what the video should be — steers the producer's editorial choices |
| `--speaker "<who>"` | who is on camera, e.g. `"Ahsan, host of Code with Ahsan"`. Helps the repair pass recognise a mangled name and stops grounding flagging it |
| `--cleanup <level>` | `exact` \| `light` \| `standard` \| `aggressive`. How hard to cut silence and fillers |
| `--llm <provider>` | `claude` \| `claude-cli` \| `gemini` \| `mock` |
| `--llm-model <id>` / `--llm-fast-model <id>` | override the editorial / mechanical model. `--llm-fast-model same` disables tiering |
| `--no-repair` | skip the ASR mishearing repair; captions then show the raw transcription |
| `--whisper-model <name>` | transcription model for this run |
| `--scenes <path>` | hand-authored scenes JSON — no LLM in the loop |
| `--force-component <id>` | debug: render every graphic with one component (e.g. `FlowDiagram`) to exercise it on real copy |
| `--source-is-edited` | the source is already an edited reel with burned-in text — keep ossclip's graphics off it |
| `--no-cover` / `--cover <path>` | skip, or redirect, the cover image written beside the video |
| `--no-render` | stop after writing the props |
| `--workdir <dir>` | where the cache lives |

### Which model runs

Without `--llm`, ossclip picks in this order: **`GEMINI_API_KEY` → `ANTHROPIC_API_KEY` → the Claude Code CLI**. The CLI path uses your logged-in Pro/Max subscription, so it costs plan usage rather than API credits — the console tells you which path it took.

Calls are **tiered**: the beat sheet (the editorial judgement the video rests on) goes to the main model; mechanical calls (transcript repair aside, which is also editorial) go to a smaller sibling. Override with `--llm-fast-model`.

### What each run costs

```
▸ llm: 3 calls · 130,749 in / 8,321 out tokens · ~$0.72 of API-rate work, covered by the subscription · 92s
```

A per-call breakdown lands in `report.txt`, the raw records in `usage.json`. Two rules the output holds to: token counts a provider actually reports are exact and anything derived from text length is marked `(est)`; a model with no known price is reported with its tokens and **no cost guess**. On the subscription path the figure is what the same tokens would cost at API rates — nothing is charged, but you can still see how much work a run was.

Prices are a built-in per-family assumption. Override for your account in `~/.ossclip/config.json`:

```json
{ "pricing": { "claude-opus-5": { "inputPerMTok": 15, "outputPerMTok": 75 } } }
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

Env vars override the file: `OSSCLIP_FFMPEG`, `OSSCLIP_FFPROBE`, `OSSCLIP_WHISPER`, `OSSCLIP_MODEL_DIR`, `OSSCLIP_MODEL`, `OSSCLIP_FAST_MODEL`, `OSSCLIP_SPEAKER`, `OSSCLIP_BROWSER`.

## What it does to your footage

- **Cuts** dead air and filler words, with every cut justified in `report.txt`.
- **Repairs** ASR mishearings before anything is drawn, so a graphic and the caption under it can never spell the same word two different ways. Strictly near-homophones only — it will refuse a rewrite and say so.
- **Frames** on the measured face rather than a constant, including sources that are letterboxed or that change framing mid-take (those get normalized to one field of view before anything else runs).
- **Plans** scenes from the transcript, then checks its own choices: a layout that would crop the speaker's head is rewritten, and copy that isn't grounded in what was actually said is flagged.
- **Captions** every word, routed around any text already burned into the source.
- **Covers** — writes `<out>.cover.jpg` sized for the Instagram profile grid's centre-square crop.

## Repo layout

```
packages/core      framework-free pipeline: schema, ingest, transcribe, analyze, cutlist,
                   timemap, captions, framing/normalization, the LLM producer
packages/scenes    React components shared by preview & render (EdlVideo, CaptionTrack, SceneLayer)
packages/renderer  Remotion composition + programmatic render entry
apps/cli           the ossclip CLI
apps/editor        direct-manipulation editing page over a produced workdir (`ossclip edit`)
```

## Development

```sh
pnpm test          # vitest
pnpm typecheck
pnpm --filter @ossclip/editor build
node scripts/make-fixture.mjs    # regenerates the deterministic test fixtures
```

## License

MIT — see [LICENSE](./LICENSE).
