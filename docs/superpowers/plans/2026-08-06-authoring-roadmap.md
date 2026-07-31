# The authoring roadmap — multi-source input, semantic cuts, and who writes a scene

> **For agentic workers:** REQUIREMENTS, not designs. Every diagnosis below was read out of the source on 2026-07-31 and is stated with its file path; the approaches are deliberately left open. **Read _The ordering, and why it is the point_ before starting anything here** — the ordering is the most load-bearing decision in this document, and three of these items are cheap only if done in the stated order.

**Status:** captured 2026-07-31 from a roadmap discussion. Nothing started.

**This document deliberately carries NO § numbers (R27).** It reserved §118–§122 before the work existed; R25 then landed the scene-count fix as §118 and R26 renumbered everything here to §119–§123; R27 would have collided again. Two renumberings in three rounds is the evidence that the practice, not the numbering, was wrong. Items below are referred to by NAME. A finding takes the next free § when it actually lands, and nothing has to move.

**Prerequisite:** [`2026-08-05-scene-count-from-content-structure.md`](./2026-08-05-scene-count-from-content-structure.md) — **shipped 2026-07-31 as R25 §118** (see `docs/PHASE1-FINDINGS.md`). See _The ordering_ below for why it came first and what its landing means for the appetite here.

---

## The ordering, and why it is the point

These five items came out of one question — *"the graphics aren't good enough to show off, what if the user could author them?"* — and the honest answer is that **authoring may be the wrong fix for that complaint.**

