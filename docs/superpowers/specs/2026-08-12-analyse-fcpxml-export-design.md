# `ossclip analyse` — FCPXML marker export

2026-08-12. Approved in session. Source: docs/local/next-directions.md §2–3
(Kinza's ask) — the analyser without the renderer. FINDINGS §140 measured the
render at 85% of wall time on two machines; this command skips it entirely.

## Decisions (user-approved)

- **New `analyse` subcommand** (alias `analyze`), not a flag on
  produce/transcribe. `ossclip analyse take.mp4 [--format fcpxml] [--out p]`.
- **FCPXML markers only** in v1. No EDL, no OTIO, no `--export` on produce.
- **Markers carry reason + numbers in the NAME** — `silence −1.77s (conf
  0.95)`, the exact report.txt vocabulary. One marker per `remove` segment,
  at SOURCE timestamps.
- **No marker colours.** Stock FCPXML `<marker>` has no colour attribute and
  colour does not reliably survive a Resolve round trip (the doc's open
  question, resolved: no). The reason lives in the name, which Resolve and
  Premiere both display.

## Shape

- Pure exporter in `@ossclip/core` (`export-fcpxml.ts`):
  `buildFcpxmlMarkers(production: Production): string`. Everything it needs —
  source path, probe (fps/size/duration), cutlist, cleanup — is already in
  `Production`. No I/O, no clock: house split.
- Times are FCPXML rationals quantized to the frame
  (`round(sec*fps)/fps` → `"53/30s"`), with NTSC rates mapped to their exact
  rationals (29.97 → 30000/1001). A float second like `1.77s` is legal but
  frame-misaligned; NLEs round it silently — quantizing ourselves keeps the
  marker where the report said it was.
- Document: `<fcpxml version="1.10">` → resources (format + asset with
  `media-rep` file URL of the ORIGINAL input) → library/event/project/
  sequence/spine/`<asset-clip>` carrying the markers. Zero markers is a valid
  document (a clean take exports clean).
- CLI command runs the existing pipeline via `produce(render:false)` (no LLM,
  no Remotion), zod-parses the workdir's `production.json` back through
  `ProductionSchema`, writes `<input>.fcpxml` (or `--out`). `--format` is a
  zod enum — a typo errors, never falls back (CLAUDE.md).
- Telemetry: `analyse_completed` — format, cleanup level,
  `source_duration_bucket`, marker count. Buckets/counts/names only (§134).

## Tests

- Pure exporter: marker-per-remove, keep-segments ignored, XML escaping in
  path/name, rational time math incl. NTSC, empty cutlist, document parses
  (jsdom DOMParser, already a devDep).
- CLI: format enum rejects typos; default out path derivation.
- Behavioural: real `produce()` run (produce-timing harness pattern), then
  export from its production.json; assert the file lands and parses.

## Out of scope

EDL (CMX3600), OTIO, `--export` on produce, marker colours, Premiere/Resolve
round-trip automation (manual validation only).
