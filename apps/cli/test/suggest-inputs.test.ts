import { describe, expect, it } from "vitest";
import {
  humanSize,
  likelyDirs,
  rankSuggestions,
  relativeAge,
  tildeify,
  type CandidateFile,
} from "../src/interactive/suggest-inputs";

/**
 * "The video I just recorded" is nearly always the newest video file in the
 * working directory, Downloads, or Movies — so the wizard offers those three
 * before it offers a file picker (§136). Ranking is pure over an injected
 * listing, so none of these rules needs a real home directory.
 */
const NOW = 1_760_000_000_000;
const HOME = "/Users/a";
const f = (path: string, ageMs: number, size = 1_000_000): CandidateFile => ({
  path,
  mtimeMs: NOW - ageMs,
  size,
});

describe("rankSuggestions", () => {
  it("newest first", () => {
    const out = rankSuggestions(
      [f("/Users/a/Downloads/old.mp4", 86_400_000), f("/Users/a/Downloads/new.mp4", 60_000)],
      NOW,
      HOME,
    );
    expect(out.map((s) => s.path)).toEqual([
      "/Users/a/Downloads/new.mp4",
      "/Users/a/Downloads/old.mp4",
    ]);
  });

  it("keeps only video extensions, case-insensitively", () => {
    const out = rankSuggestions(
      [f("/x/a.MP4", 1), f("/x/b.txt", 2), f("/x/c.pdf", 3), f("/x/d.MKV", 4)],
      NOW,
      HOME,
    );
    expect(out.map((s) => s.path)).toEqual(["/x/a.MP4", "/x/d.MKV"]);
  });

  it("drops ossclip's own output — re-cutting a finished cut is never the intent", () => {
    const out = rankSuggestions([f("/x/take.ossclip.mp4", 1), f("/x/take.mp4", 2)], NOW, HOME);
    expect(out.map((s) => s.path)).toEqual(["/x/take.mp4"]);
  });

  it("drops dotfiles", () => {
    const out = rankSuggestions([f("/x/.hidden.mp4", 1), f("/x/take.mp4", 2)], NOW, HOME);
    expect(out.map((s) => s.path)).toEqual(["/x/take.mp4"]);
  });

  it("caps at three — the menu is a shortcut, not a file manager", () => {
    const many = Array.from({ length: 9 }, (_, i) => f(`/x/take${i}.mp4`, i + 1));
    expect(rankSuggestions(many, NOW, HOME)).toHaveLength(3);
  });

  it("labels are home-relative and hints carry size and age", () => {
    const [only] = rankSuggestions(
      [f("/Users/a/Downloads/take.mp4", 720_000, 142_000_000)],
      NOW,
      HOME,
    );
    expect(only.label).toBe("~/Downloads/take.mp4");
    expect(only.hint).toBe("142 MB · 12m ago");
  });

  it("an empty listing is an empty menu, not an error", () => {
    expect(rankSuggestions([], NOW, HOME)).toEqual([]);
  });
});

describe("humanSize", () => {
  it("uses Finder-style base-1000 units", () => {
    expect(humanSize(512)).toBe("512 B");
    expect(humanSize(142_000_000)).toBe("142 MB");
    expect(humanSize(2_400_000_000)).toBe("2.4 GB");
    expect(humanSize(45_000)).toBe("45 kB");
  });
});

describe("relativeAge", () => {
  it("degrades from seconds to days", () => {
    expect(relativeAge(30_000)).toBe("just now");
    expect(relativeAge(720_000)).toBe("12m ago");
    expect(relativeAge(10_800_000)).toBe("3h ago");
    expect(relativeAge(172_800_000)).toBe("2d ago");
  });
});

describe("tildeify", () => {
  it("shortens a home path and leaves everything else alone", () => {
    expect(tildeify("/Users/a/Downloads/x.mp4", "/Users/a")).toBe("~/Downloads/x.mp4");
    expect(tildeify("/opt/raw/x.mp4", "/Users/a")).toBe("/opt/raw/x.mp4");
  });
});

describe("likelyDirs", () => {
  it("darwin looks in Movies", () => {
    expect(likelyDirs({ platform: "darwin", cwd: "/w", home: "/Users/a" })).toEqual([
      "/w",
      "/Users/a/Downloads",
      "/Users/a/Movies",
    ]);
  });

  it("linux and win32 look in Videos", () => {
    expect(likelyDirs({ platform: "linux", cwd: "/w", home: "/home/a" })).toContain(
      "/home/a/Videos",
    );
    expect(likelyDirs({ platform: "win32", cwd: "/w", home: "/home/a" })).toContain(
      "/home/a/Videos",
    );
  });

  it("deduplicates when cwd IS one of the folders", () => {
    const out = likelyDirs({ platform: "darwin", cwd: "/Users/a/Downloads", home: "/Users/a" });
    expect(out.filter((d) => d === "/Users/a/Downloads")).toHaveLength(1);
  });
});
