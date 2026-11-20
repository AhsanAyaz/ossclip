import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";
import type { LlmProvider } from "../src/producer/provider";
import { MockProvider } from "../src/producer/mock";
import {
  DRAW_ALLOWED_ELEMENTS,
  DRAW_ALLOWED_REMOTION,
  DRAW_FORBIDDEN_NAMES,
  DRAW_KIT_MODULE,
  DRAW_MAX_LINES,
  checkDrawnScene,
  type DrawIssue,
} from "../src/draw/static-check";
import {
  DRAW_NAMED_REJECTED_ELEMENTS,
  DrawReplySchema,
  drawPrompt,
  redrawPrompt,
  repairPrompt,
  type DrawRequest,
} from "../src/draw/prompt";
import { DRAW_MAX_REPAIRS, DRAW_MAX_TOKENS, drawShot, type DrawCheck } from "../src/draw/draw-shot";
import { DRAW_EXAMPLES, DRAW_EXAMPLE_CHARACTER, DRAW_EXAMPLE_KIT } from "../src/draw/examples";

/**
 * The draw call, its repair loop and the redraw (storyboard design §3, §5,
 * §6; plan Task 5; §167). The provider is scripted and the checks are a
 * stub, so this pins what the LLM is told and how failures are counted, with
 * no rendering and no filesystem.
 */

/**
 * The kit's importable names, written out here: core cannot import the
 * scenes package (scenes depends on core). apps/cli/test/draw-examples.test.ts
 * checks the examples against the real `DRAW_KIT_EXPORTS` and type-checks
 * them against the real kit.
 */
const KIT_EXPORTS = [
  "useSceneTime", "useTheme", "useFrameSize", "useSafeArea",
  "popScale", "easeInOut", "typedChars", "caretOn", "bobPx", "bump", "beatStarts", "parseCount", "countAt", "fadeIn", "riseIn",
  "Card", "Pill", "Sticker", "NumberBadge", "PhoneFrame", "Icon", "Asset",
];

const REQ: DrawRequest = {
  idea: "a goldfish forgets the plan halfway through reading it",
  spokenLine: "The goldfish reviews with fresh eyes.",
  durationSec: 4.5,
  width: 1080,
  height: 1920,
  kitReference: "// KIT REFERENCE SENTINEL\nexport declare function useSceneTime(): number;",
  assets: [
    { name: "egm-logo.png", width: 512, height: 256, note: "the Elephant-Goldfish Model logo" },
    { name: "plan.svg", width: 800, height: 600 },
  ],
};

const GOOD = "export default function Scene() { return null; }";
const BAD = "export default function Scene() { return <img />; }";
const ISSUE: DrawIssue = { line: 7, rule: "element", message: "<img> is not allowed; use div" };

type Reply = { code: string; said: string } | Error;
interface Call { system: string; user: string; schemaName: string; tier?: string; maxTokens?: number }

/** Answers each call with the next scripted reply; an Error is thrown, as a provider does for a cut-off or timed-out reply. */
function scripted(replies: Reply[]): { provider: LlmProvider; calls: Call[] } {
  const calls: Call[] = [];
  const provider: LlmProvider = {
    name: "scripted",
    usage: [],
    async complete<T>(req: { system: string; user: string; schema: z.ZodType<T>; schemaName: string; maxTokens?: number; tier?: "editorial" | "mechanical" }): Promise<T> {
      calls.push({ system: req.system, user: req.user, schemaName: req.schemaName, tier: req.tier, maxTokens: req.maxTokens });
      const next = replies[calls.length - 1];
      if (next === undefined) throw new Error("test bug: more calls than scripted replies");
      if (next instanceof Error) throw next;
      return req.schema.parse(next);
    },
  };
  return { provider, calls };
}

/** A check that fails exactly the code in `bad`. */
const checkFailing = (bad: string, issues: DrawIssue[] = [ISSUE]): DrawCheck => async (code) => (code === bad ? issues : []);

