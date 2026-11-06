# Logo Finder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During `produce --produce`, flag spoken names the overlay library lacks, fetch 3–4 logo candidates from each name's official site, and let the author pick one from a dashed chip on the editor's overlay lane.

**Architecture:** One mechanical-tier LLM call flags `{name, word, domain}`. A pure validator in core keeps only flags that sit on the right word. The CLI fetches each domain's homepage through an address-guarded fetch, extracts logo URLs with a pure HTML scanner, downloads them through the existing `fetchLibraryBytes` caps, and writes them under `<workdir>/logo-candidates/`. Suggestions live in `production.json.overlays.suggestions`. The editor draws them as dashed chips, and a pick goes through the existing library-add → stage → `addOverlay` path with a new `fromSuggestion` link.

**Tech Stack:** TypeScript, zod/v4, vitest, node:http/https (no new dependency), React editor, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-06-logo-finder-design.md` (builds on `docs/superpowers/specs/2026-11-05-overlay-library-design.md`).

## Global Constraints

- Work on a branch in a worktree (`feat/logo-finder`), never on `main`. At the time of writing, `main` has uncommitted work (I3 no-room drop, edit-server Origin guard). Branch only after that is committed, so the worktree carries it.
- Tests: `pnpm vitest run` **from the repo root** (`pnpm --filter … test` runs nothing). `pnpm typecheck`. `pnpm build`. Editor e2e: `cd apps/editor && E2E_EDIT_PORT=5274 E2E_VITE_PORT=5273 npx playwright test`. Never use ports 5173/5174 (the author's own `ossclip edit`).
- Tests never touch `~/.ossclip`. The library dir and the workdir are always injected temp dirs.
- No test touches the network. `fetch` and DNS `lookup` are injected.
- Values from the LLM or the user are parsed with zod, never cast.
- No new npm dependency.
- Comments say why, citing the spec section (`logo-finder spec §Step 2`).
- Numbers, verbatim from the spec or ruled here:
  - at most **8 flags** per video, earliest kept
  - at most **4 candidates** per name
  - **5 MB** per candidate file
  - **8 s** per request
  - **30 s** total for the fetch step
  - **4 sites** in parallel
  - raster short side **≥ 64 px**
  - **3 redirects** max per candidate (ruling: the tray's 5 is for hand-pasted links; a homepage needs fewer)
- Report lines, verbatim:
  - `logo finder: skipped (no LLM provider)`
  - `logo finder: skipped (the LLM call failed: <reason>)`
  - `logo finder: no new names`
  - `logo finder: <N> names (<A, B, …>) — <K> with logos, <M> without (<domain> <note>; …)`. Drop the `, <M> without (…)` part when M is 0.

## Rulings on the spec (made while planning)

- **Pinned guard without undici.** The spec says "an undici dispatcher whose `lookup` refuses those addresses". `undici` is not a direct dependency, and Node's global `fetch` cannot take a custom `lookup` without it. The plan builds a `fetch`-compatible function on `node:http`/`node:https` whose `lookup` option drops private addresses. The guard works the same way: the check happens inside the connect, so a DNS answer cannot change between check and connect. It is passed to `fetchLibraryBytes` through the `fetch` seam that already exists, so `fetchLibraryBytes` needs no new parameter.
- **Plan presence.** `production.json.overlays` is written when there are placements OR suggestions. Its shape is `{entries: [], placements: [], suggestions}` when only suggestions exist.
- **Paste my own.** The tray request gains `name?` and `fromSuggestion?`, so a pasted logo also hides its chip.

## Review Focus

1. **A flagged name whose word was later cut** (a recut after the finder ran). The chip must not sit on a cut word. Expected: it moves to the next kept mention of the name, or is hidden when no kept mention is left. Covered in Task 1, `visibleSuggestions`.
2. **A site that answers 200 with an HTML error page at an image URL.** Expected: it is not a candidate. Covered in Task 4 (sniff check).
3. **A redirect from a public host to `127.0.0.1` or `192.168.x.x`.** Expected: refused, and no connection is made. Covered in Task 3.
4. **Re-running `produce` with nothing changed.** Expected: no LLM call (cache hit), and the same suggestion ids, so earlier skips still apply. Covered in Task 5.
5. **Picking the same candidate twice** (pick, undo, pick). Expected: one library entry, not two. Covered in Task 6 (content-hash reuse).

---

### Task 1: Core schemas and chip visibility

**Files:**
- Modify: `packages/core/src/schema.ts`, the overlay block (≈ lines 140–215)
- Modify: `packages/core/src/overrides.ts`, the `overlays` object (≈ line 910)
- Create: `packages/core/src/logo-suggestions.ts` (browser-safe, no fs)
- Modify: `packages/core/src/browser.ts` and `packages/core/src/index.ts` (export it)
- Test: `packages/core/test/logo-suggestions.test.ts`

**Interfaces:**
- Produces:
  - `LogoCandidateSchema`, an object with:
    - `file: string`, matching `^logo-candidates/[a-z0-9-]+/[0-9]\.(png|jpg|webp|svg|gif)$`
    - `source: "header" | "icon" | "manifest" | "og"`
    - `width?: number`
    - `height?: number`
  - `LogoSuggestionSchema`, an object with:
    - `id`, matching `^[a-z0-9][a-z0-9-]*$`
    - `name: string`, 1–80 characters
    - `word: number`, an int ≥ 0
    - `domain?: string`
    - `candidates: LogoCandidate[]`, max 4
    - `note?: string`
  - Types `LogoCandidate` and `LogoSuggestion`.
  - `ProductionOverlaysSchema` gains `suggestions: z.array(LogoSuggestionSchema).max(8).optional()`.
  - `OverlayPlacementSchema` gains `fromSuggestion: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional()`.
  - `OverrideDocSchema.overlays` gains `skippedSuggestions: z.array(z.string()).default([])`.
  - `suggestionIdFor(name: string): string`. It lower-cases the name, maps runs of anything outside `[a-z0-9]` to `-` and trims dashes. Empty → `"logo"`. So `"Google Gemini"` → `"google-gemini"`.
  - `visibleSuggestions(suggestions, layer, words, kept): VisibleSuggestion[]`, where `VisibleSuggestion = LogoSuggestion & { atWord: number }`.

- [ ] **Step 1: Write the failing tests** in `packages/core/test/logo-suggestions.test.ts`:

```ts
it("ids are the name's slug, so they survive a recut", () => {
  expect(suggestionIdFor("Google Gemini")).toBe("google-gemini");
  expect(suggestionIdFor("  Kimi!! ")).toBe("kimi");
});
it("a skipped suggestion is hidden", () => {
  const out = visibleSuggestions([sug("kimi", 3)], { ...emptyLayer, skippedSuggestions: ["kimi"] }, words, () => true);
  expect(out).toEqual([]);
});
it("a live placement fromSuggestion hides its chip, a removed one does not", () => {
  const added = [{ id: "u1", entryId: "gemini", word: 2, source: "user" as const, fromSuggestion: "google-gemini" }];
  expect(visibleSuggestions([sug("google-gemini", 2)], { ...emptyLayer, added }, words, () => true)).toEqual([]);
  const removed = { ...emptyLayer, added, edits: { u1: { removed: true } } };
  expect(visibleSuggestions([sug("google-gemini", 2)], removed, words, () => true)).toHaveLength(1);
});
it("a cut word falls forward to the next kept mention of the name, else hides", () => {
  // words: ["I", "use", "Kimi", "and", "Kimi"]; word 2 cut
  expect(visibleSuggestions([sug("kimi", 2, "Kimi")], emptyLayer, words5, (i) => i !== 2)[0]!.atWord).toBe(4);
  expect(visibleSuggestions([sug("kimi", 2, "Kimi")], emptyLayer, words5, (i) => i < 2)).toEqual([]);
});
it("old production.json and overrides.json still parse unchanged", () => {
  expect(ProductionOverlaysSchema.parse({ entries: [], placements: [] }).suggestions).toBeUndefined();
});
```

(`sug(id, word, name = id)` builds a `LogoSuggestion` with no candidates. `emptyLayer = { edits: {}, added: [], entries: [], skippedSuggestions: [] }`.)

- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/logo-suggestions.test.ts`. Expected: FAIL, missing exports.
- [ ] **Step 3: Implement the schema fields and `logo-suggestions.ts`.** A placement is "live" when it is in `layer.added`, or in the plan, and `layer.edits[id]?.removed !== true`. Fall-forward matches the name with the `normalizeMatchToken` tokenizer from `overlay-match.ts`, as a contiguous word sequence over kept words after `word`.
- [ ] **Step 4: Run** the test, then `pnpm typecheck`. Expected: PASS, exit 0.
- [ ] **Step 5: Commit** `feat(core): logo suggestion schema and chip visibility`.

