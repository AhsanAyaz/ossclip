import { describe, expect, it } from "vitest";
import { groupByNetwork, networkOf } from "../src/publishGroups";

/**
 * The publish panel groups channels by NETWORK, not by provider id
 * (2026-08-29). Postiz reports a LinkedIn profile as `linkedin` and a company
 * page as `linkedin-page`, but they are one network with one idiom and one
 * limit — and nobody writes four different posts for four LinkedIn channels.
 * One caption per network is what the user actually does; per-channel
 * overrides stay possible, they are just not the default.
 */
describe("networkOf", () => {
  it("folds a LinkedIn page into LinkedIn", () => {
    expect(networkOf("linkedin-page")).toBe("linkedin");
    expect(networkOf("linkedin")).toBe("linkedin");
  });

  it("leaves every other provider as its own network", () => {
    for (const p of ["facebook", "instagram", "threads", "youtube", "tiktok", "x"]) {
      expect(networkOf(p)).toBe(p);
    }
  });

  it("an unknown provider is its own network rather than a crash or a bucket", () => {
    // A provider ossclip has never seen must still appear in the panel: the
    // publish path resolves providers dynamically from the instance.
    expect(networkOf("mastodon")).toBe("mastodon");
  });
});

describe("groupByNetwork", () => {
  const ch = (id: string, provider: string, name: string) => ({ id, provider, name, caption: "" });

  it("puts every LinkedIn channel in one group, in listed order", () => {
    const groups = groupByNetwork([
      ch("a", "linkedin-page", "Code with Ahsan"),
      ch("b", "instagram", "Ahsan"),
      ch("c", "linkedin", "Muhammad Ahsan Ayaz"),
      ch("d", "linkedin-page", "IOMechs"),
    ]);
    expect(groups.map((g) => g.network)).toEqual(["linkedin", "instagram"]);
    expect(groups[0]!.channels.map((c) => c.id)).toEqual(["a", "c", "d"]);
    expect(groups[1]!.channels.map((c) => c.id)).toEqual(["b"]);
  });

  it("seeds the group caption from the channels' own, and flags when they differ", () => {
    // The pack authors per-PLATFORM captions, so a group's channels normally
    // agree. When they do not (a hand-edited doc, or linkedin vs
    // linkedin-page resolving differently), the panel must not silently pick
    // one and overwrite the other on the first keystroke.
    const same = groupByNetwork([
      { ...ch("a", "linkedin", "A"), caption: "one" },
      { ...ch("b", "linkedin-page", "B"), caption: "one" },
    ]);
    expect(same[0]!.caption).toBe("one");
    expect(same[0]!.mixed).toBe(false);

    const differ = groupByNetwork([
      { ...ch("a", "linkedin", "A"), caption: "one" },
      { ...ch("b", "linkedin-page", "B"), caption: "two" },
    ]);
    expect(differ[0]!.mixed).toBe(true);
    // The FIRST channel's caption seeds the box — an arbitrary pick would be
    // fine, but a stable one keeps the panel from reordering under the user.
    expect(differ[0]!.caption).toBe("one");
  });

  it("an empty channel list is an empty group list, never a phantom group", () => {
    expect(groupByNetwork([])).toEqual([]);
  });
});
