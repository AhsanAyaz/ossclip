# Contributing to ossclip

Thanks for looking. This is a small, opinionated project — the fastest way to get a change merged is to know how it's built before you write one.

## Get it running

```sh
pnpm install
pnpm build            # builds the editor page (`ossclip edit` serves it)
pnpm ossclip doctor   # checks ffmpeg, whisper-cli, the model, a provider key
```

`doctor` is the fast answer to "why did that fail" — it prints the exact fix per missing prerequisite. You need `ffmpeg`/`ffprobe`, [whisper.cpp](https://github.com/ggml-org/whisper.cpp) with a ggml model, and Node ≥ 22. `pnpm ossclip setup` provisions the missing pieces into `~/.ossclip` if you'd rather not install them yourself. An LLM key is needed only for `--produce`; the cut-and-caption path is fully offline.

Run the pipeline on your own footage:

```sh
pnpm ossclip produce input.mp4 --produce -o out.mp4
pnpm ossclip edit "<work directory>"
```

## Verify before you push

```sh
pnpm typecheck
pnpm test                                          # ~600 unit tests
pnpm --filter @ossclip/editor exec playwright test # ~45 e2e (needs `pnpm build` first)
```

CI runs all three on every PR. The e2e suite drives a real edit server against a fixture workdir; it is the only thing that catches a broken gesture, so please run it if you touched `apps/editor`.

## How this repo works

**Findings-first.** Every fix traces to a numbered entry in [`docs/PHASE1-FINDINGS.md`](./docs/PHASE1-FINDINGS.md) — a defect seen in a real render, what caused it, and what changed. That log is the project's memory: it is why old decisions don't get silently re-litigated. If you fix something real, add an entry. If you're fixing something already logged, say which §.

**The layers.**

```
packages/core      pipeline: transcribe, analyze, cut, captions, framing, the LLM producer
packages/scenes    scene components + stage geometry (shared by preview and render)
packages/renderer  Remotion composition and render entry
apps/cli           the CLI (published as `ossclip`)
apps/editor        the direct-manipulation editor (`ossclip edit`)
```

**Two invariants worth knowing before you touch the editor.** Every user edit lands in `overrides.json`, a file the producer never writes — that's what lets a re-run re-plan the video and keep your edits. And every visible element carries a `data-edit-id`; the drag/resize/retype machinery is generic over that attribute, so a new component gets transforms for free by tagging its elements.

## Opening a PR

- One concern per PR. A bugfix and a refactor in one diff take three times as long to review.
- Tests for behaviour, not for coverage. A test that would have caught the bug is worth more than five that restate the implementation.
- Match the surrounding code — comment density included. Comments here explain *why*, especially where a simpler-looking approach was tried and failed.
- Say what you verified and on what footage. "Works on my 40s portrait take, e2e green" is a real report.

## Scope

Things deliberately **not** in scope, so you don't build one and find out at review: a hosted version, a web uploader, a GUI installer, stock B-roll, TTS, speaker diarisation. (`ossclip setup` is not the rejected GUI installer — it's CLI provisioning of the same toolchain doctor checks, and it deliberately stays that.) Long-form highlight selection is a real gap, not a rejected one — see the README's scope note if you want to take it on, and open an issue first so the design gets discussed before the code. The roadmap — what's next, what needs a design issue first, what's rejected — lives in [`ROADMAP.md`](./ROADMAP.md).

## Where docs live

Four places, and the distinction is worth knowing before you add a file:

| directory | committed? | what belongs there |
| --- | --- | --- |
| `docs/site/` | yes | the published single-page reference + the shipped images |
| `docs/superpowers/plans/`, `docs/PHASE1-FINDINGS.md` | yes | decisions and the defect log — the project's memory |
| `docs/assets/` | **no** | screen-recording masters only (multi-MB, re-recorded whenever the UI moves) |
| `docs/local/` | **no** | working drafts: launch copy, post scripts, evaluation notes, anything half-thought |

`docs/local/` is ignored as a whole directory, so a new draft needs no new
`.gitignore` rule. Nothing in it is published, reviewed, or a decision — if a
draft becomes one, it moves to a plan doc or the findings log and gets
committed like anything else.

## Docs assets

The shipped images live in `docs/site/assets/` — one copy, served as the Pages
site and linked from the README with a `./docs/site/assets/…` path. Screen
recordings are re-made whenever the UI moves, so the multi-MB masters stay OUT
of git (`docs/assets/` is ignored); only the derived, size-budgeted asset is
committed. To regenerate the editor GIF from a fresh recording:

```sh
ffmpeg -i docs/assets/editor-preview.mp4 \
  -vf "fps=12,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=192[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  docs/site/assets/editor-preview.gif
```

Keep it under ~8MB: GitHub renders a GIF inline on the README, but an `<video>`
tag pointing at a repo-relative MP4 does not render at all.

The before/after demo is composed rather than screen-recorded, because this
machine's ffmpeg has no `drawtext` (no freetype) and because a capture shows the
desktop. `docs/assets/demo-layers.html` renders two layers with headless Chrome —
an opaque background carrying the labels and panel borders, and a transparent
mask whose rounded-corner wedges sit on top — and ffmpeg overlays the two
portrait clips between them at fixed offsets. The geometry lives in both the
HTML and the overlay offsets, so changing one means changing the other.

Two deliverables come out of it: `demo-before-after.mp4` (1520x1460, used by the
site via `<video autoplay muted loop>`) and `demo-before-after.gif` (700x672,
10fps, 80 colours, ~6MB, used by the README). The GIF is built from a **shorter**
master — two 4s shots rather than two 6s ones — because side-by-side portrait
video is expensive in GIF: the full-length 12s version lands at 17MB however it
is tuned, and duration is the only lever that moves it far enough.

## Bugs

The useful bug report for a video tool has: the command you ran, the relevant part of `report.txt`, the source's shape (portrait/landscape, length), and — if it's a visual defect — a frame. `ossclip doctor` output helps for anything that smells environmental.

## Licence

Contributions are MIT, matching the project. Note that rendering depends on Remotion, which carries [its own two-tier licence](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md) — see the README's Licensing section.