---

### Task 2: Flag names (the LLM call and its validator)

**Files:**
- Create: `packages/core/src/producer/logo-finder.ts`
- Modify: `packages/core/src/producer/index.ts` (export it)
- Modify: `packages/core/src/producer/mock.ts`: the `logo_flags` schema name returns `{ names: [] }`
- Test: `packages/core/test/logo-finder.test.ts`

**Interfaces:**
- Consumes: `LlmProvider` (`provider.ts`), `suggestionIdFor` (Task 1), `normalizeMatchToken` and `matchLibrary` (`overlay-match.ts`).
- Produces:
  - `LOGO_FINDER_PROMPT_VERSION = 1`
  - `LogoFlagsSchema`: `{ names: { name: string; word: number; domain?: string }[] }`
  - `LogoFlag = { id: string; name: string; word: number; domain?: string }`
  - `validateLogoFlags(raw, words, kept, libraryNames): { flags: LogoFlag[]; dropped: { name: string; reason: "wrong-word" | "in-library" | "duplicate" | "over-cap" }[] }`
    - `words: readonly {text: string}[]`
    - `kept: (i: number) => boolean`
    - `libraryNames: readonly string[]`
  - `normalizeDomain(raw: string): string | undefined`
  - `generateLogoFlags(provider, words, kept, libraryNames): Promise<ReturnType<typeof validateLogoFlags>>`, calling `provider.complete` with `{ tier: "mechanical", schemaName: "logo_flags" }`
  - `logoFlagsCacheKey({ promptVersion, words, libraryNames }): string`, an 8-hex sha1 in the `sfxCacheKey` style

