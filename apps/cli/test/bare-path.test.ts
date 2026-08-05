import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * 0.1.9 first-contact (2026-08-05): `ossclip "./Anyhropic c Compiler"` — a
 * user handing the front door a folder to produce — silently DROPPED the
 * positional and opened the menu, because the root command declared no
 * argument and commander's default allows excess args. The user then
 * re-answered the wizard's input prompt by hand, wrongly, with all of
 * ~/Downloads. These tests pin the routing that replaces that: a path that
 * exists routes into produce pre-supplied, a path that doesn't is a loud
 * error naming what was tried, and registered subcommands always win.
 *
 * Same harness shape as produce-argv-roundtrip.test.ts: the REAL program,
 * with only the target action's effect stubbed out.
 */
const harness = async () => {
  const { buildProgram } = await import("../src/program");
  const program = buildProgram();
  let out = "";
  for (const cmd of [program, ...program.commands]) {
    cmd.exitOverride();
    cmd.configureOutput({
      writeErr() {},
      writeOut(s: string) {
        out += s;
      },
    });
  }
  return { program, getOut: () => out };
};

const stub = (program: { commands: readonly { name(): string; action(fn: never): unknown }[] }, name: string) => {
  let captured: unknown[] | undefined;
  const cmd = program.commands.find((c) => c.name() === name);
  if (cmd === undefined) throw new Error(`the real program has no \`${name}\` command`);
  cmd.action(((...args: unknown[]) => {
    captured = args;
  }) as never);
  return () => captured;
};

describe("bare `ossclip <path>`", () => {
  // vitest workers have no TTY, so every parse below takes the
  // non-interactive branch: routing decisions are what's under test — the
  // wizard's own prompts need a terminal and are exercised by hand.

  it("a path that does not exist is a loud error naming what was tried — never the menu", async () => {
    const { program } = await harness();
    await expect(
      program.parseAsync(["node", "ossclip", "./no-such-path-xyz"]),
    ).rejects.toThrow(/no such file or directory: \.\/no-such-path-xyz/);
  });

  it("an existing directory routes into produce with the input pre-supplied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-bare-"));
    const { program } = await harness();
    const produced = stub(program, "produce");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync(["node", "ossclip", dir]);
    } finally {
      log.mockRestore();
    }
    expect(produced()?.[0]).toBe(dir);
  });

  it("an existing file routes the same way", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-bare-"));
    const file = join(dir, "take.mp4");
    writeFileSync(file, "");
    const { program } = await harness();
    const produced = stub(program, "produce");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync(["node", "ossclip", file]);
    } finally {
      log.mockRestore();
    }
    expect(produced()?.[0]).toBe(file);
  });

  it("registered subcommand names win over path interpretation", async () => {
    // No file named `doctor` exists here — if path interpretation ran first,
    // this would be the "no such file" error above instead of the doctor run.
    const { program } = await harness();
    const doctored = stub(program, "doctor");
    await program.parseAsync(["node", "ossclip", "doctor"]);
    expect(doctored()).toBeDefined();
  });

  it("bare `ossclip` with no args still prints help when piped — not an error, not a hang", async () => {
    const { program, getOut } = await harness();
    await program.parseAsync(["node", "ossclip"]);
    expect(getOut()).toMatch(/Usage: ossclip/);
  });
});
