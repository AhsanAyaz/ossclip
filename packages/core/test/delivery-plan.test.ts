import { describe, expect, it } from "vitest";
import {
  DELIVERY_MAX_BITRATE_KBPS,
  DELIVERY_MIN_VIDEO_BITRATE_KBPS,
  DELIVERY_VIDEO_BITRATE_KBPS,
  deliveryEncodePlan,
  deliveryFileName,
  fitBitrateKbps,
  type DeliverySource,
} from "../src/publish/delivery";

/**
 * 2026-08-29 publish handoff. The field case: `ossclip publish` uploaded the
 * 589MB ~56 Mbps master and failed 5/6 channels — platforms re-encode to
 * 6–12 Mbps on ingest, so master quality bought only upload failures. The
 * plan decides what (if anything) to transcode before upload.
 */

/** A source at a given measured bitrate — the plan reads size/duration, not a probe field. */
function src(width: number, height: number, kbps: number, duration = 320): DeliverySource {
  return { width, height, fps: 30, duration, sizeBytes: (kbps * 1000 * duration) / 8 };
}

describe("deliveryEncodePlan", () => {
  it("the field case: 4K landscape lands on exactly 1920x1080", () => {
    // k = min(1, 1080/2160, 1920/3840) = 0.5 on both axes.
    const plan = deliveryEncodePlan(src(3840, 2160, 56000));
    expect(plan).toEqual({
      width: 1920,
      height: 1080,
      videoBitrateKbps: DELIVERY_VIDEO_BITRATE_KBPS,
      fileName: "delivery-1920x1080@10000k.mp4",
    });
  });

  it("4K portrait lands on 1080x1920 — the same rule, no orientation branch", () => {
    const plan = deliveryEncodePlan(src(2160, 3840, 56000));
    expect(plan).toMatchObject({ width: 1080, height: 1920 });
  });

  it("re-encodes a 1080p master when its bitrate alone trips the ceiling", () => {
    // Dims are already within caps, so this is the bitrate arm on its own —
    // and the plan keeps the exact source dims (no manufactured rescale).
    const plan = deliveryEncodePlan(src(1920, 1080, 56000));
    expect(plan).toMatchObject({ width: 1920, height: 1080 });
  });

  it("skips a 1080p master already at platform bitrate — upload it as-is", () => {
    expect(deliveryEncodePlan(src(1920, 1080, 8000))).toBeNull();
  });

  it("skips at the exact bitrate ceiling — at the cap is what the cap permits", () => {
    expect(deliveryEncodePlan(src(1920, 1080, DELIVERY_MAX_BITRATE_KBPS))).toBeNull();
  });

  it("skips a small low-rate source entirely", () => {
    expect(deliveryEncodePlan(src(1280, 720, 5000))).toBeNull();
  });

  it("never upscales: a small source over the bitrate ceiling keeps its native size", () => {
    // Bitrate forces a re-encode, but k is capped at 1 — encoding 720p up to
    // 1080p would soften every frame for zero bytes saved.
    const plan = deliveryEncodePlan(src(1280, 720, 56000));
    expect(plan).toMatchObject({ width: 1280, height: 720 });
  });

  it("rounds scaled dimensions EVEN for yuv420, not merely to the nearest integer", () => {
    // 3840x2074: k = 1920/3840 = 0.5, so height 2074 × 0.5 = 1037 — odd,
    // which x264 rejects for yuv420; nearest even is 1038.
    const plan = deliveryEncodePlan(src(3840, 2074, 56000));
    expect(plan!.width % 2).toBe(0);
    expect(plan!.height).toBe(1038);
  });

  it("refuses degenerate sources", () => {
    expect(deliveryEncodePlan(src(0, 1080, 56000))).toBeNull();
    expect(deliveryEncodePlan({ width: 1920, height: 1080, fps: 30, duration: 0, sizeBytes: 0 })).toBeNull();
  });
});

