import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  ClipImportError,
  MAX_CLIP_BYTES,
  clipOutputName,
  clipTranscodeArgs,
  importClip,
  parseClipProbe,
  resolveClipPath,
  type ImportClipDeps,
} from "../src/clip-import";

describe("resolveClipPath", () => {
  it("resolves against the script's folder", () => {
    expect(resolveClipPath("/s/script.md", "clips/a.mov")).toBe("/s/clips/a.mov");
  });

  it("refuses a path that climbs out of the folder, naming it", () => {
    expect(() => resolveClipPath("/s/script.md", "../x.mov")).toThrow(ClipImportError);
    expect(() => resolveClipPath("/s/script.md", "../x.mov")).toThrow(/\.\.\/x\.mov/);
    // Climbing out through a subfolder is the same escape.
    expect(() => resolveClipPath("/s/script.md", "clips/../../x.mov")).toThrow(/clips\/\.\.\/\.\.\/x\.mov/);
  });

  it("refuses an absolute path, naming it", () => {
    expect(() => resolveClipPath("/s/script.md", "/etc/x.mov")).toThrow(ClipImportError);
    expect(() => resolveClipPath("/s/script.md", "/etc/x.mov")).toThrow(/\/etc\/x\.mov/);
    // Absolute but inside the folder is refused too: the format says relative.
    expect(() => resolveClipPath("/s/script.md", "/s/clips/a.mov")).toThrow(ClipImportError);
  });

  it("refuses an empty path, which names the folder itself", () => {
    expect(() => resolveClipPath("/s/script.md", "")).toThrow(ClipImportError);
    expect(() => resolveClipPath("/s/script.md", ".")).toThrow(ClipImportError);
  });
});

describe("clipTranscodeArgs", () => {
  const args = clipTranscodeArgs("/s/clips/a.mov", "/p/clips/x.webm");

  it("encodes VP9 with an alpha plane and Opus audio", () => {
    expect(args).toContain("libvpx-vp9");
    expect(args).toContain("yuva420p");
    expect(args).toContain("libopus");
    // libvpx drops the alpha plane when alt-ref frames are on.
    const i = args.indexOf("-auto-alt-ref");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("0");
  });

  it("reads the source and ends with the output", () => {
    expect(args[args.indexOf("-i") + 1]).toBe("/s/clips/a.mov");
    expect(args[args.length - 1]).toBe("/p/clips/x.webm");
    expect(args[0]).toBe("-y");
  });
});

describe("clipOutputName", () => {
  it("is stable for equal inputs", () => {
    expect(clipOutputName("/s/a.mov", 10, 1000)).toBe(clipOutputName("/s/a.mov", 10, 1000));
    expect(clipOutputName("/s/a.mov", 10, 1000)).toMatch(/^clips\/[0-9a-f]{12}\.webm$/);
  });

  it("changes when the file changes", () => {
    const base = clipOutputName("/s/a.mov", 10, 1000);
    expect(clipOutputName("/s/a.mov", 10, 1001)).not.toBe(base);
    expect(clipOutputName("/s/a.mov", 11, 1000)).not.toBe(base);
    expect(clipOutputName("/s/b.mov", 10, 1000)).not.toBe(base);
  });
});

describe("parseClipProbe", () => {
  it("reads the duration and whether there is an audio stream", () => {
    const out = JSON.stringify({
      streams: [{ codec_type: "video" }, { codec_type: "audio" }],
      format: { duration: "4.600000" },
    });
    expect(parseClipProbe(out, "/p/x.webm")).toEqual({ durationSec: 4.6, hasAudio: true });
  });

  it("a clip with no audio stream says so", () => {
    const out = JSON.stringify({ streams: [{ codec_type: "video" }], format: { duration: "2" } });
    expect(parseClipProbe(out, "/p/x.webm")).toEqual({ durationSec: 2, hasAudio: false });
  });

  it("no usable duration is an error naming the file", () => {
    for (const out of [
      JSON.stringify({ streams: [], format: {} }),
      JSON.stringify({ streams: [], format: { duration: "N/A" } }),
      JSON.stringify({ streams: [], format: { duration: "0" } }),
      "not json",
    ]) {
      expect(() => parseClipProbe(out, "/p/x.webm")).toThrow(/\/p\/x\.webm/);
    }
  });
});

