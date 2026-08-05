import { describe, expect, it } from "vitest";
import { planRenderPublicDir } from "../src/produce";

/**
 * Final-review fix wave, Finding 3: the accepted-side-image check used to
 * accept an image from a directory (a folder run's clips folder, or —
 * pre-existing — a file run's own folder once a mezzanine got built) that
 * ISN'T where `dirname(renderVideo)` — the render's `publicDir` — actually
 * points. `planRenderPublicDir` is the pure decision `produce()` now shares
 * between that check and the real `renderVideo` assignment (both read the
 * SAME `mezzanineWillBuild` boolean, computed once), so the two directories
 * can never disagree. These tests pin its behavior across the shapes that
 * boolean and `analysisInput` can take.
 */
describe("planRenderPublicDir", () => {
  const input = "/Users/x/Downloads/take.mov";
  const work = "/Users/x/Downloads/.ossclip/take-abc12345";

  it("is `work` when the framing bake ran (analysisInput !== input), even with no mezzanine build", () => {
    expect(
      planRenderPublicDir({
        input,
        inputIsAnalysisInput: false,
        mezzanineWillBuild: false,
        work,
      }),
    ).toBe(work);
  });

  it("is `work` when a mezzanine will build and analysisInput === input", () => {
    expect(
      planRenderPublicDir({
        input,
        inputIsAnalysisInput: true,
        mezzanineWillBuild: true,
        work,
      }),
    ).toBe(work);
  });

  it("is dirname(input) only when analysisInput === input and no mezzanine will build", () => {
    expect(
      planRenderPublicDir({
        input,
        inputIsAnalysisInput: true,
        mezzanineWillBuild: false,
        work,
      }),
    ).toBe("/Users/x/Downloads");
  });

  it("for a folder run, `input` is already inside `work` (source-concat.mp4), so the result is `work` either way", () => {
    const folderInput = `${work}/source-concat.mp4`;
    expect(
      planRenderPublicDir({
        input: folderInput,
        inputIsAnalysisInput: true,
        mezzanineWillBuild: false,
        work,
      }),
    ).toBe(work);
  });
});
