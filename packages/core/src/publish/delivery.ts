import { existsSync } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../exec";
import { evenDim, probe, type IngestTools } from "../ingest";
import { parseFfmpegProgress, type FfmpegProgress } from "./progress";
import type { Probe } from "../schema";

/**
 * Delivery encode for `ossclip publish` (2026-08-29 handoff, item 1).
 *
 * The first real multi-platform publish uploaded the MASTER render — 589MB at
 * ~56 Mbps after `--resolution auto` kept the 4K source's pixels — and failed
 * 5/6 channels. Every platform re-encodes to 6–12 Mbps on ingest, so master
 * quality buys nothing but upload failures (Instagram 2207077, opaque
 * Facebook/Threads errors, and enough bytes to make LinkedIn's ranged-GET
 * issue fatal). The fix is a delivery encode: ≤1080p h264/aac at ~10 Mbps,
 * built lazily at publish time and cached in the workdir. The master stays
 * untouched for the archive.
 */

/** Delivery caps: 1920×1080 landscape, 1080×1920 portrait. */
export const DELIVERY_MAX_SHORT_EDGE = 1080;
export const DELIVERY_MAX_LONG_EDGE = 1920;

/**
 * 10 Mbps target, 12 Mbps ceiling — the top of the range platforms transcode
 * to, so nothing visible is lost that the platform would have kept anyway.
 * The same 12k ceiling doubles as the skip threshold: a master already at or
 * under it gains nothing from a re-encode.
 */
export const DELIVERY_VIDEO_BITRATE_KBPS = 10000;
export const DELIVERY_MAX_BITRATE_KBPS = 12000;

/** What encodeDelivery's `-b:a` always is — fitBitrateKbps must budget for it. */
export const DELIVERY_AUDIO_BITRATE_KBPS = 192;

/**
 * Below ~1 Mbps, 1080p h264 is visibly broken — a size cap that forces the
 * video bitrate under this floor is unattainable, and refusing the channel
 * beats publishing mush the platform would host forever.
 */
export const DELIVERY_MIN_VIDEO_BITRATE_KBPS = 1000;

/**
 * mp4 container overhead margin (~3%) between raw stream bitrates and the
 * bytes on disk. Checked against the field data (2026-08-29): a 2000k video +
 * 192k audio encode of a 321s take landed at 88MB, i.e. within this margin of
 * the naive stream sum — so budgeting streams at cap/1.03 keeps the file
 * under the cap without giving away real bitrate.
 */
const DELIVERY_MUX_OVERHEAD = 1.03;

/**
 * The video bitrate (kbps, floored) that fits a delivery file under
 * `capBytes`: total byte budget shrunk by the mux-overhead margin, minus the
 * audio's share. May come out below the quality floor (or negative) for long
 * videos — `deliveryEncodePlan` turns that into an explicit `unattainable`
 * verdict rather than clamping.
 */
export function fitBitrateKbps(
  capBytes: number,
  durationSec: number,
  audioKbps: number = DELIVERY_AUDIO_BITRATE_KBPS,
): number {
  const totalKbps = (capBytes * 8) / DELIVERY_MUX_OVERHEAD / durationSec / 1000;
  return Math.floor(totalKbps - audioKbps);
}

export interface DeliverySource {
  width: number;
  height: number;
  fps: number;
  /** Seconds, from probe. */
  duration: number;
  /** From stat — with duration this measures the real bitrate, no probe schema change needed. */
  sizeBytes: number;
}

export interface DeliveryPlan {
  width: number;
  height: number;
  videoBitrateKbps: number;
  fileName: string;
}

/**
 * The delivery file's name, which IS its cache key (mezzanine precedent,
 * `mezzanineFileName`): the encode parameters live in the name so a rule
 * change misses the old cache instead of silently serving it.
 */
export function deliveryFileName(width: number, height: number, videoBitrateKbps: number): string {
  return `delivery-${width}x${height}@${videoBitrateKbps}k.mp4`;
}

/**
 * The verdict when a size cap cannot be met above the quality floor —
 * distinct from null (no encode NEEDED) so a caller can refuse the channel
 * with the number that doomed it. The verdict lives in the plan's return
 * rather than a separate `sizeCapAttainable()` checker because the fit
 * arithmetic would then exist twice and drift — a caller cannot plan and
 * forget to check when the plan IS the check.
 */
export interface DeliveryUnattainable {
  unattainable: true;
  /** The video kbps the cap would have needed — for the refusal message. */
  fittedKbps: number;
}

