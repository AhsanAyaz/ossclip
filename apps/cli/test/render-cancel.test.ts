import { describe, expect, it } from "vitest";
import { renderCancellation, renderSignalAction, renderSignalPhaseOf } from "../src/produce";

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

/**
 * 2026-08-19 review of the fix above: the handler covered the whole render
 * phase but the cancelSignal only reaches `renderMedia`, and `bundle()` and
 * `selectComposition()` run FIRST. Registering a SIGINT listener suppresses
 * node's default terminate, so during a cold bundle — tens of seconds, minutes
 * when Chrome is downloaded on first run — Ctrl-C did nothing at all and the
 * terminal looked hung. That is a REGRESSION the cancel feature introduced:
 * before it, Ctrl-C killed the process there.
 */
describe("renderSignalPhaseOf", () => {
  it("treats bundling and selecting alike — neither takes a cancelSignal in 4.0.499", () => {
    expect(renderSignalPhaseOf("bundling")).toBe("pre-render");
    expect(renderSignalPhaseOf("selecting")).toBe("pre-render");
  });

  it("is only 'rendering' once renderMedia is the call in flight", () => {
    expect(renderSignalPhaseOf("rendering")).toBe("rendering");
  });
});

describe("renderSignalAction", () => {
  it("EXITS from the handler during the phases nothing is listening in", () => {
    const a = renderSignalAction("pre-render", 1);
    expect(a.exitNow).toBe(true);
    // The signal is fired anyway: free, and it covers a renderMedia that
    // starts between the decision and the exit.
    expect(a.cancel).toBe(true);
    expect(a.note).toContain("cancelled while preparing the render");
  });

  it("lets Remotion tear itself down during the render — the cooperative phase", () => {
    // A hard exit here would orphan the browser and its ffmpeg children, which
    // is the whole reason the cancelSignal exists.
    expect(renderSignalAction("rendering", 1)).toEqual({ cancel: true, exitNow: false });
  });

  it("exits on a SECOND signal in every phase — Ctrl-C must never wedge", () => {
    // If Remotion's teardown hangs, the user's next move must not have to be
    // `kill -9` from another terminal.
    for (const phase of ["pre-render", "rendering", "post-render"] as const) {
      const a = renderSignalAction(phase, 2);
      expect(a.exitNow).toBe(true);
      expect(a.note).toContain("second signal");
    }
  });

  it("HONORS a signal that lands after the render finished, rather than exiting mid-handler", () => {
    // The tail case: a signal between `renderMedia` resolving and the
    // handlers coming off used to be swallowed outright — the run went on to
    // master and produced a complete video having eaten the user's Ctrl-C.
    // The caller stops before mastering instead; the handler itself does not
    // need to exit, because control is already on its way back to that check.
    expect(renderSignalAction("post-render", 1)).toEqual({ cancel: true, exitNow: false });
  });
});
