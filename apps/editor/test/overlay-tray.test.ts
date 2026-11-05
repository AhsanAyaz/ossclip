// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIBRARY_MAX_BYTES } from "@ossclip/core";
import type { OverlayEntrySnapshot, SceneCue } from "@ossclip/core/browser";
import { OverlayTray } from "../src/OverlayTray";
import { Timeline } from "../src/Timeline";
import { useEdits } from "../src/useEdits";
import { TRAY_UPLOAD_MAX_BYTES, type LibraryEntryMeta } from "../src/overlayTrayModel";
import type { OverlayTrayRequest } from "../src/overlayLane";

/**
 * The tray against a stubbed server: what it sends (JSON, ruling R14; the
 * `POST /api/library` body shape), what it hands back (the STAGED snapshot,
 * never the library metadata), and that a refusal is shown in the tray.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LIB: LibraryEntryMeta[] = [
  { id: "gde", names: ["Google Developers Expert", "GDE"], kind: "logo", format: "png" },
  { id: "party", names: ["party"], kind: "gif", format: "gif" },
];
const snap = (id: string): OverlayEntrySnapshot => ({ id, name: id, names: [id], kind: "logo", ext: "png" });

type Call = { url: string; method: string; contentType: string | null; body: unknown };

/** A fetch stub that records calls and answers by route. */
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

