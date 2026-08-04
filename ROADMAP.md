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

- **Make source-text routing video-aware** (R27 §120). Routing dodges burned-in
  text without ever reading the video slot, so a moved graphic can land on the
  speaker in the layouts that author the two apart. Pinned as a failing test
  (`source-fit.test.ts`, `it.fails`); the scan is behind `--source-is-edited`
  now, so it can no longer fire on a raw take.
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
- Watch the graphics count on real footage. The scene-count work shipped
  (**R25 §118**: an explicit target in the prompt, structure read from the
  take's own enumeration, under-delivery reported in `report.txt`) — what
  remains is evidence: a render that under-delivers *despite* the stated
  target is the trigger for the validate-and-retry pass the plan deferred.
  See [`docs/superpowers/plans/2026-08-05-scene-count-from-content-structure.md`](./docs/superpowers/plans/2026-08-05-scene-count-from-content-structure.md).
- The exit's Backdrop Root over the scrim: `ExitFade` at `opacity < 1` empties
  the scrim's backdrop-filter, so the frost snaps to flat tint on the exit's
  first frame — the mirror of the entrance bug fixed in the element-motion
  round. ~5 lines: `Scrim` computes enter × exit opacity itself and
  `ExitFade` wraps only the content.
- Content springs vs the exit: stagger delays are constants, so a five-item
  `BulletList` at the 1.2s floor loses its last bullet (peaks at 41% opacity
  mid-exit). Deriving spring delays from cue duration is the fix, and it is
  a design round, not a patch.

## Later — needs a design issue first

The authoring track is captured in one document, ordered — the ordering is
load-bearing, and several items are cheap only in sequence. Its prerequisite
(the scene-count target) has shipped, which makes the document's own first
question live: re-ask on real footage whether authoring is still wanted before
building it:
[`docs/superpowers/plans/2026-08-06-authoring-roadmap.md`](./docs/superpowers/plans/2026-08-06-authoring-roadmap.md).
That document carries no § numbers on purpose — it reserved them twice and had
to be renumbered twice. A finding takes the next free number when it lands.

- **Multi-source input** — several raw takes in, one short out. Joined
  before anything measures them, so the time map and its property-tested
  invariants never learn there was more than one file.
- **Semantic retake removal** — the *spoken-marker* half shipped in R27 §122
  (`--blooper-marker`), deterministically. What remains is detecting a flub the
  speaker did NOT mark, which is inherently semantic and would end the
  guarantee that the cut is reproducible without an LLM.
- **User cuts** — remove a bad bit after generation. Server-side first,
  editor second. `splits` and pinned scene timing are keyed to absolute output
  seconds and would silently drift after a re-cut.
- **Agent-authored scenes** — as a `Scene[]` file the existing
  `--scenes` flag consumes, NOT an endpoint on the edit server, which is
  replay-only by deliberate design.
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

**Freeform TSX** stays here too, and now with reasons written down:
`docs/PHASE1.md` already resisted it by that exact phrase, and seven systems
are keyed to the closed component enum — four of which fail *silently* on an
unknown component, including the grounding check that stops invented copy
reaching a frame. The registry grows instead, when a real render demands it,
the way `BulletList` did.
