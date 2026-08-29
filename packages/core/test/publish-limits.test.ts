import { describe, expect, it } from "vitest";
import { PLATFORM_DURATION_CAPS_SEC, checkDurationCaps } from "../src/publish/limits";
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
