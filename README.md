# ossclip

**Open, local-first AI video producer.** Raw talking-head footage in → polished, virality-optimized short video out. Filler words, silences and rough cuts removed; word-timed captions, punch-in jump cuts — and (soon) title cards, motion graphics, B-roll and SFX planned by an LLM producer against a hand-built scene library.

Your footage never leaves your machine: transcription runs locally (whisper.cpp), rendering runs locally (Remotion), and the only network calls are LLM planning with your own Claude or Gemini API key.

> Status: **Phase 0 — Prove the Cut.** See [`BRAINSTORM.md`](./BRAINSTORM.md) for the full design and [`docs/PHASE0.md`](./docs/PHASE0.md) for the current implementation plan.

## Quick start (Phase 0)

Requirements: Node ≥ 22, pnpm, `ffmpeg`/`ffprobe` on PATH, [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`whisper-cli`) + a ggml model.

```sh
pnpm install

# Full pipeline: transcribe → analyze → cut → captions → render 9:16
pnpm --filter @ossclip/cli exec ossclip produce input.mp4 --cleanup standard -o out.mp4

# Inspect what would be cut and why, without rendering
pnpm --filter @ossclip/cli exec ossclip produce input.mp4 --inspect --no-render
```

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
