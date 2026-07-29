# OSS launch — repo hygiene, an honest promise, and the missing feature

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes. This document is REQUIREMENTS, not a design — the diagnosis under each item is verified fact; the approach is yours to settle. Two items name a decision only the author can make, and they are marked **AUTHOR DECISION**.

**Status:** requirements captured 2026-08-02 from a strategy audit of the repo (OSS vs commercial). Verdict: **open source it, MIT, do not sell, do not open-core, do not build a hosted version.** This plan is what has to be true before the repo can be published under the author's real name and put in front of strangers. Nothing here is a feature request except §89.

**Executed (remote session):** all items shipped except §89a — §89 took option B per this plan's own default (the author had not decided). The repo was PRIVATE at purge time, so §86 was an erasure, not a mitigation; the `ossclip` npm name was available; publishing itself is the author's launch-day action. Outcomes logged as findings §86–§91 in `docs/PHASE1-FINDINGS.md`.

**Standing constraints for this work:** develop on `claude/video-virality-generator-brainstorm-oci5fj`; never push to another branch. No PRs unless asked. Commit trailers as usual. Do NOT include a model identifier in any repo artifact.

**Numbering:** R17 landed §80–§85 (editor: redo, find-next, zoom-out, project switching, render log, transform audit) while this was being written, so these items are **§86–§91**. Note for the author: R17 is more editor work — see *What NOT to do*.

**Verified state at capture (2026-08-02, rebased onto `c30c9db` (R17)):** 100 commits, first on 2026-07-26. Remote `git@github.com:AhsanAyaz/open-clip.git`. 590 unit tests, ~40 e2e, tsc and editor build green.

---

## 86. `reference/` cannot be published

**Observed (verified):** `git ls-files reference | wc -l` → **30 tracked PNGs, 46MB**, and they are screenshots of a commercial product's UI and its produced frames. `BRAINSTORM.md` opens by framing itself as a decode of that product and reads as a teardown throughout.

Reverse-engineering observable output is legitimate and the analysis in this repo is good work. Publishing 46MB of another company's UI under the author's real name, in a repo whose founding document reads as a teardown, is a needless invitation — and that company ships its own CLI, so they are watching this surface.

- [x] **80a. Purge `reference/` from history**, not just from `HEAD`. The images are in every commit that touched them; deleting the directory in a new commit leaves them one `git log -p` away.
  - `git-filter-repo` is NOT installed on the author's machine (verified). Install it (`brew install git-filter-repo`) rather than reaching for `filter-branch`, which is deprecated and mangles tags.
  - `git filter-repo --path reference/ --invert-paths --force`, then re-add the remote (filter-repo drops it by design) and force-push.
  - **This rewrites the shared branch.** The author is the sole contributor and the branch exists only on their fork, so a force-push is acceptable — but state plainly in your report that every existing clone must re-clone.
  - Keep a local copy OUTSIDE the repo first. The images are still useful for the author's own comparison work; they just cannot ship.
