# Phase 0 — Prove the Cut: Implementation Plan

*Working name: `ossclip`. Companion to `BRAINSTORM.md` (§8, Phase 0). This phase contains **zero LLM surface** — it's pure engineering, runs fully offline, and produces something immediately useful on real footage.*

## Goal

A CLI that turns a raw portrait talking-head take into a cut, captioned, punch-in'd 9:16 video:

```
ossclip produce input.mp4 --cleanup standard -o out.mp4
```

## Acceptance criteria

1. Output is 1080×1920 H.264/AAC with: fillers and silences removed per cleanup level, word-timed captions, punch-in alternation concealing jump cuts.
2. No audible clicks/pops at any cut (headphone test); caption sync drift < 50 ms at the end of a 90 s clip.
3. `--inspect` writes the full Production doc (`production.json`) plus a human-readable cut report (every removal, its reason, and timestamps) — the doc is the source of truth from day one.
4. `ossclip studio` opens Remotion Studio on the same composition for visual debugging.
5. A 60–90 s clip processes in ≤ ~2× real-time on an M-series Mac (whisper `small`-class model).
6. `--cleanup exact` bypasses all cutting and still renders (captions only) — the A/B baseline.

## Repo scaffold

Scaffold from the **agent-native starter** at the root (per BRAINSTORM §5.4/§7-6); `apps/studio` stays dormant this phase. pnpm workspaces, Node 22+, TypeScript strict everywhere.

```
packages/core        # framework-free TS — no React, no agent-native imports
  schema.ts          # zod Production doc (BRAINSTORM §4.1)
  ingest.ts          # ffprobe/ffmpeg wrappers
  transcribe.ts      # whisper.cpp invocation + word normalization
  analyze.ts         # silence / filler / pause analysis
  cutlist.ts         # keep-segments, snapping, coalescing
  timemap.ts         # source-time ↔ output-time (THE critical module)
packages/scenes      # React components (used by both preview & render)
  EdlVideo.tsx       # base-track EDL playback + punch-in + audio micro-fades
  CaptionTrack.tsx   # word-timed kinetic captions
packages/renderer    # Remotion composition wiring + render entry
apps/cli             # commander: produce | transcribe | studio
apps/studio          # agent-native app (dormant until Phase 1)
```

**Binaries:** `ffmpeg`/`ffprobe` and `whisper.cpp` (`whisper-cli`) are detected on PATH with friendly install guidance (brew/apt) — no bundling this phase. Whisper models auto-download on first use (default `small`, `--model` to override). Paths overridable in `~/.ossclip/config.json`.

## Module specs

### 1. Ingest
- `ffprobe` → fps, resolution, duration, audio layout → `source.probe`.
- Extract 16 kHz mono WAV for ASR.
- Re-encode a mezzanine with dense keyframes (`-g 30`) — protects `<OffthreadVideo>` seek performance across many small EDL segments.

### 2. Transcribe
- `whisper-cli` with word/token timestamps → normalize to `words[]: { text, start, end, conf }`.
- Known issue: whisper word boundaries jitter ±50–150 ms. Phase 0 mitigation is **policy, not alignment**: cut padding (below) absorbs it. Forced alignment (WhisperX-style) is a Phase 2+ upgrade behind the same interface.

### 3. Analyze
- **Silence:** ffmpeg `silencedetect` (start at −35 dB / 0.35 s min), cross-checked against transcript inter-word gaps (both signals must agree to cut).
- **Fillers:** standalone interjections only (`um`, `uh`, `erm`, `hmm`, `uh-huh` …). Deliberately **not** touching "like"/"you know" without an LLM — false positives are worse than fillers.
- **Long pauses:** inter-word gap > 700 ms → tighten to 220 ms.
- **Cleanup levels:** `exact` (nothing) · `light` (silences > 1.2 s only) · `standard` (silences + interjections + pause tightening) · `aggressive` (thresholds 500 ms → 180 ms). These map to the "how much should I clean up?" chips in the eventual UI.

### 4. Cutlist
- Analysis → keep-segments with per-cut `{ reason, confidence }`.
- Snap boundaries to word edges with ±100 ms padding; never cut inside a word.
- Drop kept fragments < 250 ms; coalesce cuts separated by < 120 ms.

