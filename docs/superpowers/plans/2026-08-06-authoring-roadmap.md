# The authoring roadmap — multi-source input, semantic cuts, and who writes a scene

> **For agentic workers:** REQUIREMENTS, not designs. Every diagnosis below was read out of the source on 2026-07-31 and is stated with its file path; the approaches are deliberately left open. **Read §118.0 before starting anything here** — the ordering is the most load-bearing decision in this document, and three of these items are cheap only if done in the stated order.

**Status:** captured 2026-07-31 from a roadmap discussion. Nothing started. Findings numbering continues at **§118** (§116 is claimed by the scene-count plan, §117 shipped as the caption-collision fix).

**Prerequisite:** [`2026-08-05-scene-count-from-content-structure.md`](./2026-08-05-scene-count-from-content-structure.md) (§116). See §118.0 for why it comes first and is not optional.

---

## 118.0 The ordering, and why it is the point

These five items came out of one question — *"the graphics aren't good enough to show off, what if the user could author them?"* — and the honest answer is that **authoring may be the wrong fix for that complaint.**

The measured cause (§116) is that nothing plans enough scenes: `minGraphics` is `0` for any take over 45 s, the 45% coverage figure is a ceiling with no floor, and simply putting a stronger model on the editorial call moved a 64 s take from 3 graphics to 5. **§116 costs a fraction of anything in this document.** If it lands and a take of that length reliably plans eight or ten graphics, the appetite for a hand-authoring surface may not survive — and if it does survive, it will be built on a producer that plans well rather than around one that does not.

So:

1. **§116** — the scene-count floor. Prerequisite, not a peer.
2. **§118** — multi-source input (concat-first).
3. **§119** — retake/blooper removal as a cut reason.
4. **§120** — user cuts, server-side first, then the editor.
5. **§121** — `Scene[]` authored by an agent, as a CLI step.
6. **§122** — freeform TSX: a decision to record, not a task to schedule.

Items 2–5 are each tractable alone. **Together they are "the full agent-native studio shell", which `docs/PHASE1.md` lists under *Out of scope (resist)*** — and `apps/studio`, scaffolded in PHASE0, was never built and does not exist in the tree. The risk is not any single item; it is doing them at once and losing the property that makes this project unusual, which is that every change traces to a defect seen in a real render.

---

## 118. Multi-source input — join the takes before anything measures them

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

### 118.1 The shape that keeps the invariants

- [ ] **118a. Concat first, before `extractAudio`.** Probe each input, compute offsets, produce ONE joined mezzanine early, and let the entire existing pipeline treat it as a single source. This leaves `KeptSpan`, `TimeMap`, `EdlVideo`, `assembleScenes` and `buildCaptionLines` **completely untouched** — which is precisely what preserves the property-tested invariants. The alternative (a `srcId` on `KeptSpan`) touches every consumer of the time map and should be rejected unless concat-first is proven impossible.
- [ ] **118b. Workdir identity over an ordered list.** Hash the ordered `[sha1, …]` plus the join order. The human-readable prefix has no obvious answer — pick one and say why in a comment.
- [ ] **118c. A `sources:` block on `production.json`** — `[{path, probe, offsetSec}]` — so the report and the editor can say which file a span came from. This is the only genuinely new artefact.

### 118.2 The two costs this must own, out loud

- **Per-file level measurement is lost.** One derived threshold across material recorded differently is a real regression for the exact workflow this feature serves. Measure pre-concat and carry per-region thresholds, or state the limitation.
- **Per-file framing collapses to one crop** — unless `measureFaceInWindows` is fed the concat boundaries as window edges. It already accepts an arbitrary list of `{startSec, endSec, cropVf}` (`face.ts:325`), which is the strongest existing hook for this feature and should be used rather than worked around.

---

## 119. Retake and blooper removal — the slot is already cut

**The ask:** drop the flubbed takes, not just the silences and the "um"s.

### The gap, and the half that already exists

`RemovalReasonSchema` (`packages/core/src/schema.ts:21`) is already:

```ts
z.enum(["silence", "pause", "filler", "retake", "user", "clip"])
```

