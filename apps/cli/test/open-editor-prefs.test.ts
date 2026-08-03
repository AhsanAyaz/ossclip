import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveConfigPatch } from "@ossclip/core";
import { decideOpenEditor } from "../src/interactive/prefs";

const base = (over = {}) => ({
  flag: undefined as boolean | undefined,
  pref: "ask" as const,
  interactive: true,
  rendered: true,
  ...over,
});

describe("decideOpenEditor", () => {
  it("asks by default on an interactive render", () => {
    expect(decideOpenEditor(base())).toBe("ask");
  });

  it("lets the flags win over the stored preference", () => {
    expect(decideOpenEditor(base({ flag: true, pref: "never" }))).toBe("open");
    expect(decideOpenEditor(base({ flag: false, pref: "always" }))).toBe("skip");
  });

  it("honours a stored always/never without asking", () => {
    expect(decideOpenEditor(base({ pref: "always" }))).toBe("open");
    expect(decideOpenEditor(base({ pref: "never" }))).toBe("skip");
  });

  // --no-render leaves nothing to look at, so the offer would be noise.
  it("skips when nothing was rendered", () => {
    expect(decideOpenEditor(base({ rendered: false }))).toBe("skip");
    expect(decideOpenEditor(base({ rendered: false, pref: "always" }))).toBe("skip");
  });

  // An explicit flag is a deliberate instruction: the editor reads
  // render-props.json, which a --no-render run does write.
  it("still opens on an explicit flag with no render", () => {
    expect(decideOpenEditor(base({ rendered: false, flag: true }))).toBe("open");
  });

  it("never asks without a TTY", () => {
    expect(decideOpenEditor(base({ interactive: false }))).toBe("skip");
  });
});

describe("the preference round-trips through config.json", () => {
  it("writes and reads back without touching a real home", () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-prefs-"));
    const path = saveConfigPatch({ openEditorAfterProduce: "always" }, dir);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      openEditorAfterProduce: "always",
    });
  });

  it("leaves neighbouring hand-edited keys alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-prefs-"));
    saveConfigPatch({ speaker: "Ahsan" }, dir);
    const path = saveConfigPatch({ openEditorAfterProduce: "never" }, dir);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      speaker: "Ahsan",
      openEditorAfterProduce: "never",
    });
  });
});
