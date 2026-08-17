// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OVERLAY_CHAR_CAP,
  ThumbnailPanel,
  parsePortraitDataUrl,
  portraitSourceLabel,
  unavailableMessage,
  type ThumbnailInfo,
} from "../src/ThumbnailPanel";

// Same mount conventions as project-picker.test.ts: real createRoot, mocked
// fetch, no module mocking.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("unavailableMessage", () => {
  it("names the fix for every reason the server can send", () => {
    expect(unavailableMessage("no-youtube")).toContain("--youtube");
    expect(unavailableMessage("no-portrait")).toContain("--portrait");
    expect(unavailableMessage("no-key")).toContain("GEMINI_API_KEY");
    expect(unavailableMessage("portrait-missing")).toContain("portrait");
    expect(unavailableMessage(undefined)).toContain("unavailable");
  });
});

describe("portraitSourceLabel", () => {
  it("names the override; flag and config both read as the default headshot", () => {
    expect(portraitSourceLabel("override")).toBe("Project override");
    expect(portraitSourceLabel("flag")).toBe("Your default portrait");
    expect(portraitSourceLabel("config")).toBe("Your default portrait");
  });
});

describe("parsePortraitDataUrl", () => {
  it("splits a base64 data URL into the POST body shape", () => {
    expect(parsePortraitDataUrl("data:image/png;base64,AAAA")).toEqual({
      mimeType: "image/png",
      data: "AAAA",
    });
    // base64 payloads carry `+`, `/` and `=` — they must survive the split.
    expect(parsePortraitDataUrl("data:image/jpeg;base64,a+b/c==")).toEqual({
      mimeType: "image/jpeg",
      data: "a+b/c==",
    });
  });

  it("anything that is not a base64 data URL is null", () => {
    expect(parsePortraitDataUrl("data:image/png,AAAA")).toBeNull();
    expect(parsePortraitDataUrl("https://example.com/face.png")).toBeNull();
    expect(parsePortraitDataUrl("")).toBeNull();
  });
});

