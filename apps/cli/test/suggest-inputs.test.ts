import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  humanSize,
  likelyDirs,
  rankSuggestions,
  relativeAge,
  scanLikelyDirs,
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
    // Asserting WHICH three, not just how many: a cap over a broken sort
    // still returns three rows, and they would be the wrong three.
    const many = Array.from({ length: 9 }, (_, i) => f(`/x/take${i}.mp4`, i + 1));
    expect(rankSuggestions(many, NOW, HOME).map((s) => s.path)).toEqual([
      "/x/take0.mp4",
      "/x/take1.mp4",
      "/x/take2.mp4",
    ]);
  });

  it("ranks a future mtime highest but labels it 'just now', never a negative age", () => {
    const out = rankSuggestions(
      [f("/x/camera.mp4", -604_800_000), f("/x/take.mp4", 60_000)],
      NOW,
      HOME,
    );
    expect(out.map((s) => s.path)).toEqual(["/x/camera.mp4", "/x/take.mp4"]);
    expect(out[0].hint).toBe("1 MB · just now");
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

  it("promotes at the rounding boundary — never prints 1000 of a unit", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(999)).toBe("999 B");
    expect(humanSize(1_000)).toBe("1 kB");
    expect(humanSize(999_999)).toBe("1 MB");
    expect(humanSize(1_000_000)).toBe("1 MB");
    expect(humanSize(999_700_000)).toBe("1.0 GB");
    expect(humanSize(1_000_000_000)).toBe("1.0 GB");
  });
});

describe("relativeAge", () => {
  it("degrades from seconds to days", () => {
    expect(relativeAge(30_000)).toBe("just now");
    expect(relativeAge(720_000)).toBe("12m ago");
    expect(relativeAge(10_800_000)).toBe("3h ago");
    expect(relativeAge(172_800_000)).toBe("2d ago");
  });

  it("clamps a negative age — a camera with an unset clock is not 'in -7d'", () => {
    expect(relativeAge(-604_800_000)).toBe("just now");
    expect(relativeAge(59_999)).toBe("just now");
    expect(relativeAge(60_000)).toBe("1m ago");
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
    // Whole list, not a count of the duplicate: dropping the media directory
    // along with the duplicate would also pass a one-occurrence assertion.
    const out = likelyDirs({ platform: "darwin", cwd: "/Users/a/Downloads", home: "/Users/a" });
    expect(out).toEqual(["/Users/a/Downloads", "/Users/a/Movies"]);
  });
});

/**
 * The only I/O in the module, and the only place its load-bearing invariants
 * live: a missing or unreadable directory is skipped rather than thrown, a
 * file that vanishes between readdir and stat is skipped alone, `.MP4` is
 * matched on a real filename, and a symlinked take is followed the way
 * `listFolderVideos` follows one. A refactor that loses any of these reads as
 * "the wizard crashes on startup for anyone without ~/Movies".
 */
describe("scanLikelyDirs", () => {
  const scratch = (): string => mkdtempSync(join(tmpdir(), "ossclip-suggest-"));

  it("returns only the videos, tolerating a directory that is not there", async () => {
    const root = scratch();
    writeFileSync(join(root, "a.MP4"), "not really a video");
    writeFileSync(join(root, "notes.txt"), "notes");
    mkdirSync(join(root, "nested"));
    // Followed, per concat.ts's rationale — staging takes as symlinks into
    // another drive is normal.
    symlinkSync(join(root, "a.MP4"), join(root, "linked.mov"));
    // Stands in for the readdir/stat delete race: stat throws, one file only.
    symlinkSync(join(root, "gone.mp4"), join(root, "ghost.mp4"));

    const out = await scanLikelyDirs([join(root, "nope"), root]);
    expect(out.map((c) => c.path).sort()).toEqual([join(root, "a.MP4"), join(root, "linked.mov")]);
    expect(out[0].size).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "skips an unreadable directory instead of failing the wizard",
    async () => {
      const root = scratch();
      const closed = join(root, "closed");
      mkdirSync(closed);
      writeFileSync(join(closed, "take.mp4"), "not really a video");
      chmodSync(closed, 0o000);
      try {
        await expect(scanLikelyDirs([closed])).resolves.toEqual([]);
      } finally {
        // Leaving it at 000 makes the OS's tmp reaper unable to clean up.
        chmodSync(closed, 0o755);
      }
    },
  );
});
