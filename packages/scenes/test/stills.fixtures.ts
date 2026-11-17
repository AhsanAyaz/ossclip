import type { Layout, SceneComponentId } from "@ossclip/core/browser";
import { SCRIPT_LANDSCAPE_RECT } from "@ossclip/core";

/**
 * What `pnpm stills` renders (plan Task 3; scripts/render-scene-stills.ts).
 * Each fixture is drawn in 16:9 and 9:16 at every `atSec`, in the explainer
 * theme over the look's slate background, and written to `__stills__/` as
 * `<component>-<name>-<16x9|9x16>-<atSec>s.png`. The stills are committed
 * for the author to look at, not compared (plan decision 6).
 *
 * Props are parsed by the component's registry schema before rendering, so a
 * fixture must be props a planner could produce. Pattern components add one
 * sparse and one dense fixture each (the Task 4 checklist, item 9): the
 * dense one at every field's maximum length and count.
 *
 * Not a test file (no `.test.`), so vitest does not collect it; the shape is
 * restated in renderer's `StillFixture`, which this must stay assignable to.
 */
export interface StillFixture {
  component: SceneComponentId;
  name: string;
  props: unknown;
  /** Seconds into the scene to photograph; the scene runs to max + 2 s. */
  atSec: number[];
  /** Defaults to the component's registry `defaultLayout`. */
  layout?: Layout;
  /** The cue's own slot, frame fractions (a 16:9 script run's `SCRIPT_LANDSCAPE_RECT`, §161). */
  graphicRect?: { x: number; y: number; w: number; h: number };
  /** The frames to draw; both when absent. */
  aspects?: ("16x9" | "9x16")[];
}

