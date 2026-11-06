import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { logoCandidatePath } from "../src/logo-candidate-file";

/** Task 6 ruling: a candidate resolves only through its own suggestion's directory. */
const WORK = resolve("/tmp/work");
const suggestion = (id: string, files: string[]) => ({
  id,
  name: id,
  word: 0,
  candidates: files.map((file) => ({ file, source: "header" })),
});
const overlays = (...suggestions: unknown[]) => ({ entries: [], placements: [], suggestions });

describe("logoCandidatePath", () => {
  it("resolves candidate n inside <workdir>/logo-candidates/<id>/", () => {
    const o = overlays(suggestion("firebase", ["logo-candidates/firebase/0.svg", "logo-candidates/firebase/1.png"]));
    expect(logoCandidatePath(o, WORK, "firebase", 1)).toBe(join(WORK, "logo-candidates", "firebase", "1.png"));
  });

  it("refuses a candidate filed under another suggestion's directory", () => {
    const o = overlays(suggestion("a", ["logo-candidates/b/0.png"]), suggestion("b", ["logo-candidates/b/0.png"]));
    expect(logoCandidatePath(o, WORK, "a", 0)).toBeNull();
    expect(logoCandidatePath(o, WORK, "b", 0)).toBe(join(WORK, "logo-candidates", "b", "0.png"));
  });

  it("an unknown id, an out-of-range n, or a traversal-looking id is null", () => {
    const o = overlays(suggestion("firebase", ["logo-candidates/firebase/0.svg"]));
    expect(logoCandidatePath(o, WORK, "nope", 0)).toBeNull();
    expect(logoCandidatePath(o, WORK, "firebase", 1)).toBeNull();
    expect(logoCandidatePath(o, WORK, "../x", 0)).toBeNull();
  });

  it("missing, corrupt, or suggestion-less overlays mean no candidate", () => {
    expect(logoCandidatePath(undefined, WORK, "firebase", 0)).toBeNull();
    expect(logoCandidatePath({ entries: "x" }, WORK, "firebase", 0)).toBeNull();
    expect(logoCandidatePath({ entries: [], placements: [] }, WORK, "firebase", 0)).toBeNull();
    // A `../` file fails LogoCandidateSchema, so the whole plan is refused.
    expect(logoCandidatePath(overlays(suggestion("x", ["logo-candidates/x/../../etc/0.png"])), WORK, "x", 0)).toBeNull();
  });
});
