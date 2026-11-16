import { describe, expect, it } from "vitest";
import { TerminalMockProps } from "@ossclip/core/browser";
import {
  TERMINAL_CARET_HOLD_SEC,
  TERMINAL_LINE_GAP_SEC,
  TERMINAL_TYPE_CPS,
  isTypedLine,
  terminalDelays,
  terminalLineState,
  terminalTimeline,
  typedLineText,
  type TerminalTimeline,
} from "../src/components/TerminalMock";
import { latestEntryFrame } from "../src/reveal";

/**
 * The explainer look's typed terminal (§161, plan Task 8): pure schedule
 * and per-frame state, so the motion is tested without a browser. The
 * classic look never calls any of this — its frames are `terminalDelays`
 * (reveal-wiring.test.ts) and the default-theme stills `cmp`.
 */
const FPS = 30;
const parse = (windows: { title?: string; lines: string[] }[], extra: object = {}) =>
  TerminalMockProps.parse({
    windows: windows.map((w) => ({ title: w.title ?? "t", lines: w.lines })),
    ...extra,
  });
const timed = (durationInFrames: number) => ({ cueStartSec: 0, durationInFrames });
/** Everything the schedule makes appear or finish, in seconds. */
const endSec = (s: TerminalTimeline): number =>
  Math.max(
    s.tail / FPS,
    ...s.windows.flatMap((w) => [w.enterFrame / FPS, w.typeEndSec, ...w.lineAtSec]),
  );

describe("isTypedLine / typedLineText", () => {
  it("types shell and REPL prompts only", () => {
    expect(isTypedLine("$ ossclip produce")).toBe(true);
    expect(isTypedLine("> help")).toBe(true);
    expect(isTypedLine("▸ cutting…")).toBe(false);
    expect(isTypedLine("$no-space")).toBe(false);
    expect(isTypedLine("# $ comment")).toBe(false);
  });

  it("prints the prompt mark whole and types the rest", () => {
    expect(typedLineText("$ run tests", 0)).toBe("$ ");
    expect(typedLineText("$ run tests", -1)).toBe("$ ");
    // 32 cps: 4 characters at 0.125 s.
    expect(typedLineText("$ run tests", 0.125)).toBe("$ run ");
    expect(typedLineText("$ run tests", 9)).toBe("$ run tests");
    expect(typedLineText("> a😀b", 2 / TERMINAL_TYPE_CPS)).toBe("> a😀");
  });
});

