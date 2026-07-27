import { describe, expect, it } from "vitest";
import { checkGrounding } from "../src/grounding";
import type { Scene } from "../src/scene-schema";
import type { Transcript } from "../src/schema";

const takeWords =
  "our code churn went up 861 percent when teams went all in on agents".split(" ");
const transcript: Transcript = {
  language: "en",
  words: takeWords.map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4 })),
};

const scene = (component: Scene["component"], props: Record<string, unknown>): Scene => ({
  id: "s0",
  anchor: { startWord: 0, endWord: takeWords.length - 1 },
  layout: "video-top",
  component,
  props,
  overrides: {},
});

describe("checkGrounding (FINDINGS §14a)", () => {
  it("flags the invented hook label from the v3 render", () => {
    const issues = checkGrounding(
      [scene("StatCard", { label: "CODECHUN REVENUE", value: "861%" })],
      transcript,
    );
    const tokens = issues.map((i) => i.token).sort();
    expect(tokens).toEqual(["codechun", "revenue"]);
  });

  it("stops fighting the repair pass once the transcript is repaired (§17)", () => {
    // §17 was this check calling a correct repair a fabrication: the take was
    // transcribed as "coach and", the producer wrote "code churn", and both
    // its words were flagged. Repairing the transcript first — rather than
    // teaching this check to guess — removes the conflict at its source.
    const raw: Transcript = {
      language: "en",
      words: "our coach and went up 861 percent".split(" ").map((text, i) => ({
        text,
        start: i * 0.5,
        end: i * 0.5 + 0.4,
      })),
    };
    const repaired: Transcript = {
      language: "en",
      words: "our code churn went up 861 percent".split(" ").map((text, i) => ({
        text,
        start: i * 0.5,
        end: i * 0.5 + 0.4,
      })),
    };
    const label = scene("StatCard", { label: "CODE CHURN", value: "861%" });
    expect(checkGrounding([label], raw).map((i) => i.token).sort()).toEqual(["churn", "code"]);
    expect(checkGrounding([label], repaired)).toEqual([]);
  });

  it("passes labels that reuse the take's own nouns (numbers/stopwords exempt)", () => {
    const issues = checkGrounding(
      [scene("StatCard", { label: "CODE CHURN", value: "+861%", caption: "ALL IN ON AGENTS" })],
      transcript,
    );
    expect(issues).toEqual([]);
  });

  it("tolerates simple plural/singular drift", () => {
    const issues = checkGrounding([scene("RuleCard", { kicker: "AGENT RULE", text: "GO ALL IN" })], transcript);
    expect(issues).toEqual([]);
  });

  it("checks nested string arrays (FlowDiagram nodes)", () => {
    const issues = checkGrounding(
      [scene("FlowDiagram", { nodes: ["TEAMS", "AGENTS", "1 DONE BAR"] })],
      transcript,
    );
    expect(issues.map((i) => i.token)).toEqual(["bar"]);
  });

  it("leaves conversational components alone — chat copy is invented by design", () => {
    const issues = checkGrounding(
      [scene("ChatMock", { messages: [{ from: "user", text: "totally fabricated question?" }] })],
      transcript,
    );
    expect(issues).toEqual([]);
  });

  it("user overrides are checked too — they render just the same", () => {
    const s = scene("StatCard", { label: "CODE CHURN", value: "861%" });
    s.overrides = { label: "MONETIZATION" };
    const issues = checkGrounding([s], transcript);
    expect(issues.map((i) => i.token)).toEqual(["monetization"]);
  });
});
