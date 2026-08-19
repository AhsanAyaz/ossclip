---
name: verify-ossclip
description: Drive the real ossclip CLI and prove a change works — deterministic fixture in, cut report and production.json out, no whisper and no LLM. Use before tagging a release, after touching the pipeline (transcribe, analyze, cutlist, captions, framing, render props), when a bug report needs reproducing, or any time a claim about ossclip's behavior needs evidence instead of a reading of the diff.
---

# Verify ossclip

ossclip's user surface is a **CLI** published to npm (`npm i -g ossclip`). The web editor (`ossclip edit`) and
Remotion Studio (`ossclip studio`) are secondary surfaces that open on a workdir the CLI already produced.

This skill drives the CLI the way a user does, against a deterministic fixture, and captures the artifacts that
prove what happened. It runs fully offline: no whisper, no LLM, no network.

## Launch

There is no server. A CLI run is the unit of work. Two things must be true first:

```sh
cd /Users/amu1o5/personal/ossclip
pnpm install            # only if node_modules is missing or stale
```

Run the CLI through the workspace, never a globally installed `ossclip`:

```sh
pnpm ossclip <command>   # -> tsx apps/cli/src/index.ts
```

Driving the globally installed binary tests a published version, not this checkout. If you need to verify the
published artifact specifically, say so explicitly in the evidence.

Teardown is deleting the workdir you passed to `--workdir`. Nothing persists otherwise.

## Doctor

ossclip ships its own preflight. Run it first, always:

```sh
pnpm ossclip doctor
```

A healthy checkout prints `All checks passed` and green checks for node, ffmpeg, ffprobe, whisper-cli, the whisper
model, an LLM provider, and the editor page. Anything red means **stop and fix that first** — a failure downstream
is meaningless until doctor is clean. Doctor prints the exact fix for each miss; `pnpm ossclip setup` provisions
the missing pieces into `~/.ossclip`.

Note: the `LLM provider` check is only needed for `--produce` and `cover`. Every drive in this skill avoids the LLM,
so a red LLM row does not block the core proof. Say so rather than claiming a clean doctor.

## Drive

**The deterministic path.** `fixtures/fixture.mp4` is synthesized by `scripts/make-fixture.mjs` with one espeak-ng
clip per word, so word boundaries are exact by construction, and `fixtures/fixture.transcript.json` is the
ground-truth transcript. Passing `--transcript` injects it and skips whisper entirely, which makes the run fast,
offline, and byte-stable.

```sh
WD=$(mktemp -d)
pnpm ossclip transcribe fixtures/fixture.mp4 \
  --transcript fixtures/fixture.transcript.json \
  --workdir "$WD"
```

That is the real `transcribe` command a user runs — the pipeline up to the transcript and cut report, no render.
It completes in about 2 seconds and writes into `"$WD"/fixture-<hash>/`.

Other fixtures, for framing and crop work: `landscape.mp4` (16:9 source), `letterboxed.mp4`,
`mixed-framing.mp4`. Regenerate any of them with `pnpm fixture`.

**Isolation.** `--workdir` is the isolation boundary and every drive must pass it. Two runs with different
workdirs are fully independent. Without it, ossclip writes to `<input dir>/.ossclip`, which pollutes the repo's
`fixtures/` directory and makes the next run non-deterministic. Never drive a workdir a user is editing in.

**Stable handles.** Assert on the JSON, not on the pretty terminal output. The report text is for humans and its
wording changes; `production.json` is versioned (`version: 1`).

## Evidence

Copy the artifacts out of the workdir before cleanup, into `docs/verification/<date>-<slug>/`:

| Artifact | What it proves |
|---|---|
| `production.json` | The whole decision: `source.probe`, `cleanup`, `transcript`, `analysis.silences`, `cutlist`, `theme`, `render` dimensions. |
| `render-props.json` | What the renderer would draw: `spans`, `captionLines`, `sceneCues`, `zoomPlan`, `face`, `watermark`. |
| `report.txt` | The cut report as the user sees it. |
| `transcript.json` | The transcript actually used. |
| stdout transcript | Phase timings and the framing/zoom lines, which appear nowhere else. |

**Proof standards.** Exercise the real command, not an internal function or a test-only entry point. Capture the
command and its output together, not just the final file. Verify side effects — the files that landed in the
workdir — alongside what the terminal printed. Assert on values, not on the run completing: a run that exits 0 and
produces an empty cutlist is a failure that looks like a pass.

Known-good baseline for the fixture drive above, at `standard` cleanup:

- 22 words injected, source `1080x1920 @ 30fps · 17.90s`
- 4 cuts, `6.32s` removed of `17.90s` (35.3%), output `11.58s`
- cut kinds in order: silence, filler, silence, silence
- `production.json` has `version: 1`, `cleanup: "standard"`, a 7-entry `cutlist`, `render: {width:1080, height:1920, fps:30}`
- no face detected in 9 sampled frames, so framing falls back to ASSUMED and subject resolves to 3 screen spans

A change that moves any of those numbers is either the change you meant or a regression. Say which, and show the
before and after. If you did not know the number would move, it is a regression until proven otherwise.

## Cleanup

```sh
rm -rf "$WD"
```

Delete only the workdir this run created. Never `rm -rf` inside `fixtures/`, and never kill processes by name —
these are short-lived foreground commands, so there is nothing to kill.

Evidence survives cleanup: it lives in `docs/verification/`, outside the workdir, by construction. If the evidence
was still inside `$WD` when you deleted it, the proof is gone and the run does not count.

## Helpers

`scripts/drive.sh` runs the deterministic path end to end and leaves evidence behind:

```sh
.claude/skills/verify-ossclip/scripts/drive.sh              # evidence -> docs/verification/<timestamp>-fixture/
.claude/skills/verify-ossclip/scripts/drive.sh landscape    # drive fixtures/landscape.mp4 instead
```

It runs doctor, drives `transcribe`, copies the artifacts out, prints the assertions above with PASS/FAIL, and
removes the workdir. Read it before trusting it; it is 40 lines.

## Feature map

`features/README.md` indexes what a user can actually do. A proof that drives only `transcribe` is incomplete when
the change touched rendering, captions, or the cover. Check the map before claiming a change is verified.

Keep the map honest with `/maintain-verification-skill`.
