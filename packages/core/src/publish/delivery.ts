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
 * What the delivery encode should be, or null when the master is already
 * uploadable as-is (dims within caps AND measured bitrate ≤ the ceiling —
 * masters are always h264/aac out of Remotion, so codec never enters the
 * rule).
 *
 * Scale factor caps BOTH orientations without caring which one this is:
 * min(1, 1080/short-edge, 1920/long-edge) lands landscape on 1920×1080 and
 * portrait on 1080×1920, and never upscales — a small master re-encoded
 * larger would soften every frame for zero bytes saved.
 */
export function deliveryEncodePlan(src: DeliverySource): DeliveryPlan | null {
  if (src.width <= 0 || src.height <= 0 || src.duration <= 0) return null;
  const k = Math.min(
    1,
    DELIVERY_MAX_SHORT_EDGE / Math.min(src.width, src.height),
    DELIVERY_MAX_LONG_EDGE / Math.max(src.width, src.height),
  );
  const measuredKbps = (src.sizeBytes * 8) / src.duration / 1000;
  if (k === 1 && measuredKbps <= DELIVERY_MAX_BITRATE_KBPS) return null;
  // At k === 1 keep the exact source dims — even-rounding a size that is not
  // being rescaled would manufacture a 1px no-op rescale (mezzanineScale
  // learned the same lesson).
  const width = k < 1 ? evenDim(src.width * k) : src.width;
  const height = k < 1 ? evenDim(src.height * k) : src.height;
  return {
    width,
    height,
    videoBitrateKbps: DELIVERY_VIDEO_BITRATE_KBPS,
    fileName: deliveryFileName(width, height, DELIVERY_VIDEO_BITRATE_KBPS),
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
      "-c:a", "aac", "-b:a", "192k",
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
  } = {},
): Promise<DeliveryResult> {
  const [masterProbe, masterStat] = await Promise.all([probe(tools, masterPath), stat(masterPath)]);
  const plan = deliveryEncodePlan({
    width: masterProbe.width,
    height: masterProbe.height,
    fps: masterProbe.fps,
    duration: masterProbe.duration,
    sizeBytes: masterStat.size,
  });
  if (!plan) return { path: masterPath, encoded: false, probe: masterProbe };
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