/**
 * What the delivery encode should be, or null when the master is already
 * uploadable as-is (dims within caps AND measured bitrate ≤ the ceiling —
 * masters are always h264/aac out of Remotion, so codec never enters the
 * rule).
 *
 * Scale factor caps BOTH orientations without caring which one this is:
 * min(1, 1080/short-edge, 1920/long-edge) lands landscape on 1920×1080 and
 * portrait on 1080×1920, and never upscales — a small master re-encoded
 * larger would soften every frame for zero bytes saved.
 *
 * `sizeCapBytes` is the per-platform upload ceiling (2026-08-29, live:
 * Instagram's URL-fetch ingest rejected the 409MB 10 Mbps delivery file with
 * 2207077 twice, then published the same 1080p take at 88MB/2 Mbps — see
 * `PLATFORM_SIZE_CAP_BYTES`). When set, the bitrate is fitted under the cap;
 * the null-skip additionally requires the master itself to fit, since an
 * in-spec master can still be over a platform's byte ceiling.
 */
export function deliveryEncodePlan(src: DeliverySource): DeliveryPlan | null;
export function deliveryEncodePlan(
  src: DeliverySource,
  opts: { sizeCapBytes?: number },
): DeliveryPlan | DeliveryUnattainable | null;
export function deliveryEncodePlan(
  src: DeliverySource,
  opts: { sizeCapBytes?: number } = {},
): DeliveryPlan | DeliveryUnattainable | null {
  if (src.width <= 0 || src.height <= 0 || src.duration <= 0) return null;
  const k = Math.min(
    1,
    DELIVERY_MAX_SHORT_EDGE / Math.min(src.width, src.height),
    DELIVERY_MAX_LONG_EDGE / Math.max(src.width, src.height),
  );
  const measuredKbps = (src.sizeBytes * 8) / src.duration / 1000;
  const fitsCap = opts.sizeCapBytes === undefined || src.sizeBytes <= opts.sizeCapBytes;
  if (k === 1 && measuredKbps <= DELIVERY_MAX_BITRATE_KBPS && fitsCap) return null;
  // At k === 1 keep the exact source dims — even-rounding a size that is not
  // being rescaled would manufacture a 1px no-op rescale (mezzanineScale
  // learned the same lesson).
  const width = k < 1 ? evenDim(src.width * k) : src.width;
  const height = k < 1 ? evenDim(src.height * k) : src.height;
  let videoBitrateKbps = DELIVERY_VIDEO_BITRATE_KBPS;
  if (opts.sizeCapBytes !== undefined) {
    const fitted = fitBitrateKbps(opts.sizeCapBytes, src.duration);
    if (fitted < DELIVERY_MIN_VIDEO_BITRATE_KBPS) {
      return { unattainable: true, fittedKbps: fitted };
    }
    videoBitrateKbps = Math.min(DELIVERY_VIDEO_BITRATE_KBPS, fitted);
  }
  return {
    width,
    height,
    videoBitrateKbps,
    fileName: deliveryFileName(width, height, videoBitrateKbps),
  };
}

/**
 * Run the delivery encode. `+faststart` is load-bearing: it moves the moov
 * atom up front, which is what makes platforms' progressive/ranged fetches
 * work (LinkedIn's 206 consumer was the victim of a tail-moov master).
 */
