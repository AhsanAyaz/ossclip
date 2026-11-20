# Export scene clips and a Resolve timeline

`ossclip kit` takes a produced project and writes a folder for DaVinci Resolve: one ProRes 4444 clip with alpha
per visible scene (transparent around the graphic, or on the theme background in `graphic-only` and `pip-bubble`), plus an FCPXML 1.10 timeline with the cut source on track 1 and the clips on lane 1 above it
(explainer phase 3, FINDINGS §162).

## Sub-features

- One `clips/<sceneId>-<component>.mov` per graphic scene; plain filler cues are never clips
- `timeline.fcpxml`: one spine clip per kept span pointing at the source, each scene clip attached to the span it
  starts in (`--clips-only` writes no timeline)
- Reuse: a second run re-renders only scenes whose cue, the look or the frame size changed (`--force` renders all);
  a clip whose file was deleted renders again
- Refresh: when `overrides.json` is newer than `render-props.json`, the recorded produce is replayed once with
  `--no-render --no-open-editor` and the plan pinned with `--scenes` (`--no-refresh` skips it)
- A hidden scene's clip is removed from `clips/` and is absent from the timeline
- `clip:` scenes point at the author's original file (skipped with a note when it moved)
- WSL paths: `/mnt/c/...` becomes `file:///C:/...`; a Linux-side path becomes a `wsl.localhost` URL plus a warning
- `kit-report.json`: per clip the status (`rendered | reused | skipped`), reuse key and notes

## How to get to it (user POV)

```sh
ossclip kit <workdir>                        # beside the source: <video name>-kit/
ossclip kit <workdir> --out /mnt/c/Users/me/Videos/kit
```

Then in Resolve: File → Import → Timeline…, pick `timeline.fcpxml`.

## Driving it with the CLI

