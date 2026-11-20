import { describe, expect, it } from "vitest";
import {
  DRAW_ALLOWED_ELEMENTS,
  DRAW_MAX_LINES,
  checkDrawnScene,
  type DrawIssue,
} from "../src/draw/static-check";

/**
 * The static check on LLM-drawn scene code (storyboard design §5 step 1,
 * plan Task 1, §167): every rule rejects with the line the repair loop
 * quotes back to the LLM, and the allowed shape of a scene passes clean.
 */

const KIT = ["useSceneTime", "useTheme", "Card", "Pill"] as const;

const HEAD = [
  'import { useCurrentFrame, AbsoluteFill } from "remotion";',
  'import { Card } from "@ossclip/scenes/draw";',
  "",
  "export default function Scene() {",
  "  const frame = useCurrentFrame();",
];

/** A clean scene with `body` inside the component and `jsx` returned. */
function scene(body: string[] = [], jsx = "<div />", after: string[] = []): string {
  return [...HEAD, ...body, `  return ${jsx};`, "}", ...after].join("\n");
}

/** 1-based line of the first line containing `needle`. */
function lineOf(code: string, needle: string): number {
  const i = code.split("\n").findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`test bug: ${needle} not in code`);
  return i + 1;
}

const only = (issues: DrawIssue[]) => issues.map(({ rule, line }) => ({ rule, line }));

describe("checkDrawnScene: the allowed shape", () => {
  it("a scene importing react, the kit and useCurrentFrame, drawing with div, span, svg, g, path, circle, text, AbsoluteFill and a kit part, returns no issues", () => {
    const code = [
      'import React from "react";',
      'import { useSceneTime, Card } from "@ossclip/scenes/draw";',
      'import { useCurrentFrame, AbsoluteFill } from "remotion";',
      "",
      "export default function Scene({ durationSec }: { durationSec: number }) {",
      "  const frame = useCurrentFrame();",
      "  const t = useSceneTime();",
      "  return (",
      "    <AbsoluteFill style={{ top: 10, left: 0 }}>",
      "      <div><span>{frame}</span></div>",
      '      <svg viewBox="0 0 100 100">',
      "        <g>",
      '          <path d="M0 0 L10 10" fill="#fff" />',
      "          <circle cx={50} cy={50} r={t} />",
      "          <text x={10} y={20}>hi</text>",
      "        </g>",
      "      </svg>",
      "      <Card>{durationSec}</Card>",
      "    </AbsoluteFill>",
      "  );",
      "}",
    ].join("\n");
    expect(checkDrawnScene(code, KIT)).toEqual([]);
  });

  it("the allowed element list covers the drawing, gradient, clip, mask, filter and text elements and none of the loaders", () => {
    for (const el of ["div", "span", "svg", "g", "path", "rect", "linearGradient", "stop", "clipPath", "mask", "filter", "feGaussianBlur", "text", "tspan"]) {
      expect(DRAW_ALLOWED_ELEMENTS).toContain(el);
    }
    // feImage loads its href like <image> does.
    for (const el of ["image", "feImage", "foreignObject", "use", "a", "script", "style"]) {
      expect(DRAW_ALLOWED_ELEMENTS).not.toContain(el);
    }
  });
});

describe("checkDrawnScene: import", () => {
  it.each([
    ['import fs from "node:fs";'],
    ['import { Img } from "remotion";'],
    ['import * as R from "remotion";'],
    ['import { Nope } from "@ossclip/scenes/draw";'],
    // The imported name is what loads, not the local alias.
    ['import { Img as Sequence } from "remotion";'],
    // A re-export loads the module just as an import does.
    ['export * from "node:fs";'],
  ])("%s is rejected on its line", (stmt) => {
    const code = scene([], "<div />", [stmt]);
    expect(only(checkDrawnScene(code, KIT))).toEqual([{ rule: "import", line: lineOf(code, stmt) }]);
  });

  it("an allowed remotion name under a local alias passes", () => {
    const code = ['import { useCurrentFrame as useF } from "remotion";', "export default function S() { return <div>{useF()}</div>; }"].join("\n");
    expect(checkDrawnScene(code, KIT)).toEqual([]);
  });
});

describe("checkDrawnScene: dynamic-import", () => {
  it('import("x") is rejected on its line', () => {
    const code = scene(['  const m = import("x");']);
    expect(only(checkDrawnScene(code, KIT))).toEqual([{ rule: "dynamic-import", line: lineOf(code, "import(") }]);
  });
});

