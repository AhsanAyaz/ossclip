import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The README and the docs site each carry the install commands, on purpose
 * (a single-source generator is more machinery than two files deserve) —
 * but they drifted once before this test existed. This asserts the actual
 * COMMANDS match; the prose around them is free to differ per medium.
 */

const readmeText = () => readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
const siteText = () =>
  readFileSync(new URL("../../../docs/site/index.html", import.meta.url), "utf8");

/** Fenced code blocks between "## Install" and "## Quick start" in the README. */
function readmeInstallBlocks(): string[] {
  const md = readmeText();
  const section = md.slice(md.indexOf("## Install"), md.indexOf("## Quick start"));
  return [...section.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => normalize(m[1] ?? ""));
}

/** <pre><code> blocks between the install and quickstart headings on the site. */
function siteInstallBlocks(): string[] {
  const html = siteText();
  const section = html.slice(html.indexOf('id="install"'), html.indexOf('id="quickstart"'));
  return [...section.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) =>
    normalize(decode(m[1] ?? "")),
  );
}

const decode = (s: string): string =>
  s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");

const normalize = (s: string): string =>
  s
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

describe("README ↔ docs site install parity", () => {
  it("both carry the same install command blocks, in the same order", () => {
    const readme = readmeInstallBlocks();
    const site = siteInstallBlocks();
    expect(readme.length).toBeGreaterThanOrEqual(2); // quickstart + manual
    expect(site).toEqual(readme);
  });

  it("both lead with the two-command quickstart", () => {
    for (const blocks of [readmeInstallBlocks(), siteInstallBlocks()]) {
      expect(blocks[0]).toBe("npm install -g ossclip\nossclip setup");
    }
  });
});