- [ ] **Step 1: Write the failing tests:**

```ts
const words = ["I", "built", "it", "on", "Firebase", "with", "Google", "Gemini"].map((text) => ({ text }));
it("keeps a flag on its word and drops one on the wrong word", () => {
  const r = validateLogoFlags({ names: [
    { name: "Firebase", word: 4, domain: "firebase.google.com" },
    { name: "Gemini", word: 1, domain: "gemini.google.com" },
  ] }, words, () => true, []);
  expect(r.flags.map((f) => f.name)).toEqual(["Firebase"]);
  expect(r.dropped).toEqual([{ name: "Gemini", reason: "wrong-word" }]);
});
it("a multi-word name may start at its first word", () => {
  const r = validateLogoFlags({ names: [{ name: "Google Gemini", word: 6 }] }, words, () => true, []);
  expect(r.flags[0]).toMatchObject({ id: "google-gemini", word: 6 });
});
it("drops library names, cut words, duplicates and anything past 8", () => { /* one assertion per reason */ });
it("normalizeDomain keeps a bare host and refuses ports, IPs, paths and dotless names", () => {
  expect(normalizeDomain("https://Claude.ai/")).toBe("claude.ai");
  expect(normalizeDomain("claude.ai:8080")).toBeUndefined();
  expect(normalizeDomain("10.0.0.1")).toBeUndefined();
  expect(normalizeDomain("[::1]")).toBeUndefined();
  expect(normalizeDomain("localhost")).toBeUndefined();
});
it("a bad domain keeps the flag without one", () => {
  expect(validateLogoFlags({ names: [{ name: "Firebase", word: 4, domain: "localhost" }] }, words, () => true, []).flags[0]!.domain).toBeUndefined();
});
it("asks the mechanical tier and lists library names in the prompt", async () => { /* stub provider records req */ });
```

