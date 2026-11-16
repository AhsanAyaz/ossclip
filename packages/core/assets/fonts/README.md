# Bundled fonts

## NotoNastaliqUrdu-Bold.ttf

Noto Nastaliq Urdu Bold, from the notofonts/nastaliq **v3.007** GitHub
release (`googlefonts/ttf/NotoNastaliqUrdu-Bold.ttf`), © 2022 The Noto
Project Authors — licensed under the SIL Open Font License 1.1 (`OFL.txt`
beside this file). The OFL permits bundling and redistribution with the
license text included, which is why the license ships in this directory.

Why it is bundled at all: caption rendering must be deterministic across
machines, and a Linux CI box (or a fresh Windows install) has no Nastaliq
face — Urdu captions there fell back to whatever Arabic-script font the OS
had, or to tofu. Only the Bold face ships because captions render at
`fontWeight: 900` and one face keeps the package small (~616 KB).

## Inter and DejaVu Sans Mono (the explainer look)

Loaded only when the theme says `fonts: "bundled"`, which only `--look
explainer` sets (`fontsToLoad` in `src/bundled-fonts.ts`); every other run
copies and fetches none of these files. They ship so the look renders in the
same faces on a Linux render box, which has neither font, as on the author's
machine.

| File | Source file | Package |
|---|---|---|
| `Inter-ExtraBold.woff2` | `files/inter-latin-800-normal.woff2` | `@fontsource/inter@5.3.0` |
| `Inter-Black.woff2` | `files/inter-latin-900-normal.woff2` | `@fontsource/inter@5.3.0` |
| `DejaVuSansMono.woff2` | `files/dejavu-mono-latin-400-normal.woff2` | `@fontsource/dejavu-mono@5.3.0` |
| `DejaVuSansMono-Bold.woff2` | `files/dejavu-mono-latin-700-normal.woff2` | `@fontsource/dejavu-mono@5.3.0` |

Copied byte for byte from the npm tarballs (`npm pack`), latin subset only.
The render registers them under the family names the explainer stacks ask
for, `Inter` and `DejaVu Sans Mono` (fontsource calls the second family
"DejaVu Mono"; the registered name is ours).

**Licences.**

- Inter: SIL Open Font License 1.1, © 2016 The Inter Project Authors.
  `Inter-OFL.txt` is the package's `LICENSE`, verbatim. Upstream font
  metadata version `v20`.
- DejaVu Sans Mono: the package declares `OFL-1.1`, but the licence text it
  ships — `DejaVu-LICENSE.txt`, the package's `LICENSE` verbatim — is the
  Bitstream Vera Fonts licence plus the Arev Fonts licence, with DejaVu's own
  changes in the public domain. That text is the one that governs, and it
  permits redistribution with the notice included. Upstream font version
  `v2.37`.

Both licences require the notice to travel with the fonts, which is why the
text files sit here and why the packaging test checks for them.
