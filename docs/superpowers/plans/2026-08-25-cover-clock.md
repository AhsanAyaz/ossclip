# Cover Clock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The cover panel's "Use current playhead" spends the playhead on the right clock for either frame source, the seconds field stops resetting after Apply, and a Preview button tries a frame without overwriting the project's cover.

**Architecture:** The seconds field's meaning becomes explicit and single: *seconds on the currently selected video's clock* (matching `ossclip cover --at` exactly — the server keeps re-mapping nothing). The conversion happens in the panel, at the moments a clock is crossed: the playhead button maps output→source via `TimeMap.toSource` when "Original take" is selected, and toggling the frame source re-maps a filled field between clocks, both with a visible note. The finished mp4's span set rides the existing `GET /api/cover` response. Preview is a new endpoint that calls the same `regenerateCover` with a **server-derived** one-off `outPath` inside the workdir, plus an image route to show it.

**Tech Stack:** TypeScript, React (panel), zod (server), vitest. `TimeMap` from `@ossclip/core/browser` (already exported, `browser.ts:53`).

**Spec:** `docs/local/handoff-cover-panel.md` (three problems, in its priority order; its "Verified" and "Disproven" sections are settled — do not re-investigate them).

## Global Constraints

- The `--from final` + playhead path works today and must not change behaviour (handoff trap #3).
- Server derives every path; the preview `outPath` must never come from the request body (the stance documented at `edit.ts:1250-1257`).
- User-supplied values parse with zod, never coerce (CLAUDE.md).
- Pure logic separated from I/O; the editor test suite must never boot Remotion or ffmpeg (`cover.ts:570` seam contract).
- Comments cite the handoff / findings sections that forced each choice.
- `pnpm test` and `pnpm typecheck` green before every commit.
- Branch: `fix/cover-clock` off `main`. No version bumps.

## Design decisions already made (do not re-litigate in tasks)

1. **The field means "seconds on the selected video's clock", always.** The alternative (field always output-time, server maps for `source`) would make source moments that were *cut out of the output* unreachable — a legitimate cover choice ("use the frame from the bit I trimmed"). Keeping the CLI's semantics also keeps one meaning for `atSec` end to end; only the panel's two clock-crossing gestures convert.
2. **The panel maps, not the server.** `playheadSec` arrives already normalized to the finished mp4's output clock (the `CoverPanel.tsx:177-190` contract — App owns the live-recut "new → source → old" mapping; read that comment before touching anything). So the only remaining hop is finished-output → source, which needs the *resolved* cutlist the final render used. Handoff trap: `/api/cleanup` serves the PROPOSED cutlist (`cutlistProposed`, `edit.ts:554-566`) — the wrong span set for this. We serve `production.cutlist` (resolved) on `/api/cover`, the panel's one status call.
3. **Preview reuses `regenerateCover`'s one-off `outPath` machinery** — a second rendering path is what the panel's header comment forbids. Known, accepted side effect (it is the CLI's shipped semantic, `cover.ts:768-778`): a preview updates `cover.json`'s provenance (text + frame record) while leaving the canonical JPEG untouched, so a follow-up Apply with a blank field adopts the previewed frame via the cheap path. That is a feature — Preview→like it→Apply re-uses the exact still — and the note the server already prints ("one-off --out: … was NOT updated") rides back to the panel like every other note.

---

### Task 1: `GET /api/cover` serves the finished video's span set

**Files:**
- Modify: `apps/cli/src/edit.ts` (`/api/cover` GET handler, lines 1183-1207)
- Test: `apps/cli/test/edit-server.test.ts` (this file already exercises the edit server's endpoints — follow its harness)

**Interfaces:**
- Produces: response gains `cutlist: Segment[]` — the RESOLVED `production.cutlist` (never `cutlistProposed`), each span zod-parsed individually with bad spans dropped (the `/api/cleanup` lenient idiom, `edit.ts:575-585`), `[]` on missing/corrupt production.json. Task 2 consumes this exact shape.

- [ ] **Step 1: Failing test:** with a workdir whose `production.json` holds both `cutlist` and a different `cutlistProposed`, `GET /api/cover` returns the RESOLVED `cutlist`'s spans; with no `production.json`, returns `cutlist: []` and still status 200.
- [ ] **Step 2:** Run: `pnpm --filter ossclip test -- edit-server`. Expected: FAIL (no `cutlist` key).
- [ ] **Step 3: Implement.** In the GET handler, before `send(200, …)`:

```ts
// The finished mp4's OWN span set — the RESOLVED cutlist, never the
// proposal /api/cleanup serves: the panel converts the playhead between
// the output clock and the source clock (handoff-cover-panel §1), and a
// proposal the user's vetoes already changed is the wrong ruler. Lenient
// per-span parse, [] on a missing or corrupt production.json — a cover
// panel that cannot convert must still open.
let coverCutlist: Segment[] = [];
try {
  const production = JSON.parse(await readFile(join(workdir, "production.json"), "utf8")) as { cutlist?: unknown };
  if (Array.isArray(production.cutlist)) {
    coverCutlist = production.cutlist.flatMap((s) => {
      const p = SegmentSchema.safeParse(s);
      return p.success ? [p.data] : [];
    });
  }
} catch {
  // degrade — same as /api/cleanup
}
```

and add `cutlist: coverCutlist` to the response object. `SegmentSchema`/`Segment` are already imported in this file (the `/api/cleanup` handler uses them).

- [ ] **Step 4:** Run — PASS. `pnpm typecheck`.
- [ ] **Step 5:** Commit: `git commit -m "feat(edit): /api/cover serves the finished video's resolved cutlist"`

### Task 2: Pure clock-crossing helpers in the panel module

**Files:**
- Modify: `apps/editor/src/CoverPanel.tsx` (pure exports live at the top of this file beside `coverRegenerateBody` — follow that pattern; add `cutlist: Segment[]` to `CoverInfo` too, imported as a type from `@ossclip/core/browser` like `CleanupPanel.tsx` does)
- Test: `apps/editor/test/cover-panel.test.ts`

**Interfaces:**
- Produces:

```ts
/** The playhead button's value for the CURRENT frame source, plus the sentence
 *  explaining a crossed clock (null when no conversion happened). */
export function playheadAtSeconds(args: {
  playheadOutSec: number;
  from: CoverFrom;
  cutlist: readonly Segment[];
}): { atSec: number; note: string | null };

/** Re-express a filled field when the frame-source toggle crosses clocks.
 *  Returns null when the field should be left alone (blank/invalid input, or
 *  no clock change). */
export function atFieldOnFromToggle(args: {
  atRaw: string;
  prevFrom: CoverFrom;
  nextFrom: CoverFrom;
  cutlist: readonly Segment[];
}): { atRaw: string; note: string } | null;
```

- Consumes: `cutlist` from Task 1; `TimeMap` from `@ossclip/core/browser`.

- [ ] **Step 1: Failing tests** (use a two-keep-span cutlist so the clocks genuinely differ, e.g. keep 0–10s and 20–30s of source → output 0–20s):

```ts
const CUTLIST: Segment[] = [
  { kind: "keep", srcIn: 0, srcOut: 10 },
  { kind: "cut", srcIn: 10, srcOut: 20 },
  { kind: "keep", srcIn: 20, srcOut: 30 },
]; // adjust literal shape to SegmentSchema's actual fields

it("playhead passes through untouched for the finished video", () => {
  expect(playheadAtSeconds({ playheadOutSec: 15, from: "final", cutlist: CUTLIST }))
    .toEqual({ atSec: 15, note: null });
});
it("playhead maps output → source for the original take, and says so", () => {
  const r = playheadAtSeconds({ playheadOutSec: 15, from: "source", cutlist: CUTLIST });
  expect(r.atSec).toBe(25); // 15s of output = 5s into the second kept span = 25s of source
  expect(r.note).toMatch(/15\.0.*finished.*25\.0.*original take/i);
});
it("empty cutlist: source playhead refuses to pretend, passes through with a warning note", () => {
  const r = playheadAtSeconds({ playheadOutSec: 15, from: "source", cutlist: [] });
  expect(r.atSec).toBe(15);
  expect(r.note).toMatch(/couldn't convert/i);
});
it("toggle final → source re-expresses the field", () => {
  expect(atFieldOnFromToggle({ atRaw: "15", prevFrom: "final", nextFrom: "source", cutlist: CUTLIST }))
    .toMatchObject({ atRaw: "25.00" });
});
it("toggle source → final clamps a cut-out instant to the nearest kept edge and says so", () => {
  const r = atFieldOnFromToggle({ atRaw: "15", prevFrom: "source", nextFrom: "final", cutlist: CUTLIST });
  expect(r!.atRaw).toBe("10.00"); // source 15s was cut; toOutputClamped → output 10s
  expect(r!.note).toMatch(/cut/i);
});
it("blank or invalid field: toggle leaves it alone", () => {
  expect(atFieldOnFromToggle({ atRaw: "", prevFrom: "final", nextFrom: "source", cutlist: CUTLIST })).toBeNull();
  expect(atFieldOnFromToggle({ atRaw: "abc", prevFrom: "final", nextFrom: "source", cutlist: CUTLIST })).toBeNull();
});
```

Before writing, check `SegmentSchema` in `packages/core/src/schema.ts` for the real segment literal shape and `parseAtSeconds` in CoverPanel for the field-validation rule to reuse.

- [ ] **Step 2:** Run: `pnpm --filter editor test -- cover-panel` (adjust filter name to the actual package name in `apps/editor/package.json`). Expected: FAIL.
- [ ] **Step 3: Implement.** Build `new TimeMap(cutlist)` inside the helpers (cheap; memoization is the component's business, not these functions'). `final→source` = `map.toSource(v)`; `source→final` = `map.toOutput(v) ?? map.toOutputClamped(v)` with a "that instant was cut — snapped to the nearest kept moment" note when the exact lookup missed. Doc comment must state the field's single meaning (design decision 1) and cite `CoverPanel.tsx`'s `playheadSec` contract for why input is always output time.
- [ ] **Step 4:** Run — PASS. `pnpm typecheck`.
- [ ] **Step 5:** Commit: `git commit -m "feat(editor): cover panel converts the playhead between output and source clocks"`

### Task 3: Wire the panel — button, toggle, and the field survives Apply

**Files:**
- Modify: `apps/editor/src/CoverPanel.tsx` (component body: playhead button ~line 347, from-toggle ~line 368, Apply handler line 286, initial fetch ~line 218 to store `cutlist`)
- Test: `apps/editor/test/cover-panel.test.ts` (the mounted-panel tests — follow the file's existing mount/mock-fetch style)

**Interfaces:**
- Consumes: Task 1's `cutlist` in the `/api/cover` body; Task 2's helpers.

- [ ] **Step 1: Failing tests** (mounted):
  - With `from = source` selected and a mocked `/api/cover` carrying `CUTLIST`, clicking `cover-playhead-btn` (playhead 15s) puts `25.00` in `cover-at-input` and shows the conversion note.
  - Clicking `cover-from-source` with `15` in the field rewrites it to `25.00`.
  - After a successful Apply, `cover-at-input` still shows the value that was used (assert against the regenerate mock's body too).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement.**
  - Store `cutlist` from the initial fetch in state (default `[]`).
  - Playhead button: `const r = playheadAtSeconds({ playheadOutSec: playheadSec(), from, cutlist }); setAtRaw(r.atSec.toFixed(2)); setClockNote(r.note);` — a new `clockNote` state rendered as a `footNote` under the row (reuse the existing note styling; `data-testid="cover-clock-note"`).
  - From-toggle: before `setFrom(v)`, run `atFieldOnFromToggle` and apply its result when non-null.
  - Apply: delete the `setAtRaw("")` at line 286 and replace the comment — the frame used is now VISIBLE in the field instead of implied by blankness; blank-for-cheap-path remains the *initial* state only. Note in the comment that a repeat Apply with the field untouched re-extracts the same frame (idempotent, a re-extract of the identical instant), which is the price of being able to iterate from the number — the handoff's problem 2.
  - Update the `playheadSec` prop's doc comment (lines 177-190): the parenthetical "(`--from source` is the other case, and the server re-maps nothing for it)" is no longer a gap — the panel now maps it; rewrite to say the panel owns that hop and cite the helpers.
- [ ] **Step 4:** Run panel tests + `pnpm typecheck` — green.
- [ ] **Step 5:** Commit: `git commit -m "fix(editor): cover playhead spends on the right clock; seconds field survives Apply"`

### Task 4: Preview without overwriting the cover

**Files:**
- Modify: `apps/cli/src/edit.ts` (two new routes beside the cover block, lines 1183-1284)
- Modify: `apps/editor/src/CoverPanel.tsx` (Preview button + preview image state)
- Test: `apps/cli/test/edit-server.test.ts`, `apps/editor/test/cover-panel.test.ts`

**Interfaces:**
- Produces: `POST /api/cover/preview` — same body schema as regenerate; runs `regenerateCover(workdir, { …, outPath: join(workdir, "cover-preview.jpg") }, seams)`; responds `{ ok, notes, previewImageUrl }` where `previewImageUrl = "/api/cover/preview-image?ts=<mtimeMs>"`. `GET /api/cover/preview-image` serves that file with the `/api/cover/image` posture (whole-file read, `no-store`, 404 when absent).

- [ ] **Step 1: Failing server test:** POST `/api/cover/preview` with `{ atSec: 3, from: "final" }` against the seamed harness (the suite's existing `renderCover`/frame seams — never real ffmpeg): asserts (a) `cover-preview.jpg` exists in the workdir, (b) the canonical cover file is byte-identical to before, (c) the response's `previewImageUrl` serves 200, (d) the one-off note is in `notes`.
- [ ] **Step 2:** Run — FAIL (404 route).
- [ ] **Step 3: Implement the routes.** Copy the regenerate handler's exact shape (busy-gate with the same `coverBusy` flag — a preview boots the same headless browser; body parse with the same three-key schema; 200-with-ok:false error posture). The one difference:

```ts
// The ONE-OFF path, derived HERE and never from the body (the regenerate
// handler's comment owns why). Same machinery as `ossclip cover --out`
// (handoff-cover-panel §3): the canonical cover is untouched, provenance
// updates to describe the previewed frame — which is what makes a
// follow-up blank-field Apply adopt it via the cheap path, and the one-off
// note riding back is the panel's disclosure of exactly that.
outPath: join(workdir, "cover-preview.jpg"),
```

- [ ] **Step 4:** Run server test — PASS.
- [ ] **Step 5: Panel:** a `Preview` button beside Apply (`data-testid="cover-preview-btn"`, disabled under the same `busy`/validity rules), posting the same `coverRegenerateBody` to `/api/cover/preview`; on success set a `previewUrl` state shown in the image box **in place of** the cover with a visible "Preview — not saved" badge (`data-testid="cover-preview-badge"`) and the notes; a successful real Apply clears `previewUrl`. Mounted test: preview shows badge + preview image and leaves the `/api/cover` imageUrl untouched; Apply afterwards clears the badge.
- [ ] **Step 6:** Run all editor + cli tests, `pnpm typecheck` — green.
- [ ] **Step 7:** Commit: `git commit -m "feat(cover): non-destructive Preview in the panel via the one-off --out machinery"`

### Task 5: Findings entry + PR

- [ ] **Step 1:** Append a findings section to `docs/PHASE1-FINDINGS.md` (next free § after the anchoring plan's — coordinate numbering if both branches touch it; both appending is exactly what conflicted #11/#12, so this branch should take the number AFTER the anchoring branch's and expect a trivial rebase): the two-clock capture/spend mismatch, the field-semantics decision, and the preview-updates-provenance semantic.
- [ ] **Step 2:** `pnpm test && pnpm typecheck && pnpm build` — green (build matters: the editor page ships from `editor-dist/`).
- [ ] **Step 3:** Push branch, open PR titled `Cover panel spends the playhead on the right clock` linking the handoff.
