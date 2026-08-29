#!/bin/sh
# Synthesizes the non-Kenney starter sounds from pure ffmpeg expressions, so
# the bundled pack carries zero third-party license risk beyond Kenney's CC0.
# Re-run to regenerate byte-similar (encoder-dependent) sources: sh synthesize.sh <outdir>
set -e
OUT="${1:-.}"
FF="${FFMPEG:-ffmpeg}"
# whoosh-soft: pink noise through a fading band sweep
$FF -y -f lavfi -i "anoisesrc=color=pink:duration=0.7:seed=7" -af "highpass=f=300,lowpass=f=2400,afade=t=in:d=0.15,afade=t=out:st=0.35:d=0.35,volume=1.4" "$OUT/whoosh-soft.wav"
# whoosh-fast: brighter, shorter
$FF -y -f lavfi -i "anoisesrc=color=white:duration=0.35:seed=11" -af "highpass=f=800,lowpass=f=5000,afade=t=in:d=0.05,afade=t=out:st=0.15:d=0.2,volume=1.2" "$OUT/whoosh-fast.wav"
# swoosh-exit: whoosh-soft reversed
$FF -y -f lavfi -i "anoisesrc=color=pink:duration=0.6:seed=13" -af "highpass=f=300,lowpass=f=2400,afade=t=in:d=0.1,afade=t=out:st=0.3:d=0.3,areverse,volume=1.3" "$OUT/swoosh-exit.wav"
# riser-short: quadratic pitch ramp + swelling noise
$FF -y -f lavfi -i "aevalsrc='0.35*sin(2*PI*(180+520*t*t)*t)*min(1,2.5*t)':d=1.1" -f lavfi -i "anoisesrc=color=pink:duration=1.1:seed=17" -filter_complex "[1]volume='0.25*t':eval=frame,highpass=f=600[n];[0][n]amix=inputs=2:duration=first,afade=t=out:st=0.95:d=0.15" "$OUT/riser-short.wav"
# boom-dramatic: sub sine thump with harmonic and long decay (the vine-boom register)
$FF -y -f lavfi -i "aevalsrc='0.95*sin(2*PI*55*t)*exp(-2.5*t)+0.3*sin(2*PI*110*t)*exp(-4*t)':d=1.6" -af "alimiter=limit=0.9" "$OUT/boom-dramatic.wav"
# tape-stop: 440->0 pitch slide via falling-rate expression
$FF -y -f lavfi -i "aevalsrc='0.5*sin(2*PI*330*(t-2.2*t*t/2/1.1))*(1-t/1.1)':d=1.1" -af "lowpass=f=3000" "$OUT/tape-stop.wav"
