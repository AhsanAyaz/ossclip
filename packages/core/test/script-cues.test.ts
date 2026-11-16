import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseScript, stripInlineMarkup } from "../src/script/cues";

/** The author's real script (spec "Answers from the author" 2): markup in
 * spoken lines, a cue with no spoken line, prose and ✂️ notes between. */
const egm = readFileSync(new URL("./fixtures/egm-script.md", import.meta.url), "utf8");

describe("parseScript", () => {
  it("parses the EGM script: 20 cues, in order", () => {
    const cues = parseScript(egm);
    expect(cues).toHaveLength(20);
    expect(cues.map((c) => c.index)).toEqual(cues.map((_, i) => i));
    expect(cues[0]!.cueText).toMatch(/^Cold open on the final captions/);
    expect(cues[0]!.line).toBe(15);
    expect(cues[0]!.spoken).toEqual([
      "These captions were choreographed by AI.",
      "But that's not the cool part.",
    ]);
  });

  it("strips bold and code from spoken lines and cues", () => {
    const cues = parseScript(egm);
    expect(cues.find((c) => c.spoken[0]?.startsWith("One."))!.spoken[0]).toBe(
      "One. When you cut a word in the editor, it would wipe out all the AI caption data. Silently.",
    );
    expect(cues.some((c) => c.spoken.includes("I typed /egm:egm-brainstorm."))).toBe(true);
    expect(cues[1]!.cueText).toBe("Hard cut to the terminal: 4 Blockers, 6 Majors, 5 Nits.");
  });

  it("a cue with no spoken line has an empty list", () => {
    expect(parseScript(egm).find((c) => c.cueText.includes("4,494 tests passing"))!.spoken).toEqual([]);
  });

  it("a heading ends the section: a spoken line before any cue belongs to no cue", () => {
    const cues = parseScript("🎬 A\n🗣️ one\n## Next\n🗣️ orphan\n🎬 B\n🗣️ two");
    expect(cues.map((c) => c.spoken)).toEqual([["one"], ["two"]]);
  });

  it("reads hints", () => {
    const [a, b, c] = parseScript("🎬 [BugCard] x\n🗣️ a\n🎬 clip: clips/a b.mov\n🗣️ b\n🎬 Screen: demo\n🗣️ c");
    expect(a!.hint).toEqual({ kind: "component", component: "BugCard" });
    expect(a!.cueText).toBe("x");
    expect(b!.hint).toEqual({ kind: "clip", path: "clips/a b.mov" });
    expect(c!.hint).toEqual({ kind: "screen" });
    expect(c!.cueText).toBe("demo");
  });

  it("a cue without a hint prefix has hint none", () => {
    expect(parseScript("🎬 Screen recording: typing\n🗣️ a")[0]!.hint).toEqual({ kind: "none" });
  });

  it("a leading markdown link is cue text, not a component hint", () => {
    const [cue] = parseScript("🎬 [the repo](https://example.com) zooms in\n🗣️ a");
    expect(cue!.hint).toEqual({ kind: "none" });
  });

  it("ids are stable across unrelated edits to other cues", () => {
    const before = parseScript("🎬 A\n🗣️ a\n🎬 B\n🗣️ b");
    const after = parseScript("🎬 A\n🗣️ a changed\n🎬 B\n🗣️ b");
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(before[0]!.id).toMatch(/^cue-0-[0-9a-f]{8}$/);
    expect(before[0]!.id).not.toBe(before[1]!.id);
  });

  it("ignores ✂️ lines and plain prose", () => {
    expect(parseScript("🎬 A\n✂️ note\nprose\n🗣️ a")[0]!.spoken).toEqual(["a"]);
  });

  it("tolerates the emoji with or without its variation selector", () => {
    // 🗣️ is U+1F5E3 U+FE0F; editors and keyboards drop or add the selector.
    const cues = parseScript("\u{1F3AC}️ A\n\u{1F5E3} bare\n\u{1F5E3}️ selected");
    expect(cues).toHaveLength(1);
    expect(cues[0]!.cueText).toBe("A");
    expect(cues[0]!.spoken).toEqual(["bare", "selected"]);
  });

  it("CRLF line endings parse the same as LF", () => {
    expect(parseScript("🎬 A\r\n🗣️ a\r\n")).toEqual(parseScript("🎬 A\n🗣️ a\n"));
  });
});

describe("stripInlineMarkup", () => {
  it("removes bold, code and emphasis, keeping the text", () => {
    expect(stripInlineMarkup("**One.** run `ossclip produce` *now*")).toBe("One. run ossclip produce now");
  });

  it("leaves a lone asterisk and code contents alone", () => {
    expect(stripInlineMarkup("2 * 3 is `a*b*c`")).toBe("2 * 3 is a*b*c");
  });
});