- [ ] **Step 2: Run** the test file. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **"Right word":** the normalized tokens of `name` contain `normalizeMatchToken(words[word].text)`, and `kept(word)`.
  - **"In library":** the name, normalized and joined, equals any library name normalized the same way.
  - **Cap:** sort by `word`, then keep the first 8.
  - **The system prompt says:** named products, companies, tools, services, models and organisations only; never generic nouns, people or places; prefer omitting over guessing; `domain` is the official site's bare host.
  - **The user prompt:** indexed kept words (`12: Firebase`), then the library names.
- [ ] **Step 4: Run** the tests and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): flag names the overlay library lacks`.

---

### Task 3: Address-guarded fetch

**Files:**
- Create: `apps/cli/src/guarded-fetch.ts`
- Test: `apps/cli/test/guarded-fetch.test.ts`

**Interfaces:**
- Produces:
  - `isPublicAddress(ip: string): boolean`. False for:
    - `127.0.0.0/8`
    - `10/8`, `172.16/12`, `192.168/16`
    - `169.254/16`
    - `0.0.0.0/8`
    - `100.64/10`
    - `::`, `::1`
    - `fc00::/7`, `fe80::/10`
    - IPv4-mapped forms of all of these
  - `createGuardedFetch(o?: { lookup?: LookupFn; timeoutMs?: number }): typeof fetch`. A GET-only `fetch` built on `node:http`/`node:https`, which:
    - passes a `lookup` that calls `o.lookup ?? dns.lookup` with `all: true`, drops non-public addresses, and errors `refused: <host> resolves to a private address` when none remain
    - honours `redirect: "manual"` (returns 3xx as-is) and `signal`
    - returns `new Response(Readable.toWeb(res), { status, headers })`
    - refuses IP-literal hosts with `isPublicAddress` before connecting

- [ ] **Step 1: Write the failing tests.**
  - The address table: each range above, plus `8.8.8.8` and `2606:4700::1` as public.
  - Run a real local `http.createServer` on `127.0.0.1`. With an injected `lookup` that returns `127.0.0.1` for `public.test`, `createGuardedFetch` refuses `http://public.test:<port>/`, and the server's request handler is never called.
  - With a `lookup` that returns `[{address:"10.0.0.5"},{address:"127.0.0.1"}]`, it is refused.
  - **Redirect to a private address.** Give `createGuardedFetch` an optional `isAllowed?: (ip: string, host: string) => boolean`, defaulting to `isPublicAddress(ip)`. The test allows `127.0.0.1` only for host `first.test`. A local server at `first.test` answers `302 Location: http://127.0.0.1:<port>/x`. `fetchLibraryBytes(url, { fetch: createGuardedFetch({ lookup, isAllowed }), … })` must end in the refusal, and the `/x` handler must never be called.
- [ ] **Step 2: Run** `pnpm vitest run apps/cli/test/guarded-fetch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): fetch that refuses private addresses at connect time`.

---

### Task 4: Candidate extraction and the fetch step

**Files:**
- Modify: `packages/core/src/overlay-library.ts`: add `imageSize`
- Create: `apps/cli/src/logo-candidates.ts` (pure: HTML → URLs)
- Create: `apps/cli/src/logo-finder.ts` (orchestration and disk)
- Test: `packages/core/test/overlay-library.test.ts` (add cases), `apps/cli/test/logo-candidates.test.ts`, `apps/cli/test/logo-finder.test.ts`
- Fixtures: `apps/cli/test/fixtures/logo-pages/*.html`, hand-written and small

