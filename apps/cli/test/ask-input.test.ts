import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROWSE_FILE,
  BROWSE_FOLDER,
  TYPE_PATH,
  inputChoices,
  validateInputPath,
} from "../src/interactive/ask-input";
import type { Suggestion } from "../src/interactive/suggest-inputs";

/**
 * The menu that replaced the typed-path prompt (§136). Composition is pure so
 * the one rule that matters — a Browse row is never offered on a machine with
 * no dialog to open — is pinned without a TTY.
 */
const sugg = (path: string): Suggestion => ({ path, label: path, hint: "1 MB · just now" });

describe("inputChoices", () => {
  it("suggestions first, then browse, then type", () => {
    const out = inputChoices([sugg("/x/a.mp4"), sugg("/x/b.mp4")], true);
    expect(out.map((c) => c.value)).toEqual([
      "/x/a.mp4",
      "/x/b.mp4",
      BROWSE_FILE,
      BROWSE_FOLDER,
      TYPE_PATH,
    ]);
  });

  it("no browse rows when there is no picker — never offer what cannot work", () => {
    const out = inputChoices([sugg("/x/a.mp4")], false);
    expect(out.map((c) => c.value)).toEqual(["/x/a.mp4", TYPE_PATH]);
  });

  it("typing is always reachable, even with nothing else on offer", () => {
    expect(inputChoices([], false).map((c) => c.value)).toEqual([TYPE_PATH]);
  });

  it("a suggestion row shows its size and age as the hint", () => {
    const [row] = inputChoices([sugg("/x/a.mp4")], false);
    expect(row?.hint).toBe("1 MB · just now");
  });
});

describe("validateInputPath", () => {
  const dir = mkdtempSync(join(tmpdir(), "ossclip-askinput-"));
  const file = join(dir, "take.mp4");
  writeFileSync(file, "x");

  it("accepts a file and a directory", () => {
    expect(validateInputPath(file)).toBeUndefined();
    expect(validateInputPath(dir)).toBeUndefined();
  });

  it("rejects empty and missing with the wording the old prompt used", () => {
    expect(validateInputPath("")).toBe("a path is required");
    expect(validateInputPath(undefined)).toBe("a path is required");
    expect(validateInputPath("/nope/nothing.mp4")).toBe("no such path: /nope/nothing.mp4");
  });

  it("guards the picker path too — a file can vanish between dialog and return", () => {
    const gone = join(dir, "deleted.mp4");
    writeFileSync(gone, "x");
    rmSync(gone);
    expect(validateInputPath(gone)).toBe(`no such path: ${gone}`);
  });
});
