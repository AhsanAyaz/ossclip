import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { runDrawTypecheck, sceneDiagnosticIssues, typecheckDrawnScene } from "../src/draw/typecheck";

/**
 * Fixtures live in the OS temp dir, outside the repo tree, on purpose: a
 * project workdir has no node_modules and no tsconfig (§167), so passing here
 * proves `react`, `remotion` and the kit resolve from ossclip's own install,
 * not from wherever the scene happens to sit.
 */
let dir: string;
const scene = (name: string, code: string): string => {
  const path = join(dir, name);
  writeFileSync(path, code);
  return path;
};
const lineOf = (code: string, needle: string): number => code.split("\n").findIndex((l) => l.includes(needle)) + 1;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ossclip-draw-typecheck-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const GOOD = `import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { Card, fadeIn, riseIn, useSafeArea, useSceneTime, useTheme } from "@ossclip/scenes/draw";

export default function Scene({ durationSec }: { durationSec: number }) {
  const t = useSceneTime();
  const theme = useTheme();
  const area = useSafeArea();
  const x = interpolate(t, [0, durationSec], [0, 100], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: area.x + x, opacity: fadeIn(t, 0), transform: \`translateY(\${riseIn(t, 0.2)}px)\` }}>
        <Card border={theme.accent} widthPx={600}>
          <span style={{ fontFamily: theme.fontDisplay }}>Hello</span>
        </Card>
      </div>
    </AbsoluteFill>
  );
}
`;

describe("typecheckDrawnScene", () => {
  it("a correct scene using hooks, a motion helper and <Card> has no issues", () => {
    expect(typecheckDrawnScene(scene("good.tsx", GOOD))).toEqual([]);
  });

  it("a wrong prop name on <Card> is one issue on its line naming the prop", () => {
    const code = GOOD.replace("<Card border={theme.accent} widthPx={600}>", '<Card border={theme.accent} titel="x">');
    const issues = typecheckDrawnScene(scene("bad-prop.tsx", code));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: "type", line: lineOf(code, "titel") });
    expect(issues[0]!.message).toContain("titel");
    expect(issues[0]!.message).toMatch(/\(TS\d+\)$/);
  });

  it("a wrong hook argument is an issue on its line", () => {
    const code = GOOD.replace("opacity: fadeIn(t, 0)", 'opacity: fadeIn("a", 0)');
    const issues = typecheckDrawnScene(scene("bad-arg.tsx", code));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: "type", line: lineOf(code, 'fadeIn("a"') });
    expect(issues[0]!.message).toContain("(TS2345)");
  });

  it("importing a name the kit does not export is an issue", () => {
    const code = GOOD.replace("useTheme } from", "useTheme, Banner } from");
    const issues = typecheckDrawnScene(scene("bad-import.tsx", code));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: "type", line: lineOf(code, "Banner") });
    expect(issues[0]!.message).toContain("Banner");
  });

  it("a syntax error is an issue, not a throw", () => {
    const code = GOOD.replace("</Card>", "</Crad>");
    const issues = typecheckDrawnScene(scene("bad-syntax.tsx", code));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.rule === "type")).toBe(true);
    expect(issues.map((i) => i.line)).toContain(lineOf(code, "</Crad>"));
  });

  it("issues are sorted by line", () => {
    const code = GOOD.replace("opacity: fadeIn(t, 0)", 'opacity: fadeIn("a", 0)').replace(
      "const area = useSafeArea();",
      "const area = useSafeArea(1);",
    );
    const lines = typecheckDrawnScene(scene("two-bad.tsx", code)).map((i) => i.line);
    expect(lines).toEqual([lineOf(code, "useSafeArea(1)"), lineOf(code, 'fadeIn("a"')]);
  });

  it("a missing scene file throws rather than passing", () => {
    expect(() => typecheckDrawnScene(join(dir, "nope.tsx"))).toThrow(/nope\.tsx/);
  });
});

