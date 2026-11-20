/**
 * `pnpm stills`'s command line, parsed (plan Task 8). Pure, like
 * scene-still.ts, so the flag's refusals are tested without a browser; kept
 * out of scene-still.ts because that module is bundled into the still
 * composition and `LookSchema` comes from core's node entry.
 *
 * `--theme <look>` exists for the classic-pixels proof: plan Task 8 changes
 * TerminalMock and StatCard, which every user's runs draw, and the only
 * evidence that the default theme still renders the same frames is a still
 * drawn in the DEFAULT theme before the change and `cmp`'d after it. The
 * harness's own look stays the explainer one (Task 3), so the flag is opt-in.
 */
import { join } from "node:path";
import { LookSchema, type Look } from "@ossclip/core";

export interface StillsArgs {
  /** The component to render fixtures for; absent renders every fixture. */
  component?: string;
  look: Look;
}

/**
 * `[Component] [--theme default|explainer]`, in either order, `--theme=x`
 * accepted. The look is parsed with `LookSchema`, never coerced: a typo'd
 * `--theme defualt` falling back to the explainer look would write a set of
 * explainer stills into the folder a classic comparison reads, and the
 * `cmp` would "pass" against the wrong baseline. An unknown flag or a second
 * component is refused for the same reason.
 */
export function parseStillsArgs(argv: readonly string[]): StillsArgs {
  let component: string | undefined;
  let theme: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--theme" || arg.startsWith("--theme=")) {
      const value = arg === "--theme" ? argv[++i] : arg.slice("--theme=".length);
      if (value === undefined || value === "") throw new Error("--theme needs a value");
      theme = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option "${arg}" — usage: pnpm stills [Component] [--theme <look>]`);
    } else if (component === undefined) {
      component = arg;
    } else {
      throw new Error(`one component at a time — got "${component}" and "${arg}"`);
    }
  }
  const look = LookSchema.safeParse(theme ?? "explainer");
  if (!look.success) {
    throw new Error(`unknown --theme "${theme}" — one of: ${LookSchema.options.join(", ")}`);
  }
  return component === undefined ? { look: look.data } : { component, look: look.data };
}

/**
 * Where a look's stills go: the explainer stills where they always went, any
 * other look in a subfolder named after it, so a classic run can never
 * overwrite the committed explainer stills it is not comparable to.
 */
export function stillsOutDir(stillsRoot: string, look: Look): string {
  return look === "explainer" ? stillsRoot : join(stillsRoot, look);
}
