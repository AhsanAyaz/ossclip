import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { OverrideDocSchema, type CaptionLine } from "@ossclip/core";
import {
  appliedCaptionEditCount,
  captionDropLine,
  captionKeysMigrated,
  captionMigrationLine,
  reanchoredKeyCount,
  reconcileCaptionEdits,
} from "../src/caption-report";

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

  it("does not blame the cut for a key that is a POSITION, not an anchor", () => {
    // Important 2: `"0"` never had a source moment to lose. On the one path
    // that prints it — an edit reaching produce without a migration — the old
    // wording sent the user to redo work sitting intact on screen.
    const line = captionDropLine({ key: "0", expected: "batch,", found: null });
    expect(line).not.toContain("the cut removed");
    expect(line).toContain("position 0");
    expect(line).toContain("before source anchors");
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

describe("captionMigrationLine", () => {
  const line = (reason: "not-found" | "ambiguous" | "unanchorable" | "collision" | "superseded") =>
    captionMigrationLine({ key: "3", was: "batch,", reason });

  it("names the CAUSE — three of the four leave the word on screen", () => {
    // Minor 7: one message blaming the cut sends the user hunting for a word
    // that never moved.
    expect(line("not-found")).toContain("no word says it any more");
    expect(line("ambiguous")).toContain("more than one word says it");
    expect(line("unanchorable")).toContain("no source timing");
    expect(line("collision")).toContain("two stored edits point at the same word");
    expect(line("superseded")).toContain("a newer edit already covers that word");
  });

  it("only asks for a retype where a retype is the answer", () => {
    // `superseded` kept the newer edit and `unanchorable` is a defect in the
    // project's files — telling either user to retype is telling them to redo
    // work that is not lost.
    expect(line("superseded")).not.toContain("etype");
    expect(line("unanchorable")).not.toContain("etype");
    expect(line("not-found")).toContain("etype");
    expect(line("ambiguous")).toContain("etype");
  });

  it("always names the word and the key it was stored under", () => {
    for (const r of ["not-found", "ambiguous", "unanchorable", "collision", "superseded"] as const) {
      expect(line(r)).toContain('"batch,"');
      expect(line(r)).toContain("(3)");
    }
  });
});

describe("captionKeysMigrated", () => {
  const edit = { text: "Bash,", was: "batch," };

  it("is false for a doc that was already source-keyed", () => {
    // The overwhelmingly common case — it must not trigger a write-back (and
    // a `.bak`) on every single produce run.
    expect(captionKeysMigrated({ w1768: edit }, { edits: { w1768: edit }, unresolved: [] })).toBe(
      false,
    );
    expect(captionKeysMigrated({}, { edits: {}, unresolved: [] })).toBe(false);
  });

  it("is true when a key was rewritten", () => {
    expect(captionKeysMigrated({ "0": edit }, { edits: { w1768: edit }, unresolved: [] })).toBe(
      true,
    );
  });

  it("is true when an edit fell out, even though no key is new", () => {
    // Nothing was added, but the doc lost an entry — writing back is what
    // makes that visible in the file instead of only in the log.
    expect(
      captionKeysMigrated(
        { "0": edit, w1768: edit },
        { edits: { w1768: edit }, unresolved: [{ key: "0", was: "batch,", reason: "superseded" }] },
      ),
    ).toBe(true);
  });
});

describe("reanchoredKeyCount", () => {
  const edit = { text: "Bash,", was: "batch," };

  it("counts only the edits that came out under a NEW key", () => {
    expect(reanchoredKeyCount({ "0": edit }, { edits: { w1768: edit }, unresolved: [] })).toBe(1);
    expect(reanchoredKeyCount({ w1768: edit }, { edits: { w1768: edit }, unresolved: [] })).toBe(0);
  });

  it("counts nothing for a MIXED doc whose source-keyed edit simply won", () => {
    // The count that used to be `Object.keys(edits).length` said "1
    // re-anchored" here, about a key the migration never touched.
    expect(
      reanchoredKeyCount(
        { "0": edit, w1768: edit },
        { edits: { w1768: edit }, unresolved: [{ key: "0", was: "batch,", reason: "superseded" }] },
      ),
    ).toBe(0);
  });
});

describe("reconcileCaptionEdits — produce's caption pass (§137 Task 6, Critical 1)", () => {
  const lines = (...ws: Array<[string, number]>): CaptionLine[] => [
    {
      words: ws.map(([text, srcStart], i) => ({ text, start: i, end: i + 1, srcStart })),
      start: 0,
      end: ws.length,
    },
  ];
  const doc = (captions: Record<string, { text: string; was: string }>) =>
    OverrideDocSchema.parse({ captions });

  it("APPLIES a pre-§137 positional edit — the render used to ship without it", () => {
    // The field case this fix exists for: the editor repairs the doc in
    // memory, `edits.load` leaves it clean, and a Render that saves nothing
    // hands produce the untouched legacy doc. Migrate-then-apply is what puts
    // the retype in the video.
    const out = reconcileCaptionEdits(doc({ "1": { text: "Zsh,", was: "edge," } }), lines(["status", 5], ["edge,", 6]));
    expect(out.lines[0]!.words.map((w) => w.text)).toEqual(["status", "Zsh,"]);
    expect(out.doc.captions).toEqual({ w6000: { text: "Zsh,", was: "edge," } });
    expect(out.keysChanged).toBe(true);
    expect(out.log.join("\n")).toContain("re-anchored");
  });

  it("leaves a source-keyed doc completely alone — no write-back, no noise", () => {
    const before = doc({ w6000: { text: "Zsh,", was: "edge," } });
    const out = reconcileCaptionEdits(before, lines(["status", 5], ["edge,", 6]));
    expect(out.doc).toEqual(before);
    expect(out.keysChanged).toBe(false);
    // One line only: the count. A re-anchor line here would claim a migration
    // that did not happen, on every run, forever.
    expect(out.log).toEqual(["▸ 1 caption word(s) retyped by the editor"]);
  });

  it("reports an edit it could not re-anchor, and drops it from the doc it writes back", () => {
    const out = reconcileCaptionEdits(doc({ "0": { text: "Zsh", was: "gone" } }), lines(["status", 5]));
    expect(out.doc.captions).toEqual({});
    expect(out.keysChanged).toBe(true);
    expect(out.log.join("\n")).toContain('"gone"');
    // Never the old misdiagnosis: the doc's key was a POSITION, so nothing was
    // "cut" out from under a source anchor.
    expect(out.log.join("\n")).not.toContain("the cut removed the word");
    // And no "0 caption edit(s) re-anchored" over the top of the explanation:
    // the doc changed (the edit left it), but nothing was moved.
    expect(out.log.join("\n")).not.toContain("re-anchored from word positions");
  });

  it("a MIXED doc keeps the source-keyed edit, writes back, and claims no re-anchor", () => {
    // Important 3 reaching produce: a project edited before AND after this
    // change holds both key spaces over one word. The newer edit is the one
    // that renders, the legacy one is retired by name, and the write-back
    // happens because the doc really did change — but nothing moved keys, so
    // the count line stays away.
    const out = reconcileCaptionEdits(
      doc({ "0": { text: "Zsh,", was: "edge," }, w6000: { text: "Fish,", was: "edge," } }),
      lines(["edge,", 6]),
    );
    expect(out.doc.captions).toEqual({ w6000: { text: "Fish,", was: "edge," } });
    expect(out.lines[0]!.words.map((w) => w.text)).toEqual(["Fish,"]);
    expect(out.keysChanged).toBe(true);
    expect(out.log.join("\n")).not.toContain("re-anchored from word positions");
    expect(out.log.join("\n")).toContain("a newer edit already covers that word");
  });

  it("keeps the doc's other fields when it rewrites the captions", () => {
    const before = OverrideDocSchema.parse({
      captions: { "0": { text: "Zsh,", was: "edge," } },
      splits: [{ at: 5, id: "s1" }],
      captionsHidden: true,
    });
    const out = reconcileCaptionEdits(before, lines(["edge,", 6]));
    expect(out.doc.splits).toEqual(before.splits);
    expect(out.doc.captionsHidden).toBe(true);
  });
});

/**
 * Everything above tests `reconcileCaptionEdits` in isolation. This tests that
 * `produce.ts` still CALLS it — by reading the source, which is normally the
 * wrong tool and is the right one here.
 *
 * Nothing in this repo invokes `produce()`: a behavioural test of it needs
 * ffmpeg on PATH, a real transcript, a work directory and a render, and the
 * editor's `renderflow.spec.ts` "render" is a fake child process. So no test
 * in the suite executes ANY of the three lines below (`produce.ts:1958-1961`
 * plus the gate at `:2207`). That was measured, not assumed — deleting any one
 * of them LEFT THE WHOLE SUITE GREEN, which is one line away from re-creating
 * the Critical §137 just fixed.
 *
 * And what they guard is the failure most deserving of even a crude test:
 * silent, user-visible data loss, in three distinct shapes.
 *  - No `reconcileCaptionEdits` call: a legacy doc is never migrated, so every
 *    retype shows on screen and is absent from the render.
 *  - The call, but no `overrideDoc = captionWork.doc`: WORSE than not calling
 *    it, and it typechecks, because `captionWork` is still read for its lines,
 *    its log and `keysChanged`. The migration is computed and thrown away, the
 *    render still ships without the retypes — and now `keysChanged` is true, so
 *    the write gate below fires, overwrites the user's `overrides.json.bak`
 *    with the UN-migrated doc and prints "re-anchored to source-time caption
 *    keys". A false success line over destroyed evidence (§137 review,
 *    Important 1).
 *  - No `captionKeysChanged` in the write gate: the migration happens and is
 *    discarded on exit, and each further run loses a little more of it for good
 *    (a legacy key is found by the word it names, so the next re-plan that
 *    rewrites that word retires it).
 *
 * Precedent: `doctor.test.ts`'s version-literal check (R22 §113) — the same
 * shape, for the same reason. This is a stand-in, not the answer: a real
 * harness (`produce()` over the `pnpm fixture` video with `--no-render`) would
 * subsume it.
 */
describe("produce's §137 caption wiring (source-text guard)", () => {
  const src = readFileSync(new URL("../src/produce.ts", import.meta.url), "utf8");

  it("MIGRATES legacy caption keys — `reconcileCaptionEdits` is called, not just imported", () => {
    // The result must be bound to something (`= reconcileCaptionEdits(`), so
    // the import line alone cannot satisfy this.
    expect(src).toMatch(/=\s*reconcileCaptionEdits\(/);
  });

  it("ADOPTS the migrated doc — a result that is computed and not assigned is the same silence", () => {
    // The assertion above only proves the call happened. Everything downstream
    // — the render, the orphan reports, the write gate — reads `overrideDoc`,
    // so this one line is what makes the migration real. Guarded separately
    // because deleting it passes the call assertion AND typechecks: see the
    // second bullet above for what that ships.
    expect(src).toMatch(/overrideDoc\s*=\s*captionWork\.doc/);
  });

  it("WRITES the migrated doc back — the save gate is not a bare cut check", () => {
    // `cutResult.changed` alone was the gate before §137, and a caption-key
    // migration changes the doc without changing the cut, so the repaired file
    // never reached disk. Either operand order satisfies this: what must not
    // survive is one of them going missing, or the `||` narrowing to `&&`.
    expect(src).toMatch(
      /if\s*\(\s*(cutResult\.changed\s*\|\|\s*captionKeysChanged|captionKeysChanged\s*\|\|\s*cutResult\.changed)\s*\)/,
    );
  });
});
