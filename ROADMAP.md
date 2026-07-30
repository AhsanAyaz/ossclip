# Roadmap

What's next for ossclip, distilled from the launch runbook and the open items
in [`docs/PHASE1-FINDINGS.md`](./docs/PHASE1-FINDINGS.md). Ordering within a
band is not a promise; real-footage reports move things up. If you want to
take something on, open an issue first so the design gets discussed before
the code (see [CONTRIBUTING](./CONTRIBUTING.md)).

## Now

- **Kill the install cliff.** `ossclip setup` — one command that provisions
  ffmpeg, whisper.cpp, and the model into `~/.ossclip` on macOS, Linux, and
  Windows — plus Windows fixes across the CLI and docs that treat a
  first-time user on any OS as the default reader. (This round.)
- **Watch the npm install path.** The first strangers' `ossclip doctor` /
  `ossclip setup` output is the install telemetry §90 was built for — issue
  templates ask for it, and install friction reported in issues gets
  priority.

## Next

Concrete, scoped, mostly logged as findings already:

- `--safe-area <preset>` CLI flag — per-platform safe-area presets instead of
  the built-in default.
- Caption band derived from live occupancy rather than per-layout hand-tuned
  anchors.
- `--cover-in-video` — the cover frame as the short's first frames (real
  A/V-sync work, deliberately not rushed; see §93 for the
  cover-frame-outside-clip-window niggle).
- "Eyes open" in cover frame selection.
- `startSec`/`endSec` debug mirror on `production.json`.
- Real-footage validation of `--clip` across more long-form sources (§89a) —
  the newest pipeline stage, the least mileage.

## Later — needs a design issue first

- **Multi-clip**: `--clip` producing N outputs from one take. Its own round
  by decision — the selection, dedup, and naming semantics all need design.
- **Per-frame face tracking** (the "Phase 4" deferral) — today framing is
  per-window, not per-frame.
- **Long-form highlight selection** beyond one window — a real gap, not a
  rejected one.
- **whisper.cpp darwin prebuilts** hosted as ossclip release assets, so macOS
  setup stops needing Homebrew. Recurring rebuild duty + unsigned-binary
  posture — needs a deliberate yes.

## Not planned

The rejected list, so nobody builds one and finds out at review: a hosted
version, a web uploader, a GUI installer, stock B-roll, TTS, speaker
diarisation. A Dockerfile stays out until someone actually asks for it in an
issue — for the target user, Docker Desktop is a taller cliff than
`ossclip setup`.
