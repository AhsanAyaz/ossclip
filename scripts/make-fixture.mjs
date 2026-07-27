#!/usr/bin/env node
/**
 * Deterministic test fixture: synthesizes each word as its own espeak-ng clip,
 * so word boundaries are known EXACTLY by construction (no ASR involved).
 * Emits:
 *   fixtures/fixture.mp4              — 1080x1920 testsrc2 video + speech audio
 *   fixtures/fixture.transcript.json  — ground-truth transcript (schema-valid)
 *   fixtures/edited-reel.mp4          — a PRE-EDITED reel: a burned-in title
 *                                       over the first half (FINDINGS §26/§32)
 *   fixtures/landscape.mp4            — a 16:9 source, for the crop math that
 *                                       used to assume 9:16 outright
 *
 * The fixture contains everything the cutlist must handle: leading dead air,
 * a short sentence pause (must survive), fillers (um/uh), a long mid-take
 * pause (must be tightened), and trailing dead air.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RATE = 22050;
const WORD_GAP = 0.08;
const OUT_DIR = new URL("../fixtures/", import.meta.url).pathname;
const WORK = join(OUT_DIR, "work");

const SCRIPT = [
  { sil: 2.0 },
  { w: "Hello" }, { w: "everyone" }, { w: "welcome" }, { w: "back" },
  { sil: 0.45 },
  { w: "um" },
  { sil: 0.3 },
  { w: "today" }, { w: "I" }, { w: "want" }, { w: "to" }, { w: "show" },
  { w: "you" }, { w: "something" }, { w: "cool" },
  { sil: 1.8 },
  { w: "uh" },
  { sil: 0.25 },
  { w: "this" }, { w: "raw" }, { w: "take" }, { w: "becomes" }, { w: "a" },
  { w: "clean" }, { w: "edit" }, { w: "automatically" },
  { sil: 2.5 },
];

const sh = (bin, args) => execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

const probeDur = (path) =>
  Number(
    sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path])
      .toString()
      .trim(),
  );

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const pieces = []; // { path, dur, word? }
let i = 0;
let prevWasWord = false;
for (const item of SCRIPT) {
  if (item.sil !== undefined) {
    const p = join(WORK, `sil_${i}.wav`);
    sh("ffmpeg", ["-y", "-f", "lavfi", "-i", `anullsrc=r=${RATE}:cl=mono`, "-t", String(item.sil), "-c:a", "pcm_s16le", p]);
    pieces.push({ path: p, dur: item.sil });
    prevWasWord = false;
  } else {
    if (prevWasWord) {
      const p = join(WORK, `gap_${i}.wav`);
      sh("ffmpeg", ["-y", "-f", "lavfi", "-i", `anullsrc=r=${RATE}:cl=mono`, "-t", String(WORD_GAP), "-c:a", "pcm_s16le", p]);
      pieces.push({ path: p, dur: WORD_GAP });
      i++;
    }
    const raw = join(WORK, `w_${i}_raw.wav`);
    const trimmed = join(WORK, `w_${i}.wav`);
    sh("espeak-ng", ["-v", "en-us", "-s", "165", "-w", raw, item.w]);
    // Tight-trim leading/trailing silence so measured duration == spoken span.
    sh("ffmpeg", [
      "-y", "-i", raw,
      "-af",
      "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse",
      "-ar", String(RATE), "-ac", "1", "-c:a", "pcm_s16le",
      trimmed,
    ]);
    pieces.push({ path: trimmed, dur: probeDur(trimmed), word: item.w });
    prevWasWord = true;
  }
  i++;
}

// Ground-truth transcript from the assembly arithmetic.
let t = 0;
const words = [];
for (const p of pieces) {
  if (p.word) words.push({ text: p.word, start: Number(t.toFixed(4)), end: Number((t + p.dur).toFixed(4)) });
  t += p.dur;
}
const totalDur = t;

const concatList = join(WORK, "concat.txt");
writeFileSync(concatList, pieces.map((p) => `file '${p.path}'`).join("\n"));
const audioPath = join(WORK, "audio.wav");
sh("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c:a", "pcm_s16le", audioPath]);

const fixturePath = join(OUT_DIR, "fixture.mp4");
sh("ffmpeg", [
  "-y",
  "-f", "lavfi", "-i", `testsrc2=size=1080x1920:rate=30:duration=${totalDur.toFixed(3)}`,
  "-i", audioPath,
  "-shortest",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "128k",
  fixturePath,
]);

writeFileSync(
  join(OUT_DIR, "fixture.transcript.json"),
  JSON.stringify({ language: "en", words }, null, 2),
);

console.log(`fixture: ${fixturePath} (${totalDur.toFixed(2)}s, ${words.length} words)`);
console.log(`transcript: ${join(OUT_DIR, "fixture.transcript.json")}`);

/**
 * The pre-edited reel (FINDINGS §26/§32/§34).
 *
 * White type in a solid black box over the first half — the highest-contrast
 * burned-in title that exists, and TRANSIENT, which is what the first detector
 * got wrong: it demanded a band be busy in half of all sampled frames and so
 * voted out a title that ran a third of the clip. The background is testsrc2's
 * colour bars, which are every bit as bimodal as white-on-black type and were
 * the original false positive. One clip, both failure modes.
 */
const TITLE_SEC = 6;
const REEL_SEC = 12;
const reelPath = join(OUT_DIR, "edited-reel.mp4");
sh("ffmpeg", [
  "-y",
  "-f", "lavfi", "-i", `testsrc2=size=720x1280:rate=30:duration=${REEL_SEC}`,
  "-f", "lavfi", "-i", `sine=frequency=220:duration=${REEL_SEC}`,
  "-vf",
  `drawbox=x=0:y=200:w=720:h=110:color=black@1:t=fill:enable='lt(t,${TITLE_SEC})',` +
    `drawtext=text='I got Claude Max for free':fontcolor=white:fontsize=42:` +
    `x=(w-text_w)/2:y=232:enable='lt(t,${TITLE_SEC})'`,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "96k", "-shortest",
  reelPath,
]);
console.log(`edited reel: ${reelPath} (${REEL_SEC}s, title 0-${TITLE_SEC}s)`);

/**
 * A 16:9 source. Every crop calculation used to assume the source shared the
 * frame's 9:16 aspect — true for phone footage, wrong for a webcam or a screen
 * recording, where `object-fit: cover` spills HORIZONTALLY instead.
 */
const landscapePath = join(OUT_DIR, "landscape.mp4");
sh("ffmpeg", [
  "-y",
  "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=8",
  "-f", "lavfi", "-i", "sine=frequency=220:duration=8",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "96k", "-shortest",
  landscapePath,
]);
console.log(`landscape: ${landscapePath} (8s, 16:9)`);

/**
 * The letterboxed source (PLAN 2026-07-28 Task 7): the golden fixture's own
 * picture (audio and all) baked into a landscape strip with black bars above
 * and below. The file probes 1080×1920 but the picture is 1080×606 — the shape
 * of the real clip that wasted two-thirds of every video slot.
 */
const letterboxedPath = join(OUT_DIR, "letterboxed.mp4");
sh("ffmpeg", [
  "-y", "-i", fixturePath,
  "-vf", "scale=1080:606,pad=1080:1920:0:657",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
  "-c:a", "copy",
  letterboxedPath,
]);
console.log(`letterboxed: ${letterboxedPath} (content 1080x606 at y 657)`);