Produce the pattern-scene fixture in 16:9 without a render (the recipe in [produce.md](produce.md), "pattern
scenes", plus `--aspect 16:9`), then export it:

```sh
S=$(mktemp -d)
pnpm ossclip produce fixtures/fixture.mp4 \
  --transcript fixtures/fixture.transcript.json \
  --script fixtures/fixture.patterns.script.md --llm mock --look explainer --aspect 16:9 \
  --workdir "$S/wd" --no-render --no-youtube --no-open-editor
W=$(ls -d "$S"/wd/fixture-*-16x9)
pnpm ossclip kit "$W" --out "$S/kit"
```

**Proves it works** (2026-11-17, nothing else running):

- First run: about 35 s total, about 5 s per clip after a one-off bundle. Prints `▸ [1/6] scene-0-CardRow.mov  1.7s`,
  `25% / 50% / 75%`, `✓ rendered in 5.1s` per clip, then `✓ kit: 6 clips — 6 rendered, 0 reused, 0 skipped`, the
  folder, and `In Resolve: File → Import → Timeline…, then pick timeline.fcpxml`. One `⚠ 7 files are inside the Linux filesystem (first: …/clips/scene-0-CardRow.mov); Resolve may ask you to
  relink them — every path is in kit-report.json` line is expected under WSL with a scratch dir in `/tmp` (six clips and the source).
- `clips/` holds six files, `scene-0-CardRow`, `scene-1-CtaCard`, `scene-2-BugCard`, `scene-3-PhoneDemo`,
  `scene-4-TerminalMock`, `scene-5-StatCard` (10 to 20 MB each), beside `kit-report.json` and `timeline.fcpxml`.
- Each clip: `ffprobe -v error -select_streams v:0 -count_frames -show_entries
  stream=codec_name,profile,pix_fmt,r_frame_rate,nb_read_frames -of default=nw=1 <clip>` gives `prores`, `4444`,
  `yuva444p12le`, `30/1` and the report's `lengthSec × 30` frames (52, 52, 52, 52, 53, 62); one stream, no audio.
- Alpha: `ffmpeg -v error -ss 1 -i <clip> -frames:v 1 -vf "format=rgba,crop=1:1:5:5" -f rawvideo - | xxd -p` ends in
  `00` for every clip (all six are `full-bleed` here; a `graphic-only` or `pip-bubble` clip is opaque there, see
  "Backdrops" below); at `crop=1:1:960:540` CardRow, CtaCard and StatCard end in `ff` (BugCard and PhoneDemo have
  nothing drawn at the exact centre).
- `timeline.fcpxml` parses (jsdom, `contentType: "text/xml"`); `spine > asset-clip` count equals
  `render-props.json`'s `spans.length` (3); the spine offsets are contiguous and their durations sum to the
  sequence `duration` (`347/30s`, the fixture's 11.57 s); each lane clip's asset `src`, mapped back to a path
  (`file://wsl.localhost/<distro>` → `file://`, then `fileURLToPath`), exists. Formats: `FFVideoFormat1080p30` for
  the sequence, and the portrait source's 1080x1920 format carries no name.
- Second run, unchanged: about 1 s, every line `… reused`, `✓ kit: 6 clips — 0 rendered, 6 reused, 0 skipped`, clip
  mtimes untouched, no bundle.
- Hide a scene: `echo '{"scenes":{"scene-2":{"hidden":true}}}' > "$W/overrides.json"`, run again. Prints
  `▸ the project changed since it was last produced; refreshing…` (one replay, about 2 s, no editor process left
  behind), five `reused` lines, `▸ removed clips/scene-2-BugCard.mov — no scene in the project names it any more`,
  `✓ kit: 5 clips — 0 rendered, 5 reused, 0 skipped`. `render-props.json` is newer than `overrides.json` again, the
  hidden scene's slot is a plain `take-1` cue, the timeline has five lane clips, and the next run does not refresh.
  `command.json` now records `--scenes <workdir>/scenes-reviewed.json --no-open-editor`, the same shape an editor
  Render leaves.

The same flows run with fake seams in `apps/cli/test/kit-command.test.ts`.

### Backdrops: background clips and the speaker-picture note (FINDINGS §163)

Start from [produce.md](produce.md), "Driving the backdrops in 16:9": `scene-0` (`CardRow`) and `scene-4`
(`TerminalMock`) in `graphic-only`, `scene-1` (`CtaCard`) in `pip-bubble`, already refreshed and rendered by its
`kit --clips-only`. Then the full export:

```sh
pnpm ossclip kit "$W" --out "$S/kit"
px() { ffmpeg -v error -ss "$2" -i "$1" -frames:v 1 -vf "format=rgba,crop=1:1:$3:$4" -f rawvideo - | xxd -p; }
for c in "$S"/kit/clips/*.mov; do
  echo "$c $(px "$c" 0.87 0 0) $(px "$c" 0.87 1919 0) $(px "$c" 0.87 0 1079) $(px "$c" 0.87 1919 1079) t0 $(px "$c" 0 0 0) 0.2s $(px "$c" 0.2 0 0)"
done
```

**Proves it works** (2026-11-18):

- About 3 s: six `… reused` lines (the `--clips-only` run rendered them, and a timeline-only run changes no
  key), the Linux-filesystem warning, `✓ kit: 6 clips — 0 rendered, 6 reused, 0 skipped`.
- `kit-report.json`: `scene-1` alone has a note, `speaker picture not included: scale and move the footage on
  track 1 for this stretch (picture at x 1541, y 713, 302 px)`, the 16:9 picture (`pipRectFor`: 302.4 px, 4% of
  the width from the right, 6% of the height from the bottom) in output pixels. The other five have none.
- Corners at 0.87 s (mid-clip; each clip is 1.73 to 2.07 s): all four are `3a4a5cff`, the explainer look's
  `#3A4A5C` and opaque, in `scene-0`, `scene-1` and `scene-4`; all four are `00000000` in the three `full-bleed`
  clips. The background fades in over the stage's 0.35 s: `00000000` at frame 0 and `3a4a5c9c` at 0.2 s in the
  three background clips.
- In `scene-1` no pixel right of the picture's strip (`crop=436:1080:1484:0`, x ≥ picture.x − 0.03 of the width)
  differs from `3a4a5cff`: no card and no footage there. A full frame of `scene-0` has no pixel with alpha below
  `ff`.
- Every clip is still `prores`, `4444`, `yuva444p12le` (52, 52, 52, 52, 53, 62 frames). `timeline.fcpxml` parses;
  3 spine clips for 3 spans, 6 lane clips, sequence `347/30s`, and every asset `src` (the source and the six
  clips) exists.

## Gotchas

- Rendering is the only slow step and is CPU and memory heavy (two browser tabs per clip). Do not run it beside
  `pnpm test` on a 7 GB machine.
- Without `--out`, the kit lands beside the source; for `fixtures/fixture.mp4` that is `fixtures/fixture-kit/` inside
  the repo. Always pass `--out` when driving the fixture.
- Ctrl-C during a clip render (driven 2026-11-17 with one `kill -INT` at 50% of the second clip) prints
  `▸ cancelled — the clip in progress was discarded; clips already rendered are kept`, exits 130, leaves no
  `.partial.mov` and no `chrome-headless-shell`, and leaves `kit-report.json` as the last completed run wrote it.
  Remotion's own SIGINT listener exits the process at once, so everything the kit does on a cancel happens inside
  its listener. To drive it, signal the node process itself, not `pnpm`/`tsx` (a wrapper relays a second signal):
  `node --require ./node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/preflight.cjs --import
  file://$PWD/node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/loader.mjs apps/cli/src/index.ts kit …`.
- The Resolve import itself is the author's check (design, phase 3 acceptance); a machine can only check the XML.
