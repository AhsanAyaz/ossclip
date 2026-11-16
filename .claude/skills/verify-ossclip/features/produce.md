# Render a finished video

`ossclip produce` is `transcribe` plus a render: burned-in captions, graphics, framing, watermark, and optionally
an LLM-planned graphics pass and a cover image.

## Sub-features

- Full ffmpeg render to an output mp4 (`-o`)
- `--no-render` stops after `production.json` / `render-props.json` (this is what `transcribe` wraps)
- `--produce` runs the LLM producer brain for title cards and graphics; `--scenes` supplies them by hand instead
- Cover image beside the video (`--no-cover` / `--cover <path>`)
- Watermark from config, `--no-watermark` overrides
- Color grade: `--color-grade <preset|file.cube>` / `--no-color-grade`; presets ride render props
  (SVG filter in the composition), a `.cube` from `~/.ossclip/luts` bakes into a hash-suffixed mezzanine
- YouTube pack (`--no-youtube` opts out)
- Portrait / long-form windowing, zoom and punch planning

## How to get to it (user POV)

```sh
ossclip produce input.mp4 -o out.mp4              # cut + captions, no LLM, no network
ossclip produce input.mp4 --produce -o out.mp4    # + LLM-planned graphics and cover
```

## Driving it with the CLI

```sh
WD=$(mktemp -d)
pnpm ossclip produce fixtures/fixture.mp4 \
  --transcript fixtures/fixture.transcript.json \
  --workdir "$WD" -o "$WD/out.mp4" \
  --no-cover --no-youtube
```

**Proves it works:** `out.mp4` exists, `ffprobe` reports a duration matching `outputDurationSec` in
`render-props.json` (the fixture baseline is 11.58s), and the frame dimensions are 1080x1920.

## Driving `--script` (explainer phase 1, FINDINGS §158)

`fixtures/fixture.script.md` is the fixture's script: three cues whose spoken lines are the fixture's own
words — an unhinted cue, a `clip:` cue and a `[StatCard]` hint. Make its clip first (the command is in the
file), then plan it with the offline mock provider:

```sh
WD=$(mktemp -d)
mkdir -p fixtures/clips
ffmpeg -f lavfi -i "color=c=red@0.5:s=320x240:d=1.5:r=30,format=yuva420p" \
  -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -y fixtures/clips/fixture-clip.webm
pnpm ossclip produce fixtures/fixture.mp4 \
  --transcript fixtures/fixture.transcript.json \
  --script fixtures/fixture.script.md --llm mock \
  --workdir "$WD" --no-render --no-youtube --no-open-editor
```

**Proves it works:** the report prints `placed 3 of 3 · skipped 0 · reported 0`; `script-report.json` in the
workdir lists three `placed` outcomes (lines 15, 18, 23); `production.json` has three scenes (`TitleCard`,
`StatCard`, `ClipScene`) and a `script` record with the text, its `sourcePath` and the imported clip; the clip's
`clips/<hash>.webm` in the workdir is byte-identical to the source WebM (copied, not re-encoded). No
`beatsheet-*.json` is written. The same flow runs as a test: `apps/cli/test/script-produce.test.ts`.

## Gotchas

- Proven 2026-08-30 for the offline path incl. `--color-grade` (both lanes):
  evidence in `docs/verification/2026-08-30-color-grade/`. The `--produce` LLM pass is still unproven.
- Real rendering is slow and CPU-heavy. Do not put it in a tight loop.
- Skip `--produce` unless the change is about the LLM planner: it needs a provider and costs money. `--scenes` is
  the deterministic substitute.
- `--no-render` makes this command equivalent to `transcribe`; if that is all you need, drive `transcribe`.
