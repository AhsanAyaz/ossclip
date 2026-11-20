import { describe, expect, it } from "vitest";
import { kitCaptionsSrt } from "../src/kit-captions";

/**
 * The clip kit's `captions.srt` (design kit-captions-layer.md, Part 1): which
 * caption lines become subtitle entries, and the exact bytes Resolve reads.
 */

const line = (texts: string[], start: number, end: number) => ({
  words: texts.map((text) => ({ text })),
  start,
  end,
});

describe("kitCaptionsSrt", () => {
  it("two plain lines: numbered from 1, Windows line endings, a blank line between, a trailing one", () => {
    expect(kitCaptionsSrt([line(["hello", "there"], 0.5, 2), line(["again"], 61.25, 63.5)])).toEqual({
      text:
        "1\r\n00:00:00,500 --> 00:00:02,000\r\nhello there\r\n\r\n" +
        "2\r\n00:01:01,250 --> 00:01:03,500\r\nagain\r\n",
      lines: 2,
      skipped: 0,
    });
  });

  it("a line with no words, one with only blank words, and a zero- or negative-length line are skipped and counted, with no gap in the numbers", () => {
    const r = kitCaptionsSrt([
      line(["one"], 1, 2),
      line([], 2, 3),
      line(["", "  ", "\t"], 3, 4),
      line(["zero"], 4, 4),
      line(["backwards"], 5, 4.5),
      line(["two"], 6, 7),
    ]);
    expect(r).toEqual({
      text: "1\r\n00:00:01,000 --> 00:00:02,000\r\none\r\n\r\n2\r\n00:00:06,000 --> 00:00:07,000\r\ntwo\r\n",
      lines: 2,
      skipped: 4,
    });
  });

  it("blank words drop out and stray whitespace collapses, so the words are joined by single spaces", () => {
    // A newline inside a word's text would end the SRT entry early.
    expect(kitCaptionsSrt([line([" so", "", "the\nnext ", "one"], 0, 1)]).text).toBe(
      "1\r\n00:00:00,000 --> 00:00:01,000\r\nso the next one\r\n",
    );
  });

  it("no lines, or every line skipped: no text", () => {
    expect(kitCaptionsSrt([])).toEqual({ text: null, lines: 0, skipped: 0 });
    expect(kitCaptionsSrt([line([], 0, 1), line(["x"], 2, 2)])).toEqual({ text: null, lines: 0, skipped: 2 });
  });

  it("non-ASCII text is kept as is, with no byte-order mark", () => {
    const r = kitCaptionsSrt([line(["یہ", "ٹیسٹ", "ہے"], 0, 1), line(["wait", "—", "really"], 1, 2)]);
    expect(r.text!.startsWith("1\r\n")).toBe(true);
    expect(r.text).toContain("\r\nیہ ٹیسٹ ہے\r\n");
    expect(r.text).toContain("\r\nwait — really\r\n");
    const bytes = Buffer.from(r.text!, "utf8");
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toBe(r.text);
  });

  it("times past an hour", () => {
    expect(kitCaptionsSrt([line(["late"], 3600.25, 3601.5)]).text).toBe(
      "1\r\n01:00:00,250 --> 01:00:01,500\r\nlate\r\n",
    );
  });
});
