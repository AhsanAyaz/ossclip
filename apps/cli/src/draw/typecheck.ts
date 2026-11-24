/**
 * Type check of one LLM-drawn scene against the drawing kit's real source
 * (storyboard design §5 step 2, §167). A wrong prop name is the most likely
 * mistake a drawn scene makes, and the compiler's message, with its line, is
 * the best repair hint the LLM can get, so it goes back verbatim.
 *
 * The scene sits in a project workdir with no node_modules and no tsconfig,
 * so nothing is resolved from beside it. The host redirects exactly the
 * modules a scene may import (the static check has already refused any
 * other):
 * - `@ossclip/scenes/draw` goes straight to the kit's SOURCE file, the same
 *   file the render bundle aliases it to (renderer drawn/render.ts), so the
 *   check sees the props the render will run.
 * - `react`, `react/jsx-runtime` and `remotion` resolve as if the KIT had
 *   imported them. That gives the scene and the kit one copy of React's
 *   types; resolved from anywhere else, a second copy makes the kit's
 *   `ReactNode` and the scene's JSX two unrelated types, and the LLM gets an
 *   error it did not cause and cannot fix.
 * A redirecting host rather than `paths`/`baseUrl`: `paths` only maps a
 * specifier to a file, and a `react` mapped to one .d.ts loses the package's
 * exports map, which is what turns `react/jsx-runtime` into its own
 * declaration file.
 *
 * Only the scene file's diagnostics are returned. An error inside the kit,
 * React or Remotion is not the scene's fault and not something a redraw can
 * fix. But a missing allowed module, or one with no type declarations, is an
 * ossclip installation fault: it throws, because reporting it as a scene
 * issue would send the LLM after a bug in our install, and filtering it away
 * would pass every scene unchecked.
 *
 * Both of the CLI's dependencies for this are there for a published install,
 * not the workspace: `typescript` loads its `lib.*.d.ts` from its own `lib/`
 * folder, which its package ships; `@types/react` is only a devDependency of
 * the scenes and renderer packages, so without the CLI depending on it an
 * `npm i -g ossclip` has no React types and every check would throw.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";
import { DRAW_KIT_MODULE, type DrawIssue } from "@ossclip/core";

/** Where the kit is and where a scene's react/remotion are resolved from. Injected so a test can point at a broken kit. */
export interface DrawTypecheckSetup {
  /** The file `@ossclip/scenes/draw` resolves to. */
  kitEntry: string;
  /** A file whose location `react`, `react/jsx-runtime` and `remotion` resolve from. */
  typesFrom: string;
}

/** The three modules redirected to resolve from `typesFrom`; with the kit, everything a scene may import (plan Global Constraints). */
const TYPED_MODULES = new Set(["react", "react/jsx-runtime", "remotion"]);

/**
 * The repo's own settings (tsconfig.base.json) where they decide how a
 * scene's code is typed: bundler resolution, so the kit's `.ts` exports map
 * and `@ossclip/core/browser` resolve as they do for `pnpm typecheck`;
 * ES2022 and DOM, the libraries a browser scene can use. Not
 * `noUncheckedIndexedAccess`: the plan asks for `strict`, and an indexed
 * access the scene wrote correctly would come back as a repair it does not
 * need.
 *
 * `types: []` keeps the workspace's `@types/node` (and any other global
 * types package near the working directory) out: a scene runs in a browser,
 * `process` must not type-check, and the result must not depend on where
 * ossclip was started.
 */
const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
  types: [],
};

const DECLARATION_EXTENSIONS: readonly string[] = [ts.Extension.Dts, ts.Extension.Dmts, ts.Extension.Dcts];

/** The installed kit's source file and where its types come from, resolved the way the render bundle resolves it. */
export function drawTypecheckSetup(): DrawTypecheckSetup {
  const kitEntry = createRequire(import.meta.url).resolve(DRAW_KIT_MODULE);
  return { kitEntry, typesFrom: kitEntry };
}

/**
 * The scene's own diagnostics as issues (pure). Anything without a file
 * (global) or in another file (the kit, React, Remotion) is dropped here.
 * Lines are 1-based, the compiler's code is appended as `(TS2322)`, and the
 * order is by line; within a line the compiler's own order is kept.
 */
