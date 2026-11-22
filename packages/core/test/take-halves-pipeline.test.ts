import { describe, expect, it } from "vitest";
import {
  OverrideDocSchema,
  applyOverrides,
  splitCuesWithLanding,
  type ResolvedSplitPoint,
} from "../src/overrides";
import { rekeyTakeHalves } from "../src/take-halves";
import { fillPlainCues } from "../src/fill";

/**
 * Test 27 (take-framing-identity): the FE Loop short as produce runs it —
 * `fillPlainCues` → `splitCuesWithLanding` → `rekeyTakeHalves` →
 * `applyOverrides`. Every value is inline: the clip starts are the field
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
  const rekey = rekeyTakeHalves(doc, landed, points, []);
  const { cues, orphans } = applyOverrides(split, rekey.doc);
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

  it("the split is migrated to own framing and its `at` speaks this render's clock", () => {
    const s = rekey.doc.splits.find((x) => x.id === "66055");
    expect(s?.ownFraming).toBe(true);
    expect(s?.at).toBe(58.467);
  });
});
