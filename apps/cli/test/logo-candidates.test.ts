import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractLogoCandidates, manifestIcons, manifestUrl, withManifestIcons } from "../src/logo-candidates";

const page = (name: string): string => readFileSync(fileURLToPath(new URL(`fixtures/logo-pages/${name}`, import.meta.url)), "utf8");

describe("extractLogoCandidates", () => {
  it("puts the header logo first, then icons largest first, then og:image", () => {
    const got = extractLogoCandidates(page("header-img.html"), "https://firebase.google.com/", "Firebase");
    expect(got).toEqual([
      // `class="brand-logo"` matches "logo"; the CDN wordmark matches the name
      // in its src. The hamburger matches neither and is not a logo.
      { url: "https://firebase.google.com/images/firebase-logo.svg", source: "header" },
      { url: "https://cdn.example.com/firebase-wordmark.png", source: "header" },
      { url: "https://firebase.google.com/apple-touch-icon.png", source: "icon" },
      { url: "https://firebase.google.com/favicon-32.png", source: "icon" },
      { url: "https://firebase.google.com/og-banner.png", source: "og" },
    ]);
  });

  it("ignores a logo-classed <img> outside header/nav and markup inside <script>", () => {
    const urls = extractLogoCandidates(page("header-img.html"), "https://firebase.google.com/", "Firebase").map(
      (c) => c.url,
    );
    expect(urls).not.toContain("https://firebase.google.com/not-in-header-logo.png");
    expect(urls).not.toContain("https://firebase.google.com/from-script.png");
    expect(urls).not.toContain("https://firebase.google.com/hero.png");
  });

  it("ranks a 180 apple-touch-icon before a 32 icon, dedupes, and drops favicon.ico", () => {
    expect(extractLogoCandidates(page("icons-only.html"), "https://example.com/", "Example")).toEqual([
      { url: "https://example.com/icons/apple-180.png", source: "icon" },
      { url: "https://example.com/icons/icon-32.png", source: "icon" },
    ]);
  });

  it("falls back to og:image alone", () => {
    expect(extractLogoCandidates(page("og-only.html"), "https://kimi.ai/", "Kimi")).toEqual([
      { url: "https://kimi.ai/social/card.png", source: "og" },
    ]);
  });

  it("takes nothing from an inline <svg> logo in the header (logo-finder spec §Step 2, Not used)", () => {
    expect(extractLogoCandidates(page("inline-svg.html"), "https://claude.ai/", "Claude")).toEqual([]);
  });

  it("resolves relative and protocol-relative URLs, drops data: and the #fragment, ranks svg largest", () => {
    expect(extractLogoCandidates(page("relative.html"), "https://example.com/docs/page", "Example")).toEqual([
      { url: "https://example.com/assets/logo.png?v=2", source: "header" },
      { url: "https://example.com/docs/icon.svg", source: "icon" },
      { url: "https://static.example.com/touch.png", source: "icon" },
    ]);
  });

  it("matches the name case-insensitively and tolerates unquoted and single-quoted attributes", () => {
    const html = `<HEADER><IMG SRC=/a.png ALT=ACME><img src='/b.png' aria-label='Go home'></HEADER>`;
    expect(extractLogoCandidates(html, "https://acme.com/", "Acme")).toEqual([
      { url: "https://acme.com/a.png", source: "header" },
    ]);
  });

  it("a `>` inside a quoted attribute does not end the tag", () => {
    const html = `<header><img alt="a > b" class="logo" src="/l.png"></header>`;
    expect(extractLogoCandidates(html, "https://x.com/", "X")).toEqual([{ url: "https://x.com/l.png", source: "header" }]);
  });

  it("ignores an <img> inside a comment in the header", () => {
    const html = `<header><!-- <img class=logo src="/old.png"> --><img class="logo" src="/new.png"></header>`;
    expect(extractLogoCandidates(html, "https://x.com/", "X")).toEqual([{ url: "https://x.com/new.png", source: "header" }]);
  });

  it("an unclosed attribute quote costs the rest of the page, not the run", () => {
    // The quote after `class=` never closes, so the scanner reads it to the end.
    const html = `<header><img class="logo" src="/a.png"><img class="logo src=/b.png></header><link rel=icon href=/i.png>`;
    expect(extractLogoCandidates(html, "https://x.com/", "X")).toEqual([{ url: "https://x.com/a.png", source: "header" }]);
  });

  it("is empty for junk input", () => {
    expect(extractLogoCandidates("", "https://x.com/", "X")).toEqual([]);
    expect(extractLogoCandidates("<<<>>><header", "https://x.com/", "X")).toEqual([]);
  });
});

describe("manifestUrl", () => {
  it("resolves the manifest link against the page", () => {
    expect(manifestUrl(page("header-img.html"), "https://firebase.google.com/")).toBe(
      "https://firebase.google.com/site.webmanifest",
    );
  });

  it("is undefined without one, or for a non-http(s) href", () => {
    expect(manifestUrl(page("og-only.html"), "https://kimi.ai/")).toBeUndefined();
    expect(manifestUrl(`<link rel="manifest" href="javascript:alert(1)">`, "https://kimi.ai/")).toBeUndefined();
  });
});

describe("manifestIcons", () => {
  it("lists icons largest first, svg as largest, resolved against the manifest URL", () => {
    const json = {
      icons: [
        { src: "icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "icon-512.png", sizes: "512x512" },
        { src: "/mark.svg", type: "image/svg+xml", sizes: "any" },
        { src: "icon-512.png", sizes: "512x512" },
      ],
    };
    expect(manifestIcons(json, "https://example.com/static/app.webmanifest")).toEqual([
      "https://example.com/mark.svg",
      "https://example.com/static/icon-512.png",
      "https://example.com/static/icon-192.png",
    ]);
  });

  it("skips a malformed icon and survives a malformed manifest", () => {
    const base = "https://example.com/m.json";
    expect(manifestIcons({ icons: [{ src: 5 }, { src: "ok.png", sizes: "96x96" }] }, base)).toEqual([
      "https://example.com/ok.png",
    ]);
    expect(manifestIcons({ icons: "nope" }, base)).toEqual([]);
    expect(manifestIcons(null, base)).toEqual([]);
    expect(manifestIcons("text", base)).toEqual([]);
  });
});

describe("withManifestIcons", () => {
  it("inserts manifest icons before og:image and dedupes against what the page listed", () => {
    const fromPage = [
      { url: "https://x.com/h.svg", source: "header" as const },
      { url: "https://x.com/i.png", source: "icon" as const },
      { url: "https://x.com/og.png", source: "og" as const },
    ];
    expect(withManifestIcons(fromPage, ["https://x.com/i.png", "https://x.com/m.png"])).toEqual([
      { url: "https://x.com/h.svg", source: "header" },
      { url: "https://x.com/i.png", source: "icon" },
      { url: "https://x.com/m.png", source: "manifest" },
      { url: "https://x.com/og.png", source: "og" },
    ]);
  });
});