describe("checkDrawnScene: element", () => {
  it.each(["image", "foreignObject", "script", "a", "use", "style", "iframe", "img", "video", "audio", "link", "object", "embed"])(
    "<%s> is rejected on its line",
    (tag) => {
      const code = scene([], `(\n    <${tag}></${tag}>\n  )`);
      expect(only(checkDrawnScene(code, KIT))).toEqual([{ rule: "element", line: lineOf(code, `<${tag}>`) }]);
    },
  );

  it("an unknown capitalised component, neither imported nor declared, is rejected", () => {
    const code = scene([], "(\n    <Mystery />\n  )");
    expect(only(checkDrawnScene(code, KIT))).toEqual([{ rule: "element", line: lineOf(code, "<Mystery") }]);
  });

  it("components declared in the file (function, const arrow, class), before or after use, are allowed", () => {
    const code = scene(
      [],
      "(\n    <div><Dot /><Ring /><Box /></div>\n  )",
      [
        "function Dot() { return <circle r={2} />; }",
        "const Ring = () => <circle r={4} />;",
        "class Box extends React.Component { render() { return <rect />; } }",
      ],
    );
    expect(checkDrawnScene(code, KIT)).toEqual([]);
  });

  it("a capitalised const that is not a function is not a component: <Bad /> with Bad = \"iframe\" renders an iframe", () => {
    const code = scene(['  const Bad = "iframe";'], "(\n    <Bad />\n  )");
    expect(only(checkDrawnScene(code, KIT))).toEqual([{ rule: "element", line: lineOf(code, "<Bad") }]);
  });

  it("a member tag (<K.Card />) is rejected: only names imported by name or declared here are known", () => {
    const code = scene([], "(\n    <K.Card />\n  )");
    expect(only(checkDrawnScene(code, KIT))).toEqual([{ rule: "element", line: lineOf(code, "<K.Card") }]);
  });
});

const FORBIDDEN = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "eval",
  "Function",
  "constructor",
  "window",
  "document",
  "globalThis",
  "self",
  "top",
  "parent",
  "frames",
  "location",
  "open",
  "localStorage",
  "sessionStorage",
  "navigator",
  "process",
  "require",
];

describe("checkDrawnScene: name", () => {
  it.each(FORBIDDEN)("%s as an identifier is rejected", (name) => {
    const code = scene([`  const v = ${name};`]);
    expect(only(checkDrawnScene(code, KIT))).toEqual([{ rule: "name", line: lineOf(code, `= ${name};`) }]);
  });

  it.each(FORBIDDEN)("%s as a property name (x.%s) is rejected", (name) => {
    const code = scene(["  const x = {} as any;", `  const v = x.${name};`]);
    expect(only(checkDrawnScene(code, KIT))).toEqual([{ rule: "name", line: lineOf(code, `x.${name}`) }]);
  });

  it.each(FORBIDDEN)('%s as a computed property name (x["%s"]) is rejected', (name) => {
    const code = scene(["  const x = {} as any;", `  const v = x["${name}"];`]);
    expect(only(checkDrawnScene(code, KIT))).toEqual([{ rule: "name", line: lineOf(code, `x["${name}"]`) }]);
  });

  it("a declared variable, function or destructured binding named top/open is rejected", () => {
    const code = scene(["  const top = 1;", "  function open() {}", "  const { parent } = {} as any;"]);
    expect(only(checkDrawnScene(code, KIT))).toEqual([
      { rule: "name", line: lineOf(code, "const top") },
      { rule: "name", line: lineOf(code, "function open") },
      { rule: "name", line: lineOf(code, "{ parent }") },
    ]);
  });

  it("top as an object key in a style, and as a JSX attribute name, is allowed", () => {
    const code = scene(["  const style = { top: 10, left: 0 };"], "<div style={{ top: 10, position: \"absolute\" }} open={true} />");
    expect(checkDrawnScene(code, KIT)).toEqual([]);
  });

  it("names inside types are not code: an interface with a top field passes", () => {
    const code = scene([], "<div />", ["interface Box { top: number; parent: string }"]);
    expect(checkDrawnScene(code, KIT)).toEqual([]);
  });

  it("a class heritage clause is code, not a type: extends (window as any).X is rejected", () => {
    const code = scene([], "<div />", ["class Y extends (window as any).X {}"]);
    expect(only(checkDrawnScene(code, KIT))).toEqual([{ rule: "name", line: lineOf(code, "class Y") }]);
  });

  // Review Focus 1: code that hides a name from the parser.
  it('globalThis["fe"+"tch"] is rejected (computed access on a rejected global)', () => {
    const code = scene(['  globalThis["fe" + "tch"]("x");']);
    expect(only(checkDrawnScene(code, KIT))).toEqual([{ rule: "name", line: lineOf(code, "globalThis") }]);
  });

  it("[].constructor.constructor is rejected", () => {
    const code = scene(['  [].constructor.constructor("return 1")();']);
    const issues = checkDrawnScene(code, KIT);
    expect(issues.length).toBeGreaterThan(0);
    expect(only(issues).every((i) => i.rule === "name" && i.line === lineOf(code, "[].constructor"))).toBe(true);
  });
});

