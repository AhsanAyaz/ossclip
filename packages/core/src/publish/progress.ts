/**
 * Encode progress for the delivery encode (2026-08-29): a real 5-minute video
 * spends minutes in x264 with zero feedback — the CLI line and the editor
 * panel both need percent + ETA, so the parsing lives here, pure, where both
 * can reach it.
 *
 * ffmpeg's `-progress pipe:1` emits key=value lines on stdout roughly twice a
 * second; this module turns those into { outTimeSec, speed } and the ETA
 * arithmetic. No spawning here — encodeDelivery owns the ffmpeg call.
 */

export interface FfmpegProgress {
  /** How far into the OUTPUT the encode is, in seconds. */
  outTimeSec?: number;
  /** Encode speed as a multiple of realtime (`speed=1.53x` → 1.53). */
  speed?: number;
}

/**
 * Parse a chunk of ffmpeg's `-progress` key=value stream. Returns the LAST
 * value seen per key in this chunk — the stream repeats the block every
 * ~500ms, and only the newest matters. `N/A` values (the first block, before
 * ffmpeg has numbers) are ignored, and unparseable text yields nothing rather
 * than a guess. The caller keeps a running latest across chunks; feeding only
 * complete lines is also the caller's job (a chunk boundary can split a line
 * mid-value, and half a number parses as the wrong number).
 */
export function parseFfmpegProgress(chunk: string): FfmpegProgress {
  const out: FfmpegProgress = {};
  for (const line of chunk.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (value.length === 0 || value === "N/A") continue;
    // out_time_us preferred; out_time_ms is ALSO microseconds despite the
    // name (long-standing ffmpeg quirk — trusting the name would report a
    // 1000x-too-long encode), out_time is the HH:MM:SS.xx spelling.
    if (key === "out_time_us" || key === "out_time_ms") {
      const us = Number(value);
      if (Number.isFinite(us) && us >= 0) out.outTimeSec = us / 1_000_000;
    } else if (key === "out_time") {
      const m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(value);
      if (m !== null) {
        out.outTimeSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      }
    } else if (key === "speed") {
      const n = Number(value.replace(/x$/i, ""));
      if (Number.isFinite(n) && n >= 0) out.speed = n;
    }
  }
  return out;
}

/**
 * Seconds of encode left: (duration − done) / speed. Null when speed ≤ 0 —
 * a division by ffmpeg's warm-up `speed=0x` would print "Infinity left".
 * Clamped at 0: out_time can overshoot the probed duration at the tail
 * (muxer flush), and a negative ETA reads as nonsense.
 */
export function encodeEta(durationSec: number, outTimeSec: number, speed: number): number | null {
  if (speed <= 0) return null;
  return Math.max(0, (durationSec - outTimeSec) / speed);
}

/**
 * Seconds → "5:20". Lived in the CLI's publish.ts first (duration-cap
 * messages); moved here so the progress lines on both sides of the wire spell
 * time the same way — the CLI re-exports it, the panel keeps its own copy for
 * the documented Vite-bundle reason.
 */
export function formatMinSec(sec: number): string {
  const whole = Math.round(sec);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
