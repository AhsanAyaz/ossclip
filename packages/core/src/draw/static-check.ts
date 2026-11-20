import ts from "typescript";

/**
 * The static check on an LLM-drawn scene (storyboard design §5 step 1,
 * §167): parse the code and name, with its line, everything outside the
 * allow-list, so the repair loop can quote it back to the LLM.
 *
 * Pure: the code is parsed in memory, with no filesystem and no type
 * information (the type check is a later step, in the CLI). Node only — the
 * compiler is several megabytes, so this module is exported from `index.ts`
 * and never from `browser.ts`.
 *
 * This is a filter, not a sandbox (§167): code that hides a name from the
 * parser passes it. The second guard is the content security policy the
 * renderer writes into each scene's bundle, which blocks the network and
 * the editor's loopback server; the check exists so the common mistake
 * fails fast with a line number instead of as a silent blocked request.
 */

export const DRAW_MAX_LINES = 400;

/**
 * The only `remotion` names a drawn scene may import (§167): `Img`,
 * `IFrame`, `staticFile`, `delayRender` and the media components can load
 * from the network or stall a render; these cannot.
 */
export const DRAW_ALLOWED_REMOTION = [
  "useCurrentFrame",
  "useVideoConfig",
  "interpolate",
  "interpolateColors",
  "spring",
  "Easing",
  "AbsoluteFill",
  "Sequence",
] as const;

export const DRAW_KIT_MODULE = "@ossclip/scenes/draw";

/**
 * Lower-case JSX elements a drawn scene may use: `div`, `span`, and SVG
 * drawing, gradient, clip, mask, filter and text elements (§167). Everything
 * that loads or runs something is absent by construction — `image`,
 * `feImage` (it loads its `href` like `image`), `use` (it can reference
 * another document), `foreignObject` (HTML inside SVG), `a`, `script`,
 * `style` and the animation elements (`animate`/`set` can rewrite an
 * `href`). `marker` is kept: arrowheads are most of an explainer diagram.
 */
export const DRAW_ALLOWED_ELEMENTS = [
  "div",
  "span",
  // structure and shapes
  "svg",
  "g",
  "defs",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "marker",
  // gradients
  "linearGradient",
  "radialGradient",
  "stop",
  // clips and masks
  "clipPath",
  "mask",
  // filters
  "filter",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
  // text
  "text",
  "tspan",
  "textPath",
] as const;

/**
 * Names rejected wherever code can reach them (§167): the network, `eval`
 * and its relatives, the paths to the window object, and Node's globals.
 * `constructor` because `[].constructor.constructor` is `Function`;
 * `location` and `open` because the policy does not stop navigation.
 */
const FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
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
]);

/**
 * Substrings that mean a string can name a resource (§167). Matched without
 * regard to case: URL schemes and CSS `url(` are case-insensitive, so
 * `HTTPS:` loads as well as `https:`.
 */
const URL_LIKE = ["url(", "http:", "https:", "//", "data:"] as const;

export type DrawRule =
  | "import"
  | "dynamic-import"
  | "element"
  | "name"
  | "string"
  | "size"
  | "fence"
  | "syntax"
  | "export"
  // Produced by later steps (type check, still render), not by this module.
  | "type"
  | "render";

export interface DrawIssue {
  /** 1-based line in the scene file. */
  line: number;
  rule: DrawRule;
  message: string;
}

const SCENE_FILE = "/scene.tsx";
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set(DRAW_ALLOWED_ELEMENTS);
const ALLOWED_REMOTION: ReadonlySet<string> = new Set(DRAW_ALLOWED_REMOTION);
const ELEMENT_HINT = `use div, span, SVG drawing elements, parts from ${DRAW_KIT_MODULE}, AbsoluteFill, Sequence or a component declared in this file`;

/**
 * Every issue in `code`, sorted by line. `kitExports` is the kit's list of
 * importable names (`DRAW_KIT_EXPORTS`, passed in so core does not depend on
 * the scenes package).
 *
 * A file that does not parse reports its size and fence issues plus the
 * parser's first error only: the tree after error recovery is guesswork, and
 * rules run on it would send the LLM chasing issues that are not there.
 */
