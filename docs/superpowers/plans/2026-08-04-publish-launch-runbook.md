# Publishing ossclip — the launch runbook

> **For agentic workers:** this is a RUNBOOK, not a feature plan — most steps need the author's credentials (npm, GitHub settings) and are marked **AUTHOR**. Agent-executable steps are marked **AGENT**. Execute in order; the order is load-bearing. Outcomes log as findings in `docs/PHASE1-FINDINGS.md` when the launch round happens.

**Standing constraints:** develop on `claude/video-virality-generator-brainstorm-oci5fj`; never push to another branch without explicit instruction (step 4 below IS that instruction, one-time, for `main`). Do NOT include a model identifier in any repo artifact.

**Progress:** steps 0–4 DONE (R22 §108–§109) — published to npm, repo public, Pages live, CI green. Remaining: step 5 (announcement, author's to write) and step 6 (the week after). Original progress note: steps 0–2 (R22 §108) — freeze check green, assets shipped, `main` fast-forwarded to the launch tip, repo renamed to `AhsanAyaz/ossclip`, description + topics set, all four packages README-ready. Remaining: npm publish (step 3, author's commands), the public flip (step 4), announcement (step 5).

**State at capture (2026-08-04):** repo private, history purged (R18 §86 — a fresh full clone is 2.2M with no withdrawn material on any ref). npm name `ossclip` verified available; packages publish-ready (R18 §90b, verified by tarball install). CI + Pages workflows committed and green (§92). README honest (§88/§89/§93). Licensing disclosed (§87). Disclaimers in place (§105). The one asset that does not exist yet is the demo GIF.

---

## 0. Freeze check — everything the README claims, re-verified

- [x] **AGENT: full verification suite** on the tip: `pnpm typecheck` · `pnpm test` · editor build · full Playwright. All green or the launch waits.
- [x] **AGENT: fresh-clone audit.** Clone the repo fresh, full (all refs): no `reference/`, no `BRAINSTORM.md`, `.git` ~2MB. This was true after R18; re-verify at the tip being launched.
- [ ] **AUTHOR: one real end-to-end run** on the machine that will demo it: `ossclip produce <real footage> --produce -o out.mp4`, watch the output. The R20/R21 layout work (scrim, variety, band padding) has not yet been seen on a real render — this run is where it is.

## 1. The demo GIF — the highest-value missing asset

- [x] **AUTHOR: record it.** The README placeholder says exactly what to record: before/after of `ossclip produce input.mp4 --produce -o out.mp4`, then a few seconds of direct manipulation in `ossclip edit`. 15–25s, under ~8MB (GitHub renders GIFs inline; an MP4 in a `<video>` tag does NOT render on the README).
- [x] **AGENT: embed it** at the placeholder, verify the README renders on GitHub's preview.

## 2. Make `main` the launch branch

The working branch carries the whole (purged) history; `main` is still just the cleaned initial commit. GitHub shows `main` to strangers.

- [x] **AUTHOR (or AGENT with this runbook as the instruction):**
  `git push origin claude/video-virality-generator-brainstorm-oci5fj:main --force-with-lease` — main becomes the full history.
- [x] **AUTHOR:** Settings → default branch = `main`. Keep the working branch for ongoing rounds or retire it — future PRs target `main` either way.
- [x] **AGENT:** confirm CI runs green on `main` after the push.

## 3. npm — publish before anyone can read the README

The README's first command is `npm install -g ossclip`; it must be true the moment the repo is public. Publish FIRST.

- [x] **AUTHOR: npm auth.** `npm login`, then create the `ossclip` org (for the `@ossclip/*` scope) — or publish the three libraries under your user scope and adjust the CLI's dependency names accordingly (org is cleaner; it was verified unclaimed at R18).
- [x] **AUTHOR: publish, libraries first** (pnpm rewrites `workspace:*` at pack):
  `pnpm --filter @ossclip/core --filter @ossclip/scenes --filter @ossclip/renderer publish --access public`
  then `pnpm --filter ossclip publish --access public` (its `prepack` builds `editor-dist/` automatically).
- [x] **AUTHOR: smoke-test from the registry** on a clean shell: `npm i -g ossclip && ossclip doctor && ossclip --help`. Doctor's ✗ lines are the machine's, not the package's — the bin running at all is the test.

## 4. Flip the repo public

- [x] **AUTHOR:** Settings → Danger Zone → change visibility → public. This is the erasure-vs-mitigation boundary from R18: after this moment, history is cacheable — which is why §86 ran while it was still private.
- [x] **AUTHOR:** repo About: description — "Local-first CLI video producer: cuts silence and fillers, word-timed captions, face-aware framing, and LLM-planned code-rendered graphics" — plus topics (`video`, `cli`, `remotion`, `whisper`, `captions`, `shorts`, `llm`) and the docs URL once Pages is live.
- [x] **AGENT: post-flip verification.** Pages deploys (the workflow was blocked on the private plan — it starts working at the flip; Source already reads "GitHub Actions"). CI green and free (public runners are unmetered — the §92 cost question dissolves here). Fresh anonymous clone works. `npm home ossclip` links resolve.
- [x] **AGENT: add the CI badge** to the README top once the first public run is green.

## 5. Say it

- [ ] **AUTHOR: the announcement.** The differentiated story is the process, not just the tool: every fix in the repo traces to a numbered finding from a real render (`docs/PHASE1-FINDINGS.md`, 107 findings across 21 rounds), and the graphics layer is the part comparable OSS tools stop short of. The 200k-follower audience is the channel nobody else has — one honest walkthrough post beats a Show HN race. (Both is fine; the audience post first.)
- [ ] **AUTHOR: pin expectations.** The README already narrows the promise (`--clip` newest/least-proven, one clip not N, Remotion licence note) — the announcement should repeat the honest framing, not oversell past it.

## 6. The week after

- [ ] **AUTHOR/AGENT: issue triage cadence** — real-footage reports are the fuel the findings process runs on; label a `good first finding` path for contributors.
- [ ] **AGENT: watch the npm install path** — the first strangers' `ossclip doctor` output is the install-cliff telemetry §90 was built for.
- [ ] Known debts to say yes/no to when asked: multi-clip (`--clip` N outputs — its own round by decision), §89a real-footage clip validation across more sources, cover-frame-outside-clip-window niggle (§93), per-frame face tracking (Phase 4).

## What NOT to do

- No `npm publish` from CI (tokens in Actions on a fresh public repo is an attack surface nobody needs on day one; publish from the author's machine).
- No new features between the freeze check and the flip — every commit after step 0 re-runs step 0.
- Do not delete the working branch's history or squash `main` — the findings-numbered commit trail IS part of the story being published.
