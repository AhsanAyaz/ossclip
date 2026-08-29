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