**No code path emits `"retake"` or `"user"`.** They were reserved and left. `formatCutReport` prints `r.reason ?? "?"` generically, so a new reason renders in the report for free.

### 119.1 Copy `--clip`, exactly

`--clip` is the template and should be followed closely (`packages/core/src/clip.ts`). It does **not** trim the timeline: `boundCutlistToWindow` converts everything outside the window into `remove` segments with `reason: "clip"`, keeping the cutlist a full partition of `[0, duration]` so the TimeMap invariant holds by construction.

- [ ] **119a. Emit `Segment[]` with `kind: "remove", reason: "retake"`** folded into the same partition — never a separate trimming pass. Everything downstream (report, TimeMap, scene dropping by vanished anchor, caption re-derivation, `EdlVideo` spans, the editor filmstrip) then works with **zero changes**, exactly as `--clip` does.
- [ ] **119b. Cache the decision and pin it for replay.** `--clip` caches `clipwindow-<key>.json` and writes `--clip-window startWord:endWord` into `command.json` so the editor's Render reproduces the same choice with no LLM call. A detector that re-asks a model on every replay would drift every saved override — the failure §93g exists to prevent.
- [ ] **119c. Refuse rather than guess.** `--clip` refuses without `--produce` and states there is no heuristic fallback. A retake detector should be equally explicit about what it will not do.

### 119.2 The decision this forces — make it consciously

`buildCutlist` is today a **pure function of (raw transcript, analysis, duration, level)** with no LLM anywhere in it, and `produce.ts:322-327` says why:

> the cut is computed from raw ASR, so the same input and `--cleanup` always produce the same edit whether or not an LLM ran.

Retake detection is inherently semantic. **It is the first thing that would break that guarantee.** That is the real content of this item; the implementation is comparatively easy. Either accept a semantic cut stage and say so where the guarantee is currently claimed, or find a deterministic formulation (fuzzy repeated-phrase matching over the transcript is the obvious candidate and would keep the property).

---

## 120. User cuts — server-side first, editor second

**The ask:** remove a bad bit after generation, in the editor.

### The gap

The cut is frozen at produce time. `OverrideDocSchema` carries `theme / scenes / captions / splits` and **no cut concept at all**. What looks like deletion today is not: `SceneOverride.hidden` drops a *graphic* and `fillPlainCues` turns its window into a plain take — **the video keeps playing**. `splits` do not remove time either; `splitCues` splices one cue into two covering the same span. The editor reads `renderProps.spans` only to draw the filmstrip and never writes them; the only write endpoint is `PUT /api/overrides`.

This was scoped out once with reasoning (§59c): *"Deleting a sentence from the transcript and having the VIDEO lose it is a third thing again (it drives the cut, not the captions). Explicitly out of scope unless asked for."* It is now being asked for — that is legitimate, but it means **reopening a documented decision**, not filling a gap nobody noticed.

### 120.1 Why the pipeline is ready for this

Re-cutting is the case the design was built for. Scenes anchor by **word index** and are dropped *with a reason* when their anchor words vanish; captions are re-derived from the map. This is the PHASE1 risk-table mitigation, working as intended.

- [ ] **120a. `reason: "user"` cuts, server-side.** Extend the override doc with a cut list — the reason token is already reserved — and fold user cuts into `buildCutlist`'s output **before** `new TimeMap(cutlist)`. Ship and prove this from the CLI before any UI exists.
- [ ] **120b. Then the editor.** Only after 120a is solid.

### 120.2 The drift this will cause, which nothing currently guards

Two override fields are keyed to **absolute output seconds** and will silently land in the wrong place after a re-cut:

- `SceneOverride.timing` (pinned scenes) — `reclampPinnedTiming` (`overrides.ts:487-509`) already exists for this class of drift and would need extending.
- **`splits: number[]` has no equivalent guard at all.** This is the sharp edge of the whole item.

Silently is the operative word: nothing throws, the render just puts things in the wrong place. Whatever approach is chosen must make this loud.

---

