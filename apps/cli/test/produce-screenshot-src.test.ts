import { describe, expect, it } from "vitest";
import {
  isRemoteScreenshotSrc,
  isSafeScreenshotSrc,
  planScreenshotSrcCopy,
  sideImageDestRel,
} from "../src/produce";

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

  it("refuses a forward-slash path (posix traversal or an arbitrary subfolder)", () => {
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

  /**
   * Re-review, Important 2: `--scenes <path>` re-ingests a PRIOR run's
   * scenes array (program.ts: "hand-authored scenes JSON — no LLM in the
   * loop"), which can legitimately already contain the self-namespaced
   * shape `produce()` itself writes post-copy (`sideImageDestRel`). Refusing
   * it here would drop the image to a placeholder on every `--scenes`
   * re-run of a previously-produced project. The exception is narrow: ONLY
   * `side-images/<bare-safe-name>` — one separator, first segment exactly
   * the fixed subfolder — qualifies. Nothing else does, including shapes
   * that merely start with the subfolder name.
   */
  it("accepts exactly the self-namespaced round-trip shape (side-images/<name>)", () => {
    expect(isSafeScreenshotSrc("side-images/foo.png")).toBe(true);
    expect(isSafeScreenshotSrc("side-images/CLAUDE.md")).toBe(true);
  });

  it("refuses traversal even when prefixed with the subfolder name", () => {
    expect(isSafeScreenshotSrc("side-images/../x")).toBe(false);
  });

  it("refuses a different subfolder", () => {
    expect(isSafeScreenshotSrc("other/foo.png")).toBe(false);
  });

  it("refuses a nested path even under the subfolder", () => {
    expect(isSafeScreenshotSrc("side-images/a/b.png")).toBe(false);
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

  /**
   * Round-trip shape (Important 2): a `--scenes` re-ingested src that is
   * ALREADY `side-images/<name>` is accepted by `isSafeScreenshotSrc` above,
   * and produce()'s own loop treats "found in the directory that's already
   * the render's public dir" as a `continue` before `planScreenshotSrcCopy`
   * is even consulted — so the plan function itself never needs to special-
   * case this shape. Documented here as the trace, not a new branch: this
   * describe block exists so a future reader can see the round-trip was
   * checked, not just asserted.
   */
  it("(trace) the already-in-place case never reaches this function — produce() continues before calling it", () => {
    // No assertion beyond the two functions above: `isSafeScreenshotSrc`
    // accepts the shape, and produce()'s `foundDir === renderPublicDirPath`
    // check (not exercised here — it's IO-backed) is what makes the
    // already-copied case a no-op rather than a re-copy.
    expect(isSafeScreenshotSrc("side-images/already-there.png")).toBe(true);
  });
});

/**
 * Audit fix: ScreenshotFrame resolves `/^https?:\/\//` srcs itself instead
 * of `staticFile()` (ScreenshotFrame.tsx), but produce()'s safe-src check
 * rejected a URL as "names a path, not a bare filename" — a misleading
 * message about a documented shape. A remote src is recognized FIRST and
 * passed through untouched: no lookup, no copy, no rewrite.
 */
describe("isRemoteScreenshotSrc", () => {
  it("recognizes http and https URLs", () => {
    expect(isRemoteScreenshotSrc("https://example.com/shot.png")).toBe(true);
    expect(isRemoteScreenshotSrc("http://example.com/shot.png")).toBe(true);
  });

  it("does not claim local shapes, other schemes, or a URL not at the start", () => {
    expect(isRemoteScreenshotSrc("screenshot.png")).toBe(false);
    expect(isRemoteScreenshotSrc("side-images/foo.png")).toBe(false);
    expect(isRemoteScreenshotSrc("file:///etc/passwd")).toBe(false);
    expect(isRemoteScreenshotSrc("ftp://example.com/x.png")).toBe(false);
    expect(isRemoteScreenshotSrc("x https://example.com")).toBe(false);
  });

  it("(trace) a URL would otherwise be rejected by the safe-src check — the misleading-message bug", () => {
    // The slash-containing URL fails isSafeScreenshotSrc, which is exactly
    // why the remote check must run BEFORE it in produce()'s loop.
    expect(isSafeScreenshotSrc("https://example.com/shot.png")).toBe(false);
  });
});

describe("sideImageDestRel", () => {
  /**
   * Important 1: this MUST be a forward-slash literal, not a `path.join()`
   * result — it's a served relative URL Remotion's `staticFile()` splits on
   * `/`, not a filesystem path. Asserted against the literal string so this
   * test fails the same way on every platform, including Windows (where
   * `path.join()` would have silently produced a backslash).
   */
  it("joins with a literal forward slash, independent of platform", () => {
    expect(sideImageDestRel("foo.png")).toBe("side-images/foo.png");
  });

  it("uses only the basename, even if given an already-safe self-namespaced src", () => {
    expect(sideImageDestRel("side-images/foo.png")).toBe("side-images/foo.png");
  });
});
