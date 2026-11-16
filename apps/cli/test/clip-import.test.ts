import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  ClipImportError,
  MAX_CLIP_BYTES,
  canCopyClip,
  clipImportLine,
  clipOutputName,
  clipSourceProbeArgs,
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

  it("encodes at the faster good-deadline speed (24 clips pay this 24 times)", () => {
    expect(args[args.indexOf("-deadline") + 1]).toBe("good");
    expect(args[args.indexOf("-cpu-used") + 1]).toBe("4");
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

describe("canCopyClip", () => {
  const probe = (format_name: string, video: string, audio?: string) =>
    JSON.stringify({
      streams: [
        { codec_type: "video", codec_name: video },
        ...(audio ? [{ codec_type: "audio", codec_name: audio }] : []),
      ],
      format: { format_name },
    });

  it("copies VP9 or VP8 in WebM: re-encoding one through ffmpeg's VP9 decoder drops its alpha", () => {
    expect(canCopyClip(probe("matroska,webm", "vp9", "opus"))).toBe(true);
    expect(canCopyClip(probe("matroska,webm", "vp8"))).toBe(true);
  });

  it("transcodes everything else", () => {
    // ProRes 4444 in QuickTime: the EGM clips.
    expect(canCopyClip(probe("mov,mp4,m4a,3gp,3g2,mj2", "prores", "pcm_s16le"))).toBe(false);
    // A WebM container is not enough; the codec has to be one the copy keeps.
    expect(canCopyClip(probe("matroska,webm", "h264"))).toBe(false);
    // VP9 outside WebM (an MP4) is transcoded too.
    expect(canCopyClip(probe("mov,mp4,m4a,3gp,3g2,mj2", "vp9"))).toBe(false);
  });

  it("an unreadable probe is not copyable, so the transcode reports the file", () => {
    expect(canCopyClip("")).toBe(false);
    expect(canCopyClip("not json")).toBe(false);
    expect(canCopyClip(JSON.stringify({ streams: "x" }))).toBe(false);
  });

  it("the probe asks for the container and the stream codecs", () => {
    const a = clipSourceProbeArgs("/s/a.webm");
    expect(a[a.indexOf("-show_entries") + 1]).toBe("format=format_name:stream=codec_type,codec_name");
    expect(a[a.length - 1]).toBe("/s/a.webm");
  });
});

describe("clipImportLine", () => {
  it("one line per clip, counted from 1", () => {
    expect(clipImportLine(2, 24, "clips/steps.mov", "transcode")).toBe(
      "▸ importing clip 3 of 24: clips/steps.mov",
    );
    expect(clipImportLine(0, 1, "a.webm", "copy")).toBe("▸ importing clip 1 of 1: a.webm");
  });

  it("says reusing when the WebM already exists", () => {
    expect(clipImportLine(0, 2, "a.mov", "reuse")).toBe("▸ reusing clip 1 of 2: a.mov");
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

  const PRORES = JSON.stringify({
    streams: [{ codec_type: "video", codec_name: "prores" }],
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
  });
  const VP9_WEBM = JSON.stringify({
    streams: [{ codec_type: "video", codec_name: "vp9" }, { codec_type: "audio", codec_name: "opus" }],
    format: { format_name: "matroska,webm" },
  });

  /** Fake seams: a filesystem of the given paths, and a run log. */
  const fakes = (opts: { present: string[]; size?: number; source?: string }) => {
    const present = new Set(opts.present);
    const calls: Array<{ bin: string; args: string[] }> = [];
    const renames: Array<[string, string]> = [];
    const copies: Array<[string, string]> = [];
    const steps: string[] = [];
    const deps: ImportClipDeps = {
      run: (async (bin: string, args: string[]) => {
        calls.push({ bin, args });
        if (bin === "ffmpeg") present.add(args[args.length - 1]!);
        // The source probe asks for format_name; the output probe for duration.
        const isSourceProbe = args.some((a) => a.includes("format_name"));
        const stdout = bin !== "ffprobe" ? "" : isSourceProbe ? (opts.source ?? PRORES) : PROBE;
        return { stdout, stderr: "" };
      }) as ImportClipDeps["run"],
      stat: async () => ({ size: opts.size ?? 1000, mtimeMs: 5 }),
      exists: (p) => present.has(p),
      mkdir: async () => {},
      rename: async (from, to) => {
        renames.push([from, to]);
        present.delete(from);
        present.add(to);
      },
      copyFile: async (from, to) => {
        copies.push([from, to]);
        present.add(to);
      },
      onStep: (step) => steps.push(step),
    };
    return { deps, calls, renames, copies, steps, present };
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
    const probe = f.calls.filter((c) => c.bin === "ffprobe").at(-1)!;
    expect(probe.args[probe.args.length - 1]).toBe(join("/p", name));
    expect(f.copies).toEqual([]);
    expect(f.steps).toEqual(["transcode"]);
  });

  it("copies a VP9 WebM source unchanged instead of re-encoding away its alpha", async () => {
    const f = fakes({ present: ["/s/clips/a.webm"], source: VP9_WEBM });
    const out = await importClip("/s/clips/a.webm", "/p", f.deps);
    const name = clipOutputName("/s/clips/a.webm", 1000, 5);
    expect(out).toEqual({ src: name, durationSec: 4.6 });
    expect(f.calls.filter((c) => c.bin === "ffmpeg")).toEqual([]);
    // Same partial-then-rename as the encode, so an interrupted copy is never reused.
    expect(f.copies).toEqual([["/s/clips/a.webm", join("/p", name).replace(/\.webm$/, ".partial.webm")]]);
    expect(f.renames[0]![1]).toBe(join("/p", name));
    expect(f.steps).toEqual(["copy"]);
  });

  it("reuses an output that already exists and skips ffmpeg", async () => {
    const name = clipOutputName("/s/clips/a.mov", 1000, 5);
    const f = fakes({ present: ["/s/clips/a.mov", join("/p", name)] });
    const out = await importClip("/s/clips/a.mov", "/p", f.deps);
    expect(out).toEqual({ src: name, durationSec: 4.6 });
    // Only the output's duration probe: the source is not even probed.
    expect(f.calls.map((c) => c.bin)).toEqual(["ffprobe"]);
    expect(f.steps).toEqual(["reuse"]);
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
    expect(bins).toEqual(["/opt/ff/ffprobe", "/opt/ff/ffmpeg", "/opt/ff/ffprobe"]);
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
