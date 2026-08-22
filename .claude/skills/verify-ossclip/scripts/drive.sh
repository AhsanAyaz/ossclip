#!/usr/bin/env bash
# Deterministic ossclip drive: doctor -> transcribe a fixture -> assert -> keep evidence -> clean up.
# Usage: drive.sh [fixture-basename]     (default: fixture)
set -euo pipefail

FIXTURE="${1:-fixture}"
REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$REPO"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE="$REPO/docs/verification/$STAMP-$FIXTURE"
WD="$(mktemp -d)"
mkdir -p "$EVIDENCE"
# Evidence lives outside $WD on purpose, so cleanup cannot eat the proof.
trap 'rm -rf "$WD"' EXIT

echo "== doctor =="
pnpm ossclip doctor 2>&1 | tee "$EVIDENCE/doctor.txt"

echo "== drive: transcribe $FIXTURE =="
TRANSCRIPT_ARG=()
[ -f "fixtures/$FIXTURE.transcript.json" ] && TRANSCRIPT_ARG=(--transcript "fixtures/$FIXTURE.transcript.json")
pnpm ossclip transcribe "fixtures/$FIXTURE.mp4" "${TRANSCRIPT_ARG[@]}" --workdir "$WD" 2>&1 \
  | tee "$EVIDENCE/stdout.txt"

RUN="$(find "$WD" -maxdepth 1 -mindepth 1 -type d | head -1)"
[ -n "$RUN" ] || { echo "FAIL: no run directory under $WD"; exit 1; }
cp "$RUN"/*.json "$RUN"/report.txt "$EVIDENCE"/ 2>/dev/null || true

echo "== assertions =="
python3 - "$RUN" "$FIXTURE" <<'PY'
import json, sys, pathlib
run, fixture = pathlib.Path(sys.argv[1]), sys.argv[2]
p = json.loads((run / "production.json").read_text())
rp = json.loads((run / "render-props.json").read_text())
fails = []
def check(label, got, want=None, predicate=None):
    ok = predicate(got) if predicate else got == want
    print(f"{'PASS' if ok else 'FAIL'}  {label}: {got!r}" + ("" if ok else f"  (want {want!r})"))
    if not ok: fails.append(label)

check("production.json version", p.get("version"), 1)
check("cleanup level", p.get("cleanup"), "standard")
check("cutlist non-empty", len(p.get("cutlist", [])), predicate=lambda n: n > 0)
check("render dimensions", p.get("render"), {"width": 1080, "height": 1920, "fps": 30})
check("transcript has words", len(p.get("transcript", {}).get("words", [])), predicate=lambda n: n > 0)
check("render-props has spans", len(rp.get("spans", [])), predicate=lambda n: n > 0)
check("render-props has captionLines", len(rp.get("captionLines", [])), predicate=lambda n: n > 0)

if fixture == "fixture":  # known-good baseline, portrait ground-truth fixture
    check("baseline: 22 words", len(p["transcript"]["words"]), 22)
    check("baseline: 7 cutlist entries", len(p["cutlist"]), 7)
    check("baseline: source 17.90s", round(p["source"]["probe"]["duration"], 2), 17.9)

print()
print("FAILED: " + ", ".join(fails) if fails else "all assertions passed")
sys.exit(1 if fails else 0)
PY

echo
echo "evidence: $EVIDENCE"