**Interfaces:**
- Consumes: `LogoFlag` (Task 2), `LogoSuggestion` (Task 1), `createGuardedFetch` (Task 3), `fetchLibraryBytes` (`library-fetch.ts`), `sniffImageFormat` (core).
- Produces:
  - `imageSize(bytes: Uint8Array): { width: number; height: number } | null`, reading the png, gif, jpg (SOF scan) and webp (VP8/VP8L/VP8X) headers. Always null for svg.
  - `extractLogoCandidates(html, pageUrl, name): { url: string; source: "header" | "icon" | "manifest" | "og" }[]`, plus `manifestUrl(html, pageUrl): string | undefined` and `manifestIcons(json: unknown, manifestUrl: string): string[]`, largest first.
    - The scanner reads start tags only, tracking `<header>`/`<nav>` depth.
    - Order: header/nav `<img>` whose `class|id|alt|aria-label|src` contains `logo` or the name (case-insensitive) → `apple-touch-icon` and `icon` links by declared size, largest first, svg counting as largest → manifest → `og:image`.
    - URLs are resolved against `pageUrl`, kept http(s) only, and deduped.
  - `findLogoCandidates(flags, o): Promise<LogoSuggestion[]>`, where `o` is:
    - `work: string`
    - `fetch: typeof fetch`
    - `budgetMs?: number` (30000)
    - `perRequestMs?: number` (8000)
    - `concurrency?: number` (4)
    - `now?: () => number`

- [ ] **Step 1: Write the failing tests.**
  - `imageSize` on tiny generated png, gif, jpg and webp buffers. Build them in the test; there is a png builder in existing tests, so reuse its pattern.
  - `extractLogoCandidates` on these fixtures:
    - `header-img.html`: header logo first, then icons
    - `icons-only.html`: 180 apple-touch before the 32 icon
    - `og-only.html`
    - `inline-svg.html`: an inline `<svg>` logo yields nothing from the header
    - relative URLs resolved
  - `findLogoCandidates` with a fake `fetch` (a map from URL to Response):
    - writes `logo-candidates/firebase/0.png` and returns `candidates[0].source === "header"`
    - drops an HTML body served at an image URL
    - drops a 32×32 png
    - dedupes identical bytes
    - keeps at most 4
    - a flag with no `domain` gives `candidates: []` and `note: "no official site"`
    - a homepage 500 gives `note: "firebase.google.com answered 500"`
    - with `now` advanced past the budget, the rest get `note: "site timed out"` and nothing is written for them
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Each download goes through `fetchLibraryBytes(url, { fetch: o.fetch, maxBytes: 5 * 1024 * 1024, timeoutMs: perRequestMs, maxRedirects: 3 })`.
  - The homepage is fetched the same way, decoded as UTF-8, and capped at 2 MB.
  - A file is written only after its sniff and size pass, as `<n>.<format>`, with `n` counting kept candidates from 0.
  - The budget is enforced by racing the whole step against `budgetMs` and recording, per flag, whether it finished.
- [ ] **Step 4: Run** the tests, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): fetch logo candidates from a name's official site`.

---

### Task 5: Wire into produce

**Files:**
- Modify: `apps/cli/src/produce.ts`, the overlay block (≈ lines 4665–4790) and the `production.json` write (≈ line 4881)
- Modify: `apps/cli/src/overlays.ts`: add `formatLogoFinderLine`
- Test: `apps/cli/test/logo-finder-produce.test.ts`; extend `apps/cli/test/overlays.test.ts` if it exists, else add the line tests to the new file

**Interfaces:**
- Consumes: `generateLogoFlags`, `logoFlagsCacheKey`, `LOGO_FINDER_PROMPT_VERSION` (Task 2), `findLogoCandidates` (Task 4), `createGuardedFetch` (Task 3), `priorOverlayPlan` (`overlays.ts`).
- Produces:
  - `formatLogoFinderLine(result: { skipped?: string; suggestions?: LogoSuggestion[] }): string`, giving exactly the Global Constraints lines.
  - New `ProduceOptions` fields, for tests only:
    - `logoFetch?: typeof fetch`, default `createGuardedFetch()`
    - `logoFinderBudgetMs?: number`

