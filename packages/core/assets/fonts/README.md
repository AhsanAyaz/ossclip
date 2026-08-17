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
