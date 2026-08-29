# Starter SFX pack — sources and licenses

Every file is license-clean for redistribution inside this repo and in
published, monetized videos.

## Kenney "Interface Sounds" — CC0 (public domain)

Source: https://kenney.nl/assets/interface-sounds (zip:
`kenney_interface-sounds.zip`, downloaded 2026-08-29). License: Creative
Commons CC0. Transcoded to mono mp3 128k with ffmpeg.

| file | original |
|---|---|
| ding.mp3 | Audio/confirmation_001.ogg |
| pop.mp3 | Audio/drop_002.ogg |
| click.mp3 | Audio/click_002.ogg |
| error-buzz.mp3 | Audio/error_004.ogg |
| scratch.mp3 | Audio/scratch_003.ogg |

## Synthesized in-repo — CC0

`whoosh-soft`, `whoosh-fast`, `swoosh-exit`, `riser-short`, `boom-dramatic`
and `tape-stop` are generated from pure ffmpeg expressions by
`synthesize.sh` in this directory (no third-party samples involved) and are
dedicated to the public domain under CC0. Rerun the script to regenerate.

The originally-planned "vine-boom"/"bruh" style voice memes are deliberately
NOT bundled — no CC0 source exists for them. Users who want them drop their
own files into `~/.ossclip/sfx/<pack>/` with a `pack.json`.