describe("ThumbnailPanel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  const mount = async (): Promise<void> => {
    await act(async () => {
      root.render(React.createElement(ThumbnailPanel, { onClose: () => {} }));
    });
    // The mount fetch resolves over a couple of microtask turns — poll like
    // the picker test does rather than assume one.
    for (let i = 0; i < 10 && container.querySelectorAll("input, [data-testid]").length < 2; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };

  const stubGet = (info: ThumbnailInfo): void => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => info,
    })) as unknown as typeof fetch;
  };

  it("an unavailable project shows the reason plainly, no controls", async () => {
    stubGet({
      status: "unavailable",
      reason: "no-youtube",
      concept: null,
      imageUrl: null,
      model: "m",
    });
    await mount();
    const notice = container.querySelector('[data-testid="thumbnail-unavailable"]');
    expect(notice?.textContent).toContain("--youtube");
    expect(container.querySelector('[data-testid="thumbnail-regenerate-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="thumbnail-overlay-input"]')).toBeNull();
  });

  it("ready: prefills the three fields from the concept and shows the ?ts-busted image", async () => {
    stubGet({
      status: "ready",
      concept: { scene: "a terminal", overlayText: "SHIP IT", styleNotes: "dark" },
      imageUrl: "/api/thumbnail/image?ts=123",
      model: "m",
    });
    await mount();
    const overlay = container.querySelector<HTMLInputElement>(
      '[data-testid="thumbnail-overlay-input"]',
    );
    expect(overlay?.value).toBe("SHIP IT");
    // The schema's character budget rides the input itself.
    expect(overlay?.maxLength).toBe(OVERLAY_CHAR_CAP);
    expect(
      container.querySelector<HTMLTextAreaElement>('[data-testid="thumbnail-scene-input"]')?.value,
    ).toBe("a terminal");
    expect(
      container.querySelector<HTMLTextAreaElement>('[data-testid="thumbnail-style-input"]')?.value,
    ).toBe("dark");
    expect(
      container.querySelector<HTMLImageElement>('[data-testid="thumbnail-image"]')?.src,
    ).toContain("/api/thumbnail/image?ts=123");
  });

  it("ready with nothing generated yet shows the placeholder, not a broken img", async () => {
    stubGet({
      status: "ready",
      reason: "never-generated",
      concept: null,
      imageUrl: null,
      model: "m",
    });
    await mount();
    expect(container.querySelector('[data-testid="thumbnail-placeholder"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="thumbnail-image"]')).toBeNull();
    // Controls stay — the user can type a concept and generate the first one.
    expect(container.querySelector('[data-testid="thumbnail-regenerate-btn"]')).not.toBeNull();
  });

  it("a skipped project keeps the controls and says regenerating replaces the decision", async () => {
    stubGet({
      status: "skipped",
      reason: "skip-file",
      concept: null,
      imageUrl: null,
      model: "m",
    });
    await mount();
    expect(
      container.querySelector('[data-testid="thumbnail-skipped-note"]')?.textContent,
    ).toContain("skipped");
    expect(container.querySelector('[data-testid="thumbnail-regenerate-btn"]')).not.toBeNull();
  });

  it("the portrait strip shows the swapped face with 'Use default'; hidden with no portrait", async () => {
    stubGet({
      status: "ready",
      concept: { scene: "s", overlayText: "GO", styleNotes: "n" },
      imageUrl: null,
      model: "m",
      portrait: { url: "/api/thumbnail/portrait-image?ts=9", source: "override" },
    });
    await mount();
    expect(
      container.querySelector<HTMLImageElement>('[data-testid="portrait-preview"]')?.src,
    ).toContain("/api/thumbnail/portrait-image?ts=9");
    expect(container.querySelector('[data-testid="portrait-source"]')?.textContent).toBe(
      "Project override",
    );
    // Reverting only makes sense when there IS an override to revert.
    expect(container.querySelector('[data-testid="portrait-reset-btn"]')).not.toBeNull();
    // The strip says the swap is per-project and persists into renders.
    expect(
      container.querySelector('[data-testid="portrait-strip"]')?.textContent,
    ).toContain("this project only");
  });

  it("a default portrait shows Swap face… but no 'Use default'", async () => {
    stubGet({
      status: "ready",
      concept: { scene: "s", overlayText: "GO", styleNotes: "n" },
      imageUrl: null,
      model: "m",
      portrait: { url: "/api/thumbnail/portrait-image?ts=1", source: "config" },
    });
    await mount();
    expect(container.querySelector('[data-testid="portrait-source"]')?.textContent).toBe(
      "Your default portrait",
    );
    expect(container.querySelector('[data-testid="portrait-swap-btn"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="portrait-reset-btn"]')).toBeNull();
    // The hidden file input only ever offers the accepted table.
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="portrait-file-input"]')?.accept,
    ).toBe("image/png,image/jpeg,image/webp");
  });

  it("no portrait in the response (or a pre-swap server): no strip at all", async () => {
    stubGet({
      status: "ready",
      concept: { scene: "s", overlayText: "GO", styleNotes: "n" },
      imageUrl: null,
      model: "m",
    });
    await mount();
    expect(container.querySelector('[data-testid="portrait-strip"]')).toBeNull();
  });

  it("'Use default' DELETEs and swaps the strip to the re-resolved fallback", async () => {
    const info: ThumbnailInfo = {
      status: "ready",
      concept: { scene: "s", overlayText: "GO", styleNotes: "n" },
      imageUrl: null,
      model: "m",
      portrait: { url: "/api/thumbnail/portrait-image?ts=9", source: "override" },
    };
    global.fetch = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "DELETE") {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            portrait: { url: "/api/thumbnail/portrait-image?ts=10", source: "flag" },
          }),
        };
      }
      return { ok: true, json: async () => info };
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="portrait-reset-btn"]')!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('[data-testid="portrait-source"]')?.textContent).toBe(
      "Your default portrait",
    );
    expect(container.querySelector('[data-testid="portrait-reset-btn"]')).toBeNull();
  });

  it("a failed regenerate shows the server's error VERBATIM", async () => {
    const info: ThumbnailInfo = {
      status: "ready",
      concept: { scene: "s", overlayText: "GO", styleNotes: "n" },
      imageUrl: null,
      model: "m",
    };
    global.fetch = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return { ok: true, json: async () => ({ ok: false, error: "models/nope is not found" }) };
      }
      return { ok: true, json: async () => info };
    }) as unknown as typeof fetch;
    await mount();
    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="thumbnail-regenerate-btn"]',
    );
    await act(async () => {
      btn!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('[data-testid="thumbnail-error"]')?.textContent).toBe(
      "models/nope is not found",
    );
  });

  it("a successful regenerate swaps in the fresh imageUrl", async () => {
    const info: ThumbnailInfo = {
      status: "ready",
      concept: { scene: "s", overlayText: "GO", styleNotes: "n" },
      imageUrl: "/api/thumbnail/image?ts=1",
      model: "m",
    };
    global.fetch = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({ ok: true, imageUrl: "/api/thumbnail/image?ts=2" }),
        };
      }
      return { ok: true, json: async () => info };
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="thumbnail-regenerate-btn"]')!
        .click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(
      container.querySelector<HTMLImageElement>('[data-testid="thumbnail-image"]')?.src,
    ).toContain("ts=2");
    expect(container.querySelector('[data-testid="thumbnail-error"]')).toBeNull();
  });
});
