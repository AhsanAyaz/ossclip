import { describe, expect, it } from "vitest";
import { isSafeScreenshotSrc, planScreenshotSrcCopy } from "../src/produce";

/**
 * Final-review fix wave — Important finding on the second pass of Finding 3:
 * the accepted-image copy used to write straight to `join(publicDir, src)`
 * with an UNSANITIZED, LLM-authored `src`. Two verified failure classes:
 * (1) a `src` equal to a reserved pipeline filename (`mezzanine.mp4`,
 * `source-concat.mp4`) silently overwrote the real artifact BEFORE its own
 * `existsSync` guard ran; (2) a `src` containing `..` traversed outside the
 * workdir once `mkdirSync(recursive)` was added. `isSafeScreenshotSrc` closes
 * (2) by refusing anything but a bare filename BEFORE the lookup;
 * `planScreenshotSrcCopy` closes (1) by construction — every copy lands in a
 * fixed `side-images/` subfolder a reserved artifact never lives in, so the
 * only remaining question is whether the (collision-free) destination is
 * free, already holds the same bytes, or holds something else.
 */
describe("isSafeScreenshotSrc", () => {
  it("accepts a bare filename", () => {
    expect(isSafeScreenshotSrc("screenshot.png")).toBe(true);
    expect(isSafeScreenshotSrc("CLAUDE.md")).toBe(true);
    expect(isSafeScreenshotSrc("file.with.many.dots.jpg")).toBe(true);
  });

  it("refuses a forward-slash path (posix traversal or subfolder reference)", () => {
    expect(isSafeScreenshotSrc("../../etc/passwd")).toBe(false);
    expect(isSafeScreenshotSrc("images/photo.png")).toBe(false);
    expect(isSafeScreenshotSrc("/etc/passwd")).toBe(false);
  });

  it("refuses a backslash path (windows-style traversal)", () => {
    expect(isSafeScreenshotSrc("..\\..\\Windows\\win.ini")).toBe(false);
    expect(isSafeScreenshotSrc("images\\photo.png")).toBe(false);
  });

  it("refuses a bare `.` or `..` segment", () => {
    expect(isSafeScreenshotSrc(".")).toBe(false);
    expect(isSafeScreenshotSrc("..")).toBe(false);
  });

  it("does not false-positive on dots that aren't a `..` segment", () => {
    expect(isSafeScreenshotSrc("..png")).toBe(true);
    expect(isSafeScreenshotSrc("v1.2..3.png")).toBe(true);
  });
});

describe("planScreenshotSrcCopy", () => {
  it("copies when nothing exists at the destination yet", () => {
    expect(planScreenshotSrcCopy({ exists: false, identical: false })).toBe("copy");
  });

  it("skips the copy when the destination already holds identical bytes", () => {
    expect(planScreenshotSrcCopy({ exists: true, identical: true })).toBe("skip-identical");
  });

  it("refuses (conflict) when the destination holds different bytes under the same basename", () => {
    expect(planScreenshotSrcCopy({ exists: true, identical: false })).toBe("conflict");
  });
});
