import { describe, expect, it } from "vitest";
import { ensureParentDir, expandHome, moveFile, type MoveDeps } from "../src/paths";

/**
 * 2026-08-16 field incident (paths.ts has the full story): a wizard-typed
 * `~/Downloads/out.mp4` resolved against cwd — no shell expands a wizard
 * text input — and the end-of-run rename ENOENT'd after a 50-minute render.
 * These pin the two defenses: tilde expansion and the out-path move seam.
 */
describe("expandHome", () => {
  const home = "/Users/test";

  it("expands a bare ~ to the home directory", () => {
    expect(expandHome("~", home)).toBe("/Users/test");
  });

  it("expands a leading ~/ against home", () => {
    expect(expandHome("~/Downloads/out.mp4", home)).toBe("/Users/test/Downloads/out.mp4");
  });

  it("leaves ~user forms untouched — not supported, never guessed", () => {
    expect(expandHome("~alice/x.mp4", home)).toBe("~alice/x.mp4");
  });

  it("leaves absolute paths untouched", () => {
    expect(expandHome("/var/tmp/x.mp4", home)).toBe("/var/tmp/x.mp4");
  });

  it("leaves relative paths untouched, including a mid-path tilde", () => {
    expect(expandHome("./raw/take1.mp4", home)).toBe("./raw/take1.mp4");
    expect(expandHome("clips/~backup/x.mp4", home)).toBe("clips/~backup/x.mp4");
  });

  it("defaults home to os.homedir() when not injected", () => {
    // Not asserting the literal homedir value — only that the tilde is gone
    // and the rest of the path survived.
    const expanded = expandHome("~/x.mp4");
    expect(expanded.startsWith("~")).toBe(false);
    expect(expanded.endsWith("/x.mp4")).toBe(true);
  });
});

describe("ensureParentDir", () => {
  it("mkdirs the parent of the out file, not the file itself", () => {
    const made: string[] = [];
    ensureParentDir("/Users/test/Downloads/out.mp4", (dir) => made.push(dir));
    expect(made).toEqual(["/Users/test/Downloads"]);
  });
});

describe("moveFile", () => {
  const exdev = () => Object.assign(new Error("cross-device link"), { code: "EXDEV" });

  it("renames in place when the volumes match", async () => {
    const calls: string[] = [];
    const deps: MoveDeps = {
      rename: async () => void calls.push("rename"),
      copyFile: async () => void calls.push("copy"),
      unlink: async () => void calls.push("unlink"),
    };
    await moveFile("/w/norm.mp4", "/out/final.mp4", deps);
    expect(calls).toEqual(["rename"]);
  });

  it("falls back to copy+unlink on EXDEV (out on another volume)", async () => {
    const calls: Array<[string, string, string?]> = [];
    const deps: MoveDeps = {
      rename: async () => {
        throw exdev();
      },
      copyFile: async (from, to) => void calls.push(["copy", from, to]),
      unlink: async (p) => void calls.push(["unlink", p]),
    };
    await moveFile("/w/norm.mp4", "/Volumes/ext/final.mp4", deps);
    expect(calls).toEqual([
      ["copy", "/w/norm.mp4", "/Volumes/ext/final.mp4"],
      ["unlink", "/w/norm.mp4"],
    ]);
  });

  it("rethrows every other rename failure unchanged", async () => {
    const deps: MoveDeps = {
      rename: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
      copyFile: async () => {
        throw new Error("copy must not run on a non-EXDEV failure");
      },
      unlink: async () => {
        throw new Error("unlink must not run on a non-EXDEV failure");
      },
    };
    await expect(moveFile("/w/norm.mp4", "/root/final.mp4", deps)).rejects.toThrow(
      "permission denied",
    );
  });
});
