import { describe, expect, it } from "vitest";
import { appliedCaptionEditCount, captionDropLine } from "../src/caption-report";

/**
 * §137 Task 6 — what `produce` says about caption edits that did not apply.
 * Both halves of the old reporting were wrong in ways that hid exactly the
 * failure this plan exists to remove.
 */
describe("captionDropLine", () => {
  it("says the word was CUT, not that the transcript has `null`", () => {
    // The field case. `found: null` was interpolated straight into the
    // sentence, so the one drop §137 is about printed as
    // `the transcript now has "null"` — unreadable as the thing that happened.
    const line = captionDropLine({ key: "w1768", expected: "batch,", found: null });
    expect(line).not.toContain("null");
    expect(line).toContain("batch,");
    expect(line).toContain("w1768");
    expect(line).toContain("the cut removed");
  });

  it("names the word the transcript holds now when there IS one", () => {
    const line = captionDropLine({ key: "w1768", expected: "batch,", found: "bash," });
    expect(line).toContain(`says "bash," there`);
    expect(line).not.toContain("the cut removed");
  });

  it("reports a duplicate anchor as a note about reach, not a dropped edit", () => {
    // `applyCaptionEdits` pushes this for the SECOND word carrying an anchor;
    // the edit itself applied to the first. Calling it "dropped" would send
    // the user to retype an edit that is already in the video.
    const line = captionDropLine({
      key: "w1768",
      expected: "batch,",
      found: "batch,",
      reason: "duplicate-anchor",
    });
    expect(line).not.toContain("dropped");
    expect(line).toContain("only the first was retyped");
  });
});

describe("appliedCaptionEditCount", () => {
  const edit = (was: string) => ({ text: was.toUpperCase(), was });

  it("counts every edit when nothing was dropped", () => {
    expect(appliedCaptionEditCount({ w1: edit("a"), w2: edit("b") }, [])).toBe(2);
  });

  it("does not count an edit whose word was cut or had moved on", () => {
    expect(
      appliedCaptionEditCount({ w1: edit("a"), w2: edit("b") }, [
        { key: "w1", expected: "a", found: null },
      ]),
    ).toBe(1);
  });

  it("STILL counts an edit that only ever appears as a duplicate anchor", () => {
    // The edit applied to the first word carrying `w1`; the report is about
    // the second. `keys.length - dropped.length` scored this as 0 applied.
    expect(
      appliedCaptionEditCount({ w1: edit("a") }, [
        { key: "w1", expected: "a", found: "a", reason: "duplicate-anchor" },
      ]),
    ).toBe(1);
  });

  it("never goes negative when one key is reported more than once", () => {
    // Three words sharing one anchor: two duplicate reports for a single key,
    // plus a real drop for the other. The subtraction this replaces returned
    // 2 - 3 = -1, which the caller's `> 0` guard silenced completely.
    const dropped = [
      { key: "w1", expected: "a", found: "a", reason: "duplicate-anchor" as const },
      { key: "w1", expected: "a", found: "a", reason: "duplicate-anchor" as const },
      { key: "w2", expected: "b", found: null },
    ];
    expect(appliedCaptionEditCount({ w1: edit("a"), w2: edit("b") }, dropped)).toBe(1);
  });

  it("counts a key reported BOTH ways as not applied", () => {
    // The first word carrying `w1` mismatched (reason absent — a real drop)
    // and a second word carried the same anchor. The `reason`-less entry is
    // the verdict; the duplicate note must not overturn it.
    const dropped = [
      { key: "w1", expected: "a", found: "z" },
      { key: "w1", expected: "a", found: "a", reason: "duplicate-anchor" as const },
    ];
    expect(appliedCaptionEditCount({ w1: edit("a") }, dropped)).toBe(0);
  });
});