describe("drawShot: the repair loop", () => {
  it("a first reply that passes the check is one call, ok, one attempt", async () => {
    const { provider, calls } = scripted([{ code: GOOD, said: "a fish" }]);
    const result = await drawShot({ provider, req: REQ, check: checkFailing(BAD) });
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ ok: true, code: GOOD, said: "a fish", attempts: [{ code: GOOD, said: "a fish", issues: [] }] });
  });

  it("asks as the design says: schema drawn_scene, editorial tier, a token budget for a whole file", async () => {
    const { provider, calls } = scripted([{ code: GOOD, said: "a fish" }]);
    await drawShot({ provider, req: REQ, check: checkFailing(BAD) });
    expect(calls[0]).toMatchObject({ schemaName: "drawn_scene", tier: "editorial", maxTokens: DRAW_MAX_TOKENS });
    // The API providers' own ceiling (design §3): asking for more would not be honoured.
    expect(DRAW_MAX_TOKENS).toBeLessThanOrEqual(16000);
  });

  it("issues on the first reply go back: the second call quotes the line, the rule, the message and the first code", async () => {
    const { provider, calls } = scripted([
      { code: BAD, said: "first" },
      { code: GOOD, said: "second" },
    ]);
    const result = await drawShot({ provider, req: REQ, check: checkFailing(BAD) });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.user).toContain("line 7 (element): <img> is not allowed; use div");
    expect(calls[1]!.user).toContain(BAD);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(GOOD);
    expect(result.said).toBe("second");
    expect(result.attempts.map((a) => a.issues)).toEqual([[ISSUE], []]);
  });

  it("three failing replies are three calls and ok: false with every attempt, without throwing", async () => {
    const { provider, calls } = scripted([
      { code: BAD, said: "one" },
      { code: BAD, said: "two" },
      { code: BAD, said: "three" },
    ]);
    const result = await drawShot({ provider, req: REQ, check: checkFailing(BAD) });
    expect(DRAW_MAX_REPAIRS).toBe(2);
    expect(calls).toHaveLength(1 + DRAW_MAX_REPAIRS);
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.every((a) => a.issues.length === 1)).toBe(true);
    // The last code is kept, so the failed version can be written and read.
    expect(result.code).toBe(BAD);
    expect(result.said).toBe("three");
  });

  it("a provider that throws (cut off at the token limit) is one attempt, repaired with a request for a shorter scene that quotes the error (Review Focus 3)", async () => {
    const { provider, calls } = scripted([new Error("claude output truncated at max_tokens"), { code: GOOD, said: "short" }]);
    const result = await drawShot({ provider, req: REQ, check: checkFailing(BAD) });
    expect(calls).toHaveLength(2);
    expect(result.ok).toBe(true);
    expect(result.attempts[0]).toEqual({ code: null, said: null, issues: [], error: "claude output truncated at max_tokens" });
    expect(calls[1]!.user).toContain("claude output truncated at max_tokens");
    expect(calls[1]!.user).toMatch(/shorter/);
  });

  it("a provider that throws on every call (timeout) is ok: false with three attempts and no code, not a throw", async () => {
    const timeout = () => new Error("agy: timeout waiting for response");
    const { provider, calls } = scripted([timeout(), timeout(), timeout()]);
    const result = await drawShot({ provider, req: REQ, check: checkFailing(BAD) });
    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({ ok: false, code: null, said: null });
    expect(result.attempts.map((a) => a.error)).toEqual(Array(3).fill("agy: timeout waiting for response"));
  });

  it("a failing reply after a provider error keeps the last code as the result", async () => {
    const { provider } = scripted([{ code: BAD, said: "drawn" }, new Error("cut off"), new Error("cut off")]);
    const result = await drawShot({ provider, req: REQ, check: checkFailing(BAD) });
    expect(result).toMatchObject({ ok: false, code: BAD, said: "drawn" });
  });

  it("a check that throws is an ossclip fault and propagates", async () => {
    const { provider } = scripted([{ code: GOOD, said: "x" }]);
    const check: DrawCheck = async () => {
      throw new Error("the ossclip install is incomplete");
    };
    await expect(drawShot({ provider, req: REQ, check })).rejects.toThrow("the ossclip install is incomplete");
  });

  it("a redraw's first call carries the current code, every earlier note in order, then the new note", async () => {
    const { provider, calls } = scripted([{ code: GOOD, said: "redrawn" }]);
    const redraw = {
      code: "// CURRENT CODE SENTINEL\nexport default function Scene() { return null; }",
      notes: [{ text: "make the fish orange" }, { text: "slower tail" }],
      note: { text: "add a speech bubble" },
    };
    const result = await drawShot({ provider, req: REQ, check: checkFailing(BAD), redraw });
    expect(result.ok).toBe(true);
    const user = calls[0]!.user;
    expect(user).toContain(redraw.code);
    expect(user).toContain(REQ.idea);
    const [a, b, c] = ["make the fish orange", "slower tail", "add a speech bubble"].map((s) => user.indexOf(s));
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a!);
    expect(c).toBeGreaterThan(b!);
  });

  it("a stop asked for before the first call makes no call: ok false, stopped (§169)", async () => {
    const { provider, calls } = scripted([{ code: GOOD, said: "never" }]);
    const result = await drawShot({ provider, req: REQ, check: checkFailing(BAD), shouldStop: () => true });
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, stopped: true, attempts: [] });
  });

  it("a stop asked for after the first failed check ends the draw before the repair call (§169)", async () => {
    const { provider, calls } = scripted([
      { code: BAD, said: "one" },
      { code: GOOD, said: "two" },
    ]);
    let checked = 0;
    const check: DrawCheck = async (code) => {
      checked += 1;
      return checkFailing(BAD)(code);
    };
    const result = await drawShot({ provider, req: REQ, check, shouldStop: () => checked > 0 });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, stopped: true, code: BAD, said: "one" });
    expect(result.attempts).toHaveLength(1);
  });

  it("a draw never told to stop has no stopped field", async () => {
    const { provider } = scripted([{ code: GOOD, said: "a fish" }]);
    const result = await drawShot({ provider, req: REQ, check: checkFailing(BAD), shouldStop: () => false });
    expect(result.ok).toBe(true);
    expect("stopped" in result).toBe(false);
  });

  it("a redraw whose reply is cut off keeps the note and the current code in the repair", async () => {
    const { provider, calls } = scripted([new Error("claude output truncated at max_tokens"), { code: GOOD, said: "ok" }]);
    const redraw = { code: "// CURRENT CODE SENTINEL", notes: [], note: { text: "add a speech bubble" } };
    await drawShot({ provider, req: REQ, check: checkFailing(BAD), redraw });
    expect(calls[1]!.user).toContain("add a speech bubble");
    expect(calls[1]!.user).toContain("// CURRENT CODE SENTINEL");
    expect(calls[1]!.user).toMatch(/shorter/);
  });
});

