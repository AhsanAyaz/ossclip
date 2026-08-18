/**
 * Waveform peak extraction for the timing popover's strip — pure math over a
 * decoded channel, no DOM and no canvas, so the bucket boundaries and the
 * out-of-range behavior are testable without an AudioContext (the
 * openCommand/openInBrowser split: the decision is pure, the UI merely draws
 * it). The DRAWING half lives in TranscriptPanel's canvas effect.
 */

export interface WaveformPeaks {
  /** Max-abs sample per bucket, left to right across `[fromSec, toSec]`. */
  buckets: Float32Array;
  fromSec: number;
  toSec: number;
}

/**
 * Max-abs peaks for a time window over one decoded channel. The window may
 * extend past the channel on either side — the popover centers a ±1s pad
 * around a word that can sit at the clip's very edge — and the out-of-range
 * portion contributes ZERO rather than clamping the window: a bucket's x
 * position must keep meaning the same instant whether or not audio exists
 * there, or the span overlay drawn over the strip would shear against it.
 * Degenerate inputs (empty window, zero buckets, empty channel, nonsense
 * sample rate) return all-zero buckets — the flat strip the popover shows
 * when decoding failed, never a throw in a paint path.
 */
export function peaksForWindow(
  channel: Float32Array,
  sampleRate: number,
  fromSec: number,
  toSec: number,
  bucketCount: number,
): WaveformPeaks {
  const n = Math.max(0, Math.floor(bucketCount));
  const buckets = new Float32Array(n);
  if (n === 0 || !(toSec > fromSec) || !(sampleRate > 0) || channel.length === 0) {
    return { buckets, fromSec, toSec };
  }
  const spanSec = toSec - fromSec;
  for (let b = 0; b < n; b++) {
    // Ceil on both edges keeps adjacent buckets disjoint (a sample belongs
    // to exactly one bucket) while covering every sample in the window.
    const i0 = Math.max(0, Math.ceil((fromSec + (spanSec * b) / n) * sampleRate));
    const i1 = Math.min(channel.length, Math.ceil((fromSec + (spanSec * (b + 1)) / n) * sampleRate));
    let peak = 0;
    for (let i = i0; i < i1; i++) {
      const v = Math.abs(channel[i]!);
      if (v > peak) peak = v;
    }
    buckets[b] = peak;
  }
  return { buckets, fromSec, toSec };
}