export function checkDrawnScene(code: string, kitExports: readonly string[]): DrawIssue[] {
  const issues: DrawIssue[] = [...textIssues(code)];

  const sf = ts.createSourceFile(SCENE_FILE, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lineAt = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const at = (node: ts.Node) => lineAt(node.getStart(sf));

  const syntax = syntaxErrors(sf)[0];
  if (syntax) {
    issues.push({
      line: lineAt(syntax.start ?? 0),
      rule: "syntax",
      message: ts.flattenDiagnosticMessageText(syntax.messageText, "\n"),
    });
    return byLine(issues);
  }

  const kit: ReadonlySet<string> = new Set(kitExports);
  // Components are resolved after the walk: a scene may use a helper
  // component above the line that declares it.
  const knownComponents = new Set<string>();
  const componentUses: { name: string; node: ts.Node }[] = [];

  const visit = (node: ts.Node): void => {
    // Types erase before the browser sees them, so a name inside one cannot
    // reach anything. A class `extends` clause is the exception: the parser
    // files it as a type node (ExpressionWithTypeArguments) but its
    // expression is evaluated — `extends (window as any).X` is code.
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;

    if (ts.isImportDeclaration(node)) {
      checkImport(node);
      if (node.importClause) visit(node.importClause);
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      issues.push({ line: at(node), rule: "import", message: `"import … = require" is not allowed; ${importHint()}` });
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      // A re-export loads its module exactly as an import does.
      const from = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : node.moduleSpecifier.getText(sf);
      issues.push({ line: at(node), rule: "import", message: `re-exporting from "${from}" is not allowed; ${importHint()}` });
      return;
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      issues.push({ line: at(node), rule: "dynamic-import", message: "dynamic import() is not allowed; import only at the top of the file" });
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) checkElement(node.tagName);

    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name) knownComponents.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      // Only a function or class counts as a declared component: with the
      // automatic JSX runtime `<X />` for `const X = "iframe"` renders an
      // iframe, which would walk around the element rule.
      if (isComponentValue(node.initializer)) knownComponents.add(node.name.text);
    }

    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) checkName(node);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      const key = node.argumentExpression.text;
      if (FORBIDDEN_NAMES.has(key)) {
        issues.push({ line: at(node.argumentExpression), rule: "name", message: `"${key}" is not allowed, as a name or a property` });
      }
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      checkString(node);
    }

    ts.forEachChild(node, visit);
  };

  const importHint = () =>
    `a drawn scene may import only react, ${DRAW_KIT_MODULE}, and from remotion: ${DRAW_ALLOWED_REMOTION.join(", ")}`;

  const checkImport = (node: ts.ImportDeclaration): void => {
    const from = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : node.moduleSpecifier.getText(sf);
    if (from === "react") return;
    const allowed = from === "remotion" ? ALLOWED_REMOTION : from === DRAW_KIT_MODULE ? kit : null;
    if (!allowed) {
      issues.push({ line: at(node), rule: "import", message: `"${from}" cannot be imported; ${importHint()}` });
      return;
    }
    const clause = node.importClause;
    if (!clause) return; // `import "remotion"` binds nothing
    // Named imports only: a default or namespace binding is every export
    // under one name, which the list cannot check.
    if (clause.name || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))) {
      issues.push({ line: at(node), rule: "import", message: `import names from "${from}" one by one ({ a, b }); ${importHint()}` });
      return;
    }
    if (!clause.namedBindings) return;
    for (const spec of clause.namedBindings.elements) {
      // The exported name is what loads; the local alias is only a label.
      const imported = (spec.propertyName ?? spec.name).text;
      if (allowed.has(imported)) knownComponents.add(spec.name.text);
      else {
        const message =
          from === "remotion"
            ? `"${imported}" cannot be imported from remotion; ${importHint()}`
            : `"${imported}" is not exported by ${DRAW_KIT_MODULE}`;
        issues.push({ line: at(spec), rule: "import", message });
      }
    }
  };

  const checkElement = (tag: ts.JsxTagNameExpression): void => {
    if (ts.isIdentifier(tag)) {
      const name = tag.text;
      if (isIntrinsic(name)) {
        if (!ALLOWED_ELEMENTS.has(name)) issues.push({ line: at(tag), rule: "element", message: `<${name}> is not allowed; ${ELEMENT_HINT}` });
      } else componentUses.push({ name, node: tag });
      return;
    }
    issues.push({ line: at(tag), rule: "element", message: `<${tag.getText(sf)}> is not allowed; ${ELEMENT_HINT}` });
  };

  const checkName = (node: ts.Identifier | ts.PrivateIdentifier): void => {
    const name = node.text;
    if (!FORBIDDEN_NAMES.has(name) || isHarmlessNamePosition(node)) return;
    issues.push({ line: at(node), rule: "name", message: `"${name}" is not allowed, as a name or a property` });
  };

  const checkString = (node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateLiteralLikeNode): void => {
    const lower = node.text.toLowerCase();
    const hit = URL_LIKE.find((s) => lower.includes(s));
    if (hit) {
      issues.push({
        line: at(node),
        rule: "string",
        message: `a string containing "${hit}" is not allowed: a drawn scene loads nothing; draw it, or use an Asset from ${DRAW_KIT_MODULE}`,
      });
    }
  };

  visit(sf);

  for (const use of componentUses) {
    if (!knownComponents.has(use.name)) {
      issues.push({
        line: at(use.node),
        rule: "element",
        message: `<${use.name}> is neither imported from ${DRAW_KIT_MODULE} or remotion nor declared in this file; ${ELEMENT_HINT}`,
      });
    }
  }

  if (!hasDefaultExport(sf)) {
    // No node to point at; line 1 is the file.
    issues.push({ line: 1, rule: "export", message: "the scene must have a default export: export default function Scene() { … }" });
  }

  return byLine(issues);
}