describe("runDrawTypecheck: only the scene's own diagnostics", () => {
  it("a kit with type errors of its own and an unresolvable import reports nothing for a scene that uses it correctly", () => {
    // A stand-in kit in the temp dir: one real type error in its own body and
    // an import that resolves nowhere. The scene's react/remotion still come
    // from the real kit's location (`typesFrom`), as in production.
    const kitDir = mkdtempSync(join(dir, "kit-"));
    const brokenKit = join(kitDir, "index.ts");
    writeFileSync(
      brokenKit,
      `import { nothing } from "./does-not-exist";
const wrong: number = "not a number";
export function fadeIn(t: number, startSec: number): number { return t - startSec + wrong + nothing; }
`,
    );
    const realKit = createRequire(import.meta.url).resolve("@ossclip/scenes/draw");
    const code = `import React from "react";
import { fadeIn } from "@ossclip/scenes/draw";
export default function Scene({ durationSec }: { durationSec: number }) {
  return <div style={{ opacity: fadeIn(durationSec, 0) }} />;
}
`;
    const { issues, elapsedMs } = runDrawTypecheck(scene("uses-broken-kit.tsx", code), {
      kitEntry: brokenKit,
      typesFrom: realKit,
    });
    expect(issues).toEqual([]);
    expect(elapsedMs).toBeGreaterThan(0);
  });

  it("a kit path that does not exist is an installation fault, thrown", () => {
    const realKit = createRequire(import.meta.url).resolve("@ossclip/scenes/draw");
    expect(() =>
      runDrawTypecheck(scene("no-kit.tsx", GOOD), { kitEntry: join(dir, "missing-kit.ts"), typesFrom: realKit }),
    ).toThrow(/@ossclip\/scenes\/draw/);
  });

  it("react resolving with no type declarations is an installation fault, thrown", () => {
    // From a directory with no node_modules above it, `react` resolves to
    // nothing: the check must refuse rather than pass a scene unchecked.
    const realKit = createRequire(import.meta.url).resolve("@ossclip/scenes/draw");
    expect(() =>
      runDrawTypecheck(scene("no-react.tsx", GOOD), { kitEntry: realKit, typesFrom: join(dir, "x.ts") }),
    ).toThrow(/"react"/);
  });
});

describe("sceneDiagnosticIssues (pure)", () => {
  const sceneSf = ts.createSourceFile("/w/scene.tsx", "line1\nline2\nline3\n", ts.ScriptTarget.ES2022);
  const kitSf = ts.createSourceFile("/k/index.ts", "a\nb\n", ts.ScriptTarget.ES2022);
  const diag = (file: ts.SourceFile | undefined, start: number | undefined, messageText: string | ts.DiagnosticMessageChain, code: number): ts.Diagnostic => ({
    file,
    start,
    length: 1,
    messageText,
    code,
    category: ts.DiagnosticCategory.Error,
  });

  it("keeps the scene's diagnostics only, 1-based lines, sorted, code appended", () => {
    const issues = sceneDiagnosticIssues(
      [
        diag(sceneSf, 12, "third line", 2322),
        diag(kitSf, 0, "kit fault", 2322),
        diag(undefined, undefined, "global", 2318),
        diag(sceneSf, 0, "first line", 2345),
      ],
      "/w/scene.tsx",
    );
    expect(issues).toEqual([
      { line: 1, rule: "type", message: "first line (TS2345)" },
      { line: 3, rule: "type", message: "third line (TS2322)" },
    ]);
  });

  it("flattens a message chain", () => {
    const chain: ts.DiagnosticMessageChain = {
      messageText: "outer",
      category: ts.DiagnosticCategory.Error,
      code: 2322,
      next: [{ messageText: "inner", category: ts.DiagnosticCategory.Error, code: 2353 }],
    };
    const [issue] = sceneDiagnosticIssues([diag(sceneSf, 6, chain, 2322)], "/w/scene.tsx");
    expect(issue!.message).toContain("outer");
    expect(issue!.message).toContain("inner");
    expect(issue!.message.endsWith("(TS2322)")).toBe(true);
    expect(issue!.line).toBe(2);
  });
});
