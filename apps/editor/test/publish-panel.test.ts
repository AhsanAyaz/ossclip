// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOT_CONFIGURED_MESSAGE,
  PublishPanel,
  panelCaptionCap,
  scheduleIso,
  type PublishInfo,
} from "../src/PublishPanel";

// Same mount conventions as youtube-panel.test.ts: real createRoot, mocked
// fetch, no module mocking.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("scheduleIso", () => {
  it("empty means publish-now (null), garbage is null, a real time normalizes to ISO", () => {
    expect(scheduleIso("")).toBeNull();
    expect(scheduleIso("   ")).toBeNull();
    expect(scheduleIso("whenever")).toBeNull();
    expect(scheduleIso("2026-09-01T08:00")).toBe(new Date("2026-09-01T08:00").toISOString());
  });
});

describe("panelCaptionCap", () => {
  it("mirrors core's caps — x 280, unknown falls back to 1500", () => {
    expect(panelCaptionCap("x")).toBe(280);
    expect(panelCaptionCap("mastodon")).toBe(1500);
  });
});

describe("PublishPanel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  const mount = async (): Promise<void> => {
    await act(async () => {
      root.render(React.createElement(PublishPanel, { onClose: () => {} }));
    });
    for (let i = 0; i < 10 && container.querySelectorAll("[data-testid]").length < 2; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };

  const ready: PublishInfo = {
    configured: true,
    reachable: true,
    packAvailable: true,
    outPathExists: true,
    receipt: null,
    integrations: [
      { id: "a", provider: "linkedin", name: "Ahsan", caption: "authored linkedin post" },
      // A company PAGE alongside the profile: one network, one caption box
      // (publishGroups.ts). The publish request must still carry the text
      // under BOTH integration ids.
      { id: "p", provider: "linkedin-page", name: "Code with Ahsan", caption: "authored linkedin post" },
      { id: "b", provider: "x", name: "Ahsan", caption: "short x post" },
    ],
  };

  const stubGet = (info: PublishInfo): void => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => info,
    })) as unknown as typeof fetch;
  };

  it("unconfigured: the hint renders instead of controls", async () => {
    stubGet({ configured: false, reason: "missing postizUrl" });
    await mount();
    expect(container.querySelector('[data-testid="publish-unconfigured"]')?.textContent).toBe(
      NOT_CONFIGURED_MESSAGE,
    );
    expect(container.querySelector('[data-testid="publish-send"]')).toBeNull();
  });

  it("unreachable Postiz renders the labeled hint, not a crash", async () => {
    stubGet({ configured: true, reachable: false, reason: "ECONNREFUSED" });
    await mount();
    expect(container.querySelector('[data-testid="publish-unreachable"]')?.textContent).toContain(
      "ECONNREFUSED",
    );
  });

  it("checking an account reveals its caption prefilled with the server's preview, with a live count", async () => {
    stubGet(ready);
    await mount();
    // Nothing selected: the send button is disabled and no caption shows.
    const send = container.querySelector<HTMLButtonElement>('[data-testid="publish-send"]');
    expect(send?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="publish-caption-linkedin"]')).toBeNull();
    const check = container.querySelector<HTMLInputElement>('[data-testid="publish-check-linkedin"]');
    await act(async () => {
      check!.click();
    });
    const area = container.querySelector<HTMLTextAreaElement>('[data-testid="publish-caption-linkedin"]');
    expect(area?.value).toBe("authored linkedin post");
    expect(container.querySelector('[data-testid="publish-count-linkedin"]')?.textContent).toBe(
      // The counter names the fan-out: one box, both LinkedIn channels.
      `${"authored linkedin post".length} / 1500 · posts to 2 channels`,
    );
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="publish-send"]')?.disabled,
    ).toBe(false);
  });

  it("publish POSTs the picked ids and captions, then shows the receipt", async () => {
    const receipt = {
      backend: "postiz",
      postIds: ["p1"],
      publishedAt: "2026-08-26T12:00:00.000Z",
      when: { kind: "now" as const },
      targets: [{ id: "a", provider: "linkedin", name: "Ahsan" }],
    };
    const bodies: unknown[] = [];
    global.fetch = vi.fn(async (_url: unknown, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(init.body ?? "{}"));
        return { ok: true, json: async () => ({ ok: true, receipt }) };
      }
      return { ok: true, json: async () => ready };
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      container.querySelector<HTMLInputElement>('[data-testid="publish-check-linkedin"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-send"]')!.click();
    });
    expect(bodies[0]).toMatchObject({
      integrationIds: ["a", "p"],
      captions: { a: "authored linkedin post" },
    });
    // Publish-now: no `at` rides along.
    expect((bodies[0] as Record<string, unknown>).at).toBeUndefined();
    expect(container.querySelector('[data-testid="publish-done"]')?.textContent).toContain(
      "Published to 1 account(s)",
    );
  });

  it("a server error rides verbatim into the panel", async () => {
    global.fetch = vi.fn(async (_url: unknown, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return { ok: false, status: 502, json: async () => ({ error: "Postiz POST /posts failed: 400" }) };
      }
      return { ok: true, json: async () => ready };
    }) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      container.querySelector<HTMLInputElement>('[data-testid="publish-check-linkedin"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="publish-send"]')!.click();
    });
    expect(container.querySelector('[data-testid="publish-error"]')?.textContent).toContain(
      "Postiz POST /posts failed: 400",
    );
  });

  it("an existing receipt shows the already-published note and labels the button Publish again (force)", async () => {
    const receipt = {
      backend: "postiz",
      postIds: [],
      publishedAt: "2026-08-25T10:00:00.000Z",
      when: { kind: "now" as const },
      targets: [{ id: "a", provider: "linkedin", name: "Ahsan" }],
    };
    const bodies: unknown[] = [];
    global.fetch = vi.fn(async (_url: unknown, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(init.body ?? "{}"));
        return { ok: true, json: async () => ({ ok: true, receipt }) };
      }
      return { ok: true, json: async () => ({ ...ready, receipt }) };
    }) as unknown as typeof fetch;
    await mount();
    expect(
      container.querySelector('[data-testid="publish-receipt-note"]')?.textContent,
    ).toContain("2026-08-25T10:00:00.000Z");
    await act(async () => {
      container.querySelector<HTMLInputElement>('[data-testid="publish-check-linkedin"]')!.click();
    });
    const send = container.querySelector<HTMLButtonElement>('[data-testid="publish-send"]');
    expect(send?.textContent).toBe("Publish again");
    await act(async () => {
      send!.click();
    });
    expect((bodies[0] as Record<string, unknown>).force).toBe(true);
  });
});
