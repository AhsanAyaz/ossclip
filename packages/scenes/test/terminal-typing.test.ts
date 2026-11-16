import { describe, expect, it } from "vitest";
import { TerminalMockProps } from "@ossclip/core/browser";
import {
  TERMINAL_CARET_HOLD_SEC,
  TERMINAL_LINE_GAP_SEC,
  TERMINAL_TYPE_CPS,
  isTypedLine,
  terminalDelays,
  typedLineIndex,
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

  it("types a line without a prompt mark from its first character", () => {
    // The acceptance run's window (§161): a slash command, no `$ `.
    expect(typedLineText("/egm:egm-brainstorm", 0)).toBe("");
    expect(typedLineText("/egm:egm-brainstorm", -1)).toBe("");
    expect(typedLineText("/egm:egm-brainstorm", 0.125)).toBe("/egm");
    expect(typedLineText("/egm:egm-brainstorm", 9)).toBe("/egm:egm-brainstorm");
    // "$no-space" has no mark, so its "$n" is typed, not printed.
    expect(typedLineText("$no-space", 1 / TERMINAL_TYPE_CPS)).toBe("$");
  });
});

describe("typedLineIndex", () => {
  it("is the first prompt line, else line 0", () => {
    expect(typedLineIndex(["# first", "$ ls", "> help"])).toBe(1);
    expect(typedLineIndex(["/egm:egm-brainstorm", "Initial Critique & Risks"])).toBe(0);
    expect(typedLineIndex(["▸ a"])).toBe(0);
    expect(typedLineIndex([])).toBeNull();
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
    // Window 2 has no prompt line: it types its line 0, once window 1 has typed.
    const gate2 = Math.ceil(s.windows[1]!.typeEndSec * FPS);
    expect(s.windows[2]!.enterFrame).toBe(Math.max(12 + (gate - 6), gate2));
    expect(s.windows[2]!.typed).toBe(0);
    expect(s.windows[2]!.lineAtSec).toEqual([s.windows[2]!.enterFrame / FPS]);
  });

  it("types line 0 of a window with no prompt line, every character of it", () => {
    // The acceptance run's window (§161): without this rule nothing typed.
    const props = parse([{ lines: ["/egm:egm-brainstorm", "Initial Critique & Risks", "3 risks found"] }]);
    const s = terminalTimeline(props, FPS);
    const w = s.windows[0]!;
    expect(w.typed).toBe(0);
    expect(w.typeStartSec).toBeCloseTo(0.5, 9);
    // 19 characters at 32 cps: no two-character mark is taken off.
    expect(w.typeEndSec).toBeCloseTo(0.5 + 19 / 32, 9);
    expect(w.lineAtSec[0]).toBe(0);
    expect(w.lineAtSec[1]).toBeCloseTo(w.typeEndSec, 9);
    expect(w.lineAtSec[2]).toBeCloseTo(w.typeEndSec + TERMINAL_LINE_GAP_SEC, 9);
  });

  it("types every window exactly once, so no window is left static", () => {
    const props = parse([{ lines: ["▸ a"] }, { lines: ["▸ b", "$ ls"] }], { fanOut: "OUT" });
    const s = terminalTimeline(props, FPS);
    expect(s.windows.map((w) => w.typed)).toEqual([0, 1]);
    // Window 2 waits for window 1's three keystrokes.
    expect(s.windows[1]!.enterFrame).toBe(Math.ceil((0.5 + 3 / 32) * FPS));
    expect(s.tail).toBeGreaterThan(terminalDelays(props, FPS).tail);
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

describe("terminalLineState: a line without a prompt mark", () => {
  const line = "/egm:egm-brainstorm";
  const s = terminalTimeline(parse([{ lines: [line, "Initial Critique & Risks"] }]), FPS);
  const w = s.windows[0]!;
  const at = (t: number) => terminalLineState(w, line, 0, t, s.cps);

  it("is empty but laid out from the entrance, then types from its first character", () => {
    expect(at(0.1)).toEqual({ text: "", shown: true, caret: false });
    expect(at(w.typeStartSec)).toEqual({ text: "", shown: true, caret: true });
    expect(at(w.typeStartSec + 4 / 32).text).toBe("/egm");
    expect(at(w.typeEndSec)).toEqual({ text: line, shown: true, caret: true });
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