describe("OverlayTray", () => {
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
  const mount = async (request: OverlayTrayRequest, onStaged = vi.fn(), onClose = vi.fn()) => {
    await act(async () => {
      root.render(React.createElement(OverlayTray, { request, onStaged, onClose }));
    });
    return { onStaged, onClose };
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

  it("lists the library and narrows it by name", async () => {
    stubServer({ "GET /api/library": () => ({ status: 200, json: { entries: LIB } }) });
    await mount({ mode: "add", word: 3 });
    expect(find("overlay-tray-item-gde")).not.toBeNull();
    expect(find<HTMLImageElement>("overlay-tray-item-party")!.querySelector("img")!.getAttribute("src")).toBe(
      "/api/library/file?id=party",
    );
    await type("overlay-tray-search", "developers");
    expect(find("overlay-tray-item-gde")).not.toBeNull();
    expect(find("overlay-tray-item-party")).toBeNull();
  });

  it("a grid pick stages by id (JSON) and hands back the server's snapshot", async () => {
    const calls = stubServer({
      "GET /api/library": () => ({ status: 200, json: { entries: LIB } }),
      "POST /api/overlays/stage": () => ({ status: 200, json: { entry: snap("gde") } }),
    });
    const { onStaged } = await mount({ mode: "swap", id: "gde@3" });
    await click("overlay-tray-item-gde");
    const stage = calls.find((c) => c.url === "/api/overlays/stage")!;
    expect(stage).toMatchObject({ method: "POST", contentType: "application/json", body: { entryId: "gde" } });
    expect(onStaged).toHaveBeenCalledWith(snap("gde"));
  });

  it("a pasted path pre-fills name and kind, adds to the library, then stages the new entry", async () => {
    const calls = stubServer({
      "GET /api/library": () => ({ status: 200, json: { entries: [] } }),
      "POST /api/library": () => ({
        status: 201,
        json: { entry: { id: "clean-edit", names: ["Clean Edit"], kind: "gif", format: "gif" } },
      }),
      "POST /api/overlays/stage": () => ({ status: 200, json: { entry: snap("clean-edit") } }),
    });
    const { onStaged } = await mount({ mode: "add", word: 7 });
    expect(find("overlay-tray-new")).toBeNull();
    await type("overlay-tray-paste", "/Users/me/clean-edit.gif");
    expect(find<HTMLInputElement>("overlay-tray-name")!.value).toBe("clean edit");
    expect(find<HTMLSelectElement>("overlay-tray-kind")!.value).toBe("gif");
    await type("overlay-tray-name", "Clean Edit");
    await type("overlay-tray-aliases", "CE, clean edit, ");
    await click("overlay-tray-add");
    const add = calls.find((c) => c.url === "/api/library" && c.method === "POST")!;
    expect(add.contentType).toBe("application/json");
    expect(add.body).toEqual({
      name: "Clean Edit",
      aliases: ["CE"],
      kind: "gif",
      source: { path: "/Users/me/clean-edit.gif" },
    });
    expect(calls.find((c) => c.url === "/api/overlays/stage")!.body).toEqual({ entryId: "clean-edit" });
    expect(onStaged).toHaveBeenCalledWith(snap("clean-edit"));
  });

  it("a URL keeps a typed name when the paste changes", async () => {
    stubServer({ "GET /api/library": () => ({ status: 200, json: { entries: [] } }) });
    await mount({ mode: "add", word: 0 });
    await type("overlay-tray-paste", "https://x.com/a/firebase-logo.png");
    expect(find<HTMLInputElement>("overlay-tray-name")!.value).toBe("firebase logo");
    await type("overlay-tray-name", "Firebase");
    await type("overlay-tray-paste", "https://x.com/a/other.png");
    expect(find<HTMLInputElement>("overlay-tray-name")!.value).toBe("Firebase");
  });

  it("shows the server's refusal inline and stages nothing", async () => {
    const calls = stubServer({
      "GET /api/library": () => ({ status: 200, json: { entries: [] } }),
      "POST /api/library": () => ({ status: 400, json: { error: "no file at that path" } }),
    });
    const { onStaged } = await mount({ mode: "add", word: 0 });
    await type("overlay-tray-paste", "/nope.png");
    await click("overlay-tray-add");
    expect(find("overlay-tray-error")!.textContent).toBe("no file at that path");
    expect(calls.some((c) => c.url === "/api/overlays/stage")).toBe(false);
    expect(onStaged).not.toHaveBeenCalled();
  });

  it("refuses a relative path before any round-trip, and shows no form for it", async () => {
    const calls = stubServer({ "GET /api/library": () => ({ status: 200, json: { entries: [] } }) });
    await mount({ mode: "add", word: 0 });
    await type("overlay-tray-paste", "logo.png");
    expect(find("overlay-tray-paste-hint")!.textContent).toContain("absolute");
    expect(find("overlay-tray-new")).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("closes on Escape", async () => {
    stubServer({ "GET /api/library": () => ({ status: 200, json: { entries: [] } }) });
    const { onClose } = await mount({ mode: "add", word: 0 });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("restates the server's upload cap exactly", () => {
    expect(TRAY_UPLOAD_MAX_BYTES).toBe(LIBRARY_MAX_BYTES);
  });
});

describe("Find library matches (lane header)", () => {
  const cue: SceneCue = {
    id: "scene-0",
    kind: "graphic",
    layout: "lower-third",
    component: "TitleCard",
    props: { title: "X" },
    startSec: 0,
    endSec: 5,
  };
  function Harness({ onFind }: { onFind?: () => Promise<string> }) {
    const edits = useEdits();
    return React.createElement(Timeline, {
      cues: [cue],
      durationSec: 5,
      fps: 30,
      playerRef: { current: null } as never,
      selection: null,
      onSelect: () => {},
      edits,
      overlayMarkers: [],
      overlayWords: [],
      onSelectOverlay: () => {},
      onFindOverlayMatches: onFind,
    });
  }

  it("shows the report the owner resolves to", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onFind = vi.fn(async () => "added 1, skipped 0 already placed or removed");
    await act(async () => root.render(React.createElement(Harness, { onFind })));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="overlay-find-matches"]')!.click();
    });
    expect(onFind).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="overlay-match-status"]')!.textContent).toBe(
      "added 1, skipped 0 already placed or removed",
    );
    act(() => root.unmount());
    container.remove();
  });

  it("has no button without an owner", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(Harness, {})));
    expect(container.querySelector('[data-testid="overlay-find-matches"]')).toBeNull();
    act(() => root.unmount());
    container.remove();
  });
});