describe("terminalTimeline", () => {
  it("types the first prompt line once the window has entered, then lands the output 0.12 s apart", () => {
    const props = parse([{ lines: ["$ ossclip produce", "▸ a", "✓ b"] }]);
    const s = terminalTimeline(props, FPS);
    const w = s.windows[0]!;
    expect(s.cps).toBe(TERMINAL_TYPE_CPS);
    expect(w.enterFrame).toBe(0);
    expect(w.typed).toBe(0);
    // The entrance spring takes 15 frames at 30 fps.
    expect(w.typeStartSec).toBeCloseTo(0.5, 9);
    // 15 command characters at 32 cps.
    expect(w.typeEndSec).toBeCloseTo(0.5 + 15 / 32, 9);
    expect(w.lineAtSec[0]).toBe(0);
    expect(w.lineAtSec[1]).toBeCloseTo(w.typeEndSec, 9);
    expect(w.lineAtSec[2]).toBeCloseTo(w.typeEndSec + TERMINAL_LINE_GAP_SEC, 9);
    // The tail follows the last line, not just its 10 frames.
    expect(s.tail).toBe(Math.ceil(w.lineAtSec[2]! * FPS));
  });

  it("shows the lines before the typed one from the window's entrance", () => {
    const s = terminalTimeline(parse([{ lines: ["# first", "$ ls", "out"] }]), FPS);
    expect(s.windows[0]!.typed).toBe(1);
    expect(s.windows[0]!.lineAtSec.slice(0, 2)).toEqual([0, 0]);
  });

  it("holds a later window until the previous one has finished typing, keeping the stagger after it", () => {
    const props = parse([
      { lines: ["$ ossclip produce", "▸ a"] },
      { lines: ["# x", "$ ls", "out"] },
      { lines: ["plain"] },
    ]);
    const base = terminalDelays(props, FPS);
    expect(base.windows).toEqual([0, 6, 12]);
    const s = terminalTimeline(props, FPS);
    const gate = Math.ceil(s.windows[0]!.typeEndSec * FPS);
    expect(s.windows[1]!.enterFrame).toBe(gate);
    expect(s.windows[1]!.typeStartSec).toBeCloseTo((gate + 15) / FPS, 9);
    // Window 2 has no typed line; it is pushed by window 1's typing.
    const gate2 = Math.ceil(s.windows[1]!.typeEndSec * FPS);
    expect(s.windows[2]!.enterFrame).toBe(Math.max(12 + (gate - 6), gate2));
    expect(s.windows[2]!.typed).toBeNull();
    expect(s.windows[2]!.lineAtSec).toEqual([s.windows[2]!.enterFrame / FPS]);
  });

  it("leaves a terminal with no prompt line on its own delays", () => {
    const props = parse([{ lines: ["▸ a"] }, { lines: ["▸ b"] }], { fanOut: "OUT" });
    const s = terminalTimeline(props, FPS);
    expect(s.windows.map((w) => w.enterFrame)).toEqual(terminalDelays(props, FPS).windows);
    expect(s.tail).toBe(terminalDelays(props, FPS).tail);
    expect(s.windows.every((w) => w.typed === null)).toBe(true);
  });

  it("does not hold a later window for an earlier one that types nothing", () => {
    const s = terminalTimeline(parse([{ lines: ["▸ a"] }, { lines: ["$ ls"] }]), FPS);
    expect(s.windows[1]!.enterFrame).toBe(6);
    expect(s.windows[1]!.typeStartSec).toBeCloseTo(21 / FPS, 9);
  });

  it("is untouched by a cue long enough for it", () => {
    const props = parse([{ lines: ["$ ossclip produce", "▸ a"] }]);
    expect(terminalTimeline(props, FPS, timed(300))).toEqual(terminalTimeline(props, FPS));
  });

  it("types faster in a cue too short for 32 cps, never cutting the command off", () => {
    const command = "$ " + "x".repeat(38);
    const props = parse([{ lines: [command, "a", "b"] }]);
    // 45 frames: entrances must start by frame 30 (1.0 s). The command
    // starts at 0.5 s and two output lines follow, 0.12 s apart: 38
    // characters in 0.38 s is 100 cps.
    const s = terminalTimeline(props, FPS, timed(45));
    expect(latestEntryFrame(FPS, 45)).toBe(30);
    expect(s.cps).toBeGreaterThan(TERMINAL_TYPE_CPS);
    expect(s.cps).toBeCloseTo(100, 3);
    expect(endSec(s)).toBeLessThanOrEqual(1.0 + 1e-9);
    const w = s.windows[0]!;
    expect(terminalLineState(w, command, 0, w.typeEndSec, s.cps).text).toBe(command);
  });

  it("holds everything to the entry limit when even instant typing cannot fit", () => {
    const command = "$ " + "x".repeat(38);
    const props = parse([{ lines: [command, "out"] }, { lines: ["$ ls", "out"] }], {
      badge: "+1",
    });
    const s = terminalTimeline(props, FPS, timed(20));
    const latest = latestEntryFrame(FPS, 20);
    expect(s.tail).toBeLessThanOrEqual(latest);
    expect(endSec(s)).toBeLessThanOrEqual(latest / FPS + 1e-9);
    for (const [i, w] of s.windows.entries()) {
      const line = props.windows[i]!.lines[w.typed!]!;
      // Whole by the limit: the command is never left half-typed at the cut.
      expect(terminalLineState(w, line, w.typed!, latest / FPS, s.cps).text).toBe(line);
    }
  });
});

describe("terminalLineState", () => {
  const command = "$ ossclip produce";
  const props = parse([{ lines: ["# before", command, "out-1", "out-2"] }]);
  const s = terminalTimeline(props, FPS);
  const w = s.windows[0]!;
  const at = (j: number, t: number) => terminalLineState(w, props.windows[0]!.lines[j]!, j, t, s.cps);

  it("shows the prompt from the entrance and the caret only once typing starts", () => {
    expect(at(1, 0.1)).toEqual({ text: "$ ", shown: true, caret: false });
    expect(at(1, w.typeStartSec)).toEqual({ text: "$ ", shown: true, caret: true });
    expect(at(1, w.typeStartSec + 4 / 32).text).toBe("$ ossc");
    expect(at(1, w.typeStartSec + 4 / 32).caret).toBe(true);
  });

  it("holds the caret for half a second after the last keystroke, then drops it", () => {
    expect(at(1, w.typeEndSec)).toEqual({ text: command, shown: true, caret: true });
    expect(at(1, w.typeEndSec + TERMINAL_CARET_HOLD_SEC - 0.01).caret).toBe(true);
    expect(at(1, w.typeEndSec + TERMINAL_CARET_HOLD_SEC).caret).toBe(false);
    expect(at(1, w.typeEndSec + 3).caret).toBe(false);
  });

  it("lands the output lines one by one after the typing, and never carets them", () => {
    expect(at(0, 0)).toEqual({ text: "# before", shown: true, caret: false });
    expect(at(2, w.typeEndSec - 0.01).shown).toBe(false);
    expect(at(2, w.typeEndSec).shown).toBe(true);
    expect(at(3, w.typeEndSec + 0.06).shown).toBe(false);
    expect(at(3, w.typeEndSec + TERMINAL_LINE_GAP_SEC).shown).toBe(true);
    expect(at(3, 9)).toEqual({ text: "out-2", shown: true, caret: false });
  });
});
