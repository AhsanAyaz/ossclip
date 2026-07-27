# ossclip

**Open, local-first AI video producer.** Raw talking-head footage in → polished, virality-optimized short video out. Filler words, silences and rough cuts removed; word-timed captions, punch-in jump cuts — and (soon) title cards, motion graphics, B-roll and SFX planned by an LLM producer against a hand-built scene library.

Your footage never leaves your machine: transcription runs locally (whisper.cpp), rendering runs locally (Remotion), and the only network calls are LLM planning with your own Claude or Gemini API key.

> Status: **Phase 0 — Prove the Cut** (cut, captions, punch-in, render). Scene graphics, title cards and the LLM producer are **not built yet** — that is [`docs/PHASE1.md`](./docs/PHASE1.md), the next plan to pick up. See [`BRAINSTORM.md`](./BRAINSTORM.md) for the full design and [`docs/PHASE0.md`](./docs/PHASE0.md) for what Phase 0 covers.

## Quick start (Phase 0)

Requirements: Node ≥ 22, pnpm, `ffmpeg`/`ffprobe` on PATH, [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`whisper-cli`) + a ggml model.

The default transcription model is **`small.en`**. A mistranscribed word ends up
in your captions and on-screen labels, so accuracy matters more here than speed
— though no model is reliable enough on its own, which is why `--produce` also
runs a repair pass over the transcript before anything is drawn (disable with
`--no-repair`). Compare models on your own footage with `--whisper-model
base.en|small.en|medium.en`, or set `OSSCLIP_MODEL` (or `model` in
`~/.ossclip/config.json`) to change the default:

```sh
curl -L -o ~/.ossclip/models/ggml-small.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
```

```sh
pnpm install

# Full pipeline: transcribe → analyze → cut → captions → render 9:16
pnpm ossclip produce input.mp4 --cleanup standard -o out.mp4

# Inspect what would be cut and why, without rendering
pnpm ossclip produce input.mp4 --no-render

# Silence detection adapts to the take's own levels; override it if needed
pnpm ossclip produce input.mp4 --noise-db -30
```

Rendering goes through a dense-keyframe mezzanine built in the work directory.
`--no-mezzanine` renders straight from the source, which also makes the
source's own folder the render server's public directory — avoid it for files
sitting in a folder you would not want served.

Configuration (binary/model paths): `~/.ossclip/config.json` — see `apps/cli`.

## Repo layout

```
packages/core      framework-free pipeline: schema, ingest, transcribe, analyze, cutlist, timemap, captions
packages/scenes    React components shared by preview & render (EdlVideo, CaptionTrack)
packages/renderer  Remotion composition + programmatic render entry
apps/cli           the ossclip CLI
apps/studio        (dormant) agent-native studio app — Phase 1
```

## License

MIT