## 121. Scene authoring by an agent — as a CLI step, not an editor endpoint

**The ask:** let the user create scenes with AI, in the editor.

### Three problems get conflated here, and only one is about AI

**The trust boundary.** `/api/render` is replay-only by explicit written design — *"this server binds locally, but accepting a client-supplied command would make it a remote shell."* The edit server imports exactly two symbols from core (`OverrideDocSchema`, `emptyOverrideDoc`). The browser bundle **cannot** reach the producer: `packages/core/src/browser.ts` is a deliberately Node-free subset that excludes `producer/*`. A generate endpoint is a new security surface, and it is the specific one this server was built not to have.

**The data model.** `OverrideDoc.scenes` is a `Record<sceneId, SceneOverride>` keyed to ids the producer already minted; `applyOverrides` reports unknown ids as **orphans** by design (`⚠ edit for X dropped`). There is no `addScene` among the reducer's 24 actions and no create affordance anywhere in the UI. Scene *creation* has no representation in the override layer.

**The anchor gap — the actual work.** `Scene` is word-anchored (`startWord`/`endWord`). The editor only ever sees resolved `SceneCue[]` in **output seconds** and has no source word indices. Bridging that is the cost; the AI part is almost incidental.

### 121.1 The seam that already exists

`ossclip produce --scenes <path>` reads a hand-authored `Scene[]` **with no LLM in the loop** (`produce.ts:457`). That is the natural target.

- [ ] **121a. Generate `Scene[]`, not overrides.** An agent step that emits a scenes file the existing flag consumes. Cheap, no new endpoint, no new trust boundary, and it composes with everything.
- [ ] **121b. Anything using the nine registered components is editable for free.** `data-edit-id` + `editStyle` give move/resize/scale with zero editor changes; only *text* editing needs the `Overlay.tsx` id↔props mapping for a new prop shape.
- [ ] **121c. Do NOT add a generate endpoint to the edit server** without a written security story that addresses the replay-only rationale head on. Same user value is available at an order of magnitude less cost via 121a.

---

## 122. Freeform TSX — a decision, recorded

**The ask:** let the model write complete Remotion components, not just fill nine.

**Recommendation: leave it on the resist list. Grow the registry instead.**

It is named by that exact phrase in `docs/PHASE1.md:171` *Out of scope (resist)* — "freeform TSX escape hatch" — and again at `:118`, *"No freeform TSX (that is Phase 4)."* It appears nowhere in `ROADMAP.md`.

Mechanically it is *reachable*: Remotion already bundles the composition from `.tsx` on every render, so a generated module is a small change. That is exactly what makes it worth writing the reasons down.

### 122.1 Seven systems are keyed to the closed component enum

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

### 122.2 The threat model changes category

Today the model emits JSON only. Nothing executes; there is nothing to sandbox. Freeform TSX puts model output into the webpack module graph and then into a Chromium page with filesystem access via `publicDir`. The standing doctrine (§112) is *"LLM output is untrusted input, validated where the pipeline can still degrade instead of at the point where it can only die."* Codegen inverts it.

### 122.3 The middle path

- [ ] **122a. Grow the registry when a real render demands it.** `BulletList` was added exactly that way — a logged miss where copy got bent into the wrong card because no component said "list". Ten or fifteen typed components with the fit contract intact buys most of the expressive range at none of the cost. The `README` sells the typed registry as the differentiator; a codegen escape hatch would quietly retire that claim.

---

## Risks across the whole document

| risk | mitigation |
| --- | --- |
| Doing 118–121 concurrently rebuilds the resisted "agent-native studio shell" by accident | one at a time, each landing on real footage before the next starts |
| §119 silently ends the deterministic-cut guarantee | state it where the guarantee is currently claimed, or keep the detector deterministic |
| §120 drifts `splits` and pinned `timing` with no error | extend `reclampPinnedTiming`; `splits` needs a guard that does not exist yet |
| §118 regresses audio on multi-mic material | per-region thresholds, or document the limitation |
| Authoring gets built to solve a density problem §116 already solves | §116 first, then re-ask whether 121 is still wanted |
