# Releasing ossclip

The authoritative runbook. Written after 0.1.16, whose release run had to
reconstruct all of this from CLAUDE.md + eleven releases of git history —
never again. Verified against every release v0.1.5 → v0.1.16.

## What ships

Four packages move in **lockstep** — one version, one bump commit:

| Package             | Directory            |
| ------------------- | -------------------- |
| `ossclip`           | `apps/cli`           |
| `@ossclip/core`     | `packages/core`      |
| `@ossclip/renderer` | `packages/renderer`  |
| `@ossclip/scenes`   | `packages/scenes`    |

Cross-dependencies use `workspace:*`, so bumping the four `version` fields is
the whole edit — no cross-version strings to chase.

`apps/editor` stays at `0.0.1` forever: it is not published standalone. The
CLI's `prepack` builds it (`pnpm --filter @ossclip/editor build`) and ships
the output inside the `ossclip` tarball as `editor-dist/` — expect that build
to run during publish.

This repo (`AhsanAyaz/ossclip`) **is** the public repo. No subtree mirrors,
no separate release repo.

## The order (bump LAST)

The 0.1.4 → 0.1.5 lesson, permanently: the fix for `ossclip edit` crashing on
Windows/Linux landed one commit *after* the version bump, so npm shipped the
crash to every non-macOS user for the life of the release. The bump commit is
the LAST commit before publishing, and nothing lands between it and the tag.

1. **Everything functional is already merged and pushed.** Check what the
   release will contain:

   ```sh
   git log v<last>..HEAD --oneline
   ```

2. **Green gate** (before the bump commit, not after):

   ```sh
   pnpm test        # whole workspace must pass
   pnpm typecheck
   ```

3. **Bump** the four `package.json` versions to `0.1.X`, commit as a single
   commit titled exactly:

   ```
   0.1.X: <headline>
   ```

   The headline names what the release is about ("the editor stops fighting
   your clicks"), not a list. Push to `origin/main`.

4. **Publish** all four:

   ```sh
   pnpm -r publish --access public   # or: pnpm release:publish
   ```

   npm auth realities, both hit during 0.1.16:
   - `npm whoami` first. A 401 means the token in `~/.npmrc` is dead —
     `npm login` before anything else.
   - Publish triggers **2FA-on-publish**: npm prints an
     `npmjs.com/auth/cli/…` URL that must be approved in a browser. This
     step is interactive by design — an agent cannot complete it; the human
     runs the publish or sits ready to click.
   - If publish fails partway, STOP and check `npm view <pkg> version` for
     each of the four before retrying — never tag until all four report the
     new version.

5. **Tag + GitHub release** — only after all four packages are live:

   ```sh
   git tag -a v0.1.X -m "0.1.X: <headline>"
   git push origin v0.1.X
   gh release create v0.1.X --title "0.1.X: <headline>" --notes "<what shipped>"
   ```

   Tag format is bare `vX.Y.Z`. Release title matches the commit headline
   exactly. Skipping this step is the classic failure: npm live, tag absent,
   every changelog link to `…/releases/tag/v0.1.X` 404s.

6. **Verify** — the release is not done until all of these hold:

   ```sh
   npm view ossclip version              # → 0.1.X (check all four packages)
   curl -s -o /dev/null -w "%{http_code}" \
     https://github.com/AhsanAyaz/ossclip/releases/tag/v0.1.X   # → 200
   ```

## Invariants worth re-checking per release

- The npm page (npmjs.com/package/ossclip) renders `apps/cli/README.md` from
  the published tarball — README changes only appear after a publish.
- The telemetry key baked in `apps/cli/src/telemetry.ts` is the write-only
  PostHog ingest key (EU). If it ever rotates, rotate before the bump commit
  so the release ships the working key.
- Nothing in the working tree: `git status` clean before step 3.
