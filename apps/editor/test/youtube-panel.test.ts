// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NO_PACK_MESSAGE,
  TAGS_CHAR_LIMIT,
  TITLES_MAX,
  TITLES_MIN,
  YoutubePanel,
  angleLabel,
  chapterStampLabel,
  hashtagsFromLine,
  hashtagsToLine,
  tagsBudgetUsed,
  tagsFromLine,
  tagsToLine,
  type YoutubeInfo,
  type YoutubePackInfo,
} from "../src/YoutubePanel";

// Same mount conventions as thumbnail-panel.test.ts: real createRoot, mocked
// fetch, no module mocking.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("hashtag line split/join", () => {
  it("prepends # when missing and keeps an existing one exactly once", () => {
    expect(hashtagsFromLine("#agents llm #devtools")).toEqual(["#agents", "#llm", "#devtools"]);
  });

  it("extra spaces and empty entries drop", () => {
    expect(hashtagsFromLine("  #a    b  ")).toEqual(["#a", "#b"]);
    expect(hashtagsFromLine("")).toEqual([]);
    expect(hashtagsFromLine("   ")).toEqual([]);
  });

  it("a bare # with no word is noise, not a hashtag", () => {
    expect(hashtagsFromLine("# #real ##")).toEqual(["#real"]);
  });

  it("toLine ensures # and round-trips with fromLine", () => {
    expect(hashtagsToLine(["#agents", "llm"])).toBe("#agents #llm");
    const line = "#agents #llm";
    expect(hashtagsToLine(hashtagsFromLine(line))).toBe(line);
  });
});

describe("tag line split/join and the 500 budget", () => {
  it("splits on commas, trims, drops empties", () => {
    expect(tagsFromLine(" ai agents ,llm tutorial,,  ")).toEqual(["ai agents", "llm tutorial"]);
    expect(tagsFromLine("")).toEqual([]);
  });

  it("toLine uses YouTube's own comma-space spelling", () => {
    expect(tagsToLine(["a", "b"])).toBe("a, b");
  });

  it("the counter measures the NORMALIZED joined line, exactly what trimTagsToLimit counts", () => {
    // Sloppy whitespace must not inflate the number past what actually counts.
    expect(tagsBudgetUsed("  a  ,   b ")).toBe("a, b".length);
    // Boundary: two 249-char tags join to exactly the 500 budget.
    const line = `${"a".repeat(249)}, ${"b".repeat(249)}`;
    expect(tagsBudgetUsed(line)).toBe(TAGS_CHAR_LIMIT);
  });
});

describe("chapterStampLabel", () => {
  it("spells seconds the way YouTube's chapter list does", () => {
    expect(chapterStampLabel(0)).toBe("0:00");
    expect(chapterStampLabel(65)).toBe("1:05");
    expect(chapterStampLabel(125.9)).toBe("2:05");
  });
});

describe("angleLabel", () => {
  it("spells each angle the way the markdown's numbered list does (core's ANGLE_LABELS)", () => {
    expect(angleLabel("browse")).toBe("[Browse]");
    expect(angleLabel("search")).toBe("[Search]");
    expect(angleLabel("benefit")).toBe("[Benefit]");
    expect(angleLabel("alt")).toBe("[Alt]");
  });
});

