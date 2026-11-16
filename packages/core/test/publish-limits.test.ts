import { describe, expect, it } from "vitest";
import {
  PLATFORM_DURATION_CAPS_SEC,
  PLATFORM_SIZE_CAP_BYTES,
  checkDurationCaps,
  sizeCapBytesFor,
} from "../src/publish/limits";
import type { PublishTarget } from "../src/publish/provider";

/**
 * 2026-08-29 publish handoff: the 5:20 take was doomed on Threads (5:00 cap)
 * before a single byte uploaded. The caps refuse those channels up front;
 * everything else proceeds.
 */

function target(provider: string): PublishTarget {
  return { id: `${provider}-1`, provider, name: `${provider} account` };
}

describe("checkDurationCaps", () => {
  it("the field case: a 5:20 video violates threads' 5:00 cap and nothing else", () => {
    const targets = [target("threads"), target("youtube"), target("instagram")];
    expect(checkDurationCaps(targets, 320)).toEqual([{ target: targets[0], capSec: 300 }]);
  });

  it("flags every capped platform the duration exceeds", () => {
    const targets = [target("threads"), target("tiktok"), target("instagram")];
    const violations = checkDurationCaps(targets, 901);
    expect(violations.map((v) => v.target.provider)).toEqual(["threads", "tiktok", "instagram"]);
    expect(violations.map((v) => v.capSec)).toEqual([300, 600, 900]);
  });

  it("an unknown provider has no cap — absence means unlimited, a wrong refusal is worse than a platform error", () => {
    expect(checkDurationCaps([target("youtube"), target("mastodon")], 7200)).toEqual([]);
  });

  it("a video exactly at the cap passes — strictly over is the violation", () => {
    expect(checkDurationCaps([target("threads")], PLATFORM_DURATION_CAPS_SEC.threads!)).toEqual([]);
    expect(checkDurationCaps([target("threads")], PLATFORM_DURATION_CAPS_SEC.threads! + 0.1)).toHaveLength(1);
  });

  it("no targets, no violations", () => {
    expect(checkDurationCaps([], 10000)).toEqual([]);
  });
});

describe("PLATFORM_SIZE_CAP_BYTES", () => {
  it("instagram sits with margin under the observed ~100MB URL-fetch ceiling; absence means uncapped", () => {
    // 2026-08-29, live: 409MB → error 2207077 twice, the same take at 88MB →
    // published. LinkedIn took the 409MB file fine, so it (and every other
    // platform) must NOT appear here — a wrong refusal is worse than a
    // platform error.
    expect(PLATFORM_SIZE_CAP_BYTES.instagram).toBe(95_000_000);
    expect(PLATFORM_SIZE_CAP_BYTES.linkedin).toBeUndefined();
    expect(PLATFORM_SIZE_CAP_BYTES.youtube).toBeUndefined();
  });
});

// 2026-11-13: a 174MB render bounced off the Cloudflare proxy in front of the
// author's Postiz (100MB on the free plan) for EVERY channel — the ceiling is
// on the upload path, not the platform, so it applies to all of them.
describe("sizeCapBytesFor", () => {
  it("is the platform cap alone when no upload cap is configured", () => {
    expect(sizeCapBytesFor("instagram")).toBe(95_000_000);
    expect(sizeCapBytesFor("linkedin")).toBeUndefined();
    expect(sizeCapBytesFor("linkedin", null)).toBeUndefined();
  });

  it("caps an otherwise uncapped platform at the upload ceiling", () => {
    expect(sizeCapBytesFor("youtube", 90_000_000)).toBe(90_000_000);
  });

  it("takes the smaller of the two when both exist", () => {
    expect(sizeCapBytesFor("instagram", 200_000_000)).toBe(95_000_000);
    expect(sizeCapBytesFor("instagram", 50_000_000)).toBe(50_000_000);
  });
});
