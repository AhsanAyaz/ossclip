import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { warmFileCache, warmTargetFor } from "../src/warm-cache";

describe("warmFileCache", () => {
  it("reads the whole file and reports its size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warm-"));
    const file = join(dir, "mezzanine.mp4");
    await writeFile(file, Buffer.alloc(3 * 1024 * 1024 + 7, 1));
    await expect(warmFileCache(file)).resolves.toEqual({ bytes: 3 * 1024 * 1024 + 7, complete: true });
  });

  it("is best-effort: a missing file resolves instead of throwing", async () => {
    await expect(warmFileCache("/nonexistent/ossclip/mezzanine.mp4")).resolves.toEqual({
      bytes: 0,
      complete: false,
    });
  });

  it("stops when aborted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warm-"));
    const file = join(dir, "big.mp4");
    await writeFile(file, Buffer.alloc(32 * 1024 * 1024, 1));
    const ac = new AbortController();
    ac.abort();
    const r = await warmFileCache(file, ac.signal);
    expect(r.complete).toBe(false);
  });
});

describe("warmTargetFor", () => {
  it("names the video render-props plays, inside the workdir", () => {
    expect(warmTargetFor("/w", { videoFileName: "mezzanine.mp4" })).toBe(join("/w", "mezzanine.mp4"));
  });

  it("refuses a name that escapes the workdir", () => {
    expect(warmTargetFor("/w", { videoFileName: "../../etc/passwd" })).toBeNull();
  });

  it("is null for props without a usable video name", () => {
    expect(warmTargetFor("/w", {})).toBeNull();
    expect(warmTargetFor("/w", { videoFileName: "" })).toBeNull();
    expect(warmTargetFor("/w", null)).toBeNull();
  });
});
