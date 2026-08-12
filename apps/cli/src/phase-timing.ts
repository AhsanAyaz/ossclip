/**
 * Per-phase timing for `produce` (FINDINGS §140). "3 hours" was
 * unattributed: `produce_completed` carried one `duration_ms` for the whole
 * run, so nothing could say WHICH of the four candidate phases — whisper,
 * LLM planning, the Remotion render, ffmpeg concat/normalize — the time went
 * to, and each has a completely different fix if it dominates. Everything in
 * this file is pure (clock injected, no I/O), per the house split; produce()
 * owns the wrapping and program.ts owns the telemetry event.
 */

/**
 * The four attributed phases, exactly the candidates from the §140 table.
 * Everything ELSE produce does (audio extraction, silence/level analysis,
 * content-rect and face sampling, the mezzanine) lands in the log line's
 * `other` remainder rather than a fifth phase — the remainder is PRINTED, so
 * if it ever dominates a real run it accuses itself and earns a phase then.
 */
export type ProducePhase = "transcribe" | "llm" | "render" | "ffmpeg";

/** Milliseconds per phase; a phase that never ran is ABSENT, never 0. */
export type PhaseTimings = Partial<Record<ProducePhase, number>>;

/** Pipeline order — the log line reads like the run did. */
const PHASE_ORDER: ProducePhase[] = ["transcribe", "llm", "render", "ffmpeg"];

/**
 * The log labels name the TOOL, not the internal phase id, because the §140
 * table (and any hardware decision made from it) is about the tools:
 * "whisper 12m" tells the user what to swap; "transcribe 12m" makes them ask.
 */
const PHASE_LABELS: Record<ProducePhase, string> = {
  transcribe: "whisper",
  llm: "llm",
  render: "render",
  ffmpeg: "ffmpeg",
};

export class PhaseTimer {
  private readonly ms: PhaseTimings = {};
  private readonly startedAt: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = this.now();
  }

  /**
   * Accumulates — the llm phase is repair + window selection + scenes, and
   * the ffmpeg phase is concat + loudnorm, so a phase is a SUM of calls, not
   * one interval. Recorded in a `finally` so time spent is time recorded even
   * when the phase throws: the throw aborts the run either way, but a future
   * `produce_failed` that wants to say where the time went must not find the
   * books cooked.
   */
  async time<T>(phase: ProducePhase, fn: () => Promise<T>): Promise<T> {
    const t0 = this.now();
    try {
      return await fn();
    } finally {
      this.ms[phase] = (this.ms[phase] ?? 0) + (this.now() - t0);
    }
  }

  timings(): PhaseTimings {
    return { ...this.ms };
  }

  /** Wall clock since construction — the phases never sum to it; `other` is the gap. */
  totalMs(): number {
    return this.now() - this.startedAt;
  }
}

/**
 * Three scales, matched to what a human checks at each: one decimal under a
 * minute (an 8.2s llm phase must not flatten to "8s" when comparing runs),
 * zero-padded seconds under an hour ("1m03s", so it can't be misread as
 * 1m30s), minutes only above it.
 */
export function formatPhaseDuration(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  if (sec < 3600) {
    return `${Math.floor(sec / 60)}m${String(Math.floor(sec % 60)).padStart(2, "0")}s`;
  }
  return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m`;
}

/**
 * The run log's one-line breakdown, in the ▸ voice, real seconds — this is
 * the user's own machine, so unlike telemetry there is nothing to bucket.
 * Absent phases are omitted (a cached transcript is not a 0.0s whisper run),
 * the remainder is printed as `other` so unattributed time stays visible,
 * and a run with no measured phases prints only the total — an `other` at
 * 100% would just restate it. The remainder clamps at zero: the phases and
 * the total read the clock at different instants, and a -0.0s from that skew
 * would read as a bug in the very line meant to build trust in the numbers.
 */
export function formatPhaseLine(timings: PhaseTimings, totalMs: number): string {
  const measured = PHASE_ORDER.filter((p) => timings[p] !== undefined);
  const total = `▸ time: total ${formatPhaseDuration(totalMs)}`;
  if (measured.length === 0) return total;
  const parts = measured.map((p) => `${PHASE_LABELS[p]} ${formatPhaseDuration(timings[p]!)}`);
  const other = totalMs - measured.reduce((sum, p) => sum + timings[p]!, 0);
  if (other > 0) parts.push(`other ${formatPhaseDuration(other)}`);
  return `${total} — ${parts.join(" · ")}`;
}

/**
 * Same idea as telemetry.ts's `durationBucket` — the exact seconds never
 * leave the machine — but with sub-minute resolution, because the question
 * this answers ("which phase dominates?") has phases that legitimately live
 * in seconds: an llm plan at 8s and a render at 40 minutes both being ">1m"
 * would erase the very comparison §140 exists to make.
 */
export function phaseDurationBucket(
  seconds: number,
): "<10s" | "10-60s" | "1-5m" | "5-15m" | ">15m" {
  if (seconds < 10) return "<10s";
  if (seconds <= 60) return "10-60s";
  if (seconds <= 300) return "1-5m";
  if (seconds <= 900) return "5-15m";
  return ">15m";
}

/**
 * The `produce_completed` props for the phases that ran: `<phase>_bucket`,
 * bucketed, never raw milliseconds (§134 floor — a raw per-phase duration is
 * even closer to fingerprinting a specific take than the total the floor
 * already buckets). Keys are pinned against `assertSafeProps` in
 * phase-timing.test.ts, since a spread into `telemetry.record` is invisible
 * to telemetry.test.ts's source-text drift check.
 */
export function phaseBucketProps(timings: PhaseTimings): Record<string, string> {
  const props: Record<string, string> = {};
  for (const p of PHASE_ORDER) {
    const ms = timings[p];
    if (ms !== undefined) props[`${p}_bucket`] = phaseDurationBucket(ms / 1000);
  }
  return props;
}
