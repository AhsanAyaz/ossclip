# Fixture script (explainer phase 1, FINDINGS §158)

The `--script` fixture for `fixtures/fixture.mp4`: its spoken lines are the
fixture's own words (`fixture.transcript.json`), written the way a playbook
script writes them, so every cue aligns at a score of 1. One cue of each kind
the planner handles: an unhinted cue, a `clip:` cue, and a `[Component]` hint.

The clip is not committed; make it beside this file with

    mkdir -p fixtures/clips && ffmpeg -f lavfi -i "color=c=red@0.5:s=320x240:d=1.5:r=30,format=yuva420p" \
      -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -y fixtures/clips/fixture-clip.webm

## Hook

🎬 Title card: welcome back
🗣️ Hello everyone, welcome back.

🎬 clip: clips/fixture-clip.webm
🗣️ Today I want to show you something **cool**.

## Payoff

🎬 [StatCard] One number: the clean edit
🗣️ This raw take becomes a clean edit automatically.