describe("YoutubePanel", () => {
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
      root.render(React.createElement(YoutubePanel, { onClose: () => {} }));
    });
    // The mount fetch resolves over a couple of microtask turns — poll like
    // the thumbnail test does rather than assume one.
    for (let i = 0; i < 10 && container.querySelectorAll("input, [data-testid]").length < 2; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };

  const pack = {
    titles: ["How agents actually work", "5 agent mistakes", "Agents in 8 minutes"],
    description: "The one agent pattern nobody explains.",
    hashtags: ["#agents", "llm"],
    tags: ["ai agents", "llm tutorial"],
    chapters: [
      { atSec: 0, title: "Hook" },
      { atSec: 65, title: "The pattern" },
    ],
  };

  const stubGet = (info: YoutubeInfo): void => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => info,
    })) as unknown as typeof fetch;
  };

  it("no pack: shows the no-pack message plainly, no controls", async () => {
    stubGet({ available: false, reason: "no-pack", pack: null, mdPath: null });
    await mount();
    expect(container.querySelector('[data-testid="youtube-unavailable"]')?.textContent).toBe(
      NO_PACK_MESSAGE,
    );
    expect(container.querySelector('[data-testid="youtube-save-btn"]')).toBeNull();
  });

  it("prefills titles, description, joined hashtag/tag lines and read-only chapters", async () => {
    stubGet({ available: true, pack, mdPath: "/out/final.youtube.md" });
    await mount();
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="youtube-title-input-0"]')?.value,
    ).toBe("How agents actually work");
    expect(container.querySelector('[data-testid="youtube-title-input-2"]')).not.toBeNull();
    expect(
      container.querySelector<HTMLTextAreaElement>('[data-testid="youtube-description-input"]')
        ?.value,
    ).toBe(pack.description);
    // The hashtag line carries # on every entry, whether the pack did or not.
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="youtube-hashtags-input"]')?.value,
    ).toBe("#agents #llm");
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="youtube-tags-input"]')?.value,
    ).toBe("ai agents, llm tutorial");
    expect(container.querySelector('[data-testid="youtube-tags-counter"]')?.textContent).toContain(
      `${"ai agents, llm tutorial".length} / ${TAGS_CHAR_LIMIT}`,
    );
    const chapters = container.querySelector('[data-testid="youtube-chapters"]');
    expect(chapters?.textContent).toContain("0:00 Hook");
    expect(chapters?.textContent).toContain("1:05 The pattern");
    // Read-only: no input for chapter text.
    expect(chapters?.querySelector("input")).toBeNull();
  });

  it("title add/remove respects the schema's 3-5 bounds in the UI", async () => {
    stubGet({ available: true, pack, mdPath: null });
    await mount();
    // At the minimum, remove is disabled.
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="youtube-title-remove-0"]')
        ?.disabled,
    ).toBe(true);
    const add = container.querySelector<HTMLButtonElement>('[data-testid="youtube-title-add"]')!;
    expect(TITLES_MIN).toBe(3);
    await act(async () => {
      add.click();
    });
    await act(async () => {
      add.click();
    });
    // Now at 5 — the maximum — add is disabled and remove is possible.
    expect(container.querySelectorAll('[data-testid^="youtube-title-input-"]')).toHaveLength(
      TITLES_MAX,
    );
    expect(add.disabled).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="youtube-title-remove-0"]')
        ?.disabled,
    ).toBe(false);
  });

  it("save PUTs the NORMALIZED pack (hashtags #-ed, tags trimmed, chapters riding through)", async () => {
    const putBodies: string[] = [];
    global.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "PUT") {
        putBodies.push(init.body!);
        return { ok: true, json: async () => ({ ok: true, mdPath: null }) };
      }
      return { ok: true, json: async () => ({ available: true, pack, mdPath: null }) };
    }) as unknown as typeof fetch;
    await mount();
    const hashtags = container.querySelector<HTMLInputElement>(
      '[data-testid="youtube-hashtags-input"]',
    )!;
    const tags = container.querySelector<HTMLInputElement>('[data-testid="youtube-tags-input"]')!;
    await act(async () => {
      // React reads the input's value through the native setter — assign the
      // way other editor tests drive controlled inputs.
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(hashtags, "agents  #llm ");
      hashtags.dispatchEvent(new Event("input", { bubbles: true }));
      set.call(tags, " one , two ,, ");
      tags.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="youtube-save-btn"]')!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(putBodies).toHaveLength(1);
    const sent = JSON.parse(putBodies[0]!) as { pack: typeof pack };
    expect(sent.pack.hashtags).toEqual(["#agents", "#llm"]);
    expect(sent.pack.tags).toEqual(["one", "two"]);
    expect(sent.pack.titles).toEqual(pack.titles);
    expect(sent.pack.chapters).toEqual(pack.chapters);
  });

  const v2Pack: YoutubePackInfo = {
    ...pack,
    titleAngles: ["browse", "search", "benefit"],
    hook60: "Show the result at 0:05.",
    linkedinPost: "Story.\n\nLink in comments.",
    communityPost: "New video is live!",
  };

  // The approved-file back-compat pin, panel-side: a pack saved before
  // prompt v2 renders exactly as it did — no labels, no phantom sections —
  // and its save body carries none of the fields it never had.
  it("a pre-v2 pack shows no angle labels and hides the v2 sections", async () => {
    const putBodies: string[] = [];
    global.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "PUT") {
        putBodies.push(init.body!);
        return { ok: true, json: async () => ({ ok: true, mdPath: null }) };
      }
      return { ok: true, json: async () => ({ available: true, pack, mdPath: null }) };
    }) as unknown as typeof fetch;
    await mount();
    expect(container.querySelector('[data-testid="youtube-title-angle-0"]')).toBeNull();
    expect(container.querySelector('[data-testid="youtube-hook60-input"]')).toBeNull();
    expect(container.querySelector('[data-testid="youtube-linkedin-input"]')).toBeNull();
    expect(container.querySelector('[data-testid="youtube-community-input"]')).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="youtube-save-btn"]')!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    const sent = JSON.parse(putBodies[0]!) as { pack: Record<string, unknown> };
    expect("titleAngles" in sent.pack).toBe(false);
    expect("hook60" in sent.pack).toBe(false);
    expect("linkedinPost" in sent.pack).toBe(false);
    expect("communityPost" in sent.pack).toBe(false);
  });

  it("angle labels render per title and stay PARALLEL through remove/add", async () => {
    const putBodies: string[] = [];
    global.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "PUT") {
        putBodies.push(init.body!);
        return { ok: true, json: async () => ({ ok: true, mdPath: null }) };
      }
      return { ok: true, json: async () => ({ available: true, pack: v2Pack, mdPath: null }) };
    }) as unknown as typeof fetch;
    await mount();
    expect(container.querySelector('[data-testid="youtube-title-angle-0"]')?.textContent).toBe(
      "[Browse]",
    );
    expect(container.querySelector('[data-testid="youtube-title-angle-2"]')?.textContent).toBe(
      "[Benefit]",
    );
    // Add a fourth title: a user-written title is none of the model's three
    // angles, so it labels [Alt] — the arrays must stay parallel.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="youtube-title-add"]')!.click();
    });
    expect(container.querySelector('[data-testid="youtube-title-angle-3"]')?.textContent).toBe(
      "[Alt]",
    );
    // Remove the second: its OWN label goes with it, not a neighbour's.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="youtube-title-remove-1"]')!
        .click();
    });
    expect(container.querySelector('[data-testid="youtube-title-angle-1"]')?.textContent).toBe(
      "[Benefit]",
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="youtube-save-btn"]')!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    const sent = JSON.parse(putBodies[0]!) as { pack: YoutubePackInfo };
    expect(sent.pack.titleAngles).toEqual(["browse", "benefit", "alt"]);
    expect(sent.pack.titles).toHaveLength(3);
  });

  it("the v2 text fields prefill as editable textareas and ride the save", async () => {
    const putBodies: string[] = [];
    global.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "PUT") {
        putBodies.push(init.body!);
        return { ok: true, json: async () => ({ ok: true, mdPath: null }) };
      }
      return { ok: true, json: async () => ({ available: true, pack: v2Pack, mdPath: null }) };
    }) as unknown as typeof fetch;
    await mount();
    const hook = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="youtube-hook60-input"]',
    )!;
    expect(hook.value).toBe("Show the result at 0:05.");
    expect(
      container.querySelector<HTMLTextAreaElement>('[data-testid="youtube-linkedin-input"]')
        ?.value,
    ).toBe("Story.\n\nLink in comments.");
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(hook, "Cold-open on the demo.");
      hook.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="youtube-save-btn"]')!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    const sent = JSON.parse(putBodies[0]!) as { pack: YoutubePackInfo };
    expect(sent.pack.hook60).toBe("Cold-open on the demo.");
    expect(sent.pack.linkedinPost).toBe("Story.\n\nLink in comments.");
    expect(sent.pack.communityPost).toBe("New video is live!");
  });

  it("a failed save shows the server's error VERBATIM", async () => {
    global.fetch = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === "PUT") {
        return { ok: false, json: async () => ({ error: "titles: too small" }) };
      }
      return { ok: true, json: async () => ({ available: true, pack, mdPath: null }) };
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="youtube-save-btn"]')!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('[data-testid="youtube-error"]')?.textContent).toBe(
      "titles: too small",
    );
  });
});