### 5. Timemap
- Built once from the cutlist: `toOutput(tSrc)`, `toSource(tOut)`, `mapRange()`.
- **Property-based tests (fast-check) required before anything consumes it:** monotonicity, roundtrip identity on kept ranges, `outputDuration === Σ kept`. This is the module where a subtle bug becomes a rewrite later (BRAINSTORM §4.1).

### 6. EdlVideo
- Sequence of `<OffthreadVideo>` with trim props, one per kept segment.
- Punch-in alternation `1.00 ↔ 1.07` at cuts where the removed gap ≥ 150 ms (below that, a hard cut is invisible anyway).
- 10 ms audio volume ramps at every segment boundary (kills clicks).

### 7. CaptionTrack
- Group words into lines: ≤ 3 words or ≤ 1.2 s, whichever first; active-word highlight.
- 9:16 safe-area placement (~75% height), heavy grotesque + stroke/shadow for contrast.
- Deliberately minimal styling — theme tokens arrive in Phase 2; the component API (`words × timemap → lines`) is what matters now.

### 8. Renderer + CLI
- Composition assembles Production doc → `EdlVideo` + `CaptionTrack`; `renderMedia` → H.264; post-pass ffmpeg `loudnorm` (EBU R128) on the muxed output.
- CLI: `produce` (full pipeline, each stage cached in a `.ossclip/` workdir keyed by content hash — re-runs are incremental), `transcribe` (stops after ASR), `studio`.

## Test plan

- **Unit:** timemap property tests; cutlist snapping against synthetic transcripts (fixtures with known fillers/pauses).
- **Integration:** a checked-in ~10 s fixture clip → deterministic `production.json` golden file; `renderStill` smoke test in CI.
- **Manual QA checklist per real clip:** click-free cuts, caption sync at start/middle/end, punch-ins read as intentional, A/B against `--cleanup exact`.

## Milestones

| # | Deliverable | Done when |
|---|---|---|
| M0.1 | Scaffold + ingest + transcribe | `ossclip transcribe clip.mp4` emits `production.json` with words |
| M0.2 | Analyze + cutlist + timemap | cut report correct on fixtures; timemap properties green |
| M0.3 | Composition | EDL playback + captions visible in Remotion Studio |
| M0.4 | Render + loudnorm + acceptance | criteria 1–6 pass on 3 real clips → tag `v0.0.1` |

## Out of scope (resist)

LLM anything · scene graphics · SFX/BGM · retake detection · reframing · editable layers · studio UI · Tauri packaging.

## Status — 2026-07-26

Built and end-to-end verified in the dev container:

- **M0.1–M0.4 implemented.** 23 unit/property tests green; typecheck clean. The fast-check properties caught two real TimeMap boundary issues before any consumer existed (float-ulp edge overshoot; two-preimage semantics at exact cut boundaries).
- **E2E on the deterministic fixture** (`pnpm fixture`, per-word espeak-ng synthesis → ground-truth transcript by construction): standard level produced 4 cuts — lead trim to 0.25 s, both fillers, 1.8 s pause tightened to ~0.22 s (merged cleanly with the adjacent filler), tail trim — 35.2 % removed. Rendered 1080×1920 H.264/AAC via headless Chromium; frame-extracted testsrc2 timecodes match the cut report **to the frame**; captions render with active-word highlight; loudnorm applied.

Remaining before calling M0.4 fully done (needs a real machine — the dev container's network policy blocks model downloads):

1. **Live whisper.cpp run** on real footage (the `-oj -ml 1` parser is unit-tested against the real output shape, but hasn't seen a live model in-container).
2. **Acceptance pass on 3 real clips** (click-free cuts on headphones, punch-in feel, caption drift).
3. `ossclip studio` smoke test (interactive; untestable headless).

## Phase-0-specific risks

| Risk | Mitigation |
|---|---|
| Whisper word-timestamp jitter → clipped word starts | ±100 ms padding + both-signals-agree rule for silence cuts; forced-alignment upgrade path behind the transcribe interface |
| `<OffthreadVideo>` seek stalls with many segments | dense-keyframe mezzanine at ingest; measured in M0.3 |
| Filler false-positives feel broken | conservative interjection list; per-cut confidence in the report; `exact` always available |
| agent-native starter imposes structure that fights the monorepo | core packages have zero imports from it; worst case the starter is just deleted from the scaffold |