- [ ] **Step 1: Write the failing tests.**
  - `formatLogoFinderLine` gives each verbatim line.
  - A produce test following the existing produce-with-mock tests (find one with `grep -ln "MockProvider\|provider: \"mock\"" apps/cli/test`). It injects a provider whose `logo_flags` answer flags a fixture word, and a fake `logoFetch`. Assert that `production.json.overlays.suggestions[0]` has the id, the word and one candidate, and that `report.txt` contains the line.
  - A second run with the same inputs makes zero `logo_flags` calls (the `logo-flags-<key>.json` cache).
  - A `--scenes` replay makes no call, no fetch, and carries the suggestions forward.
  - A run without `--produce` carries the prior suggestions forward. On a fresh workdir it prints `logo finder: skipped (no LLM provider)`.
  - A provider that throws on `logo_flags` still finishes, printing `logo finder: skipped (the LLM call failed: …)`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The finder runs after `applyOverlayOverrides`, only when `provider && opts.produce === true && !opts.scenes`.
  - `libraryNames` is every `names[]` of `loadLibrary()`. `kept(i)` is `at[i] !== null`.
  - The flags cache is `<work>/logo-flags-<key>.json`, holding `{flags}`, zod-parsed, with malformed meaning re-ask.
  - The candidate files are cached by the files themselves: a re-run with the same flags and an existing `logo-candidates/<id>/` reuses them without fetching. That keeps re-runs offline.
  - On every other run, `priorOverlayPlan(work)?.suggestions` is carried forward.
  - Write `overlays` when placements or suggestions exist (see the ruling).
  - Log the line to the console and add it to `report.txt` next to the overlay accounting line.
- [ ] **Step 4: Run** the produce tests and the full `pnpm vitest run`. Expected: PASS. The verify-ossclip baseline does not move, because the fixture drive has no `--produce`.
- [ ] **Step 5: Commit** `feat(cli): logo finder runs in produce and lands in production.json`.

---

### Task 6: Server routes

**Files:**
- Modify: `apps/cli/src/edit.ts`: `LibraryAddBodySchema` (≈ line 493), `POST /api/library` (≈ line 3026), and a new route next to `/api/library/file`
- Test: `apps/cli/test/edit-server.test.ts` (extend; it already injects a temp library dir)

**Interfaces:**
- Consumes: `LogoSuggestionSchema`, `ProductionOverlaysSchema` (Task 1).
- Produces:
  - `GET /api/logo-candidates/file?suggestion=<id>&n=<0-3>`. It looks up the suggestion in the open workdir's `production.json` and serves `candidates[n].file` from the workdir, with `IMAGE_SANDBOX_HEADERS`. Unknown → 404; no workdir → 409.
  - The `POST /api/library` source union gains `z.strictObject({ candidate: z.strictObject({ suggestion: z.string(), n: z.number().int().min(0).max(3) }) })`. The server resolves it the same way and never takes a client path. Unknown → 400 `no such logo candidate`.
  - **Reuse:** before `addLibraryEntry`, if any loaded library entry's file bytes have the same sha1 as the incoming bytes, return that entry (200) instead of adding. Applies to every source kind.
  - `GET /api/overlays/plan` already returns `overlays` through `ProductionOverlaysSchema`. With Task 1 it carries `suggestions`. No change, but assert it in a test.