describe("fitBitrateKbps", () => {
  it("the field case: 95MB over 321s fits ~2.1 Mbps of video", () => {
    // 95MB → 760 Mbit; /1.03 mux overhead /321s ≈ 2299 kbps total, minus the
    // 192k audio → 2106. The real 2 Mbps encode of this take landed at 88MB
    // and Instagram published it (2026-08-29) — this pins that shape.
    expect(fitBitrateKbps(95_000_000, 321)).toBe(2106);
  });

  it("budgets for the caller's audio rate — silence buys the video its kbps back", () => {
    expect(fitBitrateKbps(95_000_000, 321, 0)).toBe(2298);
  });

  it("goes under the quality floor (even negative) for long videos — the plan turns that into a verdict, not a clamp", () => {
    expect(fitBitrateKbps(95_000_000, 3600)).toBeLessThan(DELIVERY_MIN_VIDEO_BITRATE_KBPS);
    expect(fitBitrateKbps(95_000_000, 36000)).toBeLessThan(0);
  });
});

describe("deliveryEncodePlan with a size cap", () => {
  // Instagram's cap (PLATFORM_SIZE_CAP_BYTES), inlined so this file stays a
  // pure-arithmetic test of the plan, not of the platform table.
  const CAP = 95_000_000;
  /** The 2026-08-29 field master: 1080p ~10.2 Mbps, 409MB over 321s. */
  const master: DeliverySource = { width: 1920, height: 1080, fps: 30, duration: 321, sizeBytes: 409_000_000 };

  it("the field case: the 409MB 10 Mbps file is a null-skip WITHOUT the cap, and re-plans fitted under it", () => {
    // Measured ~10.2 Mbps is inside the 12k ceiling and dims are in caps, so
    // only the byte ceiling forces this encode — exactly Instagram's 2207077
    // at 409MB vs. published at 88MB.
    expect(deliveryEncodePlan(master)).toBeNull();
    expect(deliveryEncodePlan(master, { sizeCapBytes: CAP })).toEqual({
      width: 1920,
      height: 1080,
      videoBitrateKbps: 2106,
      // Distinct filename — the capped variant caches BESIDE the 10000k one.
      fileName: "delivery-1920x1080@2106k.mp4",
    });
  });

  it("a master already under the cap (and otherwise in spec) stays a null-skip", () => {
    // 8 Mbps × 60s = 60MB ≤ 95MB: nothing about this file needs an encode.
    expect(deliveryEncodePlan(src(1920, 1080, 8000, 60), { sizeCapBytes: CAP })).toBeNull();
  });

  it("a generous cap never RAISES the bitrate past the 10 Mbps default", () => {
    const plan = deliveryEncodePlan(src(3840, 2160, 56000), { sizeCapBytes: 10_000_000_000 });
    expect(plan).toMatchObject({ videoBitrateKbps: DELIVERY_VIDEO_BITRATE_KBPS });
  });

  it("a video too long to fit above the quality floor is UNATTAINABLE, not encoded as mush", () => {
    // 3600s under 95MB fits only ~13 kbps of video — refusing the channel
    // beats publishing it.
    const long: DeliverySource = { width: 1920, height: 1080, fps: 30, duration: 3600, sizeBytes: 4_500_000_000 };
    expect(deliveryEncodePlan(long, { sizeCapBytes: CAP })).toEqual({ unattainable: true, fittedKbps: 12 });
  });

  it("an undefined cap is the uncapped path — same behavior as no opts at all", () => {
    expect(deliveryEncodePlan(master, { sizeCapBytes: undefined })).toBeNull();
  });
});

describe("deliveryFileName", () => {
  it("embeds every encode parameter — the name IS the cache key, so a rule change misses the old cache", () => {
    expect(deliveryFileName(1920, 1080, 10000)).toBe("delivery-1920x1080@10000k.mp4");
    expect(deliveryFileName(1080, 1920, 8000)).toBe("delivery-1080x1920@8000k.mp4");
  });
});