- [x] **80b. Add `reference/` to `.gitignore`** so a stray `git add -A` cannot reintroduce them.
- [x] **80c. Fix the four references to the directory** — `BRAINSTORM.md`, `docs/PHASE1.md`, and `docs/PHASE1-FINDINGS.md:9` ("Reference frames for comparison live in `reference/`"). They become dangling instructions the moment the directory is gone. Rewrite them to say the comparison frames were local to the author's machine and are not distributed.
- [x] **80d. `BRAINSTORM.md`** — **AUTHOR DECISION**, take the safer default unless told otherwise: keep it out of the public tree (move to the author's local notes) OR rewrite it as a design-rationale document with the competitor teardown framing removed. Do not publish it as-is. 274 lines; the value is in §5 and §7, which stand on their own without the "decoding" frame.

**Check before you start:** whether `AhsanAyaz/open-clip` is already public on GitHub. If it is, the purge still happens, but say so in the report — history that has been public may be cached or forked, and the author needs to know the purge is a mitigation rather than an erasure.

---

## 87. The licence promise is wrong

**Observed (verified):** root `LICENSE` says "MIT License, Copyright (c) 2026 Muhammad Ahsan Ayaz" with no qualification, and the README says "MIT — see LICENSE." But `remotion@4.0.499/LICENSE.md` grants a free licence to individuals, non-profits and small for-profit companies only; **for-profit organisations above its stated size need a paid Remotion Company Licence.**

ossclip's own code is the author's to license MIT. What the README currently implies — that any company can take this and render video for free — is not true, and a company that follows it is exposed. This is a disclosure fix, not a licensing change.

- [x] **81a.** Add a short **Licensing** section to `README.md`: ossclip is MIT; rendering uses Remotion, which is source-available under a two-tier licence; link to Remotion's LICENSE and state that for-profit companies above its threshold need a company licence. Do not paraphrase the threshold numbers — link and let Remotion state its own terms, so the note cannot go stale.
- [x] **81b.** Same note, two lines, at the bottom of `LICENSE`, clearly separated from the MIT text so nobody reads it as a modification of the MIT grant.
- [x] **81c.** Mirror it in `docs/site/index.html` (there is no licensing section there at all today).

---

## 88. The README promises a category the tool is not in

**Observed:** the first line reads "raw talking-head footage in → a polished, virality-optimized vertical short out." Two problems.

1. **"Viral/virality" is the wrong register for the audience that will actually adopt this.** The evidence from comparable launches is one-sided: creator-framed short-form tools land in the low single-digit points on HN; developer-tool framings of the same domain ("video editing in plain English", "open-source video editor built for AI") land two orders of magnitude higher. The people who can clear this tool's install requirements are developers.
2. **It promises long-form → short-form, which the tool does not do.** See §89.

- [x] **82a.** Rewrite the README's opening paragraph and the GitHub repo description in developer-tool register. No "viral", no "virality-optimized", no "AI producer" as the lead noun. Say what it does mechanically: cuts silence and fillers, word-timed captions, face-aware framing, LLM-planned on-screen graphics, local transcription and rendering.
- [x] **82b.** Leave `PRODUCER_SYSTEM` in `packages/core/src/producer/beats.ts` alone. Its "virality grammar" block is an internal prompt that steers editorial choices and it works; this item is about the public promise, not the model's instructions.
- [x] **82c.** Put the differentiator in the first screenful, because it is real and unique: **LLM-planned, code-rendered on-screen graphics** (`packages/core/src/scene-registry.ts` — nine Zod-typed components with `whenToUse` strings the producer consumes, plus the fit contract that keeps them inside the safe area on real copy). Every comparable OSS project stops at find → crop → caption; the commercial tools gate the graphics layer behind paid tiers. This is the reason to choose ossclip and it is currently buried.
- [x] **82d.** Lead the README with a demo GIF, above the prose. **Blocked on the author** — it needs their footage. Leave a placeholder with the exact command that produced it, and say in your report that the GIF is the single highest-value missing asset for a video tool.

---

## 89. There is no highlight selection — AUTHOR DECISION

**Observed (verified):** no `--clip`, no target duration, no moment scoring anywhere in `apps/cli/src/index.ts` or `packages/core/src`. Feed a 20-minute podcast in and you get a 20-minute vertical video with graphics on it. The findings log already admits this, filed under Round 12's "Not defects, noted":

> "there is no highlight selection anywhere in the pipeline, and for long-form input that is a bigger gap than framing."

Long-form → short-form selection is the defining feature of this category, commercial and open source alike. Every test round to date used a 32–68s take, so the tool is honestly a **polisher**, and the README currently promises a **clipper**.

**The decision is which of these to ship. Do not do both, and do not start until the author has chosen.**

- [ ] **89a (option A — build it).** `--clip <seconds>` selects the best window and produces only that.
  - Reuse the beat sheet rather than adding a second editorial call: `BeatSheetSchema` (`packages/core/src/producer/beats.ts`) already returns `hook` plus 1–12 `moments` with word ranges. Extend it with an optional highlight window (word range + one-line reason), asked for only when `--clip` is set.
  - **Ordering matters and is the whole design risk:** selection must happen after transcript + repair but BEFORE analyze/cut/captions/scenes, because it changes which words exist. Slice the transcript to the chosen window, then let the existing pipeline run unchanged. Getting this wrong means captions and scene anchors index into words that are no longer there — the same class of bug §17 fixed for repairs.
  - Requires `--produce` (the window is an editorial judgement). Without it, fail with a clear message rather than falling back to a heuristic that will pick a bad 60 seconds and look like a bug.
  - Tests: unit coverage for window selection given a beat sheet (in range, clamped to the take, minimum length, refuses an empty window). No e2e needed.
- [x] **89b (option B — narrow the promise).** Say plainly in the README that ossclip polishes a take you have already cut, that long-form clip selection is out of scope today, and link the findings entry. Honest, defensible, and consistent with every run to date.

**Recommendation if the author does not decide:** take **89b** and ship. It costs an hour, it makes the README true, and it does not risk the transcript-slicing bug on launch week. 89a can follow after launch with real users' long-form footage to test against.

---

## 90. The install cliff is the adoption ceiling

**Observed:** the documented quick start (`pnpm ossclip produce …`) only works inside a clone of this monorepo — there is no published npm package, and `pnpm build` is a precondition for `ossclip edit` because the editor page is a Vite app that nothing builds on install. A first-time user needs Node ≥22, pnpm, ffmpeg, ffprobe, a compiled whisper.cpp with `whisper-cli` on PATH, a ~466MB model download, and an LLM key. Seven preconditions before the first frame renders.

This is the difference between ~20 people completing a render and ~60 — and every failure that does happen arrives as a GitHub issue the author answers personally.

- [x] **84a. `ossclip doctor`** — a subcommand that checks each precondition and prints the exact fix per platform (ffmpeg, ffprobe, whisper-cli, model present in `~/.ossclip/models`, a provider key or a logged-in Claude Code) with a ✓/✗ per line and a non-zero exit if anything is missing. This is the highest-leverage item in the plan. Note that `loadEnvFiles` (R16 §77) already resolves keys from `.env`, so the key check must run after it or it will report a false negative.
- [x] **84b. Publish to npm.** The root package is `ossclip-monorepo` and the CLI is `@ossclip/cli`; the public entry point should be plain `ossclip` with a `bin`. **Check name availability on npm first** and report back if it is taken rather than inventing a variant. Ship the prebuilt editor bundle in the package `files` so `ossclip edit` works without a build step.
- [x] **84c.** Rewrite the README quick start to lead with the published-package path, with the clone-the-monorepo path kept below for contributors.

---

## 91. Delete the dormant app

- [x] **91.** `apps/studio/` contains a single `README.md` describing a UI that was never built (verified: `ls apps/studio` → `README.md`). A dead app directory in a published tree reads as an abandoned project. Delete it; the idea is preserved in `BRAINSTORM.md` §5.4 if that document survives §86d.

---

## What NOT to do

This section is load-bearing. The audit's sharpest finding is that the most-invested surface in this repo is the least load-bearing for adoption.

- **Freeze the editor.** `apps/editor/src` is 4,768 LOC — larger than the entire scene library at 3,409 — with 28 e2e tests, and rounds 9–16 were almost entirely editor polish. Someone who never completes a first render never opens it. No editor work in this plan, and none before launch unless it blocks a first render.
- **No more provider or cost-accounting work.** Four providers, tiering, per-family pricing overrides, an append-only usage log with provenance stamps (§78). Elegant, and approximately zero adoption impact.
- **No new scene components.** Nine is plenty and the fit contract covers them.
- **Never (per the audit):** a hosted version, a web uploader, a GUI installer, Windows support, stock B-roll, TTS, speaker diarisation.
- **Ship with known-open findings.** §24, §40, §45, §47 are polish. The findings log makes leaving them open honest rather than sloppy.

---

## Execution order

The first two blocks are what make the repo publishable at all; do them first and in this order.

1. **§86** (purge + doc fixes) and **§87** (licence note) — together, they turn "cannot publish under my real name" into "publishable." Roughly two hours. `git filter-repo` last, after the doc edits are committed, so the rewrite carries them.
2. **§91** (delete `apps/studio`) — trivial, do it in the §86 commit.
3. **§90a** (`doctor`), then **§90b/c** (npm) — the adoption items.
4. **§88** (README reframe) — after §89 is decided, because the promise depends on it.
5. **§89** — whichever option the author picks. If unanswered when you reach it, take 89b and say so.

**Verification before you report done:** `pnpm -r exec tsc --noEmit`, `pnpm vitest run` (590 passing at capture), the editor build, and the full Playwright suite. For §86, additionally: `git log --all --stat | grep -c reference/` returns 0, and a fresh clone of the pushed branch has no `reference/` directory and no 46MB in `.git`.

**Report honestly on:** whether the GitHub repo was already public before the purge, whether the `ossclip` npm name was available, and which §89 option shipped. Each of those changes what the author does on launch day.