describe("drawPrompt", () => {
  const { system, user } = drawPrompt(REQ);
  const all = `${system}\n${user}`;

  it("contains the idea, the spoken line, the duration, the frame size, the kit reference and each asset", () => {
    expect(all).toContain(REQ.idea);
    expect(all).toContain(REQ.spokenLine);
    expect(all).toContain("4.5 seconds");
    expect(all).toContain("1080 x 1920");
    expect(all).toContain(REQ.kitReference);
    for (const a of REQ.assets) {
      expect(all).toContain(a.name);
      expect(all).toContain(`${a.width} x ${a.height}`);
    }
    expect(all).toContain("the Elephant-Goldfish Model logo");
  });

  it("says so when there are no assets", () => {
    const none = drawPrompt({ ...REQ, assets: [] }).user;
    expect(none).toMatch(/no assets/i);
  });

  it("contains both examples, whole", () => {
    expect(system).toContain(DRAW_EXAMPLE_KIT);
    expect(system).toContain(DRAW_EXAMPLE_CHARACTER);
  });

  it("states the reply shape and the file shape", () => {
    expect(system).toContain("code");
    expect(system).toContain("said");
    expect(system).toContain("export default function Scene({ durationSec }: { durationSec: number })");
  });

  it("states each rule of design section 3", () => {
    expect(system).toMatch(/transparent/i);
    expect(system).toMatch(/pure function of time/i);
    expect(system).toMatch(/Math\.random/);
    expect(system).toMatch(/clock/i);
    expect(system).toMatch(/timer/i);
    expect(system).toMatch(/fractions? of durationSec/);
    expect(system).toContain("beatStarts");
    expect(system).toMatch(/holds? to the end/);
    expect(system).toContain("theme.fontDisplay");
    expect(system).toMatch(/palette/);
    expect(system).toMatch(/own colours/);
    expect(system).toContain("useSafeArea");
    expect(system).toMatch(/safe area/);
    expect(system).toContain(`${DRAW_MAX_LINES} lines`);
    expect(system).toMatch(/three backticks/);
    // The rule is stated without writing the run itself: the command-line
    // provider strips it from what it sends back, and the prompt must not
    // model it either.
    expect(system).not.toContain("```");
  });

  it("asks for a drawing, not a card with text", () => {
    expect(system).toMatch(/draw/i);
    expect(system).toMatch(/SVG paths/);
    expect(system).toMatch(/card with text/);
  });

  it("explains why: frames render out of order, and the code is machine-checked first", () => {
    expect(system).toMatch(/out of order/);
    expect(system).toMatch(/checked/);
  });

  it("writes no all-caps emphasis", () => {
    // Words of four or more capitals outside the code (examples, kit text and
    // the shot data are what the prompt quotes, not what it says).
    const prose = system.replace(DRAW_EXAMPLE_KIT, "").replace(DRAW_EXAMPLE_CHARACTER, "").replace(REQ.kitReference, "");
    const acronyms = new Set(["JSON", "HTML"]);
    expect((prose.match(/\b[A-Z]{4,}\b/g) ?? []).filter((w) => !acronyms.has(w))).toEqual([]);
  });
});

