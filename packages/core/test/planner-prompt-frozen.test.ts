import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  BeatSheetSchema,
  ClipBeatSheetSchema,
  buildBeatsUserPrompt,
  producerSystem,
  type Moment,
} from "../src/producer/beats";
import type { LlmProvider } from "../src/producer/provider";
import { generateScenes } from "../src/producer/scene-props";
import type { Transcript } from "../src/schema";

/**
 * G6 of the explainer plan (docs/designs/explainer-video-patterns.md): a run
 * without `--script` must hand every LLM the prompt and schema it gets today.
 * The registry is about to gain a component no planner may pick (ClipScene),
 * and every planner menu used to be `Object.entries(SCENE_REGISTRY)` — so a
 * new entry would have reached the model with no test noticing. These
 * snapshots were recorded on the code BEFORE ClipScene existed; a change to
 * any of them is a G6 break to fix, never a snapshot to update.
 */

const TRANSCRIPT: Transcript = {
  language: "en",
  words: "number one ship small diffs number two measure churn weekly"
    .split(" ")
    .map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4 })),
};

/**
 * Today's nine planner components, written out rather than read from the
 * registry or the enum: both are what is changing, and a test input derived
 * from them would change with them.
 */
const PLANNER_IDS = [
  "TitleCard",
  "StatCard",
  "RuleCard",
  "StrikethroughReveal",
  "FlowDiagram",
  "TerminalMock",
  "ChatMock",
  "ScreenshotFrame",
  "BulletList",
] as const;