export const STILL_FIXTURES: StillFixture[] = [
  // The harness's own check: an existing component, settled (its entrance
  // springs take 0.5 s and the caption starts 6 frames later). The text
  // carries 1s on purpose — Inter's 1 has a flag and no foot, Arial's has a
  // foot — so the still shows at a glance whether the bundled font loaded.
  {
    component: "StatCard",
    name: "settled",
    props: { label: "Stars in 11 days", value: "+1,214", caption: "From 1 launch post" },
    atSec: [1.5],
  },
  // CardRow (plan Task 4). No word timings in a still, so the cards build at
  // `beatStarts`: 0.25, 0.95, 1.65, 2.35 s, each popping for 0.35 s. Sparse
  // at 0.4 s catches the first card mid-pop; dense at 1.8 s has two cards
  // settled, the third mid-overshoot and the fourth not yet in. Settled is
  // after the last pop AND the highlight's bump (last start + 0.35 + 0.3).
  {
    component: "CardRow",
    name: "sparse",
    props: { cards: [{ text: "Draft" }, { text: "Review" }] },
    atSec: [0.4, 1.5],
  },
  {
    component: "CardRow",
    name: "dense",
    // Every cap: 18-character titles, 24-character sub-lines, four cards,
    // an icon on each, and the highlight on the third.
    props: {
      cards: [
        { text: "WRITE THE TESTS OK", sub: "pnpm vitest run --watch!", icon: "check" },
        { text: "MEASURE EVERY RUN!", sub: "tokens, seconds and cost", icon: "bolt" },
        { text: "Review the diff ok", sub: "git diff main...HEAD -w!", icon: "code" },
        { text: "Ship it on Monday!", sub: "npm publish --tag latest", icon: "terminal" },
      ],
      highlight: 2,
    },
    atSec: [1.8, 3.5],
  },
  // CtaCard (plan Task 5): one sparse and one dense fixture per action, at
  // 30% and 90% of a 6 s scene. The harness runs a scene to max(atSec) + 2 s
  // (7.4 s), not 6 s, which moves only the Subscribe press (60%: 4.44 s
  // rather than 3.6 s) — both still before 5.4 s and after 1.8 s, so each
  // still shows the state a 6 s cue would. At 1.8 s a comment is fully
  // typed (16 characters by 1.0 s, 40 by 1.75 s) with its caret in the
  // blink's on half; at 5.4 s Subscribe reads "Subscribed". Dense is every
  // cap at once: text 40, keyword 16, channel 24, in capitals.
  {
    component: "CtaCard",
    name: "comment-sparse",
    props: { action: "comment", text: "Want the prompt?", keyword: "PROMPT" },
    atSec: [1.8, 5.4],
  },
  {
    component: "CtaCard",
    name: "comment-dense",
    props: {
      action: "comment",
      text: "COMMENT THE WORD BELOW TO GET MY PROMPT!",
      keyword: "COMMENTPROMPTNOW",
      channel: "THE MIDNIGHT COMPILER!!!",
    },
    atSec: [1.8, 5.4],
  },
  {
    component: "CtaCard",
    name: "subscribe-sparse",
    props: { action: "subscribe", text: "Subscribe for more" },
    atSec: [1.8, 5.4],
  },
  {
    component: "CtaCard",
    name: "subscribe-dense",
    props: {
      action: "subscribe",
      text: "SUBSCRIBE FOR ONE NEW AGENT TRICK WEEKLY",
      keyword: "COMMENTPROMPTNOW",
      channel: "THE MIDNIGHT COMPILER!!!",
    },
    atSec: [1.8, 5.4],
  },
  {
    component: "CtaCard",
    name: "link-sparse",
    props: { action: "link", text: "Grab the template", keyword: "ossclip.dev" },
    atSec: [1.8, 5.4],
  },
  {
    component: "CtaCard",
    name: "link-dense",
    props: {
      action: "link",
      text: "GET THE FULL TEMPLATE FREE AT THIS LINK:",
      keyword: "ossclip.dev/tmpl",
      channel: "THE MIDNIGHT COMPILER!!!",
    },
    atSec: [1.8, 5.4],
  },
  // BugCard (plan Task 6), at 1.6 s and 5.4 s. The harness runs a scene to
  // max(atSec) + 2 s (7.4 s), so the build is: badge 0.25 s, headline 0.55,
  // sub 0.95, mock 1.35 (mid-pop at 1.6), fault 1.95, sticker at two thirds
  // of 7.4 s (4.93 s, bumped by 5.23) — at 5.4 s everything has settled.
  // 9:16 draws no mock. The caption fixtures have four entries, the schema's
  // most (`mockLines` max 4, `mockWrong` max 3).
  {
    component: "BugCard",
    name: "none-sparse",
    props: { number: 1, headline: "Captions drift" },
    atSec: [1.6, 5.4],
  },
  {
    component: "BugCard",
    name: "caption-clipped-dense",
    // Every text cap: headline 40, sub 40, sticker 14; the last caption
    // word runs off the panel's edge.
    props: {
      number: 3,
      headline: "WHISPER DROPS THE LAST WORD OF EVERY CUT",
      sub: "and the one it drops is the one you need",
      mock: "caption",
      mockLines: ["Claude", "wrote", "the", "migration"],
      mockWrong: 3,
      mockFault: "clipped",
      sticker: "WATCH THE EDGE",
    },
    atSec: [1.6, 5.4],
  },
  {
    component: "BugCard",
    name: "caption-struck",
    props: {
      number: 2,
      headline: "Captions mishear names",
      sub: "and viewers notice",
      mock: "caption",
      mockLines: ["Ask", "Cloud", "to", "refactor"],
      mockWrong: 1,
    },
    atSec: [1.6, 5.4],
  },
  {
    component: "BugCard",
    name: "lines-dense",
    // Four lines at the 32-character cap, the third one wrong.
    props: {
      number: 4,
      headline: "Retries hide the real failure",
      sub: "and the log says nothing",
      mock: "lines",
      mockLines: [
        "const plan = await agent.plan();",
        "for (const step of plan.steps) {",
        "  await run(step, { retry: 0 });",
        "} // no retry, no log, no trace!",
      ],
      mockWrong: 2,
      sticker: "NO RETRY LOOP!",
    },
    atSec: [1.6, 5.4],
  },
  // PhoneDemo (plan Task 7), at 1.2 s and 4.5 s. No word timings in a
  // still, so the phone pops at 0.25 s (settled 0.6), the emphasis boxes pop
  // at 0.75, and the pills build from 0.75 s every 0.7 s: at 1.2 s one pill
  // is in and the second not yet; at 4.5 s everything has settled and the
  // phone is mid-bob. Dense is every cap: six 12-character words (two
  // emphasised) and four 22-character pills, in capitals.
  {
    component: "PhoneDemo",
    name: "sparse",
    props: { caption: [{ text: "YOUR" }, { text: "CAPTIONS", emphasis: "yellow" }] },
    atSec: [1.2, 4.5],
  },
  {
    component: "PhoneDemo",
    name: "typical",
    props: {
      caption: [
        { text: "Captions" },
        { text: "that" },
        { text: "actually", emphasis: "orange" },
        { text: "read" },
        { text: "well" },
      ],
      pills: [
        { text: "Big and bold", state: "ok" },
        { text: "Tiny grey text", state: "bad" },
        { text: "Two lines at most", state: "plain" },
      ],
    },
    atSec: [1.2, 4.5],
  },
  {
    component: "PhoneDemo",
    name: "dense",
    props: {
      caption: [
        { text: "AUTOGENERATE" },
        { text: "TRANSCRIBING", emphasis: "yellow" },
        { text: "UNBELIEVABLE" },
        { text: "INSTRUCTIONS" },
        { text: "PROGRAMMATIC", emphasis: "orange" },
        { text: "CONFIGURABLE" },
      ],
      pills: [
        { text: "WORKS ON EVERY PHONE!!", state: "ok" },
        { text: "NEVER COVERS THE FACE!", state: "ok" },
        { text: "NO TINY GREY WORDS NOW", state: "bad" },
        { text: "MAX TWO WORDS PER LINE", state: "plain" },
      ],
    },
    atSec: [1.2, 4.5],
  },
  // StatCard's count-up (plan Task 8). The card's entrance spring settles at
  // 0.5 s and, in the explainer look, a value `parseCount` accepts counts up
  // over the next 1.0 s: 1.0 s is half way through the count, 2.0 s is
  // settled. 0.2 s is mid-entrance, for the classic byte-identical check
  // (`pnpm stills StatCard --theme default`, before and after the change).
  {
    component: "StatCard",
    name: "count",
    props: { label: "Lines removed", value: "4,494", caption: "In one refactor" },
    atSec: [0.2, 1.0, 2.0],
  },
  {
    component: "StatCard",
    name: "percent",
    props: { label: "Faster builds", value: "+242%" },
    atSec: [1.0, 2.0],
  },
  // TerminalMock (plan Task 8): two windows and a fan-out, each window with a
  // typed line — the second after a line that is present from its entrance.
  // Classic: the legacy stagger (windows at 0 and 6 frames, tail at 16), so
  // 0.2 s and 0.6 s catch the second window and the tail mid-entrance.
  // Explainer: window 1 types 0.5-1.25 s, window 2 may not enter before that
  // typing ends, so 1.5 s has window 2 arriving, 2.0 s has it typing
  // (1.77-2.3 s) and 4.0 s is settled.
  {
    component: "TerminalMock",
    name: "two-windows",
    props: {
      windows: [
        { title: "agent-01", lines: ["$ ossclip produce talk.mp4", "▸ transcribing…", "✓ done"] },
        { title: "agent-02", lines: ["# then, to review", "$ ossclip edit talk", "▸ opening the editor…"] },
      ],
      fanOut: "OUTPUT ×2",
    },
    atSec: [0.2, 0.6, 1.5, 2.0, 4.0],
  },
  // The playbook's command shot: one window, the command typed 0.5-1.69 s
  // (38 characters at 32 cps), the output 0.12 s apart from there, the badge
  // popping with the tail at 1.93 s. 1.1 s is mid-command; 1.75 s is just
  // after (caret held, first output line in); 3.0 s is settled.
  {
    component: "TerminalMock",
    name: "typed",
    props: {
      windows: [
        {
          title: "ossclip",
          lines: [
            "$ ossclip produce talk.mp4 --script s.md",
            "▸ transcribing…",
            "▸ planning 12 scenes",
            "✓ done in 41s",
          ],
        },
      ],
      badge: "+1,568 lines",
    },
    atSec: [1.1, 1.75, 3.0],
  },
  // The acceptance run's window (§161): the planner wrote no `$ `, and the
  // explainer look now types line 0 instead of nothing — from its first
  // character, uncoloured, 0.5-1.09 s (19 characters at 32 cps). 0.8 s is
  // mid-command ("/egm:egm-"); 3.0 s is settled. Classic draws it static.
  {
    component: "TerminalMock",
    name: "no-prompt",
    props: {
      windows: [
        {
          title: "claude",
          lines: ["/egm:egm-brainstorm", "Initial Critique & Risks", "3 risks found"],
        },
      ],
    },
    atSec: [0.8, 3.0],
  },
  // The 16:9 script placement (§161): a slot component in a script run goes
  // full-bleed in SCRIPT_LANDSCAPE_RECT, centred, with the frosted scrim
  // behind it — here a tint on the slate, since a still has no footage.
  // Landscape only: portrait never gets this placement. Each is settled:
  // the command types 0.5-1.69 s, the count runs 0.5-1.5 s.
  {
    component: "TerminalMock",
    name: "script-landscape",
    props: {
      windows: [
        {
          title: "ossclip",
          lines: ["$ ossclip produce talk.mp4 --script s.md", "▸ planning 12 scenes", "✓ done in 41s"],
        },
      ],
    },
    atSec: [3.0],
    layout: "full-bleed",
    graphicRect: { ...SCRIPT_LANDSCAPE_RECT },
    aspects: ["16x9"],
  },
  {
    component: "TitleCard",
    name: "script-landscape",
    props: { eyebrow: "STEP TWO", emphasis: "goldfish", title: "reviews every plan" },
    atSec: [2.0],
    layout: "full-bleed",
    graphicRect: { ...SCRIPT_LANDSCAPE_RECT },
    aspects: ["16x9"],
  },
  {
    component: "StatCard",
    name: "script-landscape",
    props: { label: "Tests passing", value: "4,494", caption: "Across four packages" },
    atSec: [2.0],
    layout: "full-bleed",
    graphicRect: { ...SCRIPT_LANDSCAPE_RECT },
    aspects: ["16x9"],
  },
];
