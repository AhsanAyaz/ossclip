# @ossclip/core

Part of [**ossclip**](https://github.com/AhsanAyaz/ossclip) — a local-first CLI that turns a talking-head take into a finished short: silence and filler words cut, word-timed kinetic captions, face-aware framing, and LLM-planned code-rendered on-screen graphics.

This package is the framework-free pipeline: schema, transcription, analysis, cutlist, captions, framing, and the LLM producer.

It is published so the CLI can depend on it and so the pieces are reusable, but the supported entry point is the CLI:

```sh
npm install -g ossclip
ossclip doctor
```

APIs here move between rounds — pin an exact version if you depend on them directly.

**Documentation:** [github.com/AhsanAyaz/ossclip](https://github.com/AhsanAyaz/ossclip)

## Licence

MIT. Rendering depends on [Remotion](https://www.remotion.dev/), which carries [its own two-tier licence](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md).