/** Size and fence work on the raw text, so they report even when it does not parse. */
function textIssues(code: string): DrawIssue[] {
  const issues: DrawIssue[] = [];
  const lines = code.split(/\r?\n/);
  // A final newline ends the last line; it does not start line 401.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length > DRAW_MAX_LINES) {
    issues.push({
      line: DRAW_MAX_LINES + 1,
      rule: "size",
      message: `the scene has ${lines.length} lines; at most ${DRAW_MAX_LINES} are allowed`,
    });
  }
  // The command-line provider strips runs of three backticks from a reply
  // before parsing it (§167), so a file holding one would not survive the
  // round trip as written.
  lines.forEach((l, i) => {
    if (l.includes("```")) issues.push({ line: i + 1, rule: "fence", message: "three backticks in a row are not allowed anywhere in the file" });
  });
  return issues;
}

/**
 * The parser's errors for an already-parsed file. `parseDiagnostics` is not
 * public API, so a one-file program over an in-memory host asks for them:
 * nothing is resolved or read (noLib, noResolve), the tree is the same one
 * the rules walk.
 */
function syntaxErrors(sf: ts.SourceFile): readonly ts.Diagnostic[] {
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === sf.fileName ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => f === sf.fileName,
    readFile: () => undefined,
  };
  const program = ts.createProgram({ rootNames: [sf.fileName], options: { noLib: true, noResolve: true, types: [] }, host });
  return [...program.getSyntacticDiagnostics(sf)].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

/** React's own rule: a lower-case first letter or a dash makes a tag a string, not a reference. */
function isIntrinsic(name: string): boolean {
  return /^[a-z]/.test(name) || name.includes("-");
}

function isComponentValue(init: ts.Expression): boolean {
  let e = init;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isClassExpression(e);
}

/**
 * Positions where a forbidden word names nothing the code can reach (§167):
 * an object literal's own key (`{ top: 10 }` in a style), a JSX attribute
 * name, and a JSX tag (the element rule owns tags). Everything else — a
 * reference, a declaration, `x.top`, `{ top }` shorthand (a reference to
 * `top`), a destructured `{ constructor: F }` (a property read) — is
 * rejected, because each one is a way to the thing the name stands for.
 */
function isHarmlessNamePosition(node: ts.Identifier | ts.PrivateIdentifier): boolean {
  const p = node.parent;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if ((ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === node && ts.isObjectLiteralExpression(p.parent)) {
    return true;
  }
  if (ts.isJsxAttribute(p) && p.name === node) return true;
  if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === node) return true;
  return false;
}

function hasDefaultExport(sf: ts.SourceFile): boolean {
  return sf.statements.some((s) => {
    if (ts.isExportAssignment(s)) return !s.isExportEquals;
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.modifiers) {
      const kinds = s.modifiers.map((m) => m.kind);
      return kinds.includes(ts.SyntaxKind.ExportKeyword) && kinds.includes(ts.SyntaxKind.DefaultKeyword);
    }
    if (ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause)) {
      return s.exportClause.elements.some((e) => e.name.text === "default");
    }
    return false;
  });
}

function byLine(issues: DrawIssue[]): DrawIssue[] {
  // Array.prototype.sort is stable, so issues on one line keep walk order.
  return issues.sort((a, b) => a.line - b.line);
}