describe("drawPrompt and the static check agree (no drift)", () => {
  const { system } = drawPrompt(REQ);

  it("lists every allowed element, remotion name and rejected name from the check's own constants", () => {
    for (const el of DRAW_ALLOWED_ELEMENTS) expect(system).toContain(el);
    for (const name of DRAW_ALLOWED_REMOTION) expect(system).toContain(name);
    for (const name of DRAW_FORBIDDEN_NAMES) expect(system).toContain(name);
    expect(system).toContain(DRAW_KIT_MODULE);
  });

  it("every element the prompt names as rejected is rejected by the check", () => {
    expect(DRAW_NAMED_REJECTED_ELEMENTS.length).toBeGreaterThan(0);
    for (const el of DRAW_NAMED_REJECTED_ELEMENTS) {
      expect(system).toContain(el);
      const code = `export default function Scene() { return <${el} />; }`;
      expect(checkDrawnScene(code, KIT_EXPORTS).map((i) => i.rule)).toContain("element");
    }
  });

  it("the practical consequences it states hold in the check: style keys named top pass, a read of .top, xmlns and a non-local url fail", () => {
    const wrap = (body: string, jsx: string) =>
      `export default function Scene() {\n  const area = { x: 1, y: 2 };\n${body}\n  return ${jsx};\n}`;
    expect(checkDrawnScene(wrap("", "<div style={{ top: 10 }} />"), KIT_EXPORTS)).toEqual([]);
    expect(checkDrawnScene(wrap("", '<svg><rect fill="url(#grad)" /></svg>'), KIT_EXPORTS)).toEqual([]);
    expect(checkDrawnScene(wrap("  const y = (area as any).top;", "<div />"), KIT_EXPORTS).map((i) => i.rule)).toEqual(["name"]);
    expect(checkDrawnScene(wrap("", '<svg xmlns="http://www.w3.org/2000/svg" />'), KIT_EXPORTS).map((i) => i.rule)).toEqual(["string"]);
    expect(checkDrawnScene(wrap("", '<div style={{ background: "url(a.png)" }} />'), KIT_EXPORTS).map((i) => i.rule)).toEqual(["string"]);
    expect(system).toContain("xmlns");
    expect(system).toContain("url(#");
    expect(system).toContain("style={{ top:");
  });
});

