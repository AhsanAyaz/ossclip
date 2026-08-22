# Cut and caption a take

`ossclip transcribe` runs the pipeline up to the transcript and cut report and stops before rendering. It is the
heart of the product: everything else consumes what it decides.

## Sub-features

- Transcription (whisper), or an injected transcript via `--transcript`
- Silence and filler detection, and the measured noise floor (`--noise-db` overrides it)
- Cutlist construction at four cleanup levels: `exact`, `light`, `standard` (default), `aggressive`
- Caption line layout, written into `render-props.json` as `captionLines`
- Framing: face detection, subject classification per span, crop and zoom planning
- Non-Latin languages via `--whisper-language` (Urdu shipped 2026-08-19)

## How to get to it (user POV)

```sh
npm i -g ossclip && ossclip setup      # once
ossclip transcribe my-take.mp4
```

The user sees a cut report in the terminal and a workdir path they can hand to `ossclip edit`.

## Driving it with the CLI

```sh
WD=$(mktemp -d)
pnpm ossclip transcribe fixtures/fixture.mp4 \
  --transcript fixtures/fixture.transcript.json \
  --workdir "$WD"
```

Ground truth is `fixtures/fixture.transcript.json`, so cut boundaries are exact by construction. The fixture is
built to contain every case the cutlist must handle: leading dead air, a short sentence pause that must survive,
fillers, a long mid-take pause that must be tightened, and trailing dead air.

Cleanup levels are the cheapest real matrix: rerun with `--cleanup exact` and `--cleanup aggressive` and confirm
the removed-seconds total moves monotonically. A level that changes nothing is a bug.

**Proves it works:** `production.json` carries a non-empty `cutlist` whose kinds and boundaries match the report,
and `render-props.json` carries `spans` and `captionLines` covering the output duration.

## Gotchas

- Always pass `--workdir`. Without it ossclip writes into `fixtures/.ossclip` and the next run is no longer clean.
- The fixture has no face, so framing correctly falls back to ASSUMED and logs `no face detected in 9 sampled
  frames`. That line is expected here and is **not** a failure. Use `landscape.mp4` or `mixed-framing.mp4` when the
  change is about framing.
- Assert on `production.json`, not the report text. The report is prose for humans and its wording changes.
- Word count and cut count are the fixture's, not the app's. Regenerating fixtures with `pnpm fixture` can move the
  baseline legitimately; re-baseline deliberately and say you did.
