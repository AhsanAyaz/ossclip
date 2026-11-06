# Logo finder: fetch logo candidates for names the library lacks — design

Date: 2026-11-06. Status: draft for review.

## Why

The author says "Firebase", "Google Gemini", "Claude" and "Kimi" on camera and
wants each logo to pop on that word. The overlay library (project 1,
`2026-11-05-overlay-library-design.md`) already does that for names it holds.
For names it lacks, the author today leaves the editor, searches Google, finds
the official site, downloads the logo, and pastes it into the tray. Four names
is four round trips. Noticing the name was never the slow part; the hunting
and downloading is.

This is project 2 of 3 from the overlay brainstorm. The original sketch was
"the LLM flags mentions, the tray shows a paste box". The author sharpened it:
**ossclip fetches the candidates itself and the author picks.**

## Goals

- During `produce`, the LLM flags spoken names that deserve a logo and are
  not in the library yet (products, companies, tools, models).
- For each flagged name, ossclip fetches **3–4 logo candidates from the
  name's official site**, before the editor opens.
- In the editor, each flagged name is a **dashed chip on the overlay lane** at
  the word, and clicking it pops up its candidates right there (mockup option
  A, the author's pick). Three actions: **Use this**, **Skip**, **Paste my
  own**.
- **Use this** saves the logo to the global library under the flagged name
  and turns the chip into an ordinary overlay placement at that word. The next
  video gets it from project 1's plain word match, with no LLM.

## Non-goals

- Memes, GIFs and reaction moments (project 3).
- Images that are not a named thing's logo (a photo of a place, a screenshot).
- Fetching anything at render time, or on a replay.
- Choosing a logo automatically. The author always picks.
- Background removal, recolouring, or cropping of candidates.
- A licence check. The author ruled that the official logo from the official
  site is fine.

## Anti-goals

These make it a failure even if it technically works:

- **Chips on things that are not logos.** "Firebase" yes; "database", "the
  cloud", "my laptop" no. A wrong chip costs a click to skip; ten wrong chips
  make the author ignore the lane. Prefer flagging too few over too many.
- **A `produce` that fails or hangs because a site is slow or the LLM is
  down.** The finder is best-effort: on any failure `produce` finishes with no
  chips (or chips with no candidates) and says why in `report.txt`.
- **Candidates that are blank, tiny, or not images.** A 16×16 favicon or an
  HTML error page never shows as a candidate.
- **A rendered video that changes because of the finder.** An unpicked chip
  renders nothing and makes no sound.
- **Reaching the author's own network.** Names come from a transcript and the
  domain comes from an LLM; neither may point the fetcher at localhost or a
  LAN address.

## Decided (by the author)

- Fetch candidates and let the author pick (not just a paste box).
- Source: the official site's own logo. No licence requirement.
- Timing: candidates are fetched during `produce` and waiting when the editor
  opens. No button to press, no waiting in the editor.
- UI: click the dashed chip on the timeline; candidates pop up beside it.
- Skip is for this video only; the name is flagged again next video.
- One chip per name per video, at its first kept mention, even if said five
  times.
- No LLM or no network: `produce` still finishes, with no chips, and
  `report.txt` says why.

## Design

### When the finder runs

- It runs inside `produce` **only when an LLM provider is in play** (the
  `--produce` path). A run without an LLM gets no chips and one report line:
  `logo finder: skipped (no LLM provider)`. (My call: the plain `produce`
  path stays offline and LLM-free, as project 1 promised.)
- **Fresh run or `--produce` re-plan:** the finder runs.
- **Replay** (the editor's Render button, `--scenes`) and **plain re-runs**
  (no LLM): it never runs. The suggestions are carried forward from the prior
  `production.json`, the same way `priorOverlayPlan` carries placements (my
  call; a run without the finder must not hit the network or wipe chips the
  author has not handled yet). A plain *first* run has nothing to carry and
  gets the "skipped" report line.
- It runs **after** library matching, against the kept words, so it knows
  which names are already covered.

### Step 1 — flag names (one LLM call)

- One `mechanical`-tier call through the existing `LlmProvider` seam, with a
  zod schema. (My call: a separate small call, not folded into the beat sheet,
  so a finder failure never costs the edit.)
- **Input:** the kept transcript as indexed words, plus every library name and
  alias (so the LLM does not re-flag them).
- **Output, per name:**
  `{ name, word, domain }`
  - `name`: the display name as it should be saved ("Google Gemini").
  - `word`: the index of the first kept word of its first mention.
  - `domain`: the official site's host (`firebase.google.com`, `claude.ai`).
    A bare host, no path or scheme.
- **The prompt asks for** named products, companies, tools, services, models
  and organisations only, never generic nouns, people, or places. It says to
  prefer omitting a name over guessing.
- **Validation after the call (pure, in core):**
  - `word` must be a kept-word index, and the spoken words there must
    contain the name or one of its words (case-insensitive, using the
    project 1 tokenizer). A flag pointing at the wrong word is dropped. This
    keeps the anti-goal "logo on the wrong word" from project 1.
  - A name that `matchLibrary` would match (any library name or alias) is
    dropped.
  - Duplicates (same name, case-insensitive) keep the earliest word.
  - `domain` must parse as a hostname with a dot, no port and no IP literal.
    A bad domain does not drop the flag; the chip appears with no candidates
    (paste box only).
  - Cap: at most **8 flags per video**, keeping the earliest (my call).
- **Cache:** the result is cached in the workdir keyed on transcript, library
  names and a prompt version, the same as the sfx plan (`sfx-<key>.json`), so
  a re-plan with nothing changed costs no call.

### Step 2 — fetch candidates (network, best-effort)

For each flag with a valid domain, fetch `https://<domain>/` and collect
candidate image URLs from it, in this order (my call; the builder may
re-rank with real sites as fixtures):

1. `<img>` in the page header or nav whose `class`, `id`, `alt`,
   `aria-label` or `src` contains "logo" (or the name).
2. `<link rel="apple-touch-icon">` and `<link rel="icon">` with the largest
   declared size, and SVG icons.
3. Icons from the web app manifest (`<link rel="manifest">`), largest first.
4. `og:image` (often a banner, not a logo; last).

Not used (my calls):

- **Inline `<svg>`** in the header. It usually takes its colour from page CSS
  (`currentColor`, class fills), so saved on its own it often renders black
  or invisible, which breaks the "no blank candidates" anti-goal. A later
  version may serialize it with inlined styles.
- **`/favicon.ico`.** ICO is not a library format, and most are 16–48 px,
  under the size floor.

Then:

- Download each candidate with the existing `fetchLibraryBytes` and its caps
  (http(s) on every hop, redirects capped, streaming size cap, one timeout),
  with tighter limits for this step: about 5 MB per file and 8 s per request
  (my call).
- **Never fetch a private address.** Refuse loopback, link-local, private
  (RFC 1918, ULA) and unspecified addresses, for the page and for every image
  URL found on it, on every redirect hop. The check is **pinned to the
  connection** (an undici dispatcher whose `lookup` refuses those addresses),
  not check-then-fetch, so a DNS answer cannot change between the check and
  the connect (my call). `fetchLibraryBytes` gains an optional dispatcher
  parameter for this. The guard applies **only to the finder**: the
  project 1 tray URL add keeps working for `localhost` and LAN image URLs the
  author pastes on purpose.
- Keep a candidate only if `sniffImageFormat` recognises it and, for a raster
  image, it is at least 64 px on its short side. SVG has no such check.
- Dedupe by content hash. Keep the **first 4**.
- **Budgets:** at most 4 sites in parallel, and a hard **30 s total** for the
  whole step. Whatever is still pending at 30 s is abandoned, and those names
  get chips with what they have so far (possibly none).
- Candidates are written to `<workdir>/logo-candidates/<suggestionId>/<n>.<ext>`.
  They are never written into the library until the author picks one.

### Stored shape

`production.json` gains `overlays.suggestions`:

```ts
LogoSuggestion = {
  id: string,          // stable: slug of the normalized name (one per name per video)
  name: string,        // display name to save under
  word: number,        // transcript word index of the first kept mention
  domain?: string,     // absent when the LLM gave none or it was invalid
  candidates: { file: string; source: "header" | "icon" | "manifest" | "og" | "favicon"; width?: number; height?: number }[],
  note?: string,       // why there are no candidates ("site timed out", "no logo found")
}
```

`overrides.json` gains, under `overlays`:

- `skippedSuggestions: string[]`: suggestion ids skipped for this video.
  Ids are the slug of the name, not the word, so a skip survives a recut that
  moves the first kept mention (my call).
- A pick becomes an ordinary `added` placement with `source: "user"` plus a
  library entry, the same path as a tray add in project 1, so render and
  recut need nothing new. The placement gains one optional field,
  `fromSuggestion: string` (the suggestion id).

**What hides a chip** (my call): it is skipped, OR some live (not removed)
placement has `fromSuggestion` equal to its id. It is not hidden by a name
check, so a pick saved under an edited name ("Gemini" for "Google Gemini")
still hides its chip.

**Undo of a pick** removes the placement, so the chip comes back. The
library entry stays: the library is global and outside undo, and keeping an
extra logo is harmless. Picking again reuses that entry instead of adding a
duplicate (the server matches on the candidate's content hash).

### Editor

- **Overlay lane:** each unskipped, unpicked suggestion is a dashed chip at its
  word, labelled with the name and a "?" (mockup A). It is visually distinct
  from real overlay chips, and it is not a placement: it never reaches the
  player props, so preview matches render.
- **Click a chip** to open a popover beside it showing:
  - the name and timestamp
  - the candidates as thumbnails, served by id from a new
    `GET /api/logo-candidates/file?suggestion=&n=` (an id lookup, never a
    client path, like `/api/library/file`)
  - `Use this`, `Skip`, `Paste my own`
  - `note`, when there are no candidates
- **Use this:** `POST /api/library` with a new source kind
  `{ candidate: { suggestion, n } }`. The server resolves it to the workdir
  file, so the client never sends a path. The name is pre-filled from the
  suggestion and editable, with optional aliases, as in the project 1 tray
  add. Then it adds the placement at the suggestion's word, as an undoable
  `useEdits` action.
- **Skip:** adds the id to `skippedSuggestions`. Undoable.
- **Paste my own:** opens the existing project 1 tray paste box, pre-targeted
  at this word and pre-filled with the name.

### Report

One line in `report.txt` and the console, for example:

`logo finder: 4 names (Firebase, Google Gemini, Claude, Kimi) — 3 with logos, 1 without (kimi.ai timed out)`

Failure lines:

- `logo finder: skipped (no LLM provider)`
- `logo finder: skipped (the LLM call failed: <reason>)`
- `logo finder: no new names`

## Testing expectations

- **Core (pure):**
  - flag validation: wrong-word flags dropped, library names dropped, dupes
    keep earliest, cap of 8, bad domains keep the flag with no domain
  - suggestion ids are stable across re-plans and recuts
  - a chip is hidden by a live `fromSuggestion` placement, and comes back
    when that placement is removed
- **Candidate extraction (pure, HTML in, URLs out):**
  - fixture pages: a header SVG logo, `apple-touch-icon`, a manifest, only
    `og:image`, only `favicon.ico`
  - ranking order and dedupe
- **Fetch (injected `fetch` and resolver, no network):**
  - private and loopback addresses refused on the first hop and after a
    redirect
  - an HTML body behind an image URL is rejected
  - a too-small raster is rejected
  - the 30 s total budget leaves the remaining names with no candidates and a
    `note`
- **Produce:**
  - the mock provider returns flags, and `production.json.overlays.suggestions`
    carries them
  - a replay does not call the provider or fetch
  - an LLM failure still finishes `produce`, with the report line
- **Server:**
  - `POST /api/library {candidate}` adds the entry
  - an unknown suggestion or `n` gets a 400
  - a temp library dir is injected, never `~/.ossclip`
- **Editor e2e:**
  - a workdir with suggestions shows dashed chips
  - clicking one shows its thumbnails
  - Use this makes a real overlay, survives a reload, and undo brings the
    chip back
  - Skip hides the chip and survives a reload

## Left to the builder

- The exact prompt wording.
- The HTML parser (a small dependency or a careful hand parser).
- Chip and popover visuals.
- How `produce` logs progress while it fetches.
