# Handoff — 2026-08-29: publish end-to-end, editor authority, cover fix

Written at the end of a long session. Everything below is on `main` and
pushed; the suite is green (3100 unit, 62 editor Playwright, typecheck clean).

## What this session was

Two threads that kept feeding each other:

1. Take `ossclip publish` from "shipped but never run against a live
   instance" to actually publishing, on real accounts.
2. Fix what that exposed. Every publish bug below was invisible to the unit
   suite and only appeared against a real Postiz instance with real channels.

## Shipped

| commit | what |
|---|---|
| `c72c127` | Editor picks up a Postiz API key set while it is running — config was re-read per request, the key was frozen at startup |
| `21cfddc` | `--resolution <auto\|1080\|1440\|2160>`: a 4K source keeps its pixels instead of being forced to 1080p |
| `d0c2d78` | YouTube publishes the pack's `description`, not the title-plus-hashtags floor |
| `9c5fc95` | Threads gets a real 500-char cap and borrows the Instagram caption |
| `3511be5` | YouTube's `type` (privacy) and Instagram's `post_type` — both required by Postiz's DTOs; without them the WHOLE `/posts` call 400s after the upload |
| `dbcf178` | `--whisper-translate`: non-English speech captioned in English, and keyed into the transcript cache |
| `1d4bef0` | A render from the EDITOR replays the reviewed plan (`--scenes`), not a fresh LLM plan |
| `f1fa9ec` | The cover banner reaches landscape covers instead of rendering off-frame |
| `35db242` | Publish panel groups channels by network — one caption per LinkedIn/Facebook, not per channel |

Earlier the same session (caption windows, publish config): `2cfe2c0`,
`4f5116b`, `828d200`, `d7e7925`.

## Infrastructure now in place

Postiz runs on the **Mac mini**, not this laptop:

- Compose at `~/postiz` on the mini (`ssh mini`; docker needs
  `PATH=/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin`).
- Public at `https://postiz.codewithahsan.dev` via a `postiz-mini` Cloudflare
  Tunnel installed as a root LaunchDaemon. Registration disabled; a teammate
  is added as USER.
- `~/postiz/set-creds.sh KEY=VALUE …` writes provider credentials and
  restarts the container.
- **11 channels connected**: 4 LinkedIn (profile + 3 pages), 3 Facebook
  pages, Instagram, YouTube, Threads, TikTok (sandbox).
- `postizUrl` in `~/.ossclip/config.json` points at the **Tailscale** address
  `http://100.70.156.24:4007` deliberately — Cloudflare's free plan caps a
  proxied upload at 100MB and renders run bigger. Publishing from outside
  Tailscale needs the public URL and a sub-100MB video.

The tunnel's `cert.pem` on the mini carries a zone-scoped Cloudflare API
token that can write DNS records (used for TikTok's verification TXT). No
separate API token needed for future DNS work.

## Open items, in the order I would take them

### 1. Ground the caption copy (root cause, matters most)

The last produce printed `⚠ grounding: … "example" — not in the take` for
several scene props — that check exists for graphics. The YouTube/LinkedIn
**caption copy has no equivalent**, which is how "50 teams applied" became a
stated fact in the published copy when the video used it as an example. The
user hit this in real copy on real accounts.

Fixing the pack prompt (or adding a grounding pass over `platformCaptions`)
prevents the error; the regenerate button below only repairs it after.

### 2. Regenerate a caption from the editor (designed, not built)

Approved design, bounded:

- `POST /api/publish/regenerate` on the edit server taking
  `{ network, instruction }`.
- Calls the same LLM provider the run used (read from `command.json`),
  passing the transcript, the current caption and the user's correction
  ("the 50 teams figure was an example, not a real number").
- Returns replacement text into the panel's box. The user still reviews and
  edits; nothing auto-sends. Report the spend the way produce does.

### 3. YouTube thumbnail

`publish()` uploads exactly one file — the video. `IMG_2709.ossclip.cover.jpg`
and `.thumbnail.png` are written for the user and reach no platform.
Postiz's YouTube DTO accepts an optional `thumbnail` (a second `MediaDto`),
so this is wireable: upload the cover as a second media, pass it as
`settings.thumbnail`. The other four networks have no cover concept for a
video post — nothing to wire there.

### 4. TikTok production access

Connected via **sandbox** only. An unaudited client can post only to accounts
that are **private at the time of posting**, with `SELF_ONLY` visibility —
the account setting, not the post's, is what the
`unaudited_client_can_only_post_to_private_accounts` error is about. To
submit for review TikTok wants a demo video of the flow, which the sandbox is
meant to produce. Suggested path: a throwaway private TikTok account as a
second sandbox target, record the flow there, submit.

Also note: ossclip sends no `privacy_level`, so a real TikTok publish will
take Postiz's default and hit the same refusal. Either exclude TikTok from
`--all` runs until approved, or add a privacy setting the way YouTube's was
added.

### 5. Smaller, carried

- Rotate the Facebook and Threads app secrets — they were pasted in chat.
- The editor's render modal has a "Re-plan graphics" checkbox; there is no
  equivalent control for `--youtube-privacy`, so editor publishes are always
  YouTube-private.
- Caption-arm gap: `captionForProvider` silently publishes the floor for any
  provider without an arm. Three bugs of that exact shape so far. A test that
  enumerates connected providers, or a loud report at publish time, would
  close the class.

## Traps worth knowing

- **Workdir contention.** The workdir hash derives from input path + aspect,
  NOT whisper settings — so a background `produce` run lands in the same
  workdir the user is editing. I did this mid-session and caused plan churn
  in their project. Always pass `--workdir` for a background run.
- **First boot of the postiz container** sometimes hangs holding `:::3000`;
  everything 502s and `docker restart postiz` clears it. Expect it after
  every recreate.
- **Do not pipe a produce/publish run through `grep`** — the shell reports
  grep's exit code, so a failed render looks like a success. This hid a real
  4K render failure for a whole cycle.
- **A rendered-pixel check is the only way to catch layout bugs.** The cover
  banner rendered off-frame in landscape for who knows how long; no unit test
  can see a box positioned outside the frame.

## State of the current project

`~/Downloads/.ossclip/IMG_2709-24b2e8e0-16x9` — a 5m24s landscape talk,
Urdu speech translated to English captions, 12 graphics, rendered at
`~/Downloads/IMG_2709.ossclip.mp4` (589MB). Cover regenerated WITH its
banner after `f1fa9ec`. The pack's caption copy contains the "50 teams"
factual error described above and needs a manual edit before publishing.
