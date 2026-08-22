# Provision prerequisites

`ossclip setup` provisions ffmpeg, whisper-cli, and the transcription model into `~/.ossclip`.
`ossclip doctor` checks every prerequisite and prints the exact fix for anything missing.

## Sub-features

- `setup`: shows the plan with sizes and asks before downloading (~600 MB, mostly the `small.en` model), resumes
  interrupted downloads, verifies checksums, and skips anything already present
- Records absolute paths in `~/.ossclip/config.json` and never edits PATH
- LLM provider detection: a logged-in `agy` (Antigravity) or Claude Code needs no key
- `doctor`: one read-only pass over node, ffmpeg, ffprobe, whisper-cli, the model, the LLM provider, and the
  editor page

## How to get to it (user POV)

```sh
npm i -g ossclip
ossclip setup     # once
ossclip doctor    # any time something looks wrong
```

## Driving it with the CLI

```sh
pnpm ossclip doctor
```

**Proves it works:** every row is green and the last line reads `All checks passed`.

Captured 2026-08-19 on this machine: node v24, ffmpeg, ffprobe, whisper-cli, `~/.ossclip/models/ggml-small.en.bin`,
LLM provider `antigravity (agy CLI on PATH)`, editor page `apps/cli/editor-dist`.

## Gotchas

- **Do not drive `setup` as a verification step.** It downloads hundreds of megabytes and mutates `~/.ossclip`,
  which is shared user state, not a sandbox. Verify setup changes by reading the plan it prints, or on a throwaway
  machine.
- `doctor` is safe and read-only. Run it first, every time.
- A red LLM provider row blocks only `--produce` and `cover`. Every drive in this skill is offline, so say which
  rows were red rather than reporting a clean doctor.