export async function encodeDelivery(
  tools: IngestTools,
  src: { path: string; width: number; height: number },
  dest: string,
  plan: DeliveryPlan,
  opts: { onProgress?: (p: FfmpegProgress) => void } = {},
): Promise<void> {
  const scaling = plan.width !== src.width || plan.height !== src.height;
  // ffmpeg's -progress stream vs. chunk boundaries: a data event can split a
  // line mid-value ("out_time_us=12" + "345\n" parses as the wrong number),
  // so only complete lines reach the parser and the tail carries over. The
  // merged latest goes out per chunk — undefined never overwrites a value
  // already seen.
  let carry = "";
  const latest: { outTimeSec?: number; speed?: number } = {};
  const onStdout = (chunk: string): void => {
    const text = carry + chunk;
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline < 0) {
      carry = text;
      return;
    }
    carry = text.slice(lastNewline + 1);
    const parsed = parseFfmpegProgress(text.slice(0, lastNewline + 1));
    if (parsed.outTimeSec === undefined && parsed.speed === undefined) return;
    if (parsed.outTimeSec !== undefined) latest.outTimeSec = parsed.outTimeSec;
    if (parsed.speed !== undefined) latest.speed = parsed.speed;
    opts.onProgress?.({ ...latest });
  };
  // Encode to a sibling temp path, rename only on success (R27 §125): ffmpeg
  // writes the container header as it goes, so an encode that dies mid-run
  // leaves a valid-looking file, and the existence-keyed cache below would
  // reuse that corpse forever.
  const partial = `${dest}.partial.mp4`;
  try {
    await run(tools.ffmpegPath, [
      "-y", "-i", src.path,
      // Machine-readable progress on stdout, and -nostats so the human
      // frame-counter doesn't spam stderr alongside it.
      "-progress", "pipe:1", "-nostats",
      ...(scaling ? ["-vf", `scale=${plan.width}:${plan.height}`] : []),
      "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p",
      "-b:v", `${plan.videoBitrateKbps}k`,
      "-maxrate", `${DELIVERY_MAX_BITRATE_KBPS}k`, "-bufsize", "20000k",
      // The audio rate fitBitrateKbps budgets for — one constant, no drift.
      "-c:a", "aac", "-b:a", `${DELIVERY_AUDIO_BITRATE_KBPS}k`,
      "-movflags", "+faststart",
      partial,
    ], { onStdout });
    await rename(partial, dest);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
}

export interface DeliveryResult {
  /** The file to upload: the delivery encode, or the master when no encode is needed. */
  path: string;
  /** True when this call ran ffmpeg (vs. skip or cache hit). */
  encoded: boolean;
  /** The MASTER's probe — callers need its duration for the duration caps. */
  probe: Probe;
}

/**
 * The delivery file for a master, encoding it on first need and caching it in
 * the workdir. A cache hit requires the delivery file to exist AND be no
 * older than the master: a re-render writes the same master filename, so
 * existence alone would silently publish the PREVIOUS render's delivery
 * encode.
 */
export async function ensureDeliveryFile(
  tools: IngestTools,
  workdir: string,
  masterPath: string,
  opts: {
    onStart?: (fileName: string) => void;
    /** Live encode progress (percent/ETA are the caller's arithmetic —
     * both already hold the master's duration). Never fires on a skip or a
     * cache hit, which is why the consumers keep a static fallback line. */
    onProgress?: (p: FfmpegProgress) => void;
    /**
     * Per-platform upload ceiling (`PLATFORM_SIZE_CAP_BYTES`) — the bitrate
     * fits under it, and the bitrate-bearing filename caches the capped
     * variant BESIDE the default one (delivery-1920x1080@10000k.mp4 and
     * @2106k.mp4 coexist), so a multi-platform publish encodes each at most
     * once.
     */
    sizeCapBytes?: number;
  } = {},
): Promise<DeliveryResult> {
  const [masterProbe, masterStat] = await Promise.all([probe(tools, masterPath), stat(masterPath)]);
  const plan = deliveryEncodePlan(
    {
      width: masterProbe.width,
      height: masterProbe.height,
      fps: masterProbe.fps,
      duration: masterProbe.duration,
      sizeBytes: masterStat.size,
    },
    { sizeCapBytes: opts.sizeCapBytes },
  );
  if (!plan) return { path: masterPath, encoded: false, probe: masterProbe };
  if ("unattainable" in plan) {
    // A throw, not a silent fallback: falling back to the 10 Mbps file would
    // re-run the exact 2207077 failure the cap exists to prevent. Callers
    // that want to refuse the channel gracefully pre-check with the pure
    // deliveryEncodePlan before spending an encode.
    throw new Error(
      `a ${opts.sizeCapBytes} byte cap needs ~${plan.fittedKbps} kbps for ` +
        `${Math.round(masterProbe.duration)}s of video — under the ` +
        `${DELIVERY_MIN_VIDEO_BITRATE_KBPS} kbps quality floor; the video is too long for this platform's size cap`,
    );
  }
  const deliveryPath = join(workdir, plan.fileName);
  if (existsSync(deliveryPath)) {
    const deliveryStat = await stat(deliveryPath);
    if (deliveryStat.mtimeMs >= masterStat.mtimeMs) {
      return { path: deliveryPath, encoded: false, probe: masterProbe };
    }
  }
  opts.onStart?.(plan.fileName);
  await encodeDelivery(
    tools,
    { path: masterPath, width: masterProbe.width, height: masterProbe.height },
    deliveryPath,
    plan,
    { onProgress: opts.onProgress },
  );
  return { path: deliveryPath, encoded: true, probe: masterProbe };
}