describe("importClip", () => {
  const PROBE = JSON.stringify({ streams: [{ codec_type: "video" }], format: { duration: "4.6" } });

  /** Fake seams: a filesystem of the given paths, and a run log. */
  const fakes = (opts: { present: string[]; size?: number }) => {
    const present = new Set(opts.present);
    const calls: Array<{ bin: string; args: string[] }> = [];
    const renames: Array<[string, string]> = [];
    const deps: ImportClipDeps = {
      run: (async (bin: string, args: string[]) => {
        calls.push({ bin, args });
        if (bin === "ffmpeg") present.add(args[args.length - 1]!);
        return { stdout: bin === "ffprobe" ? PROBE : "", stderr: "" };
      }) as ImportClipDeps["run"],
      stat: async () => ({ size: opts.size ?? 1000, mtimeMs: 5 }),
      exists: (p) => present.has(p),
      mkdir: async () => {},
      rename: async (from, to) => {
        renames.push([from, to]);
        present.delete(from);
        present.add(to);
      },
    };
    return { deps, calls, renames, present };
  };

  it("transcodes once into the public dir and returns the probed duration", async () => {
    const f = fakes({ present: ["/s/clips/a.mov"] });
    const out = await importClip("/s/clips/a.mov", "/p", f.deps);
    const name = clipOutputName("/s/clips/a.mov", 1000, 5);
    expect(out).toEqual({ src: name, durationSec: 4.6 });
    expect(f.calls.filter((c) => c.bin === "ffmpeg")).toHaveLength(1);
    // Written beside the final name and moved into place only when complete.
    expect(f.renames).toHaveLength(1);
    expect(f.renames[0]![1]).toBe(join("/p", name));
    expect(f.present.has(join("/p", name))).toBe(true);
    const probe = f.calls.find((c) => c.bin === "ffprobe")!;
    expect(probe.args[probe.args.length - 1]).toBe(join("/p", name));
  });

  it("reuses an output that already exists and skips ffmpeg", async () => {
    const name = clipOutputName("/s/clips/a.mov", 1000, 5);
    const f = fakes({ present: ["/s/clips/a.mov", join("/p", name)] });
    const out = await importClip("/s/clips/a.mov", "/p", f.deps);
    expect(out).toEqual({ src: name, durationSec: 4.6 });
    expect(f.calls.map((c) => c.bin)).toEqual(["ffprobe"]);
  });

  it("uses the configured ffmpeg and ffprobe", async () => {
    const f = fakes({ present: ["/s/clips/a.mov"] });
    const run = f.deps.run!;
    const bins: string[] = [];
    await importClip("/s/clips/a.mov", "/p", {
      ...f.deps,
      ffmpegPath: "/opt/ff/ffmpeg",
      ffprobePath: "/opt/ff/ffprobe",
      run: (async (bin: string, args: string[]) => {
        bins.push(bin);
        return run(bin === "/opt/ff/ffmpeg" ? "ffmpeg" : "ffprobe", args);
      }) as ImportClipDeps["run"],
    });
    expect(bins).toEqual(["/opt/ff/ffmpeg", "/opt/ff/ffprobe"]);
  });

  it("a source over 500 MB is refused, naming the path, before any encode", async () => {
    const f = fakes({ present: ["/s/clips/a.mov"], size: 600_000_000 });
    expect(600_000_000).toBeGreaterThan(MAX_CLIP_BYTES);
    await expect(importClip("/s/clips/a.mov", "/p", f.deps)).rejects.toThrow(ClipImportError);
    await expect(importClip("/s/clips/a.mov", "/p", f.deps)).rejects.toThrow(/\/s\/clips\/a\.mov/);
    expect(f.calls).toEqual([]);
  });

  it("a missing source is refused, naming the path", async () => {
    const f = fakes({ present: [] });
    await expect(importClip("/s/clips/a.mov", "/p", f.deps)).rejects.toThrow(ClipImportError);
    await expect(importClip("/s/clips/a.mov", "/p", f.deps)).rejects.toThrow(/\/s\/clips\/a\.mov/);
    expect(f.calls).toEqual([]);
  });
});