export function sceneDiagnosticIssues(diagnostics: readonly ts.Diagnostic[], sceneFileName: string): DrawIssue[] {
  const issues: DrawIssue[] = [];
  for (const d of diagnostics) {
    if (d.file === undefined || d.file.fileName !== sceneFileName) continue;
    const line = d.start === undefined ? 1 : d.file.getLineAndCharacterOfPosition(d.start).line + 1;
    issues.push({ line, rule: "type", message: `${ts.flattenDiagnosticMessageText(d.messageText, "\n")} (TS${d.code})` });
  }
  return issues.sort((a, b) => a.line - b.line);
}

/**
 * The check with its setup injected, and its wall time. The time is returned,
 * not logged: the CLI has no debug log level to print it at, so the command
 * that runs this (plan Task 7) prints it and the gate records it.
 */
export function runDrawTypecheck(scenePath: string, setup: DrawTypecheckSetup): { issues: DrawIssue[]; elapsedMs: number } {
  const started = performance.now();
  const sceneFile = resolve(scenePath);
  if (!existsSync(sceneFile)) throw new Error(`drawn-scene type check: scene file not found: ${sceneFile}`);
  if (!existsSync(setup.kitEntry)) {
    throw new Error(`drawn-scene type check: ${DRAW_KIT_MODULE} not found (expected ${setup.kitEntry}); the ossclip install is incomplete`);
  }

  const host = ts.createCompilerHost(OPTIONS, true);
  const cache = ts.createModuleResolutionCache(host.getCurrentDirectory(), host.getCanonicalFileName, OPTIONS);
  const sceneKey = host.getCanonicalFileName(ts.sys.resolvePath(sceneFile));
  const faults: string[] = [];

  host.resolveModuleNameLiterals = (literals, containingFile, redirectedReference, options, containingSourceFile) =>
    literals.map((literal) => {
      const name = literal.text;
      const mode = ts.getModeForUsageLocation(containingSourceFile, literal, options);
      const fromScene = host.getCanonicalFileName(containingFile) === sceneKey;
      if (fromScene && name === DRAW_KIT_MODULE) {
        return {
          resolvedModule: { resolvedFileName: setup.kitEntry, extension: ts.Extension.Ts, isExternalLibraryImport: false },
        };
      }
      if (fromScene && TYPED_MODULES.has(name)) {
        const resolved = ts.resolveModuleName(name, setup.typesFrom, options, host, cache, redirectedReference, mode);
        const ext = resolved.resolvedModule?.extension;
        // Found as plain JavaScript is as bad as not found: every kit part
        // and hook would type as `any` and every scene would pass.
        if (ext === undefined || !DECLARATION_EXTENSIONS.includes(ext)) {
          faults.push(`"${name}" has no type declarations resolvable from ${setup.typesFrom}`);
        }
        return resolved;
      }
      return ts.resolveModuleName(name, containingFile, options, host, cache, redirectedReference, mode);
    });

  const program = ts.createProgram({ rootNames: [sceneFile], options: OPTIONS, host });
  if (faults.length > 0) {
    throw new Error(`drawn-scene type check: the ossclip install is incomplete: ${[...new Set(faults)].join("; ")}`);
  }
  // A file-less diagnostic (a lib file that would not load, a bad option)
  // means the compiler itself is broken here. Dropped by the scene filter,
  // it would turn into a silent pass, so it throws.
  const global = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
  if (global.length > 0) {
    throw new Error(`drawn-scene type check: compiler setup failed: ${ts.flattenDiagnosticMessageText(global[0]!.messageText, "\n")}`);
  }

  const sceneSf = program.getSourceFile(sceneFile);
  if (sceneSf === undefined) throw new Error(`drawn-scene type check: the compiler did not load ${sceneFile}`);
  // The scene file's diagnostics only: the checker types the kit as far as
  // the scene uses it but does not check the kit's bodies, which is also
  // what keeps one check fast. A syntax error is returned alone, because
  // the semantic errors after it are the parser's recovery, not the LLM's
  // mistakes.
  const syntactic = program.getSyntacticDiagnostics(sceneSf);
  const diagnostics = syntactic.length > 0 ? syntactic : program.getSemanticDiagnostics(sceneSf);
  return { issues: sceneDiagnosticIssues(diagnostics, sceneSf.fileName), elapsedMs: performance.now() - started };
}

/** Type-checks one drawn scene file against the installed kit; issues have `rule: "type"`. */
export function typecheckDrawnScene(scenePath: string): DrawIssue[] {
  return runDrawTypecheck(scenePath, drawTypecheckSetup()).issues;
}
