import { describe, expect, it } from "vitest";
import {
  DELIVERY_MAX_BITRATE_KBPS,
  DELIVERY_VIDEO_BITRATE_KBPS,
  deliveryEncodePlan,
  deliveryFileName,
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

describe("deliveryFileName", () => {
  it("embeds every encode parameter — the name IS the cache key, so a rule change misses the old cache", () => {
    expect(deliveryFileName(1920, 1080, 10000)).toBe("delivery-1920x1080@10000k.mp4");
    expect(deliveryFileName(1080, 1920, 8000)).toBe("delivery-1080x1920@8000k.mp4");
  });
});
