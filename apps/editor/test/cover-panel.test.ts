// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CoverPanel,
  coverRegenerateBody,
  coverUnavailableMessage,
  frameSourceNote,
  headlinePreview,
  parseAtSeconds,
  sourceFrameOption,
  type CoverInfo,
  type CoverProvenanceView,
} from "../src/CoverPanel";

// Same mount conventions as thumbnail-panel.test.ts: real createRoot, mocked
// fetch, no module mocking.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** React reads a controlled input's value through the native setter — assign
 * the way youtube-panel.test.ts drives its fields, or the change never lands. */
function setInputValue(el: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("coverUnavailableMessage", () => {
  it("names the fix for the one reason that blocks the panel outright", () => {
    expect(coverUnavailableMessage("no-destination")).toContain("--out");
    expect(coverUnavailableMessage(undefined)).toContain("unavailable");
  });
});

describe("headlinePreview", () => {
  it("a headline inside the cap previews unchanged and is NOT reported as trimmed", () => {
    const { preview, trimmed } = headlinePreview("SIX MONTHS OF MAX, FREE");
    expect(preview).toBe("SIX MONTHS OF MAX, FREE");
    expect(trimmed).toBe(false);
  });

  it("double spaces are collapsed but never cry wolf as a trim (resolveCoverText's rule)", () => {
    const { preview, trimmed } = headlinePreview("  SHIP  IT  ");
    expect(preview).toBe("SHIP IT");
    expect(trimmed).toBe(false);
  });

  it("an over-long headline previews the §35 trim the render will actually use", () => {
    const { preview, trimmed } = headlinePreview(
      "THE ONE THING NOBODY TELLS YOU ABOUT THE FUTURE OF WORK",
    );
    expect(trimmed).toBe(true);
    expect(preview.split(" ").length).toBeLessThanOrEqual(9);
    // The trimming rules are core's, not restated here — this asserts the
    // panel shows what coverHeadline decided, right down to the §35 rule that
    // a cut may not end on a dangling word ("OF WORK" goes, "THE FUTURE"
    // stays because the cap fell there).
    expect(preview).toBe("THE ONE THING NOBODY TELLS YOU ABOUT THE FUTURE");
  });
});

describe("parseAtSeconds", () => {
  it("blank is 'no timestamp' — the cheap path, and NOT zero", () => {
    expect(parseAtSeconds("")).toEqual({ ok: true });
    expect(parseAtSeconds("   ")).toEqual({ ok: true });
    // Zero is a real, different answer: seek to the first frame.
    expect(parseAtSeconds("0")).toEqual({ ok: true, atSec: 0 });
  });

  it("parses a decimal timestamp", () => {
    expect(parseAtSeconds("12.4")).toEqual({ ok: true, atSec: 12.4 });
  });

  it("refuses a negative or non-numeric field rather than seeking to zero", () => {
    expect(parseAtSeconds("-3").ok).toBe(false);
    expect(parseAtSeconds("abc").ok).toBe(false);
  });
});

describe("frameSourceNote", () => {
  it("states the burned-in caveat for final and the cleanliness of source", () => {
    expect(frameSourceNote("final")).toContain("burned-in");
    expect(frameSourceNote("source")).toContain("clean");
  });
});

describe("sourceFrameOption", () => {
  const provenance = (sourceVideo: string | null): CoverProvenanceView => ({
    text: "SHIP IT",
    textSource: "beatsheet",
    frame: { source: "final", timeSec: 4.2, sourceVideo },
    size: { width: 1080, height: 1920 },
    out: "/tmp/clip.ossclip.cover.jpg",
  });

  it("a recorded take is a live option", () => {
    expect(sourceFrameOption(provenance("mezzanine.mp4"))).toEqual({ enabled: true });
  });

  it("a null sourceVideo is the file saying the take is unknown — no live option", () => {
    // The pre-feature case, and any project whose cover was only ever built
    // from the final render. The server refuses this request; the panel just
    // stops offering it.
    const opt = sourceFrameOption(provenance(null));
    expect(opt.enabled).toBe(false);
    expect(opt.note).toContain("no record of the original take");
    expect(opt.note).toContain("ossclip produce");
  });

  it("no provenance at all is the same answer", () => {
    expect(sourceFrameOption(null)).toEqual(sourceFrameOption(provenance(null)));
  });
});

describe("coverRegenerateBody", () => {
  it("carries text, timestamp and video — and NEVER a path", () => {
    const body = coverRegenerateBody({
      typed: "SHIP IT",
      persistedText: "OLD HEADLINE",
      atSec: 12.4,
      from: "final",
    });
    expect(body).toEqual({ text: "SHIP IT", atSec: 12.4, from: "final" });
    // The security stance, asserted on the client half too: no key here can
    // ever name a file for the server to write.
    for (const key of Object.keys(body)) {
      expect(["text", "atSec", "from"]).toContain(key);
    }
  });

  it("omits text when it still matches what is persisted — `ossclip cover --at` parity", () => {
    // Sending it back unchanged would flip textSource to "user" and pin the
    // generated headline against every future produce, for someone who only
    // wanted a different frame.
    expect(
      coverRegenerateBody({
        typed: "OLD HEADLINE",
        persistedText: "OLD HEADLINE",
        atSec: 3,
        from: "source",
      }),
    ).toEqual({ atSec: 3, from: "source" });
  });

  it("omits atSec when the field was blank — the no-ffmpeg path", () => {
    expect(
      coverRegenerateBody({ typed: "NEW", persistedText: null, from: "final" }),
    ).toEqual({ text: "NEW", from: "final" });
  });
});

describe("CoverPanel", () => {
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

  const mount = async (playheadSec = () => 0): Promise<void> => {
    await act(async () => {
      root.render(React.createElement(CoverPanel, { onClose: () => {}, playheadSec }));
    });
    for (let i = 0; i < 10 && container.querySelectorAll("input, [data-testid]").length < 2; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };

  const stubGet = (info: CoverInfo): void => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => info })) as unknown as typeof fetch;
  };

  const READY: CoverInfo = {
    status: "ready",
    provenance: {
      text: "SHIP IT",
      textSource: "beatsheet",
      frame: { source: "source", timeSec: 4.2, sourceVideo: "mezzanine.mp4" },
      size: { width: 1080, height: 1920 },
      out: "/tmp/clip.ossclip.cover.jpg",
    },
    outPath: "/tmp/clip.ossclip.cover.jpg",
    imageUrl: "/api/cover/image?ts=123",
  };

  it("a workdir with nowhere to write shows the reason plainly, no controls", async () => {
    stubGet({
      status: "unavailable",
      reason: "no-destination",
      provenance: null,
      outPath: null,
      imageUrl: null,
    });
    await mount();
    expect(container.querySelector('[data-testid="cover-unavailable"]')?.textContent).toContain(
      "--out",
    );
    expect(container.querySelector('[data-testid="cover-apply-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="cover-text-input"]')).toBeNull();
  });

  it("ready: prefills the headline and the frame source, shows the ?ts-busted image", async () => {
    stubGet(READY);
    await mount();
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="cover-text-input"]')?.value,
    ).toBe("SHIP IT");
    // The persisted timestamp is deliberately NOT prefilled — a blank field is
    // "re-use the still on disk", the path that runs no ffmpeg.
    expect(container.querySelector<HTMLInputElement>('[data-testid="cover-at-input"]')?.value).toBe(
      "",
    );
    expect(
      container.querySelector('[data-testid="cover-from-source"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(container.querySelector<HTMLImageElement>('[data-testid="cover-image"]')?.src).toContain(
      "/api/cover/image?ts=123",
    );
    // A recorded take, so both frame sources are live and there is nothing to
    // explain away.
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="cover-from-source"]')?.disabled,
    ).toBe(false);
    expect(container.querySelector('[data-testid="cover-from-disabled-note"]')).toBeNull();
  });

  // 2026-08-19: the toggle was offered unconditionally, so on a project with
  // no recorded take the user learned that "Original take" cannot work from a
  // server error after Apply.
  it("no recorded take: the 'original take' option is disabled and says why", async () => {
    stubGet({
      ...READY,
      provenance: {
        ...READY.provenance!,
        frame: { ...READY.provenance!.frame, source: "final", sourceVideo: null },
      },
    });
    await mount();
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="cover-from-source"]')?.disabled,
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="cover-from-disabled-note"]')?.textContent,
    ).toContain("no record of the original take");
    // The finished video is still selected, and Apply is still a live button:
    // this closes one control, not the panel.
    expect(
      container.querySelector('[data-testid="cover-from-final"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="cover-apply-btn"]')?.disabled,
    ).toBe(false);
  });

  it("no cover on disk yet shows the placeholder and keeps the controls", async () => {
    stubGet({
      status: "ready",
      reason: "never-rendered",
      provenance: null,
      outPath: "/tmp/clip.ossclip.cover.jpg",
      imageUrl: null,
    });
    await mount();
    expect(container.querySelector('[data-testid="cover-placeholder"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="cover-image"]')).toBeNull();
    expect(container.querySelector('[data-testid="cover-apply-btn"]')).not.toBeNull();
    // No provenance at all is the pre-feature workdir: nothing names a take,
    // so the same option is dead here.
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="cover-from-source"]')?.disabled,
    ).toBe(true);
  });

  it("'use current playhead' fills the seconds field from the getter, at click time", async () => {
    stubGet(READY);
    let now = 4;
    await mount(() => now);
    now = 17.5;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="cover-playhead-btn"]')!.click();
    });
    // 17.50, not 4 — the getter is read on the click, so a playhead that moved
    // after the panel opened is the one that lands in the field.
    expect(container.querySelector<HTMLInputElement>('[data-testid="cover-at-input"]')?.value).toBe(
      "17.50",
    );
  });

  it("a bad seconds field blocks Apply instead of seeking to zero", async () => {
    stubGet(READY);
    await mount();
    const field = container.querySelector<HTMLInputElement>('[data-testid="cover-at-input"]')!;
    await act(async () => {
      setInputValue(field, "-3");
    });
    expect(container.querySelector('[data-testid="cover-at-error"]')).not.toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="cover-apply-btn"]')?.disabled,
    ).toBe(true);
  });

  it("a failed regenerate shows the server's message VERBATIM", async () => {
    global.fetch = vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return { ok: true, json: async () => ({ ok: false, error: "no frame at 90.0s of clip.mp4" }) };
      }
      return { ok: true, json: async () => READY };
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="cover-apply-btn"]')!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('[data-testid="cover-error"]')?.textContent).toBe(
      "no frame at 90.0s of clip.mp4",
    );
  });

  it("a successful Apply swaps in the fresh image and shows the server's notes", async () => {
    const bodies: unknown[] = [];
    global.fetch = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(init.body!));
        return {
          ok: true,
          json: async () => ({
            ok: true,
            provenance: { ...READY.provenance, text: "SHIP IT NOW" },
            notes: ["▸ headline trimmed to 9 words: \"SHIP IT NOW\""],
            imageUrl: "/api/cover/image?ts=456",
          }),
        };
      }
      return { ok: true, json: async () => READY };
    }) as unknown as typeof fetch;
    await mount();
    const field = container.querySelector<HTMLInputElement>('[data-testid="cover-text-input"]')!;
    await act(async () => {
      setInputValue(field, "SHIP IT NOW");
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="cover-apply-btn"]')!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(bodies).toEqual([{ text: "SHIP IT NOW", from: "source" }]);
    expect(container.querySelector<HTMLImageElement>('[data-testid="cover-image"]')?.src).toContain(
      "ts=456",
    );
    expect(container.querySelector('[data-testid="cover-notes"]')?.textContent).toContain("trimmed");
    expect(container.querySelector('[data-testid="cover-error"]')).toBeNull();
  });
});
