# An interactive front door — wizards that teach the flags

*Design. Companion to `apps/cli/src/index.ts` and the R17 §83 project picker in `apps/cli/src/edit.ts`.*

## Why

A first user was handed `ossclip produce input.mp4 --produce -o out.mp4` over
chat and got through it. The next command defeated her for seven minutes:

```
> ossclip edit D:\CWA\TiDB
no render-props.json in D:\CWA\TiDB — run `ossclip produce` there first
```

She had run `produce` there. The error names a fix already performed, because
`produce` writes into `<input dir>/.ossclip/<name>/` and `edit` wants that
nested directory — a fact stated nowhere in the failure. She was unblocked
only by being told the path over chat.

Two separate failures sit underneath that, and neither is solved by better
documentation:

1. **Nothing tells you what to run.** Her first question was "how can I open
   the editor? do I have to run the produce command first?" — asked before
   any command was typed. `ossclip` with no arguments prints a help page
   organised around commands she has no model for yet.
2. **`produce` has twenty-five flags.** The chat transcript shows exactly one
   being discovered per message, from a human who already knew the answer.

Meanwhile `ossclip edit` with *no* argument already opens a picker over
`~/.ossclip/recent-projects.json`, which `produce` already populates
(`recordRecentProject`, R17 §83). The feature that would have saved her
existed the entire time. She passed an argument, so she never saw it, and the
error message pointed away from it rather than at it.

## Scope

**In:** a wizard reachable from bare `ossclip`; prompt-on-demand when
`produce` or `edit` is missing information at a TTY; a workdir resolution
ladder for `edit`; an offer to open the editor after a successful `produce`,
persistable; the `▸ running:` echo that makes every wizard run a flags lesson.

**Out, deliberately:**

- **A full-screen TUI.** Adds a render dependency, fights ConPTY, and the
  logic worth testing would live inside a component tree. The wizard is a
  sequence of questions, which is what clack is.
- **Migrating `setup.ts` to clack.** Its hand-rolled `readline/promises`
  works. Mechanical follow-up, not a prerequisite.
- **Wizards for `transcribe` and `studio`.** Debugging surfaces used by
  people who already know the flags.
- **A `--dry-run` that prints argv and exits.** Wanted, but it is a flag
  feature; it does not need the wizard to exist.

Flags remain the source of truth. Nothing about a non-TTY invocation changes.

## Architecture

### Wizards emit argv, not option objects

The load-bearing decision. A wizard's output is a `string[]` of CLI
arguments, handed back through the *existing* commander parse rather than
constructed into a `ProduceOptions` and passed to `produce()` directly.

```
answers ──> produceWizard() ──> ["produce", "./take.mp4", "--produce",
                                 "--intent", "…"]
                                        │
                                        ├──> printed as `▸ running: …`
                                        └──> program.parseAsync(argv)
                                                    │
                                              existing zod parses
                                                    │
                                                 produce()
```

Three things follow, and all three are the reason for the choice:

- **One validation path.** The `CleanupLevelSchema.parse`, the provider
  enum, `SceneComponentIdSchema` and the `source-fit` enum at
  `index.ts:124-133` stay the only place those values are checked. A wizard
  cannot assemble a combination the flags would have rejected.
- **The echo cannot drift from the run.** The printed command is rendered
  from the same array that is executed. A wizard that teaches the wrong
  incantation is worse than no wizard, and this makes that failure
  unrepresentable rather than merely unlikely.
- **Wizards become pure.** `answers → argv` is a function over data with no
  I/O, which is how the rest of this repo is tested.

### Module layout

New directory `apps/cli/src/interactive/`:

| file | job |
| --- | --- |
| `tty.ts` | `isInteractive()` — `stdin.isTTY && stdout.isTTY && !env.CI && !env.OSSCLIP_NO_INTERACTIVE`. The only TTY sniff in the codebase; everything else asks this. |
| `menu.ts` | bare `ossclip` → Produce / Edit / Set up / Doctor. Produce enters the wizard; Edit enters the ladder with no target, i.e. the existing picker; Set up and Doctor are thin passthroughs to the commands that already exist, taking no further answers. |
| `produce-wizard.ts` | answers → `["produce", …]` |
| `resolve-workdir.ts` | pure `(target, probe) → Resolution`. No `fs` inside: the caller passes a `probe` record — is `target` a file or a directory, does it hold `render-props.json`, and what does `target/.ossclip/` contain with mtimes. Tests inject that record; production fills it from `fs`. |
| `prefs.ts` | the new config keys, over the existing `saveConfigPatch` |
| `render.ts` | the `▸ running:` echo, quoting per platform |

`@clack/prompts` is the one new dependency. Chosen over `@inquirer/prompts`
for a smaller install and a look already close to this CLI's `▸` output;
chosen over another hand-rolled readline because select, multiselect and
real cancel semantics are the entire point and writing them again is not.

### Four call sites in `index.ts`

1. **`program.action(…)` on the root.** Fires only when no subcommand is
   given. Interactive → `menu()`. Non-interactive → today's help output,
   byte for byte.
2. **`produce` argument becomes `[input]`.** Missing *and* interactive →
   wizard. Missing and non-interactive → commander's existing "missing
   required argument" error, unchanged.
3. **`edit [workdir]`** routes through `resolveWorkdir` before
   `startEditServer`.
