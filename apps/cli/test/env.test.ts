import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFiles } from "../src/env";

const KEYS = ["OSSCLIP_TEST_A", "OSSCLIP_TEST_B", "GEMINI_API_KEY", "OSSCLIP_ENV_FILE"];
const saved = new Map<string, string | undefined>();
for (const k of KEYS) saved.set(k, process.env[k]);

afterEach(() => {
  for (const k of KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const dirWithEnv = (body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "ossclip-env-"));
  writeFileSync(join(dir, ".env"), body);
  return dir;
};

describe("loadEnvFiles (R16 §77)", () => {
  it("reads KEY=value from <cwd>/.env", () => {
    delete process.env.OSSCLIP_TEST_A;
    const dir = dirWithEnv("OSSCLIP_TEST_A=from-file\n");
    expect(loadEnvFiles(dir)).toEqual([join(dir, ".env")]);
    expect(process.env.OSSCLIP_TEST_A).toBe("from-file");
  });

  it("a real environment variable WINS over the file", () => {
    // `GEMINI_API_KEY=… ossclip produce` must not be overridden by a stale
    // .env sitting in the repo the command happened to run from.
    process.env.OSSCLIP_TEST_A = "from-shell";
    const dir = dirWithEnv("OSSCLIP_TEST_A=from-file\n");
    loadEnvFiles(dir);
    expect(process.env.OSSCLIP_TEST_A).toBe("from-shell");
  });

  it("skips comments and blanks, strips `export` and quotes", () => {
    delete process.env.OSSCLIP_TEST_A;
    delete process.env.OSSCLIP_TEST_B;
    const dir = dirWithEnv(
      ["# a comment", "", "export OSSCLIP_TEST_A=plain", 'OSSCLIP_TEST_B="quoted value"'].join("\n"),
    );
    loadEnvFiles(dir);
    expect(process.env.OSSCLIP_TEST_A).toBe("plain");
    expect(process.env.OSSCLIP_TEST_B).toBe("quoted value");
  });

  it("a value containing '=' survives", () => {
    delete process.env.OSSCLIP_TEST_A;
    const dir = dirWithEnv("OSSCLIP_TEST_A=a=b=c\n");
    loadEnvFiles(dir);
    expect(process.env.OSSCLIP_TEST_A).toBe("a=b=c");
  });

  it("walks UP to find a repo-root .env", () => {
    // `pnpm --filter ossclip exec …` runs with the cwd at apps/cli, so a
    // repo-root .env is invisible without this — which is exactly how the
    // first §77 run still failed with 'GEMINI_API_KEY is not set'.
    delete process.env.OSSCLIP_TEST_A;
    const root = dirWithEnv("OSSCLIP_TEST_A=from-root\n");
    const nested = join(root, "apps", "cli");
    mkdirSync(nested, { recursive: true });
    expect(loadEnvFiles(nested)).toEqual([join(root, ".env")]);
    expect(process.env.OSSCLIP_TEST_A).toBe("from-root");
  });

  it("the NEAREST .env wins over one further up", () => {
    delete process.env.OSSCLIP_TEST_A;
    const root = dirWithEnv("OSSCLIP_TEST_A=from-root\n");
    const nested = join(root, "apps", "cli");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, ".env"), "OSSCLIP_TEST_A=from-nested\n");
    loadEnvFiles(nested);
    expect(process.env.OSSCLIP_TEST_A).toBe("from-nested");
  });

  it("a missing file is not an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-env-"));
    expect(() => loadEnvFiles(dir)).not.toThrow();
  });

  it("OSSCLIP_ENV_FILE is read first", () => {
    delete process.env.OSSCLIP_TEST_A;
    const explicit = dirWithEnv("OSSCLIP_TEST_A=explicit\n");
    const cwd = dirWithEnv("OSSCLIP_TEST_A=cwd\n");
    process.env.OSSCLIP_ENV_FILE = join(explicit, ".env");
    loadEnvFiles(cwd);
    expect(process.env.OSSCLIP_TEST_A).toBe("explicit");
  });
});
