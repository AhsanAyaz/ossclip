import type { PublishTarget } from "./provider";

/**
 * Per-platform video duration caps, by the provider identifier the backend
 * reports (the `CAPTION_CAPS` shape, applied to duration). Only platforms
 * with a cap under long-form appear; absence means unlimited — a wrong
 * refusal is worse than a platform error, so an unknown provider is never
 * capped (2026-08-29 handoff: the 5:20 take was doomed on Threads' 5:00 cap
 * before a single byte uploaded).
 */
export const PLATFORM_DURATION_CAPS_SEC: Record<string, number> = {
  threads: 300,
  tiktok: 600,
  instagram: 900,
};

/**
 * Per-platform upload size caps, in bytes, same shape and posture as the
 * duration caps: absence means uncapped, because a wrong refusal is worse
 * than a platform error. The Instagram number is empirical (2026-08-29,
 * live): its URL-fetch ingest rejected the 409MB 10 Mbps delivery file with
 * error 2207077 TWICE, then published the very same 1080p landscape take at
 * 88MB (2 Mbps, same 192k audio) — the ceiling sits around 100MB, and 95MB
 * leaves margin under it. LinkedIn took the 409MB file fine the same day, so
 * capped platforms get their own smaller encode and everyone else keeps the
 * 10 Mbps file.
 */
export const PLATFORM_SIZE_CAP_BYTES: Record<string, number> = {
  instagram: 95_000_000,
};

export interface DurationViolation {
  target: PublishTarget;
  capSec: number;
}

/**
 * The targets this video is too long for. Semantics downstream: refuse the
 * violating channels, publish the rest — the platform hard-fails an over-cap
 * upload anyway, so there is no `--force` for duration.
 */
export function checkDurationCaps(targets: PublishTarget[], durationSec: number): DurationViolation[] {
  const violations: DurationViolation[] = [];
  for (const target of targets) {
    const capSec = PLATFORM_DURATION_CAPS_SEC[target.provider];
    // Strictly over: a video exactly at the cap is what the cap permits.
    if (capSec !== undefined && durationSec > capSec) {
      violations.push({ target, capSec });
    }
  }
  return violations;
}
