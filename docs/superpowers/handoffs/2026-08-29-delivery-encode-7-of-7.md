# Handoff — 2026-08-29 (pm): delivery encode, caption authority, 7-of-7

Follow-up to the morning handoff (`2026-08-29-publish-and-editor-authority.md`).
Everything below is on `main`, pushed, and RELEASED as **0.1.34** (npm live for
all four packages, tag `v0.1.34`, GitHub release verified 200). Suite at
release: 3229 unit, 62 Playwright, typecheck clean.

## The headline

The morning's failed publish (1 of 6 channels) is fixed end to end. The same
pipeline published a new portrait short to **7 of 7 channels on the first
try** — including Instagram, Threads and the LinkedIn page, which had never
worked. The field session that proved it is the evidence trail for most of
what shipped.

## Shipped (ea1349d → bd58734)

| commit | what |
|---|---|
| `aa408cf` | Publish uploads a delivery encode (≤1080p h264/aac ~10 Mbps `+faststart`), not the master. Cached in the workdir (`delivery-<w>x<h>@<kbps>k.mp4`), mtime-guarded against re-renders. Duration caps (threads 5:00, tiktok 10:00, instagram 15:00) refuse channels loudly pre-confirm; the panel grays them out. `--delivery <auto\|master>` |
| `2ebaf84` | Editor caption regenerate: `POST /api/publish/regenerate`, same provider the run used, transcript-grounded prompt, spend persisted to usage.json, advisory grounding notes |
| `20c76e8` | Batch regenerate (all selected networks, sequential, per-network instruction wins), notes collapsed behind a count, author-voice prompt: em/en dashes banned (ellipsis instead, `stripDashes` enforces), per-platform practice lines |
| `673f3a9` | Encode progress + ETA: ffmpeg `-progress` parsed (NB `out_time_ms` is MICROseconds), CLI `\r` line, editor polls `GET /api/publish/progress` |
| `5062c8a` | Per-platform size-fitted media: `PLATFORM_SIZE_CAP_BYTES` (instagram 95MB), bitrate fitted to duration, `PublishPost.videoPath` per-post override, Postiz provider uploads each distinct file once. The plumbing master-to-YouTube needs now exists |
| `c5b5e2c` | On-demand caption pack: `POST /api/youtube/generate` + a "Generate captions" button where the publish modal used to dead-end — a render produced without `--youtube` can now publish |
| `bd58734` | 0.1.34 lockstep bump (bumped LAST, per the 0.1.5 lesson) |

## Field findings — the debugging that produced the fixes

- **Instagram 2207077 was SIZE.** The 409MB 10 Mbps delivery file failed
  twice; the identical video at 88MB (2 Mbps, same 1080p landscape, same 192k
  audio) published as a Reel. Landscape is fine. The 95MB cap with a 1000 kbps
  quality floor means an IG video over ~10:19 is refused pre-confirm.
- **The serving path is clean.** Full 409MB downloads through the Cloudflare
  tunnel at 13MB/s and ranged GETs return proper 206 (`+faststart` matters).
  Cloudflare's 100MB free-plan cap bites request bodies (uploads through the
  public URL), not downloads.
- **LinkedIn's morning "range request (status 200)" failure did not recur** —
  profile and page both published with the delivery encode. The root 206
  serving question from the morning handoff is moot in practice; reopen only
  if it recurs.
- **Postiz post state is NOT platform truth** (now also in auto-memory).
  Facebook posts marked ERROR were live on the page, twice. A linkedin-page
  ERROR was a Temporal `postSocialPending` StartToClose timeout — the worker
  gave up *watching*, the platform may still publish. Check on-platform before
  any `--force` retry; a retry of a silent success posts a duplicate. The real
  error text lives in the `Post.error` DB column
  (`docker exec postiz-postgres psql -U postiz-user -d postiz-db-local`),
  richer than `docker logs postiz`.

## State of the accounts (end of session)

- New portrait short: live on all 7 channels (12:00Z batch, all PUBLISHED with
  releaseURLs in Postiz).
- IMG_2709 (the 5:21 landscape talk): live on LinkedIn profile, both Facebook
  pages, Instagram (`/reel/Dcnxm0wDdKr/`), YouTube, LinkedIn page (Code with
  Ahsan). The VisionWise **linkedin-page retry** (`…q8ezn4`) shows ERROR but
  is the timeout case above — CHECK THE PAGE before retrying. Threads is
  impossible for this take (5:21 > 5:00).
- Old ERROR rows from the 07:15/09:00 batches are history, not work.

## Open items, in the order I would take them

1. **Ground the produce-time caption copy** (morning item 3, still the root
   cause). The regenerate prompt has the example-never-stated-as-fact rule;
   `buildYoutubePrompt` does not — "50 teams applied" shipped as fact and a
   regenerated caption invented "around 200 teams" until hand-corrected. Add
   the same grounding rules to the pack prompt. Note: `ungroundedTokens()` is
   now extracted and shared, but its digit exemption means unspoken NUMBERS
   pass the advisory — the prompt rule is the defense; a caption-specific
   number check is a design decision waiting.
2. **YouTube thumbnail** (morning item 5) — `PublishPost.videoPath` per-post
   media landed, so a second upload mapped to one post is proven plumbing;
   Postiz's YouTube DTO takes `settings.thumbnail`.
3. **Master-to-YouTube** — same plumbing, explicitly deferred twice; comment
   sits on `PublishRequest.videoPath`.
4. **TikTok production access** (morning item 6) — unchanged; sandbox only,
   no `privacy_level` sent.
5. Carried smalls: rotate the Facebook/Threads app secrets (pasted in chat);
   `--youtube-privacy` control in the editor render modal; the
   `PANEL_CAPTION_CAPS` display map lacks `linkedin-page`/`threads` (drift
   only, server re-caps); the on-demand pack endpoint doesn't write the
   `.youtube.md` sidecar produce writes.

## Traps worth knowing (new this session)

- **The global npm `ossclip` shadows the dev build.** The user ran the
  released binary mid-session and got a pre-feature editor plus a confusing
  "missing postizUrl" (older config reading). In this repo, always
  `pnpm ossclip edit <workdir>`. (0.1.34 narrows the gap but it will reopen.)
- **The dev editor and Playwright e2e fight over port 5174.** e2e refuses the
  port; killing the user's live editor session is the failure mode. Check
  what holds the port and whose it is; restart the editor afterwards.
- **Restarting the edit server resets unsent panel state** (caption box
  edits live in the browser). Warn before cycling.
- **`out_time_ms` from ffmpeg `-progress` is microseconds.** Trusting the
  name reports 1000x. Pinned by test in `delivery-progress.test.ts`.
- The morning handoff's traps (workdir contention, grep-masked exit codes,
  first-boot postiz hang, rendered-pixel checks) all still apply.
