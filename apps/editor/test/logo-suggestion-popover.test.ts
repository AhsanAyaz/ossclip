// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OverlayEntrySnapshot } from "@ossclip/core/browser";
import { LogoSuggestionPopover } from "../src/LogoSuggestionPopover";
import type { SuggestionChip } from "../src/overlayLane";

/**
 * The suggestion popover against a stubbed server (logo-finder spec §Editor).
 * The claims: "Use this" is library add → stage → `onPicked`, three awaited
 * steps, the candidate named by `(suggestion, n)` and never a path; a failure
 * in either request shows inline and picks nothing; and a chip with no
 * candidates shows its note instead of thumbnails.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHIP: SuggestionChip = { id: "google-gemini", name: "Google Gemini", atSec: 12.4, word: 30, candidateCount: 3 };
const SNAP: OverlayEntrySnapshot = { id: "gemini", name: "Gemini", names: ["Gemini"], kind: "logo", ext: "png" };

type Call = { url: string; method: string; contentType: string | null; body: unknown };

function stubServer(routes: Record<string, (body: unknown) => { status: number; json: unknown }>): Call[] {
  const calls: Call[] = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, contentType: headers["content-type"] ?? null, body });
    const route = routes[`${method} ${url}`];
    const res = route ? route(body) : { status: 404, json: { error: "no route" } };
    return { ok: res.status < 400, status: res.status, json: async () => res.json } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe("LogoSuggestionPopover", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const realFetch = global.fetch;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    global.fetch = realFetch;
  });

  const find = <T extends HTMLElement>(testid: string): T | null =>
    container.querySelector<T>(`[data-testid="${testid}"]`);
  const mount = async (chip: SuggestionChip = CHIP) => {
    const handlers = { onPicked: vi.fn(), onSkip: vi.fn(), onPasteOwn: vi.fn(), onClose: vi.fn() };
    await act(async () => {
      root.render(React.createElement(LogoSuggestionPopover, { chip, anchor: { left: 100, top: 600 }, ...handlers }));
    });
    return handlers;
  };
  const type = async (testid: string, value: string) => {
    const el = find<HTMLInputElement>(testid)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const click = async (testid: string) => {
    await act(async () => {
      find<HTMLElement>(testid)!.click();
    });
  };

  it("shows the name, the timestamp and one thumbnail per candidate, by id, the first preselected", async () => {
    await mount();
    const popover = find("logo-suggestion-popover")!;
    expect(popover.textContent).toContain("Google Gemini");
    expect(popover.textContent).toContain("0:12");
    expect(find("logo-candidate-2")).not.toBeNull();
    expect(find("logo-candidate-3")).toBeNull();
    expect(find("logo-candidate-1")!.querySelector("img")!.getAttribute("src")).toBe(
      "/api/logo-candidates/file?suggestion=google-gemini&n=1",
    );
    expect(find("logo-candidate-0")!.getAttribute("data-selected")).toBe("true");
    expect(find<HTMLInputElement>("logo-name")!.value).toBe("Google Gemini");
  });

  it("Use this adds the SELECTED candidate under the edited name, stages it, then hands back the snapshot", async () => {
    const calls = stubServer({
      "POST /api/library": () => ({ status: 201, json: { entry: { id: "gemini", names: ["Gemini"], kind: "logo", format: "png" } } }),
      "POST /api/overlays/stage": () => ({ status: 200, json: { entry: SNAP } }),
    });
    const { onPicked } = await mount();
    await click("logo-candidate-2");
    await type("logo-name", "Gemini");
    await click("logo-use");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/library", "POST /api/overlays/stage"]);
    expect(calls[0]).toMatchObject({
      contentType: "application/json",
      body: { name: "Gemini", source: { candidate: { suggestion: "google-gemini", n: 2 } } },
    });
    expect(calls[1]!.body).toEqual({ entryId: "gemini" });
    expect(onPicked).toHaveBeenCalledWith(SNAP);
  });

  it("a library refusal shows inline, never stages, and picks nothing", async () => {
    const calls = stubServer({
      "POST /api/library": () => ({ status: 400, json: { error: "no such logo candidate" } }),
    });
    const { onPicked } = await mount();
    await click("logo-use");
    expect(find("logo-suggestion-error")!.textContent).toBe("no such logo candidate");
    expect(calls.some((c) => c.url === "/api/overlays/stage")).toBe(false);
    expect(onPicked).not.toHaveBeenCalled();
    expect(find<HTMLButtonElement>("logo-use")!.disabled).toBe(false);
  });

  it("a stage refusal shows inline and picks nothing", async () => {
    stubServer({
      "POST /api/library": () => ({ status: 200, json: { entry: { id: "gemini", names: ["Gemini"], kind: "logo", format: "png" } } }),
      "POST /api/overlays/stage": () => ({ status: 500, json: { error: "disk full" } }),
    });
    const { onPicked } = await mount();
    await click("logo-use");
    expect(find("logo-suggestion-error")!.textContent).toBe("disk full");
    expect(onPicked).not.toHaveBeenCalled();
  });

  it("Use this is disabled while the pick is in flight", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    global.fetch = vi.fn(async () => {
      await answered;
      return { ok: false, status: 400, json: async () => ({ error: "nope" }) } as Response;
    }) as unknown as typeof fetch;
    await mount();
    await click("logo-use");
    expect(find<HTMLButtonElement>("logo-use")!.disabled).toBe(true);
    await act(async () => {
      answer();
      await answered;
    });
    expect(find<HTMLButtonElement>("logo-use")!.disabled).toBe(false);
  });

  it("Skip and Paste my own are the owner's to act on; paste carries the edited name", async () => {
    const { onSkip, onPasteOwn } = await mount();
    await click("logo-skip");
    expect(onSkip).toHaveBeenCalledTimes(1);
    await type("logo-name", "Gemini");
    await click("logo-paste-own");
    expect(onPasteOwn).toHaveBeenCalledWith("Gemini");
  });

  it("no candidates: the note in their place, and no Use this", async () => {
    await mount({ id: "kimi", name: "Kimi", atSec: 3, word: 5, candidateCount: 0, note: "kimi.ai timed out" });
    expect(find("logo-suggestion-note")!.textContent).toBe("kimi.ai timed out");
    expect(find("logo-candidate-0")).toBeNull();
    expect(find("logo-use")).toBeNull();
    expect(find("logo-paste-own")).not.toBeNull();
  });
});
