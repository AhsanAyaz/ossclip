# Overlay library: logos, images and GIFs on cue — design

Date: 2026-11-05. Status: draft for review.

## Why

The author says "Google Developers Expert" on camera and nothing happens on
screen. What they want: the GDE logo pops up on that word, with a pop sound,
the way an editor would cut it by hand. Today the only way to show a picture
is a ScreenshotFrame *scene*, which takes over a layout slot, is chosen by the
LLM, and needs the file to sit next to the video. That's the wrong shape for a
two-second logo sting on top of whatever is already on screen.

This is project 1 of 3, agreed in brainstorming:

1. **Library + overlays (this document).** A global library of logos, images
   and GIFs, deterministic matching against the transcript, overlay/card
   rendering, editor lane + tray. Works fully offline, no LLM.
2. **Moment finder (later).** The LLM flags mentions the library has no logo
   for. The editor tray shows placeholders with a "paste URL or path" box.
3. **Meme suggestions (later).** The LLM flags reaction moments, Giphy
   candidates go into the tray, and the author picks one and swaps it later.

Project 1 must leave room for 2 and 3: the tray, the placement schema and the
library-add endpoint are the shared parts.

## Goals

- A **global library** at `~/.ossclip/library/` that grows over time and
  every project draws from.
- **Auto-placement by name:**
  - If a library entry's name or alias is spoken, its overlay is placed at the
    **first mention only** (author's call).
  - The editor can add more.
- **Two looks** (the author's):
  - **overlay** (default): the image sits over the live video, above the
    captions where it fits.
  - **card**: a full-screen black card with the image centred.
- **Optional sound:** on by default, using the bundled `pop` sound.
- **Editor:**
  - An overlay lane on the timeline.
  - Select an overlay to swap its image, change its look, length or sound, or
    delete it.
  - Add an overlay at any word.
  - A **tray** where the author picks from the library or pastes a URL or local
    path (or drops a file). The pasted or dropped item is saved into the
    global library and used.
- **GIFs play** (animated) in preview and render.

## Non-goals (this project)

- LLM suggestions of any kind (projects 2 and 3).
- Giphy or any web search.
- Video clips as overlays.
- Free positioning or drag-to-move of an overlay on the canvas. Placement is
  computed; the only choice is overlay or card.
- Per-overlay entrance styles. It pops in and fades out, nothing else.

## Anti-goals

These would make it a failure even if it technically works:

- A logo popping on the **wrong word**. False matches erode trust fast; we
  prefer a missed match over a wrong one.
- A render that **depends on the library folder later**. A project must
  re-render identically after the author deletes or renames a library file.
- **Network access at render time.** URLs are fetched once, on add, into the
  library.
- A blank or broken box in the output. A missing image renders nothing and
  warns.
- Covering the captions with an overlay. The card is the only look that may
  hide them.

## Decided (by the author)

- **Sourcing:** local files first, with a library that builds up over time.
  Web search is out because of licensing.
- **Resolving missing items** happens in the editor tray, not in CLI prompts,
  so `produce` never blocks on questions.
- **Matching:** first mention only; the editor adds more.
- **Memes:** pick from a few in the tray, swap in the editor. This is project
  3, but it is why the tray is a general "choose an image for this moment"
  surface.

## Design

### Library on disk

`~/.ossclip/library/` contains the image files and `library.json`:

```jsonc
{
  "entries": [
    {
      "id": "gde",                      // slug, unique
      "file": "gde.png",                // relative to the library dir
      "names": ["Google Developers Expert", "GDE"],  // first = display name
      "kind": "logo",                   // logo | image | gif — gif = animated
      "look": "overlay",                // optional per-entry default: overlay | card
      "sound": "pop"                    // optional: sfx sound id, or null for silent
    }
  ]
}
```

- **Loader:** parse with zod and never throw. Problems come back as
  `issues[]`, the same as `loadSfxLibrary` and `loadLutLibrary`.
- **Directory:** the library dir is an injectable default parameter, the same
  as `sfx-pack.ts` and `lut-library.ts`. Tests never touch the real home
  directory.
- **Unindexed files:** a file dropped into the folder with no `library.json`
  entry still loads. Its id and only name are the filename stem, with `-` and
  `_` read as spaces (`google-cloud.png` → "google cloud"). This follows the
  LUT folder's drop-in habit.
- **Formats:** png, jpg/jpeg, webp, svg, gif. Check the type by magic bytes
  (svg by its root element), not by the extension.
- **Writes** to `library.json` are atomic: write a temp file, then rename.

### Matching (pure, in core)

`matchLibrary(words, entries, opts) → OverlayPlacement[]`. It runs on the
**kept** words.

It is a **stricter** matcher than `reveal-match.ts` (my call; wrong-word pops
are the main anti-goal):

- case-insensitive
- edge punctuation stripped
- a trailing possessive `'s` / `’s` stripped
- **no** stemming, stop-word dropping or minimum token length
- multi-word names match as a contiguous word sequence

It may share the tokenizer with `reveal-match.ts`, nothing else.

Rules:

- **First mention per entry.** Only the first occurrence of any of an entry's
  names counts.
- **Longer name wins on overlap.** "Google Developers Expert" beats a separate
  "Google" entry on the same words.
- **Short names must match exactly.** To guard against wrong-word pops, a name
  that is one word of 3 or fewer letters (e.g. "GDE", "Go", "AI") matches only
  when the spoken word's case matches the name's case. Whisper writes "GDE" as
  "GDE", so the match still works, but "go" the verb never matches "Go" the
  language. This is the default; the builder may tune it with tests.
- **Overlap with another overlay.** If two placements land within one overlay
  duration of each other, the later one is dropped. A dropped placement goes
  into a reported `dropped[]` with a reason, the same as the sfx normaliser.

### Placement schema

This mirrors sfx: word-indexed, so it survives recuts.

```ts
OverlayPlacement = {
  id: string,                 // stable: `${entryId}@${word}` for matches
  entryId: string,
  word: number,               // transcript word index; fires at its start
  look?: "overlay" | "card",  // default: entry.look ?? "overlay"
  durationSec?: number,       // default 1.5 (overlay), 2.0 (card); clamp 0.5–6
  sound?: string | null,      // default: entry.sound ?? "pop"; null = silent
  source: "match" | "user",
}
```

- **`production.json`:** gains `overlays: { placements: OverlayPlacement[] }`
  alongside `sfx`.
- **Overrides:** `overrides.json` gains `overlays: { edits: record<id,
  {entryId?, word?, look?, durationSec?, sound?, removed?}>, added:
  OverlayPlacement[] }`, the same shape as `sfx.edits` / `sfx.added`. A
  removed match stays removed on re-produce, because the id is stable.
- **When matching runs** (my call, mirroring sfx's `priorSfxPlan`):
  - A fresh `produce`, or a `--produce` re-plan: matching runs against the
    current library.
  - A replay: the editor's Render button replays `command.json` with
    `--scenes`. A replay **carries `production.json.overlays` forward**
    (`priorOverlayPlan`) and never re-matches, so an old project doesn't
    change because the library grew.
  - Overrides apply on top in every case. A removed match stays removed,
    because its id is stable.
  - The editor's **"Find library matches"** action is the only re-match on an
    existing project. It adds first mentions that aren't already placed or
    removed, which covers "I just added the GDE logo through the tray, place
    it where I said GDE".
- **Snapshot** (my call). A render must not depend on the library:
  - Each used entry is snapshotted: `{id, name, kind, ext, look, sound}`.
    - Matched entries are snapshotted into `production.json.overlays.entries`.
    - Tray-added entries are snapshotted into `overrides.json.overlays.entries`.
  - Its file is copied into `<workdir>/library/<id>.<ext>` at the moment it is
    placed: by produce for matches, by the server for tray adds.
  - The workdir copy wins on every render. New art in the library reaches a
    project only through a tray swap, which re-copies. Renaming or deleting a
    library file never changes an existing project.

### Resolve → render props

An assemble step turns placements into
`OverlayCue {file, atSec, endSec, look, kind}`:

- **Time:** output seconds.
- **Cut word** (my call):
  - A `match` placement whose word was cut falls forward to the next kept
    mention of any of its entry's names.
  - With no kept mention left, it is dropped and the report says so.
  - A `user` placement whose word was cut moves to the next kept word.
- **End:** `endSec` is clamped to the composition end.
- **Sound:** a placement's sound becomes an ordinary `SfxCue` at the same
  `atSec`. There's no new audio path. Muting is `sound: null`.
- **Sound without `--sfx`** (author's call): overlay sounds play regardless
  of `--sfx`.
  - Produce loads the sfx library and stages the overlay sounds even when
    sfx planning is off.
  - Overlay sounds still find the bundled pack when `sfxBundledPack`
    excludes it, so `pop` keeps working (my call).
  - If a sound id can't be found, the overlay stays, plays silent, and the
    report shows a ⚠ line.
- **Spacing against planned sfx** (my call): a planned sfx within 0.5s of an
  overlay sound is dropped, with reason `overlay`. The overlay pop wins, so
  the two never stack into mush.

**Staging:**

- Every used library file is copied into the render publicDir and the workdir
  under `library/<id>.<ext>`, the same as staged sfx.
- The workdir copy is authoritative for re-renders. If the library file is
  gone later, the render uses the workdir copy.
- If both are missing, the render skips that overlay and logs a ⚠ line.

### Rendering (scenes package)

`OverlayTrack` lives in the scenes package and is a new layer in
`ProductionComposition` (in `packages/renderer`), after `CaptionTrack`.

- **overlay look:**
  - Centred horizontally.
  - The bottom edge sits a small gap above the caption block's **actual** top
    at that moment. Use the same anchor chain `CaptionTrack.tsx` uses:
    `captionY` → `captionAnchorAvoiding` → the layout anchor, plus
    `captionScale` and wrapped line count. Pull that chain into a shared pure
    helper rather than duplicating it. Plain `captionAnchorAt` ignores hand
    moves and would cover captions.
  - If a scene's graphic rect is on screen, the overlay avoids it too (my
    call), and it moves to the top safe area when the space between the
    graphic and the captions is too small. If neither fits, it may overlap the
    graphic. It never overlaps the captions.
  - Width about a third of the frame, height capped so it stays inside
    `SAFE_AREA`, aspect preserved.
  - If there's no room above the captions (for example, captions placed high),
    it goes in the top safe area instead.
- **card look:**
  - A full-frame black background with the image centred at about 50% of the
    frame's shorter side.
  - Captions are hidden while a card is on screen. This is the one exception
    to "never cover captions".
- **Animation:**
  - Pop in with the existing `anim.ts` entrance spring (`enterFrames`), scale
    plus opacity.
  - Fade out over the last ~0.25s.
- **GIF:** `@remotion/gif` (new dependency), looping over the duration. Other
  formats use Remotion `Img`.
- **Preview (editor):** the file comes from a new
  `/api/library/file?id=` route (an id lookup, never a client path, mirroring
  `/api/sfx/audio`), or the workdir copy under `/media/`.

### Editor

- **Overlay lane:** next to the sfx lane. Chips sit at their word; the chip
  thumbnail is the image. Selection state is separate from scenes and sfx, the
  same as sfx.
- **Inspector**, for a selected overlay:
  - image (opens the tray to swap)
  - look: overlay or card
  - duration slider, with reset to "default"
  - sound on/off
  - delete
- **Undo:** all of these are `useEdits` actions with undo, saved through the
  existing `PUT /api/overrides`.
- **Add an overlay:** right-click a transcript word (or the timeline) and
  choose "Add logo/image here", then pick in the tray.
- **Tray:**
  - A library grid (search by name) with GIF thumbnails animating.
  - A **paste box** that takes a URL or a local file path, plus drag-and-drop
    of a file.
  - **Adding a new item asks for:**
    - a name, pre-filled from the file name or the URL's last path part
    - optional aliases
    - a kind, guessed from the format: gif → gif, else logo
  - After the add, the item is placed on the chosen word.
- **"Find library matches":** a button in the overlay lane header. It reports
  "added N, skipped M already placed or removed".

### Server endpoints (`apps/cli/src/edit.ts`)

- **`GET /api/library`:** metadata only (id, names, kind, look, sound), never
  absolute paths.
- **`GET /api/library/file?id=`:** serves the file by id.
- **`POST /api/library`:** `{name, aliases?, kind?, source}` where `source` is
  one of:
  - `{url}`: the server fetches it once (http/https only, 20 MB cap, 15s
    timeout, redirects capped)
  - `{path}`: an absolute local path, copied in
  - `{data: base64, mimeType}`: a dropped file, as the portrait upload does
- **What `POST /api/library` does:**
  - Validates format by magic bytes and enforces the size cap.
  - Picks a unique slug id.
  - Copies the file into the library dir and writes `library.json`
    atomically.
  - Returns the entry.
  - **Never** writes outside the library dir. The file name comes from the
    slug, not from the URL or path.
- **MIME table:** add `.gif`, `.webp` and `.svg`.

### CLI

- **`produce`:**
  - Loads the library and runs matching.
  - Prints a one-line summary in the report: "overlays: 2 placed (GDE,
    Firebase), 1 skipped".
  - Has no new prompts.
- **Re-render** (`ossclip render` / the editor's Render button) uses
  `production.json` plus overrides, and the staged copies.

## Testing expectations

- **Core:** pure tests for
  - `matchLibrary`: first mention, longest-name wins, the short-name exact
    case rule, words that were cut, overlap drop
  - the library loader: index, unindexed files, bad JSON → issues
  - the override merge: edit, add, remove survives re-produce
  - resolve: cut word dropped, clamp at end, sound → SfxCue
- **Server:**
  - `POST /api/library` with url / path / base64
  - rejects a non-image, oversize or traversal-looking name
  - a temp library dir is injected, never `~/.ossclip`
- **Scenes:** overlay rect sits above the caption anchor; falls back to the top
  when there is no room; card hides captions.
- **Editor e2e:** add from the tray via a local path → the chip appears →
  save → reload persists; swap the look; delete.
- **verify-ossclip drive:**
  - A fixture library dir with one entry whose name is a word in
    `fixture.transcript.json`.
  - Assert that `production.json.overlays` places it at that word index, and
    that the render props carry the cue and the pop SfxCue.

## Left to the builder

- Exact sizes, gaps, the fade length and the spring scale.
- Lane visuals and the tray layout.
- Slug algorithm and id collision suffixes.
- How the "Find library matches" report is shown.
- Whether a card fades the video under it or cuts hard. Default: a quick
  0.15s fade to black.
