import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyRepairs, type AppliedRepair, type Transcript } from "@ossclip/core";
import {
  cacheKeyDictionary,
  confirmRepairs,
  decidedProposals,
  loadRepairDecisions,
  newDictionaryTerms,
  saveRepairDecisions,
  unseenProposals,
  type RepairDecision,
  type RepairPrompts,
} from "../src/interactive/repair-confirm";

const take: Transcript = {
  language: "en",
  words: ["I'm", "Esmeyaz.", "I", "use", "cloud", "daily"].map((text, i) => ({
    text,
    start: i * 0.5,
    end: (i + 1) * 0.5,
  })),
};

// What the gates decided on the 2026-11-04 field take, in miniature.
const gated: AppliedRepair[] = applyRepairs(take, [
  { startWord: 1, endWord: 1, heard: "Esmeyaz.", correction: "Ahsan Ayaz." },
  { startWord: 4, endWord: 4, heard: "cloud", correction: "Claude" },
]).applied;

/** A scripted prompt seam: the ticks to return, then one text answer per call. */
function scripted(ticks: string[], answers: string[] = []): RepairPrompts & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    multiselect: async () => ticks,
    text: async (o) => {
      asked.push(o.message);
      return answers.shift() ?? "";
    },
  };
}

describe("repair confirmation", () => {
  it("starts from the gates' verdicts — the refusal unticked, the repair ticked", async () => {
    expect(gated.map((r) => r.applied)).toEqual([false, true]);
    let seen: { initialValues: string[]; options: { hint?: string }[] } | undefined;
    await confirmRepairs(gated, {
      multiselect: async (o) => {
        seen = o;
        return o.initialValues;
      },
      text: async () => "",
    });
    expect(seen!.initialValues).toEqual(["1"]);
    expect(seen!.options[0]!.hint).toMatch(/^refused: .*does not sound like/);
  });

  it("enter on the untouched list reproduces the gates exactly", async () => {
    const p = scripted(["1"]);
    const decisions = await confirmRepairs(gated, p);
    const d = decidedProposals(gated, decisions);
    const out = applyRepairs(take, d.proposals, { confirmed: d.confirmed });
    expect(out.transcript.words.map((w) => w.text)).toEqual(
      applyRepairs(take, gated).transcript.words.map((w) => w.text),
    );
  });

  it("ticking a refusal applies it over the gate", async () => {
    const decisions = await confirmRepairs(gated, scripted(["0", "1"]));
    const d = decidedProposals(gated, decisions);
    const out = applyRepairs(take, d.proposals, { confirmed: d.confirmed });
    expect(out.transcript.words.map((w) => w.text)).toEqual([
      "I'm", "Ahsan", "Ayaz.", "I", "use", "Claude", "daily",
    ]);
  });

  it("unticking asks what was said; typed text replaces, empty keeps what was heard", async () => {
    const p = scripted([], ["Ahsan Ayaz.", ""]);
    const decisions = await confirmRepairs(gated, p);
    expect(p.asked).toHaveLength(2);
    const d = decidedProposals(gated, decisions);
    expect(d.dropped.map((r) => r.heard)).toEqual(["cloud"]);
    const out = applyRepairs(take, d.proposals, { confirmed: d.confirmed });
    expect(out.transcript.words.map((w) => w.text)).toEqual([
      "I'm", "Ahsan", "Ayaz.", "I", "use", "cloud", "daily",
    ]);
  });

  it("a re-run asks only about proposals it has not seen", () => {
    const decided: RepairDecision[] = [{ ...gated[0]!, keep: true }];
    expect(unseenProposals(gated, decided).map((r) => r.heard)).toEqual(["cloud"]);
  });

  it("typed corrections become dictionary terms, minus edge punctuation and duplicates", () => {
    const decisions: RepairDecision[] = [
      { ...gated[0]!, keep: false, said: "Ahsan Ayaz." },
      { ...gated[1]!, keep: false, said: "claude" },
      { ...gated[1]!, keep: false, said: "Cloud" }, // same as heard — no term
    ];
    expect(newDictionaryTerms(decisions, ["JSON", "Claude"])).toEqual(["Ahsan Ayaz"]);
  });

  it("the cache keys ignore terms this take added (keep today's transcript)", () => {
    expect(cacheKeyDictionary(["JSON", "Ahsan Ayaz"], ["Ahsan Ayaz"])).toEqual(["JSON"]);
  });

  it("round-trips the decisions file; a missing file reads as empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-repair-dec-"));
    const path = join(dir, "repair-decisions.json");
    expect(await loadRepairDecisions(path)).toEqual({ decisions: [], addedTerms: [] });
    const file = { decisions: [{ ...gated[0]!, keep: true }], addedTerms: ["Ahsan Ayaz"] };
    await saveRepairDecisions(path, {
      decisions: file.decisions.map(({ startWord, endWord, heard, correction, keep }) => ({
        startWord, endWord, heard, correction, keep,
      })),
      addedTerms: file.addedTerms,
    });
    const back = await loadRepairDecisions(path);
    expect(back.addedTerms).toEqual(["Ahsan Ayaz"]);
    expect(unseenProposals(gated, back.decisions)).toHaveLength(1);
  });
});