- [ ] **Step 1: Write the failing tests:**
  - a candidate add creates the entry with the given name
  - the same candidate twice gives one entry
  - an unknown suggestion gives 400
  - the file route serves the bytes with the sandbox headers
  - a traversal-looking `suggestion` (`../x`) gives 404
  - the plan route includes `suggestions`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the edit-server tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(edit): serve logo candidates and add one to the library`.

---

### Task 7: Editor — chips, popover, actions

**Files:**
- Modify: `apps/editor/src/useEdits.ts`:
  - `addOverlay` gains `fromSuggestion?: string`
  - new actions `skipSuggestion { id }` and `unskipSuggestion { id }`
  - both are undoable, and both write through `withOverlays` (the slot is removed when empty, so `skippedSuggestions: []` must not keep the slot alive)
- Modify: `apps/editor/src/overlayLane.ts`: add `suggestionChips(...)`
- Modify: `apps/editor/src/overlayLane.ts`: `OverlayTrayRequest`'s `add` mode gains `name?` and `fromSuggestion?`
- Create: `apps/editor/src/LogoSuggestionPopover.tsx`
- Modify: `apps/editor/src/Timeline.tsx` (draw the chips in the overlay lane), `apps/editor/src/App.tsx` (state and handlers), `apps/editor/src/OverlayTray.tsx` (pre-fill the name; pass `fromSuggestion` to `onStaged`)
- Test: `apps/editor/test/overlayLane.test.ts`, `apps/editor/test/useEdits.test.ts` (or wherever overlay actions are tested; find with grep), `apps/editor/e2e/logo-finder.spec.ts`

**Interfaces:**
- Consumes: `visibleSuggestions` and `LogoSuggestion` (Task 1). The server routes (Task 6).
- Produces:
  - `suggestionChips(suggestions, layer, plan, words, map): { id; name; atSec; word: number; candidateCount: number; note?: string }[]`. It calls `visibleSuggestions`, then maps `atWord` through the ruler's clock the way `overlayLaneMarkers` does.
  - `logoCandidateUrl(suggestion: string, n: number): string`
  - The lane test ids:
    - chip: `logo-suggestion-<id>`
    - popover: `logo-suggestion-popover`
    - candidate: `logo-candidate-<n>`
    - buttons: `logo-use`, `logo-skip`, `logo-paste-own`

- [ ] **Step 1: Write the failing unit tests:**
  - `suggestionChips` hides skipped and picked suggestions
  - `skipSuggestion` then undo restores the chip
  - `addOverlay` with `fromSuggestion` stores the field on the `added` record
  - an emptied `skippedSuggestions` drops the slot
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Chips:** dashed outline, the name and a `?`, visually distinct from overlay chips. They never feed `playerProps`.
  - **Popover:** opens beside the chip and shows the name, a timestamp, up to 4 thumbnails (`logoCandidateUrl`) and the `note` when there are none.
  - **Use this:** select a thumbnail (the first is preselected) and edit the name (pre-filled). Then:
    1. `POST /api/library {name, source: {candidate}}`
    2. `POST /api/overlays/stage {entryId}`, the existing tray path
    3. dispatch `addOverlay({ entry, word: chip.word, source: "user", fromSuggestion: chip.id })`
  - **Errors** show inline in the popover.
  - **Skip:** dispatch `skipSuggestion`.
  - **Paste my own:** `openOverlayTray({ mode: "add", word, name, fromSuggestion })`.
- [ ] **Step 4: Write the e2e** `apps/editor/e2e/logo-finder.spec.ts`. Follow the existing overlay e2e's fixture workdir setup: write `production.json` with one suggestion and a candidate png into the temp workdir. Then:
  - the chip shows
  - clicking it shows `logo-candidate-0`
  - Use this makes `overlay-chip-*` appear and the suggestion chip disappear
  - after a reload the overlay persists and the chip stays hidden
  - undo brings the chip back
  - Skip hides a second suggestion, and it survives a reload
- [ ] **Step 5: Run** the unit tests, then `pnpm build`, then the e2e suite (the command in Global Constraints). Expected: all PASS.
- [ ] **Step 6: Commit** `feat(editor): logo suggestion chips with pick, skip and paste`.

---

### Task 8: End-to-end proof

**Files:**
- Create: `docs/verification/2026-11-06-logo-finder/`, holding evidence only

- [ ] **Step 1:** Run the verify-ossclip baseline drive (`.claude/skills/verify-ossclip/scripts/drive.sh`). Expected: every baseline assertion PASS, unchanged.
- [ ] **Step 2:** Drive `pnpm ossclip fixtures/fixture.mp4 --transcript fixtures/fixture.transcript.json --workdir "$WD" --produce --llm mock` with an injected test hook. If the CLI cannot inject a fake `fetch`, run the Task 5 produce test with `--reporter verbose` instead, and copy its workdir's `production.json` and `report.txt`. Expected: `report.txt` has a `logo finder:` line, and a plain run carries the suggestions forward.
- [ ] **Step 3:** Run the full suite (`pnpm vitest run`), `pnpm typecheck`, `pnpm build` and the e2e suite. Record the counts in the evidence folder's `README.md`.
- [ ] **Step 4: Commit** `docs: logo finder verification evidence`.