describe("planner prompt and schema are frozen for runs without --script (G6)", () => {
  it("beat-sheet JSON schema", () => {
    expect(JSON.stringify(z.toJSONSchema(BeatSheetSchema))).toMatchInlineSnapshot(`"{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"hook":{"type":"string","maxLength":120},"coverText":{"description":"cover banner: at most 9 words, the hook compressed to a thumbnail headline","type":"string","maxLength":60},"moments":{"minItems":1,"maxItems":24,"type":"array","items":{"type":"object","properties":{"startWord":{"type":"integer","minimum":0,"maximum":9007199254740991},"endWord":{"type":"integer","minimum":0,"maximum":9007199254740991},"purpose":{"type":"string","maxLength":100},"onScreenCopy":{"type":"string","maxLength":60},"sceneKind":{"anyOf":[{"type":"string","enum":["TitleCard","StatCard","RuleCard","StrikethroughReveal","FlowDiagram","TerminalMock","ChatMock","ScreenshotFrame","BulletList"]},{"type":"string","const":"none"}]},"layout":{"description":"stage layout for this scene; omit for the component default. NEVER a layout the framing brief marks UNAVAILABLE for these words","type":"string","enum":["full-bleed","video-top","pip-bubble","graphic-only","blurred-behind","lower-third","split-left","split-right"]},"rationale":{"type":"string","maxLength":120},"cueWord":{"description":"word index where the graphic should appear — where its content is first said; omit if it is the moment's first word","type":"integer","minimum":0,"maximum":9007199254740991}},"required":["startWord","endWord","purpose","onScreenCopy","sceneKind"],"additionalProperties":false}}},"required":["hook","moments"],"additionalProperties":false}"`);
  });

  it("clip beat-sheet JSON schema (the --clip editorial call)", () => {
    expect(JSON.stringify(z.toJSONSchema(ClipBeatSheetSchema))).toMatchInlineSnapshot(`"{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"hook":{"type":"string","maxLength":120},"coverText":{"description":"cover banner: at most 9 words, the hook compressed to a thumbnail headline","type":"string","maxLength":60},"moments":{"minItems":1,"maxItems":24,"type":"array","items":{"type":"object","properties":{"startWord":{"type":"integer","minimum":0,"maximum":9007199254740991},"endWord":{"type":"integer","minimum":0,"maximum":9007199254740991},"purpose":{"type":"string","maxLength":100},"onScreenCopy":{"type":"string","maxLength":60},"sceneKind":{"anyOf":[{"type":"string","enum":["TitleCard","StatCard","RuleCard","StrikethroughReveal","FlowDiagram","TerminalMock","ChatMock","ScreenshotFrame","BulletList"]},{"type":"string","const":"none"}]},"layout":{"description":"stage layout for this scene; omit for the component default. NEVER a layout the framing brief marks UNAVAILABLE for these words","type":"string","enum":["full-bleed","video-top","pip-bubble","graphic-only","blurred-behind","lower-third","split-left","split-right"]},"rationale":{"type":"string","maxLength":120},"cueWord":{"description":"word index where the graphic should appear — where its content is first said; omit if it is the moment's first word","type":"integer","minimum":0,"maximum":9007199254740991}},"required":["startWord","endWord","purpose","onScreenCopy","sceneKind"],"additionalProperties":false}},"highlight":{"description":"the single contiguous window to produce — every moment above must lie inside it","type":"object","properties":{"startWord":{"type":"integer","minimum":0,"maximum":9007199254740991},"endWord":{"type":"integer","minimum":0,"maximum":9007199254740991},"reason":{"description":"one line: why THIS window is the strongest stretch of the take","type":"string","maxLength":200}},"required":["startWord","endWord","reason"],"additionalProperties":false}},"required":["hook","moments","highlight"],"additionalProperties":false}"`);
  });

  it("beat-sheet system prompt, both aspects", () => {
    expect(producerSystem("9:16")).toMatchInlineSnapshot(`
      "You are the producer for a short-form vertical video (Reels/Shorts/TikTok). You receive a word-indexed transcript of a talking-head take that has already been cut. Your job is EDITORIAL: segment the take into moments, pick which moments deserve a graphic scene, and write the on-screen copy.

      Virality grammar — follow these as hard policies:
      - The first moment is the hook: the strongest claim or number anywhere in the take, on screen within 2 seconds.
      - Pattern interrupts: alternate graphic moments with plain talking-head moments ("none") — never a wall of back-to-back graphics.
      - On-screen copy is SHORT: numbers over adjectives, verbs over descriptions, never full sentences.
      - Use contrast/negation beats (StrikethroughReveal, RuleCard with struck alternatives) when the speaker rejects an idea.
      - End with a payoff or takeaway moment.
      - A moment spans the FULL stretch of speech about its beat — typically 5-15 seconds — in transcript order, non-overlapping. The graphic stays on screen for the ENTIRE moment, so the word range must cover everything the graphic refers to: a stat card leaves when the speaker moves on, not before.
      - CUE: set \`cueWord\` to the word where the graphic's content is first said — the payoff phrase, not the start of the topic. The moment still spans the whole beat; only the graphic's entrance moves.
      - COUNT: the user prompt states how many graphic moments this take should get. That number is a TARGET, not a maximum — hit it. Planning under it is the most common failure: a take that makes five distinct points and gets two graphics has been under-produced, whatever the coverage percentage says.
      - COVERAGE: graphics should be on screen for roughly 40-50% of the runtime. A graphic spends its whole moment against that budget, so when the target implies many graphics, make each moment SHORTER rather than dropping moments — more, tighter graphics beats fewer, longer ones. Spread them evenly: never leave a stretch longer than ~10 seconds with no graphic.
      - VARIETY: never the same component twice in a row, and prefer a component you have NOT used yet in this video — reuse a treatment only when the beat genuinely calls for it. A repeat reads as a template.
      - Keep the face LARGE: prefer StatCard/RuleCard/ScreenshotFrame (they sit under a big face) over TitleCard (face becomes a small bubble); use FlowDiagram/TerminalMock sparingly — they remove the face entirely and only earn that when the graphic IS the point.
      - The transcript is ASR output and may contain mishearings: an unfamiliar proper noun is more likely a mistranscription of a common phrase than a real entity — write on-screen copy with the common-sense reading, never a suspected mishearing.
      - FRAMING: when the prompt carries a "Camera framing" brief, it is measured from the footage and is a HARD constraint: on words marked CLOSE, never choose a layout listed as UNAVAILABLE there — pick a \`layout\` that keeps the whole head in frame (pip-bubble, graphic-only, full-bleed) or leave the moment as "none". You may set \`layout\` on any moment; omit it to accept the component's default.
      - COVER: also write \`coverText\` — the hook compressed to a thumbnail headline, AT MOST 9 WORDS. It is read at a glance in a profile grid, so it must stand alone without the video: the claim or the number, no lead-in, no ellipsis."
    `);
    expect(producerSystem("16:9")).toMatchInlineSnapshot(`
      "You are the producer for a landscape video (YouTube). You receive a word-indexed transcript of a talking-head take that has already been cut. Your job is EDITORIAL: segment the take into moments, pick which moments deserve a graphic scene, and write the on-screen copy.

      Virality grammar — follow these as hard policies:
      - The first moment is the hook: the strongest claim or number anywhere in the take, on screen within 2 seconds.
      - Pattern interrupts: alternate graphic moments with plain talking-head moments ("none") — never a wall of back-to-back graphics.
      - On-screen copy is SHORT: numbers over adjectives, verbs over descriptions, never full sentences.
      - Use contrast/negation beats (StrikethroughReveal, RuleCard with struck alternatives) when the speaker rejects an idea.
      - End with a payoff or takeaway moment.
      - A moment spans the FULL stretch of speech about its beat — typically 5-15 seconds — in transcript order, non-overlapping. The graphic stays on screen for the ENTIRE moment, so the word range must cover everything the graphic refers to: a stat card leaves when the speaker moves on, not before.
      - CUE: set \`cueWord\` to the word where the graphic's content is first said — the payoff phrase, not the start of the topic. The moment still spans the whole beat; only the graphic's entrance moves.
      - COUNT: the user prompt states how many graphic moments this take should get. That number is a TARGET, not a maximum — hit it. Planning under it is the most common failure: a take that makes five distinct points and gets two graphics has been under-produced, whatever the coverage percentage says.
      - COVERAGE: graphics should be on screen for roughly 40-50% of the runtime. A graphic spends its whole moment against that budget, so when the target implies many graphics, make each moment SHORTER rather than dropping moments — more, tighter graphics beats fewer, longer ones. Spread them evenly: never leave a stretch longer than ~10 seconds with no graphic.
      - VARIETY: never the same component twice in a row, and prefer a component you have NOT used yet in this video — reuse a treatment only when the beat genuinely calls for it. A repeat reads as a template.
      - Keep the face LARGE: prefer StatCard/RuleCard/ScreenshotFrame (they sit under a big face) over TitleCard (face becomes a small bubble); use FlowDiagram/TerminalMock sparingly — they remove the face entirely and only earn that when the graphic IS the point.
      - The transcript is ASR output and may contain mishearings: an unfamiliar proper noun is more likely a mistranscription of a common phrase than a real entity — write on-screen copy with the common-sense reading, never a suspected mishearing.
      - FRAMING: when the prompt carries a "Camera framing" brief, it is measured from the footage and is a HARD constraint: on words marked CLOSE, never choose a layout listed as UNAVAILABLE there — pick a \`layout\` that keeps the whole head in frame (pip-bubble, graphic-only, full-bleed) or leave the moment as "none". You may set \`layout\` on any moment; omit it to accept the component's default.
      - COVER: also write \`coverText\` — the hook compressed to a thumbnail headline, AT MOST 9 WORDS. It is read at a glance in a profile grid, so it must stand alone without the video: the claim or the number, no lead-in, no ellipsis."
    `);
  });

  it("beat-sheet user prompt, with its component menu", () => {
    expect(buildBeatsUserPrompt(TRANSCRIPT, 30, undefined)).toMatchInlineSnapshot(`
      "Intent: make this clear, punchy and viral-worthy
      Output duration after the cut: 30.0s
      Graphic moments to plan: 4 — the speaker enumerates 2 points out loud, so each one earns its own graphic, plus a hook and a payoff.

      Scene components available (sceneKind values; "none" = talking head only):
      - TitleCard: The core claim or hook as big typography; use \`emphasis\` for a huge number or punch word.
      - StatCard: One striking metric (value like '+242%', '×3', '5s'); punchline in \`caption\`.
      - RuleCard: A prescriptive takeaway ('CAPACITY RULE / CAP ACTIVE AGENTS'); \`struck\` shows the rejected alternative.
      - StrikethroughReveal: Negation/contrast beat — big words over the blurred speaker. Strike EVERY line of the phrase the speaker negates, not just its tail — a half-struck claim reads as a typo. For wrong-vs-right lists, set mark: "cross"/"check" (✗/✓) per line instead.
      - FlowDiagram: A causal chain or pipeline as chips with arrows (TEAM → AI AGENTS → CHURN).
      - TerminalMock: Anything about running code/processes/agents — stylized terminal windows.
      - ChatMock: A quoted phrase or exchange as chat bubbles over the blurred speaker; for a comment-CTA beat, set \`keyword\` to the word viewers should type.
      - ScreenshotFrame: Reference to a document/PR/review — a framed screenshot look with a label chip.
      - BulletList: An ENUMERATION — the speaker lists two or more parallel things ('what you need is X, Y, Z'). One bullet per item, optional kicker title. Use this for lists instead of bending TitleCard or StrikethroughReveal around them.

      Word-indexed transcript (word indices refer to THIS list):
      [0]number [1]one [2]ship [3]small [4]diffs [5]number [6]two [7]measure [8]churn [9]weekly"
    `);
  });

  it("props call: the batched request for one moment of every planner component", async () => {
    // The props call does not read the registry for a menu, but it does show
    // each moment's component and props schema; freezing one moment per
    // planner id pins every props schema an LLM is ever shown.
    const moments: Moment[] = PLANNER_IDS.map((sceneKind, i) => ({
      startWord: i,
      endWord: i,
      purpose: `beat ${i}`,
      onScreenCopy: `COPY ${i}`,
      sceneKind,
    }));
    const calls: { system: string; user: string; schema: unknown; schemaName: string }[] = [];
    const provider: LlmProvider = {
      name: "recording",
      usage: [],
      async complete(req) {
        calls.push({
          system: req.system,
          user: req.user,
          schema: z.toJSONSchema(req.schema),
          schemaName: req.schemaName,
        });
        // Every call fails, so the run falls back and records each request.
        throw new Error("recording stub");
      },
    };
    await generateScenes(provider, moments, TRANSCRIPT);
    const batch = calls.find((c) => c.schemaName === "scene_props_batch")!;
    expect(batch.system).toMatchInlineSnapshot(`
      "You fill the props for ONE scene component of a short-form video, from the transcript slice it accompanies. Copy is SHORT and punchy: numbers over adjectives, ALL-CAPS reads fine for labels/kickers, never full sentences. Output only what the schema asks for.

      GROUNDING — hard rules:
      - Every label, noun and claim must be supported by the transcript slice. NEVER introduce an entity, metric name or brand the slice does not contain — a number gets the noun the speaker attached to it, not a plausible-sounding one. If the slice offers no supporting noun, use the number alone or fall back to the suggested copy verbatim.
      - The transcript is automatic speech recognition output and may contain mishearings. An unfamiliar proper noun is more likely a mistranscription of a common phrase than a real company or product — prefer the common-sense reading ("code churn", not "CodeChun") and never promote a suspected mishearing into a name or label."
    `);
    expect(batch.user).toMatchInlineSnapshot(`
      "Fill the props for EACH moment below. Reply with one entry per moment, echoing its index. Each entry's props must satisfy that moment's own schema.

      --- moment 0 ---
      Component: TitleCard
      Purpose of this moment: beat 0
      Suggested on-screen copy: COPY 0
      Transcript slice: "number"
      Props schema: {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"eyebrow":{"type":"string","maxLength":28},"title":{"description":"the claim WITHOUT the emphasis token — never repeat the emphasis here","type":"string","minLength":1,"maxLength":48},"emphasis":{"description":"the number/punch token pulled OUT of the title (e.g. '861%') — not a duplicate of it","type":"string","maxLength":16},"sub":{"type":"string","maxLength":64}},"required":["title"],"additionalProperties":false}

      --- moment 1 ---
      Component: StatCard
      Purpose of this moment: beat 1
      Suggested on-screen copy: COPY 1
      Transcript slice: "one"
      Props schema: {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"label":{"type":"string","minLength":1,"maxLength":28},"value":{"type":"string","minLength":1,"maxLength":12},"caption":{"type":"string","maxLength":40},"inverted":{"default":false,"type":"boolean"}},"required":["label","value","inverted"],"additionalProperties":false}

      --- moment 2 ---
      Component: RuleCard
      Purpose of this moment: beat 2
      Suggested on-screen copy: COPY 2
      Transcript slice: "ship"
      Props schema: {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"kicker":{"type":"string","minLength":1,"maxLength":24},"text":{"type":"string","minLength":1,"maxLength":40},"struck":{"type":"string","maxLength":40}},"required":["kicker","text"],"additionalProperties":false}

      --- moment 3 ---
      Component: StrikethroughReveal
      Purpose of this moment: beat 3
      Suggested on-screen copy: COPY 3
      Transcript slice: "small"
      Props schema: {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"lines":{"minItems":1,"maxItems":4,"type":"array","items":{"type":"object","properties":{"text":{"type":"string","minLength":1,"maxLength":32},"struck":{"default":false,"type":"boolean"},"mark":{"default":"none","type":"string","enum":["none","cross","check"]}},"required":["text","struck","mark"],"additionalProperties":false}}},"required":["lines"],"additionalProperties":false}

      --- moment 4 ---
      Component: FlowDiagram
      Purpose of this moment: beat 4
      Suggested on-screen copy: COPY 4
      Transcript slice: "diffs"
      Props schema: {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"nodes":{"minItems":2,"maxItems":5,"type":"array","items":{"type":"string","minLength":1,"maxLength":16}},"emphasizeLast":{"default":true,"type":"boolean"}},"required":["nodes","emphasizeLast"],"additionalProperties":false}

      --- moment 5 ---
      Component: TerminalMock
      Purpose of this moment: beat 5
      Suggested on-screen copy: COPY 5
      Transcript slice: "number"
      Props schema: {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"windows":{"minItems":1,"maxItems":5,"type":"array","items":{"type":"object","properties":{"title":{"type":"string","maxLength":24},"lines":{"minItems":1,"maxItems":6,"type":"array","items":{"type":"string","maxLength":40}}},"required":["title","lines"],"additionalProperties":false}},"fanOut":{"type":"string","maxLength":20}},"required":["windows"],"additionalProperties":false}

      --- moment 6 ---
      Component: ChatMock
      Purpose of this moment: beat 6
      Suggested on-screen copy: COPY 6
      Transcript slice: "two"
      Props schema: {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"messages":{"minItems":1,"maxItems":4,"type":"array","items":{"type":"object","properties":{"from":{"type":"string","enum":["user","agent"]},"text":{"type":"string","minLength":1,"maxLength":60}},"required":["from","text"],"additionalProperties":false}},"keyword":{"description":"ONLY for a 'comment <word>' ask: the single distinctive word the viewer types, plain and unformatted. Leave unset for any other CTA — especially 'reply with a number/which one', where there is no word to type. Never a referential filler like 'number', 'answer', 'comment' or 'below'.","type":"string","maxLength":16}},"required":["messages"],"additionalProperties":false}

      --- moment 7 ---
      Component: ScreenshotFrame
      Purpose of this moment: beat 7
      Suggested on-screen copy: COPY 7
      Transcript slice: "measure"
      Props schema: {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"src":{"description":"OMIT THIS unless the user supplied an actual image file beside the video — never invent a filename from the transcript; without it the frame renders as a styled placeholder, which is the intended look","type":"string"},"label":{"type":"string","maxLength":32},"kenBurns":{"default":true,"type":"boolean"}},"required":["kenBurns"],"additionalProperties":false}

      --- moment 8 ---
      Component: BulletList
      Purpose of this moment: beat 8
      Suggested on-screen copy: COPY 8
      Transcript slice: "churn"
      Props schema: {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"title":{"type":"string","maxLength":28},"items":{"minItems":2,"maxItems":5,"type":"array","items":{"type":"string","minLength":1,"maxLength":36}}},"required":["items"],"additionalProperties":false}"
    `);
    expect(JSON.stringify(batch.schema)).toMatchInlineSnapshot(`"{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"scenes":{"type":"array","items":{"type":"object","properties":{"index":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991},"props":{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{}}},"required":["index","props"],"additionalProperties":false}}},"required":["scenes"],"additionalProperties":false}"`);
    expect(calls.map((c) => c.schemaName)).toMatchInlineSnapshot(`
      [
        "scene_props_batch",
        "TitleCard_props",
        "TitleCard_props",
        "StatCard_props",
        "StatCard_props",
        "RuleCard_props",
        "RuleCard_props",
        "StrikethroughReveal_props",
        "StrikethroughReveal_props",
        "FlowDiagram_props",
        "FlowDiagram_props",
        "TerminalMock_props",
        "TerminalMock_props",
        "ChatMock_props",
        "ChatMock_props",
        "ScreenshotFrame_props",
        "ScreenshotFrame_props",
        "BulletList_props",
        "BulletList_props",
      ]
    `);
  });
});
