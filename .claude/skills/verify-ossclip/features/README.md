# ossclip feature map

What a user can actually do, from their point of view. The harness is the `ossclip` CLI driven through
`pnpm ossclip` — see `../SKILL.md`.

A change is verified when every feature it touches has been driven, not when the run that was easiest to drive
passed. Check this index before claiming a change is proven.

| Feature | File | Drive cost | Proven |
|---|---|---|---|
| Cut and caption a take (`transcribe`) | [transcribe.md](transcribe.md) | ~2s, offline | **yes** — baseline in `../SKILL.md` |
| Render a finished video (`produce`) | [produce.md](produce.md) | slow, ffmpeg render | **yes** (offline path, 2026-08-30) — `docs/verification/2026-08-30-color-grade/` |
| Export cuts as NLE markers (`analyze`) | [analyze.md](analyze.md) | ~2s, offline | no |
| Edit captions and framing in the browser (`edit`) | [edit.md](edit.md) | needs a browser | no |
| Provision prerequisites (`setup` / `doctor`) | [setup-doctor.md](setup-doctor.md) | doctor is instant | doctor only |

"Proven" means a real run captured evidence, not that the code was read. Update the column when that changes;
a stale "yes" is worse than a "no".

Not yet mapped: `studio`, `cover`, `telemetry`, and the `--produce` LLM planner. Add them when they are driven.