The measured cause was that nothing plans enough scenes — and that fix has now **landed as R25 §118**: an explicit count target in the prompt (runtime density plus the take's own enumeration), the moment cap raised, and under-delivery reported. Verified on the motivating take: 3 → 6 graphics on the same model. So the question this document was built to defer is now LIVE: with a producer that plans to a stated count, re-ask whether a hand-authoring surface is still wanted before starting items 4–5 below. If the appetite survives, it will be built on a producer that plans well rather than around one that does not.

So:

1. **The scene-count target** — shipped (R25 §118); the prerequisite is met.
2. **Multi-source input** (concat-first).
3. **Retake/blooper removal** as a cut reason — the SPOKEN-MARKER half shipped
   in R27 §122 (`--blooper-marker`), which is deterministic. What remains here
   is the semantic detector, and with it the guarantee question below.
4. **User cuts**, server-side first, then the editor.
5. **`Scene[]` authored by an agent**, as a CLI step.
6. **Freeform TSX** — a decision to record, not a task to schedule.

Items 2–5 are each tractable alone. **Together they are "the full agent-native studio shell", which `docs/PHASE1.md` lists under *Out of scope (resist)*** — and `apps/studio`, scaffolded in PHASE0, was never built and does not exist in the tree. The risk is not any single item; it is doing them at once and losing the property that makes this project unusual, which is that every change traces to a defect seen in a real render.

---

## Multi-source input — join the takes before anything measures them

**The ask:** hand ossclip several raw files and get one produced short, with the joins invisible.

**Why it is the safest of these items:** it appears nowhere on any resist list, and the architecture cooperates.

### The gap

`produce()` takes a scalar (`apps/cli/src/produce.ts:184`), the CLI argument is `<input>` singular, and nothing multi-input exists anywhere in the tree. Seventeen sites assume one source. The consequential ones:

| site | file | why it hurts |
| --- | --- | --- |
| workdir identity | `produce.ts:217-222` | `sha1File(input)` + `basename(input)` — two files have no defined workdir name or cache key |
| probe | `produce.ts:227-231` | one `{width,height,fps,duration}` treated as *the* timeline; files of differing fps/resolution have no single answer |
| transcript | `produce.ts:271-299` | one word-index space — the anchor namespace for scenes, repairs, `--clip` and caption edits |
| level threshold | `produce.ts:301-310` | one noise floor for the whole timeline; two mics or two rooms produce one threshold wrong for both |
| `face.json` | `produce.ts:792-808` | one face box, one crop, applied to everything |
| content-rect | `produce.ts:259-267` | two files with different letterboxing look like one file that changes framing mid-take |
| `production.json` | `schema.ts:93-109` | `source:` is a singular object, not an array |

### The shape that keeps the invariants

- [ ] **a. Concat first, before `extractAudio`.** Probe each input, compute offsets, produce ONE joined mezzanine early, and let the entire existing pipeline treat it as a single source. This leaves `KeptSpan`, `TimeMap`, `EdlVideo`, `assembleScenes` and `buildCaptionLines` **completely untouched** — which is precisely what preserves the property-tested invariants. The alternative (a `srcId` on `KeptSpan`) touches every consumer of the time map and should be rejected unless concat-first is proven impossible.
- [ ] **b. Workdir identity over an ordered list.** Hash the ordered `[sha1, …]` plus the join order. The human-readable prefix has no obvious answer — pick one and say why in a comment.
- [ ] **c. A `sources:` block on `production.json`** — `[{path, probe, offsetSec}]` — so the report and the editor can say which file a span came from. This is the only genuinely new artefact.

### The two costs this must own, out loud

- **Per-file level measurement is lost.** One derived threshold across material recorded differently is a real regression for the exact workflow this feature serves. Measure pre-concat and carry per-region thresholds, or state the limitation.
- **Per-file framing collapses to one crop** — unless `measureFaceInWindows` is fed the concat boundaries as window edges. It already accepts an arbitrary list of `{startSec, endSec, cropVf}` (`face.ts:325`), which is the strongest existing hook for this feature and should be used rather than worked around.

---

## Retake and blooper removal — the slot is already cut

**The ask:** drop the flubbed takes, not just the silences and the "um"s.

### The gap, and the half that already exists

`RemovalReasonSchema` (`packages/core/src/schema.ts:21`) is already:

```ts
z.enum(["silence", "pause", "filler", "retake", "user", "clip"])
```

**No code path emits `"retake"` or `"user"`.** They were reserved and left. `formatCutReport` prints `r.reason ?? "?"` generically, so a new reason renders in the report for free.

### Copy `--clip`, exactly

`--clip` is the template and should be followed closely (`packages/core/src/clip.ts`). It does **not** trim the timeline: `boundCutlistToWindow` converts everything outside the window into `remove` segments with `reason: "clip"`, keeping the cutlist a full partition of `[0, duration]` so the TimeMap invariant holds by construction.

- [ ] **a. Emit `Segment[]` with `kind: "remove", reason: "retake"`** folded into the same partition — never a separate trimming pass. Everything downstream (report, TimeMap, scene dropping by vanished anchor, caption re-derivation, `EdlVideo` spans, the editor filmstrip) then works with **zero changes**, exactly as `--clip` does.
- [ ] **b. Cache the decision and pin it for replay.** `--clip` caches `clipwindow-<key>.json` and writes `--clip-window startWord:endWord` into `command.json` so the editor's Render reproduces the same choice with no LLM call. A detector that re-asks a model on every replay would drift every saved override — the failure §93g exists to prevent.
- [ ] **c. Refuse rather than guess.** `--clip` refuses without `--produce` and states there is no heuristic fallback. A retake detector should be equally explicit about what it will not do.

### The decision this forces — make it consciously

`buildCutlist` is today a **pure function of (raw transcript, analysis, duration, level)** with no LLM anywhere in it, and `produce.ts:322-327` says why:

> the cut is computed from raw ASR, so the same input and `--cleanup` always produce the same edit whether or not an LLM ran.

Retake detection is inherently semantic. **It is the first thing that would break that guarantee.** That is the real content of this item; the implementation is comparatively easy. Either accept a semantic cut stage and say so where the guarantee is currently claimed, or find a deterministic formulation (fuzzy repeated-phrase matching over the transcript is the obvious candidate and would keep the property).

**Update (R27 §122): the deterministic half shipped, and the guarantee survived.** `--blooper-marker <word>` cuts the attempt a speaker marks OUT LOUD, back to the start of the sentence it spoiled. A spoken marker needs no judgement — the word is in the transcript or it is not — so it is the third option this paragraph did not consider: not "accept a semantic stage", not "approximate the semantics deterministically", but *let the speaker supply the semantics at record time*. `buildCutlist` remains pure; the spans arrive as an argument. Everything predicted above held — `reason: "retake"` folded into the same partition, and report, TimeMap, scene dropping, caption re-derivation and `EdlVideo` all worked with zero changes.

What is left of this item is the case the speaker did NOT mark, which is still semantic and still carries the whole trade-off above. Note that the marker approach makes the trade-off avoidable rather than solved: it asks the user to change how they record. If that proves too much to ask, the semantic detector is back on the table with its guarantee question intact.

---

## User cuts — server-side first, editor second

**The ask:** remove a bad bit after generation, in the editor.

### The gap

The cut is frozen at produce time. `OverrideDocSchema` carries `theme / scenes / captions / splits` and **no cut concept at all**. What looks like deletion today is not: `SceneOverride.hidden` drops a *graphic* and `fillPlainCues` turns its window into a plain take — **the video keeps playing**. `splits` do not remove time either; `splitCues` splices one cue into two covering the same span. The editor reads `renderProps.spans` only to draw the filmstrip and never writes them; the only write endpoint is `PUT /api/overrides`.

This was scoped out once with reasoning (§59c): *"Deleting a sentence from the transcript and having the VIDEO lose it is a third thing again (it drives the cut, not the captions). Explicitly out of scope unless asked for."* It is now being asked for — that is legitimate, but it means **reopening a documented decision**, not filling a gap nobody noticed.

### Why the pipeline is ready for this

Re-cutting is the case the design was built for. Scenes anchor by **word index** and are dropped *with a reason* when their anchor words vanish; captions are re-derived from the map. This is the PHASE1 risk-table mitigation, working as intended.

- [ ] **a. `reason: "user"` cuts, server-side.** Extend the override doc with a cut list — the reason token is already reserved — and fold user cuts into `buildCutlist`'s output **before** `new TimeMap(cutlist)`. Ship and prove this from the CLI before any UI exists.
- [ ] **b. Then the editor.** Only after 121a is solid.

### The drift this will cause, which nothing currently guards

Two override fields are keyed to **absolute output seconds** and will silently land in the wrong place after a re-cut:

- `SceneOverride.timing` (pinned scenes) — `reclampPinnedTiming` (`overrides.ts:487-509`) already exists for this class of drift and would need extending.
- **`splits: number[]` has no equivalent guard at all.** This is the sharp edge of the whole item.

Silently is the operative word: nothing throws, the render just puts things in the wrong place. Whatever approach is chosen must make this loud.

---

## Scene authoring by an agent — as a CLI step, not an editor endpoint

**The ask:** let the user create scenes with AI, in the editor.

### Three problems get conflated here, and only one is about AI

**The trust boundary.** `/api/render` is replay-only by explicit written design — *"this server binds locally, but accepting a client-supplied command would make it a remote shell."* The edit server imports exactly two symbols from core (`OverrideDocSchema`, `emptyOverrideDoc`). The browser bundle **cannot** reach the producer: `packages/core/src/browser.ts` is a deliberately Node-free subset that excludes `producer/*`. A generate endpoint is a new security surface, and it is the specific one this server was built not to have.

**The data model.** `OverrideDoc.scenes` is a `Record<sceneId, SceneOverride>` keyed to ids the producer already minted; `applyOverrides` reports unknown ids as **orphans** by design (`⚠ edit for X dropped`). There is no `addScene` among the reducer's 24 actions and no create affordance anywhere in the UI. Scene *creation* has no representation in the override layer.

**The anchor gap — the actual work.** `Scene` is word-anchored (`startWord`/`endWord`). The editor only ever sees resolved `SceneCue[]` in **output seconds** and has no source word indices. Bridging that is the cost; the AI part is almost incidental.

### The seam that already exists

`ossclip produce --scenes <path>` reads a hand-authored `Scene[]` **with no LLM in the loop** (`produce.ts:457`). That is the natural target.

- [ ] **a. Generate `Scene[]`, not overrides.** An agent step that emits a scenes file the existing flag consumes. Cheap, no new endpoint, no new trust boundary, and it composes with everything.
- [ ] **b. Anything using the nine registered components is editable for free.** `data-edit-id` + `editStyle` give move/resize/scale with zero editor changes; only *text* editing needs the `Overlay.tsx` id↔props mapping for a new prop shape.
- [ ] **c. Do NOT add a generate endpoint to the edit server** without a written security story that addresses the replay-only rationale head on. Same user value is available at an order of magnitude less cost via 122a.

---

## Freeform TSX — a decision, recorded

**The ask:** let the model write complete Remotion components, not just fill nine.

**Recommendation: leave it on the resist list. Grow the registry instead.**

It is named by that exact phrase in `docs/PHASE1.md:171` *Out of scope (resist)* — "freeform TSX escape hatch" — and again at `:118`, *"No freeform TSX (that is Phase 4)."* It appears nowhere in `ROADMAP.md`.

Mechanically it is *reachable*: Remotion already bundles the composition from `.tsx` on every render, so a generated module is a small change. That is exactly what makes it worth writing the reasons down.

### Seven systems are keyed to the closed component enum

| system | what an unknown component does |
| --- | --- |
| producer prompt | `sceneKind` is a closed enum — the model *cannot* name a non-existent component |
| `COMPONENTS` map (`SceneLayer.tsx`) | exhaustive by the compiler; an unknown string is `undefined` → React crash |
| fit contract (`fit.ts`) | `estimateHeightPx` is a `switch` with **no `default`** → NaN scale, unbounded or collapsed transform |
| grounding (`grounding.ts`) | `CHECKED_FIELDS[unknown] ?? []` → the hallucination check silently becomes a **no-op** |
| copy reconciliation (`repair.ts`) | same per-component field table, same silent no-op |
| source-text routing (`source-fit.ts`) | no `defaultLayout`/`altLayouts` candidate set |
| editor | no `data-edit-id` leaves → invisible to direct manipulation |

**Four of those fail silently.** The grounding one is the worst: the defence against invented copy reaching a frame would stop applying to exactly the scenes invented most freely.

### The threat model changes category

Today the model emits JSON only. Nothing executes; there is nothing to sandbox. Freeform TSX puts model output into the webpack module graph and then into a Chromium page with filesystem access via `publicDir`. The standing doctrine (§112) is *"LLM output is untrusted input, validated where the pipeline can still degrade instead of at the point where it can only die."* Codegen inverts it.

### The middle path

- [ ] **a. Grow the registry when a real render demands it.** `BulletList` was added exactly that way — a logged miss where copy got bent into the wrong card because no component said "list". Ten or fifteen typed components with the fit contract intact buys most of the expressive range at none of the cost. The `README` sells the typed registry as the differentiator; a codegen escape hatch would quietly retire that claim.

---

## Risks across the whole document

| risk | mitigation |
| --- | --- |
| Doing multi-source, retakes, user cuts and agent-authored scenes concurrently rebuilds the resisted "agent-native studio shell" by accident | one at a time, each landing on real footage before the next starts |
| Semantic retake detection silently ends the deterministic-cut guarantee | state it where the guarantee is currently claimed, or keep the detector deterministic |
| User cuts drift `splits` and pinned `timing` with no error | extend `reclampPinnedTiming`; `splits` needs a guard that does not exist yet |
| Multi-source regresses audio on multi-mic material | per-region thresholds, or document the limitation |
| Authoring gets built to solve a density problem §118 already solved | §118 has landed — re-ask on real footage whether agent-authored scenes are still wanted before building it |
