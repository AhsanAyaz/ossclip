# Edit captions and framing in the browser

`ossclip edit <workdir>` opens a local editing page on a workdir that `produce` or `transcribe` already created.
Caption editing in the transcript shipped 2026-08-19, together with the non-Latin pipeline.

## Sub-features

- Transcript-as-caption-editor: fix a word and the burned-in caption follows
- Framing and crop overrides, written back as override files in the workdir
- Cover regeneration from the editor without a full re-render (0.1.27)
- Cover frame picked on the right clock: **Use current playhead** converts to the source clock for `--from source`,
  clamps a cut instant with a spoken note, and **Preview** renders a candidate to `cover-preview.jpg` without
  replacing the cover; the seconds field survives Apply (0.1.31, §156)
- Scene overrides anchored to their transcript words, so a re-plan that renumbers scenes cannot misapply an edit;
  an edit whose words are gone is parked under a `#orphaned` key rather than joined to the impostor (0.1.31, §155)
- Non-Latin text end to end, Urdu being the case that drove it

## How to get to it (user POV)

```sh
ossclip produce input.mp4 -o out.mp4    # config `openEditorAfterProduce` may open it automatically
ossclip edit <workdir>                  # or open it later
```

## Driving it with the CLI

Two surfaces, so two levels of proof:

1. **Server:** start `pnpm ossclip edit "$WD" --editor-port <free port>`, confirm the port answers, then stop the
   process you started.
2. **Browser:** drive the page with Playwright MCP. Prefer ARIA labels and route paths over coordinates.

**Proves it works:** editing a word in the transcript writes an override file into the workdir, and a re-render
picks it up. Assert on the override file, not only on what the page shows — the visible state and the persisted
state are exactly what can diverge here.

## Gotchas

- **Unproven.** No captured run.
- `doctor` checks `editor page → apps/cli/editor-dist`. A stale or missing `editor-dist` means you are driving an
  old build; rebuild with `pnpm build` before trusting what you see.
- Pass an explicit `--editor-port` so two drives cannot collide, and never drive a workdir the user has open.
