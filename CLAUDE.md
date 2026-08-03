# Working in this repo

## Model routing

Opus in the main thread does the thinking: exploring the codebase, design,
writing plans, reviewing what came back, and any debugging where the cause is
not yet known.

Mechanical steps from a settled design get delegated to the `executor`
subagent, which is pinned to Sonnet (`.claude/agents/executor.md`). A step is
delegable when it is self-contained enough to hand to someone who has not
read this conversation — which a written plan task already is. Bundle the
context it needs into the prompt; subagents do not inherit the main thread's
context.

Escalate back to the main thread the moment a delegated step turns out to
need a decision. A subagent guessing at design is the failure mode this split
exists to avoid, and it is worse than not delegating at all.

Do not delegate: anything still being designed, debugging with an unknown
cause, or a change whose blast radius is not yet mapped.

## Commands

```sh
pnpm test        # vitest, whole workspace — must be green before anything ships
pnpm typecheck   # tsc --noEmit across every package, in parallel
pnpm build       # builds the editor page the CLI serves from editor-dist/
pnpm fixture     # generates a synthetic test video
```

## House style

Comments explain *why*, not what, and cite the findings section that forced
the choice where one exists (`R24 §117`, `§93a`). The history is full of
comments that are the only record of a bug that cost hours — keep writing
them.

Pure logic is separated from I/O so it can be tested without a filesystem, a
TTY, or a network: `openCommand()` returns a `{bin, args}` pair and
`openInBrowser()` spawns it, and that split is why the platform matrix has a
test. Follow it.

Values that come from a user are parsed with zod, never coerced. A typo'd
`--source-fit containn` silently falling back to `cover` is the exact crop
the flag exists to prevent.

## Releases

All four packages (`ossclip`, `@ossclip/core`, `@ossclip/renderer`,
`@ossclip/scenes`) move in lockstep, in a single `0.1.X: <headline>` commit.

The 0.1.4 → 0.1.5 gap is the cautionary tale: the fix for `ossclip edit`
crashing on Windows and Linux landed one commit *after* the version bump, so
npm shipped the crash to every non-macOS user for the life of the release.
Bump last, and check `git log <last-tag>..HEAD` before publishing.
