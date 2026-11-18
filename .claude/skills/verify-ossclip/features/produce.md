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

## Driving the pattern scenes and `--look explainer` (explainer phase 2, FINDINGS §161)

`fixtures/fixture.patterns.script.md` splits the same 22 words into six short spoken lines, each under a
hinted cue: `[CardRow]`, `[CtaCard]`, `[BugCard]`, `[PhoneDemo]`, `[TerminalMock]`, `[StatCard]`. No clip, so
nothing to make first:

```sh
WD=$(mktemp -d)
pnpm ossclip produce fixtures/fixture.mp4 \
  --transcript fixtures/fixture.transcript.json \
  --script fixtures/fixture.patterns.script.md --llm mock --look explainer \
  --workdir "$WD" --no-render --no-youtube --no-open-editor
```

**Proves it works:** stdout opens with `▸ look: explainer` and stages the four bundled font files
(`▸ look: bundled fonts staged as fonts/Inter-ExtraBold.woff2, …`); the report prints
`placed 6 of 6 · skipped 0 · reported 0`; `script-report.json` lists six `placed` outcomes on lines 12, 15, 18,
21, 24, 27 with components `CardRow`, `CtaCard`, `BugCard`, `PhoneDemo`, `TerminalMock`, `StatCard` in that
order; `production.json` parses with `ProductionSchema` and every scene's props parse with its registry schema;
`render-props.json` carries `theme.motion: "explainer"`, `theme.fonts: "bundled"`, `theme.bg: "#3A4A5C"`, and
the same in `baseTheme`. The cut is the fixture baseline (4 cuts, 6.32s removed, output 11.58s): a look and a
script change what is drawn, never the cut.

Expected noise, not a failure: grounding warnings for `CtaCard`, `BugCard` and `StatCard`. The mock answers each
props call with fixed canned copy ("PROMPT", "Captions miss words", "FILLERS REMOVED") that the fixture never
says.

With `-o "$WD/out.mp4" --no-cover` in place of `--no-render`, the same run renders (2026-11-16: about 70 s
total, 57 s of it the Remotion render; 1080x1920, 347 video frames = 11.57 s).

## Driving the backdrops in 16:9 (FINDINGS §163)

The same fixture in 16:9, three scenes set to a backdrop the way the editor saves them, then replayed the way
the editor's Render replays (`--scenes` pinned, `--script` dropped, `--no-render`). `ossclip kit`'s refresh is
that replay, so it is the simplest faithful driver; `--clips-only` skips the timeline:

```sh
S=$(mktemp -d)
pnpm ossclip produce fixtures/fixture.mp4 \
  --transcript fixtures/fixture.transcript.json \
  --script fixtures/fixture.patterns.script.md --llm mock --look explainer --aspect 16:9 \
  --workdir "$S/wd" --no-render --no-youtube --no-open-editor
W=$(ls -d "$S"/wd/fixture-*-16x9)
echo '{"scenes":{"scene-0":{"layout":"graphic-only"},"scene-1":{"layout":"pip-bubble"},"scene-4":{"layout":"graphic-only"}}}' \
  > "$W/overrides.json"
pnpm ossclip kit "$W" --clips-only --out "$S/kit"
```

**Proves it works** (2026-11-18):

- Before the overrides, `render-props.json`'s `sceneCues` are `scene-0` … `scene-5` (`CardRow`, `CtaCard`,
  `BugCard`, `PhoneDemo`, `TerminalMock`, `StatCard`), all `full-bleed`; the two slot components (`scene-4`,
  `scene-5`) carry `graphicRect {x:0.14,y:0.16,w:0.72,h:0.68}` (`SCRIPT_LANDSCAPE_RECT`) and the four full-frame
  cards carry none. `face` is `null` (the fixture's three spans measure as `screen`), so the picture's head zoom
  and the editor's "Below the face" are not exercised here.
- The kit prints `▸ the project changed since it was last produced; refreshing…` first. It then renders the six
  clips too (about 60 s); the checks on them are in [kit.md](kit.md), "backdrops".
- `command.json` now ends `--scenes <W>/scenes-reviewed.json --no-open-editor` and has no `--script`;
  `production.json` still carries its `script` record, so the next Render is a script project too.
- The new `render-props.json`: `scene-0` `graphic-only`, `scene-1` `pip-bubble`, `scene-4` `graphic-only` with
  its `graphicRect` still `{x:0.14,y:0.16,w:0.72,h:0.68}` (the box is kept between backdrop layouts,
  `keepsBoxAcross`). Each of the three differs from before in `layout` only; `scene-2`, `scene-3` and `scene-5` are
  JSON-identical to before; `spans` unchanged (3), output 11.58 s. `baseSceneCues` and `production.json`'s scenes
  stay `full-bleed`: the backdrop lives in `overrides.json`, as the editor writes it.

An override was already applied after both landscape remaps, so this recipe proves the whole path (editor save →
Render replay → kit), not the remap exemption alone. The case the exemption exists for, a stored scene of
`graphic-only` or `pip-bubble` in `scenes-reviewed.json` replayed without `--script`, is pinned by
`apps/cli/test/script-produce.test.ts` ("a stored backdrop survives the editor's Render").

## Gotchas

- Proven 2026-08-30 for the offline path incl. `--color-grade` (both lanes):
  evidence in `docs/verification/2026-08-30-color-grade/`. The `--produce` LLM pass is still unproven.
- Real rendering is slow and CPU-heavy. Do not put it in a tight loop.
- Skip `--produce` unless the change is about the LLM planner: it needs a provider and costs money. `--scenes` is
  the deterministic substitute.
- `--no-render` makes this command equivalent to `transcribe`; if that is all you need, drive `transcribe`.
