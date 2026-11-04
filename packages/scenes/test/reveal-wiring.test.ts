import { describe, expect, it } from "vitest";
import {
  ChatMockProps,
  FlowDiagramProps,
  StrikethroughRevealProps,
  TerminalMockProps,
} from "@ossclip/core/browser";
import { flowDelays } from "../src/components/FlowDiagram";
import { chatDelays } from "../src/components/ChatMock";
import { terminalDelays } from "../src/components/TerminalMock";
import { strikeRowDelays } from "../src/components/StrikethroughReveal";
import { enterFrames } from "../src/anim";

/**
 * The four staggered components on the shared schedule (reveal-timing spec
 * §4). Legacy must be today's constants to the frame — every scene rendered
 * before reveal timing depends on it (plan Review Focus 5) — and a cue with
 * item times must put each item on its word.
 */

const FPS = 30;
const DURATION = 300;
const LATEST = DURATION - enterFrames(FPS);

/** A cue starting at 10s with the given absolute item times. */
const timed = (itemAtSec?: (number | null)[]) => ({
  cueStartSec: 10,
  durationInFrames: DURATION,
  itemAtSec,
});

describe("FlowDiagram", () => {
  const props = FlowDiagramProps.parse({ nodes: ["A", "B", "C"] });

  it("legacy: chip i*6, arrow i*6+3 — with no timing, or timing with nothing reveal-related", () => {
    const legacy = [
      { chip: 0, arrow: 3 },
      { chip: 6, arrow: 9 },
      { chip: 12, arrow: 15 },
    ];
    expect(flowDelays(props, FPS)).toEqual(legacy);
    expect(flowDelays(props, FPS, timed(undefined))).toEqual(legacy);
  });

  it("synced: chips on their words, each arrow 3 frames after its chip", () => {
    expect(flowDelays(props, FPS, timed([10, 11, 12]))).toEqual([
      { chip: 0, arrow: 3 },
      { chip: 30, arrow: 33 },
      { chip: 60, arrow: 63 },
    ]);
  });

  it("no timing means legacy even when the author set timing props (direct use)", () => {
    const paced = FlowDiagramProps.parse({ nodes: ["A", "B", "C"], reveal: "paced" });
    expect(flowDelays(paced, FPS).map((d) => d.chip)).toEqual([0, 6, 12]);
  });

  it("timed: an arrow into a chip at the entry limit is held to it, not drawn past the cut", () => {
    // Last chip on a word near the cut → clamped to LATEST; chip+3 would
    // still be fading in at the last frame.
    expect(flowDelays(props, FPS, timed([10, 11, 19.9]))).toEqual([
      { chip: 0, arrow: 3 },
      { chip: 30, arrow: 33 },
      { chip: LATEST, arrow: LATEST },
    ]);
  });
});

describe("ChatMock", () => {
  const props = ChatMockProps.parse({
    messages: [
      { from: "user", text: "hi" },
      { from: "agent", text: "hello" },
      { from: "user", text: "ok" },
    ],
  });

  it("legacy: bubble i*8", () => {
    expect(chatDelays(props, FPS)).toEqual([0, 8, 16]);
    expect(chatDelays(props, FPS, timed(undefined))).toEqual([0, 8, 16]);
  });

  it("synced: bubbles on their words", () => {
    expect(chatDelays(props, FPS, timed([10, 11.5, 13]))).toEqual([0, 45, 90]);
  });

  it("a keyword renders ONE bubble, so the schedule has one entry", () => {
    const cta = ChatMockProps.parse({ ...props, keyword: "agents" });
    expect(chatDelays(cta, FPS)).toEqual([0]);
    expect(chatDelays(cta, FPS, timed([12]))).toEqual([60]);
  });
});

describe("TerminalMock", () => {
  const props = TerminalMockProps.parse({
    windows: [
      { title: "a", lines: ["x"] },
      { title: "b", lines: ["y"] },
    ],
    fanOut: "OUTPUT ×2",
  });

  it("legacy: window i*6, tail n*6+4", () => {
    expect(terminalDelays(props, FPS)).toEqual({ windows: [0, 6], tail: 16 });
    expect(terminalDelays(props, FPS, timed(undefined))).toEqual({ windows: [0, 6], tail: 16 });
  });

  it("synced: windows on their words, the tail 10 frames after the last", () => {
    expect(terminalDelays(props, FPS, timed([10, 12]))).toEqual({ windows: [0, 60], tail: 70 });
  });

  it("a tail that would start past the entry limit is held to it", () => {
    // Second window on a word near the cut → clamped to LATEST; tail too.
    expect(terminalDelays(props, FPS, timed([10, 19.9]))).toEqual({
      windows: [0, LATEST],
      tail: LATEST,
    });
  });
});

describe("StrikethroughReveal", () => {
  const props = StrikethroughRevealProps.parse({
    lines: [{ text: "one" }, { text: "two" }, { text: "three" }],
  });
  // Line 0 wrapped into two rows; lines 1 and 2 are one row each.
  const rows = [
    { lineIndex: 0, rowInLine: 0 },
    { lineIndex: 0, rowInLine: 1 },
    { lineIndex: 1, rowInLine: 0 },
    { lineIndex: 2, rowInLine: 0 },
  ];

  it("legacy: row i*6 by RENDERED row, so a wrap still pushes later lines back", () => {
    // The strike is exactly 8 frames after its row on this path, unclamped.
    const legacy = [0, 6, 12, 18].map((row) => ({ row, strike: row + 8 }));
    expect(strikeRowDelays(rows, props, FPS)).toEqual(legacy);
    expect(strikeRowDelays(rows, props, FPS, timed(undefined))).toEqual(legacy);
  });

  it("synced: each line on its word, a wrapped row 6 frames after its line's first", () => {
    expect(strikeRowDelays(rows, props, FPS, timed([10, 11, 12])).map((d) => d.row)).toEqual([
      0, 6, 30, 60,
    ]);
    expect(strikeRowDelays(rows, props, FPS, timed([10, 11, 12])).map((d) => d.strike)).toEqual([
      8, 14, 38, 68,
    ]);
  });

  it("a wrapped row of a line at the entry limit is held to it", () => {
    const late = [
      { lineIndex: 0, rowInLine: 0 },
      { lineIndex: 1, rowInLine: 0 },
      { lineIndex: 1, rowInLine: 1 },
    ];
    const two = StrikethroughRevealProps.parse({ lines: [{ text: "a" }, { text: "b" }] });
    // The strike too: row + 8 on a row already at the limit would still be
    // drawing at the cut.
    expect(strikeRowDelays(late, two, FPS, timed([10, 19.9]))).toEqual([
      { row: 0, strike: 8 },
      { row: LATEST, strike: LATEST },
      { row: LATEST, strike: LATEST },
    ]);
  });
});
