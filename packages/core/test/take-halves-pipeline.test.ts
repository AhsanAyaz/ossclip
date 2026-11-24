import { describe, expect, it } from "vitest";
import {
  OverrideDocSchema,
  applyOverrides,
  splitCuesWithLanding,
  type ResolvedSplitPoint,
} from "../src/overrides";
import { reconcileSplitAnchors, rekeyTakeHalves } from "../src/take-halves";
import { fillPlainCues } from "../src/fill";
import { feMap } from "./take-looks.fixtures";

/**
 * Test 27 (take-framing-identity): the FE Loop short as produce runs it —
 * `fillPlainCues` → `splitCuesWithLanding` → `rekeyTakeHalves` →
 * `reconcileSplitAnchors` → `applyOverrides`. Every value is inline: the clip starts are the field
 * workdir's span boundaries (not half starts), and the resolved point is
 * where `src` 66.055 lands on that render's clock. The edit was keyed
 * `take-2@66055` on an older clock; on this one the split falls in take-3,
 * so before P2 the half rendered as `take-3@66055` unframed and the edit
 * orphaned.
 */
describe("FE Loop through produce's pipeline (take-framing-identity test 27)", () => {
  const doc = OverrideDocSchema.parse({
    scenes: {
      "take-2": { video: { scale: 2.2, dx: 814.4 } },
      "take-2@66055": { video: { scale: 2.2, dx: -664.8 } },
    },
    splits: [{ at: 58.784, src: 66.055, id: "66055" }],
  });
  const points: ResolvedSplitPoint[] = [{ at: 58.467, id: "66055" }];
  // No graphics in the window, so there are no pass-1 graphic cues either.
  const filled = fillPlainCues([], {
    outputDurationSec: 70,
    clipStarts: [0, 8.21438, 17.94988, 21.71588, 60.76448],
  });
  const { cues: split, landed } = splitCuesWithLanding(filled, points);
  const rekey = rekeyTakeHalves(doc, landed);
  // The `at` the old step 7 refreshed is now the reconcile's to write
  // (split-positions-by-source D4, R7-4).
  const reconcile = reconcileSplitAnchors(rekey.doc, new Set(), landed, points, [], feMap());
  const { cues, orphans } = applyOverrides(split, reconcile.doc);
  const byId = (id: string) => cues.find((c) => c.id === id);

  it("the half renders as take-3@66055 with the framing the author gave it", () => {
    expect(byId("take-3@66055")?.video).toEqual({ scale: 2.2, dx: -664.8 });
  });

  it("take-2 keeps its own framing", () => {
    expect(byId("take-2")?.video).toEqual({ scale: 2.2, dx: 814.4 });
  });

  it("the stale key is gone and nothing orphans", () => {
    expect(rekey.doc.scenes["take-2@66055"]).toBeUndefined();
    expect(orphans).toEqual([]);
  });

  it("the split is migrated to own framing, and reconciled so its `at` speaks this render's clock", () => {
    expect(rekey.doc.splits.find((x) => x.id === "66055")?.at).toBe(58.784);
    const s = reconcile.doc.splits.find((x) => x.id === "66055");
    expect(s?.ownFraming).toBe(true);
    expect(s?.at).toBe(58.467);
    expect(reconcile.notes).toEqual(["split 66055 anchors reconciled (at 58.467s, source 66.055s)"]);
  });
});
