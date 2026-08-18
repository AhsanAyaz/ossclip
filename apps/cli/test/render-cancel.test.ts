import { describe, expect, it } from "vitest";
import { renderCancellation } from "../src/produce";

/**
 * 2026-08-19 field report: "Cancelling rerendering doesn't work". Nothing in
 * the CLI handled SIGINT and no cancelSignal reached Remotion, so Ctrl-C left
 * the browser and its ffmpeg children running. The wiring (process.on around
 * the render phase, the signal removal in finally) is I/O and lives at the
 * call site; this is the decision half — what gets deleted, and what the
 * process exits with — tested without spawning a render.
 */

describe("renderCancellation", () => {
  it("discards the partial raw render, never the user's --out", () => {
    // The finished path is raw → loudnorm → moveFile(out). A cancel happens
    // before the move, so there is no output file to mistake for a finished
    // render; what is left is a truncated mp4 in the workdir under the name
    // the next run reads, and THAT is what gets removed.
    const c = renderCancellation("SIGINT", "/w/.ossclip/render-raw.mp4");
    expect(c.removePaths).toEqual(["/w/.ossclip/render-raw.mp4"]);
  });

  it("exits 130 on SIGINT and 143 on SIGTERM — 128 + the signal", () => {
    // Non-zero because no video was produced, but signal-shaped rather than 1
    // so a script (and the editor's cancel path) can tell a deliberate stop
    // from a failure.
    expect(renderCancellation("SIGINT", "/w/raw.mp4").exitCode).toBe(130);
    expect(renderCancellation("SIGTERM", "/w/raw.mp4").exitCode).toBe(143);
  });

  it("says cancelled, not failed", () => {
    expect(renderCancellation("SIGINT", "/w/raw.mp4").message).toBe(
      "▸ cancelled — partial output discarded",
    );
    expect(renderCancellation("SIGTERM", "/w/raw.mp4").message).toBe(
      "▸ cancelled — partial output discarded",
    );
  });
});
