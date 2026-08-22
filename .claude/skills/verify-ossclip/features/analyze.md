# Export cuts as NLE markers

`ossclip analyze` (alias `analyse`) plans the cuts and exports them as labelled markers for an editor timeline.
No render, no LLM.

## Sub-features

- Marker export for a video editor
- The same cutlist analysis as `transcribe`, without the caption and framing work
- American and British spelling both resolve — the alias exists so a learned command never becomes an unknown one

## How to get to it (user POV)

```sh
ossclip analyze my-take.mp4
```

For someone who wants ossclip's cut decisions but intends to edit in their own NLE.

## Driving it with the CLI

```sh
WD=$(mktemp -d)
pnpm ossclip analyze fixtures/fixture.mp4 \
  --transcript fixtures/fixture.transcript.json \
  --workdir "$WD"
```

**Proves it works:** a marker file lands in the workdir, and its marker timestamps line up with the `cutlist`
boundaries that `transcribe` produces from the same fixture. The two commands disagreeing is the bug this drive
is for.

## Gotchas

- **Unproven.** Derived from the command registration in `apps/cli/src/program.ts`, not from a captured run. The
  exact output filename and marker format still need to be confirmed against a real run.
- Verify the alias too: `pnpm ossclip analyse` must behave identically.