describe("repairPrompt", () => {
  it("quotes the previous code and each issue as line N (rule): message", () => {
    const issues: DrawIssue[] = [
      { line: 3, rule: "import", message: '"node:fs" cannot be imported' },
      { line: 12, rule: "type", message: "Property 'titel' does not exist (TS2322)" },
    ];
    const { system, user } = repairPrompt(REQ, { code: BAD, issues });
    expect(system).toBe(drawPrompt(REQ).system);
    expect(user).toContain(BAD);
    expect(user).toContain('line 3 (import): "node:fs" cannot be imported');
    expect(user).toContain("line 12 (type): Property 'titel' does not exist (TS2322)");
    // The shot is restated: every call stands alone.
    expect(user).toContain(REQ.idea);
  });

  it("caps each issue message at 400 characters with an ellipsis", () => {
    const long = "x".repeat(1000);
    const { user } = repairPrompt(REQ, { code: BAD, issues: [{ line: 1, rule: "type", message: long }] });
    const line = user.split("\n").find((l) => l.includes("line 1 (type): "))!;
    const message = line.slice(line.indexOf("line 1 (type): ") + "line 1 (type): ".length);
    expect(message).toHaveLength(400);
    expect(message.endsWith("…")).toBe(true);
  });

  it("for a provider error there is no code: it says what happened, caps the error at 300 characters and asks for a shorter, simpler scene", () => {
    const error = `claude output truncated at max_tokens ${"y".repeat(600)}`;
    const { user } = repairPrompt(REQ, { code: null, issues: [], error });
    expect(user).toContain("claude output truncated at max_tokens");
    expect(user).not.toContain("y".repeat(300));
    expect(user).toContain(`${error.slice(0, 299)}…`);
    expect(user).toMatch(/shorter/);
    expect(user).toMatch(/simpler/);
    expect(user).not.toMatch(/previous code/i);
  });
});

describe("redrawPrompt", () => {
  it("has the idea, the current code, the earlier notes in order and the new note, and asks for the whole file with the rest kept", () => {
    const { system, user } = redrawPrompt(REQ, {
      code: "// CURRENT",
      notes: [{ text: "first note" }, { text: "second note" }],
      note: { text: "new note" },
    });
    expect(system).toBe(drawPrompt(REQ).system);
    expect(user).toContain(REQ.idea);
    expect(user).toContain("// CURRENT");
    expect(user.indexOf("first note")).toBeLessThan(user.indexOf("second note"));
    expect(user.indexOf("second note")).toBeLessThan(user.indexOf("new note"));
    expect(user).toMatch(/whole file/);
    expect(user).toMatch(/keep/i);
  });
});

describe("the worked examples", () => {
  it.each([
    ["kit parts with timed beats", DRAW_EXAMPLE_KIT],
    ["a character drawn in SVG", DRAW_EXAMPLE_CHARACTER],
  ])("%s passes checkDrawnScene", (_name, code) => {
    expect(checkDrawnScene(code, KIT_EXPORTS)).toEqual([]);
  });

  it("each is 60 to 140 lines, reads time and the safe area, and has a description", () => {
    expect(DRAW_EXAMPLES).toHaveLength(2);
    for (const ex of DRAW_EXAMPLES) {
      const lines = ex.code.trimEnd().split("\n").length;
      expect(lines).toBeGreaterThanOrEqual(60);
      expect(lines).toBeLessThanOrEqual(140);
      expect(ex.code).toContain("useSceneTime()");
      expect(ex.code).toContain("useTheme()");
      expect(ex.code).toMatch(/useSafeArea\(\)|useFrameSize\(\)/);
      expect(ex.code).not.toMatch(/Math\.random|Date|performance/);
      expect(ex.description.split("\n")).toHaveLength(1);
    }
  });
});

describe("the mock provider", () => {
  it("answers drawn_scene with the character example", async () => {
    const mock = new MockProvider();
    const reply = await mock.complete({ ...drawPrompt(REQ), schema: DrawReplySchema, schemaName: "drawn_scene" });
    expect(reply.code).toBe(DRAW_EXAMPLE_CHARACTER);
    expect(reply.said.length).toBeGreaterThan(0);
  });
});
