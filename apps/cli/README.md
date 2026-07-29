# ossclip

**A local-first CLI that turns a talking-head take into a finished short.** It cuts silence and filler words, writes word-timed kinetic captions, frames on the measured face, and has an LLM plan **code-rendered on-screen graphics** — title cards, stat cards, diagrams, terminal and chat mockups — from what was actually said.

Transcription is local (whisper.cpp), rendering is local (Remotion); the only network calls are the LLM planning ones, on your own key or your existing Claude Code subscription. Vertical 9:16 by default, landscape 16:9 with `--aspect`.

![A produced frame](https://raw.githubusercontent.com/AhsanAyaz/ossclip/main/docs/site/assets/render-example.png)

```sh
npm install -g ossclip
ossclip doctor             # checks every prerequisite, prints the exact fix per line
```

`ossclip doctor` checks Node ≥ 22, `ffmpeg`/`ffprobe`, [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`whisper-cli`), the transcription model, and an LLM provider — printing the per-platform install command for anything missing.

```sh
# The whole thing: cut + captions + LLM-planned graphics + cover
ossclip produce input.mp4 --produce -o out.mp4

# Just the cut and captions — no LLM, no network
ossclip produce input.mp4 -o out.mp4

# Long-form in, one short out: the strongest ~60s window, chosen by the producer
ossclip produce podcast.mp4 --produce --clip 60 -o clip.mp4

# Edit what it produced — direct manipulation, in the browser
ossclip edit "<work directory>"
```

**Scope, honestly:** ossclip is at its best polishing a take you have already cut down. `--clip` selects a single strongest window from long-form input — one clip, not N.

AI can make mistakes: the cut, the captions and every graphic are generated — review the output before publishing.

**Full documentation, flags, keybinds and the findings log:** [github.com/AhsanAyaz/ossclip](https://github.com/AhsanAyaz/ossclip)

## Licence

MIT. Rendering depends on [Remotion](https://www.remotion.dev/), which is source-available under [its own two-tier licence](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md) — for-profit companies above its stated size need a company licence.
