import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { ClaudeCliProvider, extractJsonObject, unwrapCliEnvelope } from "../src/producer/claude-cli";

const schema = z.object({ title: z.string().min(1) });

/** Writes an executable stub that plays the given stdout scripts call-by-call. */
function stubClaude(...stdoutPerCall: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ossclip-claude-stub-"));
  const counter = join(dir, "calls");
  const script = [
    "#!/usr/bin/env bash",
    "cat > /dev/null", // consume the prompt on stdin
    `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
    `echo $((n+1)) > "${counter}"`,
    ...stdoutPerCall.map(
      (out, i) => `if [ "$n" -eq ${i} ]; then cat <<'EOF'\n${out}\nEOF\nexit 0; fi`,
    ),
    "exit 1",
  ].join("\n");
  const bin = join(dir, "claude");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}

const envelope = (result: string): string =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result });

describe("ClaudeCliProvider", () => {
  it("parses a clean envelope reply", async () => {
    const bin = stubClaude(envelope('{"title": "FROM THE CLI"}'));
    const provider = new ClaudeCliProvider(undefined, bin);
    const out = await provider.complete({ system: "s", user: "u", schema, schemaName: "t" });
    expect(out).toEqual({ title: "FROM THE CLI" });
  });

  it("tolerates markdown fences and prose around the JSON", async () => {
    const bin = stubClaude(envelope('Sure! Here it is:\n```json\n{"title": "FENCED"}\n```'));
    const provider = new ClaudeCliProvider(undefined, bin);
    const out = await provider.complete({ system: "s", user: "u", schema, schemaName: "t" });
    expect(out).toEqual({ title: "FENCED" });
  });

  it("self-repairs once when the first reply fails validation", async () => {
    const bin = stubClaude(envelope('{"title": ""}'), envelope('{"title": "FIXED"}'));
    const provider = new ClaudeCliProvider(undefined, bin);
    const out = await provider.complete({ system: "s", user: "u", schema, schemaName: "t" });
    expect(out).toEqual({ title: "FIXED" });
  });

  it("throws with install/login guidance after two bad replies", async () => {
    const bin = stubClaude(envelope("not json at all"), envelope("still not json"));
    const provider = new ClaudeCliProvider(undefined, bin);
    await expect(
      provider.complete({ system: "s", user: "u", schema, schemaName: "t" }),
    ).rejects.toThrow(/logged in/);
  });

  it("surfaces CLI-side errors from the envelope", () => {
    expect(() =>
      unwrapCliEnvelope(JSON.stringify({ is_error: true, result: "usage limit reached" })),
    ).toThrow(/usage limit/);
  });

  it("extractJsonObject rejects reply with no object", () => {
    expect(() => extractJsonObject("no braces here")).toThrow(/no JSON object/);
  });
});