describe("checkDrawnScene: string", () => {
  it.each([
    ['  const s = "url(x.png)";'],
    ['  const s = "http:x";'],
    ['  const s = "https:x";'],
    ['  const s = "a//b";'],
    ['  const s = "data:image/png;base64,AA";'],
    // Case does not hide a scheme or a CSS function.
    ['  const s = "HTTPS:x";'],
    // The cooked value is checked: an escape does not hide a scheme.
    ['  const s = "\\x68ttps:x";'],
    ["  const s = `url(x.png)`;"],
    ["  const s = `${frame}https:x`;"],
    ["  const s = `https:x${frame}`;"],
    ["  const s = `${frame}a//b${frame}`;"],
  ])("%s is rejected on its line", (stmt) => {
    const code = scene([stmt]);
    expect(only(checkDrawnScene(code, KIT))).toEqual([{ rule: "string", line: lineOf(code, stmt) }]);
  });

  it("a JSX attribute string is a string literal", () => {
    const code = scene([], '<div style={{ background: "url(x.png)" }} />');
    expect(only(checkDrawnScene(code, KIT))).toEqual([{ rule: "string", line: lineOf(code, "url(") }]);
  });

  it('"M0 0 L10 10" and "#fff" are allowed', () => {
    const code = scene(['  const d = "M0 0 L10 10";', '  const c = "#fff";']);
    expect(checkDrawnScene(code, KIT)).toEqual([]);
  });
});

describe("checkDrawnScene: size and fence", () => {
  it(`${DRAW_MAX_LINES + 1} lines is rejected at line ${DRAW_MAX_LINES + 1}`, () => {
    const base = scene().split("\n");
    const code = [...base, ...Array.from({ length: DRAW_MAX_LINES + 1 - base.length }, () => "// pad")].join("\n");
    expect(code.split("\n")).toHaveLength(DRAW_MAX_LINES + 1);
    expect(only(checkDrawnScene(code, KIT))).toEqual([{ rule: "size", line: DRAW_MAX_LINES + 1 }]);
  });

  it(`${DRAW_MAX_LINES} lines with a trailing newline passes`, () => {
    const base = scene().split("\n");
    const code = [...base, ...Array.from({ length: DRAW_MAX_LINES - base.length }, () => "// pad")].join("\n") + "\n";
    expect(checkDrawnScene(code, KIT)).toEqual([]);
  });

  it("three backticks anywhere, even in a comment, are rejected on their line", () => {
    const code = scene(["  // see ``` here"]);
    expect(only(checkDrawnScene(code, KIT))).toEqual([{ rule: "fence", line: lineOf(code, "```") }]);
  });
});

describe("checkDrawnScene: syntax and export", () => {
  it("unbalanced JSX returns one issue with the parser's line", () => {
    const code = scene([], "<div><span></div>");
    const issues = checkDrawnScene(code, KIT);
    expect(only(issues)).toEqual([{ rule: "syntax", line: lineOf(code, "<div><span>") }]);
    expect(issues[0]!.message.length).toBeGreaterThan(0);
  });

  it("no default export is rejected", () => {
    const code = ["export function Scene() {", "  return <div />;", "}"].join("\n");
    expect(only(checkDrawnScene(code, KIT))).toEqual([{ rule: "export", line: 1 }]);
  });

  it.each([
    ["export default function Scene() { return <div />; }"],
    ["const Scene = () => <div />;\nexport default Scene;"],
    ["const Scene = () => <div />;\nexport { Scene as default };"],
  ])("a default export in any form passes: %s", (code) => {
    expect(checkDrawnScene(code, KIT)).toEqual([]);
  });
});