4. **After a successful `produce`** — the open-editor offer.

## Behaviour

### Produce wizard: three tiers of flag

Twenty-five flags. A wizard that asks all of them is worse than the flags.

**Tier 1 — always asked (6 prompts, one of them the positional argument):**

| prompt | flag |
| --- | --- |
| Video file | `<input>`, validated to exist and be a file |
| Shape | `--aspect` 9:16 / 16:9 |
| Cleanup | `--cleanup`, default `standard` |
| Plan graphics with an LLM? | `--produce` |
| What is the video about? | `--intent` — asked **only** when graphics are on |
| Output path | `--out`, default shown, Enter accepts |

**Tier 2 — one multiselect ("Anything else?"), then a follow-up per checked
item (7):** `--clip`, `--source-fit contain`, `--speaker`,
`--whisper-model`, `--blooper-marker`, `--source-is-edited`, `--llm`.

Unchecked means the flag is absent from argv, which means the existing
default applies. **The wizard never emits a flag whose value equals the
default** — otherwise the taught command line grows noise that the user then
copies forever.

`--speaker` and `--llm` prefill from `~/.ossclip/config.json` where set, so
those answers persist through the config that already exists rather than a
new one.

**Tier 3 — flags only, never prompted (the remaining 13):** `--transcript`, `--scenes`,
`--force-component`, `--clip-window`, `--noise-db`, `--workdir`,
`--no-mezzanine`, `--no-repair`, `--cover`, `--no-cover`, `--no-render`,
`--llm-model` / `--llm-fast-model`. Debug and internal surfaces. Offering
`--clip-window` in a menu would be a defect: it is written *by* `--clip` runs
into `command.json` so the editor's Render replays the same window without an
LLM call. A human choosing it by hand is a corrupted replay.

### The `edit` workdir ladder

`resolveWorkdir(target)`, first match wins:

1. `target/render-props.json` exists → that directory. (Today's only rung.)
2. `target/.ossclip/*/render-props.json`, exactly one → use it, and say so:
   `▸ resolved D:\TiDB → D:\TiDB\.ossclip\take1`.
3. …more than one → an interactive select, newest first by mtime.
   Non-interactive → an error listing every candidate path verbatim, so the
   next command is copy-paste.
4. `target` is a video file → run the same ladder against its parent.
5. Nothing matches → the error that should have greeted her:

```
✗ no ossclip output under D:\TiDB

  produce writes into <video's folder>\.ossclip\<name>\ —
  that nested folder is what `edit` wants, not the folder you ran produce in.

  Produce one:                ossclip produce D:\TiDB\your-video.mp4
  Or pick from recent runs:   ossclip edit
```

The last line is the actual repair. The old message's failure was not tone;
it was pointing at `produce` — work already done — instead of at the picker
that was one keystroke away.

### The offer to open the editor

New config key, read and written by `prefs.ts`:

```jsonc
// ~/.ossclip/config.json
{ "openEditorAfterProduce": "ask" }   // "ask" (default) | "always" | "never"
```

Fires only when the run succeeded, the session is interactive, **and**
rendering happened — `--no-render` skips it, since there is nothing to look
at.

```
◆  Open the editor on this project?
│  ● Yes
│  ○ No
│  ○ Yes, and stop asking
│  ○ No, and stop asking
```

The last two write the key via `saveConfigPatch`, which already
read-merge-writes the raw file so a hand-edited `pricing` or `speaker`
survives. `"always"` opens without asking; `"never"` is silent.

`--open-editor` / `--no-open-editor` on `produce` beat the config, and are
how a non-interactive run states its intent. Choosing yes calls the same
`startEditServer` + `openInBrowser` path `edit` uses, on the workdir just
produced, and holds the foreground until Ctrl-C exactly as `ossclip edit`
does.

## Error handling

- **Cancel is not a failure.** Ctrl-C or Esc at any prompt prints
  `▸ nothing changed.` and exits 0 — matching `setup`'s existing wording for
  the same situation. Never a stack trace, never a half-run.
- **Wizard argv is validated like any other argv.** A wizard bug surfaces as
  the same message a typo'd flag produces, from the same zod parse.
- **A prompt reached without a TTY is a programming error.** `isInteractive()`
  is checked before entry, and the prompt helpers throw a developer-facing
  error if called anyway. That fails in the test suite rather than hanging in
  somebody's CI.

## Testing

Every unit below is pure and needs no TTY:

- `produce-wizard.test.ts` — answers fixture → exact argv. Covers: a
  default-valued answer emits no flag; `--intent` appears only with graphics
  on; unchecked tier-2 items emit nothing.
- `resolve-workdir.test.ts` — all five rungs against an injected listing,
  including exactly-one and many.
- `argv-roundtrip.test.ts` — the one that matters: wizard argv fed into a
  real `program.parseAsync` with a stubbed `produce()`, asserting the
  resulting options object. This is the test that stops wizard/flag drift,
  and it is why wizards emit argv.
- `prefs.test.ts` — all three `openEditorAfterProduce` values against a temp
  config dir. `saveConfigPatch` already takes a `baseDir`, so no test touches
  a real `$HOME`.
- `render.test.ts` — argument quoting for paths containing spaces, both
  platforms.

The interactive paths themselves stay untested by unit tests. The design's
answer to that is that no logic lives inside them.
