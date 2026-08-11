import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FLUSH_TIMEOUT_MS,
  FORBIDDEN_PROP_KEYS,
  NOTICE,
  POSTHOG_HOST,
  POSTHOG_PLACEHOLDER,
  Telemetry,
  TelemetryStateSchema,
  assertSafeProps,
  buildEvent,
  defaultTelemetryState,
  durationBucket,
  loadState,
  maybeShowNotice,
  parseRating,
  saveState,
  shouldAskRating,
  telemetryDisabled,
  telemetryOffReason,
  type TelemetryState,
} from "../src/telemetry";

/** A real-looking key so tests can exercise the enabled path — production
 *  builds carry the placeholder until a maintainer pastes the project key. */
const TEST_KEY = "phc_test_0000";

const ctx = {
  anonymousId: "anon-1",
  version: "0.0.0-test",
  platform: "darwin",
  arch: "arm64",
  nodeMajor: 22,
  ci: false,
  apiKey: TEST_KEY,
};

const state = (over: Partial<TelemetryState> = {}): TelemetryState => ({
  ...defaultTelemetryState(),
  ...over,
});

describe("telemetryDisabled precedence (FINDINGS §134)", () => {
  it("the placeholder key is a hard off, beating everything", () => {
    expect(telemetryDisabled({}, state(), POSTHOG_PLACEHOLDER)).toBe(true);
    expect(telemetryOffReason({}, state({ enabled: true }), POSTHOG_PLACEHOLDER)).toBe(
      "placeholder-key",
    );
    // Even an explicit opt-IN cannot turn a keyless build on.
    expect(
      telemetryDisabled({ OSSCLIP_TELEMETRY: "1" }, state({ enabled: true }), POSTHOG_PLACEHOLDER),
    ).toBe(true);
  });

  // THE hermetic-suite invariant: this repo ships with the placeholder, so
  // every test that builds the real program gets inert telemetry without
  // mocking anything. If this assertion ever fails, someone pasted a real
  // key — re-check that the suite still never writes ~/.ossclip or hits the
  // network before shipping. Do not delete this to make that convenient.
  it("this build's own key is the placeholder, so default-arg calls are off", () => {
    expect(telemetryDisabled({}, state())).toBe(true);
  });

  it("OSSCLIP_TELEMETRY 0/false/off disable; other values do not", () => {
    for (const v of ["0", "false", "off"]) {
      expect(telemetryDisabled({ OSSCLIP_TELEMETRY: v }, state(), TEST_KEY)).toBe(true);
      expect(telemetryOffReason({ OSSCLIP_TELEMETRY: v }, state(), TEST_KEY)).toBe("env");
    }
    expect(telemetryDisabled({ OSSCLIP_TELEMETRY: "1" }, state(), TEST_KEY)).toBe(false);
  });

  it("DO_NOT_TRACK is respected", () => {
    for (const v of ["1", "true"]) {
      expect(telemetryOffReason({ DO_NOT_TRACK: v }, state(), TEST_KEY)).toBe("do-not-track");
    }
    expect(telemetryDisabled({ DO_NOT_TRACK: "0" }, state(), TEST_KEY)).toBe(false);
  });

  it("state.enabled=false disables, and every env override outranks it", () => {
    expect(telemetryOffReason({}, state({ enabled: false }), TEST_KEY)).toBe("config");
    // The env var names WHY it is off — a user who exported the var should
    // see that reason win, not the config file's.
    expect(
      telemetryOffReason({ OSSCLIP_TELEMETRY: "off" }, state({ enabled: false }), TEST_KEY),
    ).toBe("env");
    expect(
      telemetryOffReason({ DO_NOT_TRACK: "1" }, state({ enabled: false }), TEST_KEY),
    ).toBe("do-not-track");
  });

  it("a real key, clean env and enabled state is ON", () => {
    expect(telemetryDisabled({}, state(), TEST_KEY)).toBe(false);
  });
});

describe("TelemetryStateSchema", () => {
  it("a corrupt document resets to defaults with a fresh anonymousId", () => {
    const a = TelemetryStateSchema.parse("not an object");
    const b = TelemetryStateSchema.parse(42);
    expect(a.enabled).toBe(true);
    expect(a.produceCount).toBe(0);
    expect(a.anonymousId).not.toBe(b.anonymousId); // fresh per reset, not shared
  });

  it("a corrupt FIELD resets alone — the rest of the file survives", () => {
    const s = TelemetryStateSchema.parse({
      anonymousId: "keep-me",
      enabled: "yes", // hand-edited to a non-boolean
      noticeShown: true,
      produceCount: 7,
      ratingAsked: 1,
      ratingDone: false,
    });
    expect(s.anonymousId).toBe("keep-me");
    expect(s.enabled).toBe(true);
    expect(s.produceCount).toBe(7);
  });

  it("roundtrips a valid state unchanged", () => {
    const s = state({ produceCount: 3, ratingAsked: 1 });
    expect(TelemetryStateSchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe("loadState / saveState", () => {
  it("roundtrips through telemetry.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-tel-"));
    const s = state({ produceCount: 2, noticeShown: true });
    saveState(s, dir);
    expect(loadState(dir)).toEqual(s);
  });

  it("a corrupt file on disk loads as defaults instead of crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-tel-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "telemetry.json"), "{ definitely not json");
    const s = loadState(dir);
    expect(s.enabled).toBe(true);
    expect(s.anonymousId.length).toBeGreaterThan(0);
  });

  it("a missing file loads as defaults with a generated anonymousId", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ossclip-tel-")), "nope");
    const s = loadState(dir);
    expect(s.anonymousId).toMatch(/[0-9a-f-]{36}/);
  });
});

describe("buildEvent", () => {
  it("folds the common props in and stays anonymous", () => {
    const e = buildEvent("produce_completed", { duration_ms: 1234 }, ctx);
    expect(e.api_key).toBe(TEST_KEY);
    expect(e.event).toBe("produce_completed");
    expect(e.distinct_id).toBe("anon-1");
    expect(e.properties.duration_ms).toBe(1234);
    expect(e.properties.app_version).toBe("0.0.0-test");
    expect(e.properties.os).toBe("darwin");
    expect(e.properties.arch).toBe("arm64");
    expect(e.properties.node_major).toBe(22);
    expect(e.properties.ci).toBe(false);
    // Anonymous events, no person profiles — the PostHog-side half of the
    // privacy stance.
    expect(e.properties.$process_person_profile).toBe(false);
    expect(Date.parse(e.timestamp)).not.toBeNaN();
  });

  it("runs the forbidden-key guard on its props", () => {
    expect(() => buildEvent("x", { source_path: "/Users/me/take.mp4" }, ctx)).toThrow(/path/);
  });
});

describe("assertSafeProps (the drift guard)", () => {
  it("rejects any key containing a forbidden substring, case-insensitively", () => {
    expect(() => assertSafeProps({ source_path: "x" })).toThrow(/source_path/);
    expect(() => assertSafeProps({ Transcript_len: 1 })).toThrow(/transcript/i);
    expect(() => assertSafeProps({ fileName: "a" })).toThrow(/file/);
    expect(() => assertSafeProps({ api_key_id: 1 })).toThrow(/key/);
  });

  it("passes the props the shipped events actually use", () => {
    expect(() =>
      assertSafeProps({
        duration_ms: 1,
        llm_provider: "gemini",
        produced: true,
        aspect: "9:16",
        clip: false,
        render: true,
        source_duration_bucket: "1-5m",
        scenes: 4,
        error_class: "Error",
        score: 5,
      }),
    ).not.toThrow();
  });

  it("the forbidden list itself keeps the load-bearing entries", () => {
    for (const k of ["path", "file", "transcript", "intent", "prompt", "key"]) {
      expect(FORBIDDEN_PROP_KEYS).toContain(k);
    }
  });
});

describe("durationBucket", () => {
  it("buckets on the minute edges", () => {
    expect(durationBucket(59)).toBe("<1m");
    expect(durationBucket(60)).toBe("1-5m");
    expect(durationBucket(300)).toBe("1-5m");
    expect(durationBucket(900)).toBe("5-15m");
    expect(durationBucket(901)).toBe(">15m");
  });
});

describe("shouldAskRating", () => {
  it("asks only after the 3rd produce, before an answer, and at most twice", () => {
    expect(shouldAskRating(state({ produceCount: 2 }))).toBe(false);
    expect(shouldAskRating(state({ produceCount: 3 }))).toBe(true);
    expect(shouldAskRating(state({ produceCount: 3, ratingDone: true }))).toBe(false);
    expect(shouldAskRating(state({ produceCount: 9, ratingAsked: 2 }))).toBe(false);
    expect(shouldAskRating(state({ produceCount: 9, ratingAsked: 1 }))).toBe(true);
  });
});

describe("parseRating", () => {
  it("accepts a single 1-5 and nothing else", () => {
    expect(parseRating("3")).toBe(3);
    expect(parseRating(" 5 ")).toBe(5);
    expect(parseRating("")).toBeNull();
    expect(parseRating("0")).toBeNull();
    expect(parseRating("6")).toBeNull();
    expect(parseRating("3.5")).toBeNull();
    expect(parseRating("great")).toBeNull();
  });
});

describe("Telemetry", () => {
  const fakeFetch = () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = ((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
    return { calls, impl };
  };

  it("flush POSTs one batch with the recorded events", async () => {
    const { calls, impl } = fakeFetch();
    const t = new Telemetry({}, state(), impl, ctx);
    t.record("cli_first_run", {});
    t.record("produce_completed", { duration_ms: 5 });
    await t.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${POSTHOG_HOST}/batch/`);
    const body = JSON.parse(String(calls[0].init.body)) as {
      api_key: string;
      batch: { event: string; distinct_id: string }[];
    };
    expect(body.api_key).toBe(TEST_KEY);
    expect(body.batch.map((e) => e.event)).toEqual(["cli_first_run", "produce_completed"]);
    expect(body.batch[0].distinct_id).toBe("anon-1");
    // A second flush has nothing left to send.
    await t.flush();
    expect(calls).toHaveLength(1);
  });

  it("disabled → record is a no-op and flush never fetches", async () => {
    const { calls, impl } = fakeFetch();
    const t = new Telemetry({ OSSCLIP_TELEMETRY: "0" }, state(), impl, ctx);
    t.record("produce_completed", { duration_ms: 5 });
    await t.flush();
    expect(calls).toHaveLength(0);
  });

  // The invariant the whole test suite leans on: with no apiKey injected the
  // class uses POSTHOG_KEY, which in this repo is the placeholder — so the
  // Telemetry instances built inside the real program are inert, and no test
  // needs to mock fetch or guard ~/.ossclip. Removing this test removes the
  // only named guard on that assumption.
  it("the placeholder key makes record() a no-op — the hermetic-suite invariant", async () => {
    const { calls, impl } = fakeFetch();
    const t = new Telemetry({}, state({ enabled: true }), impl);
    t.record("produce_completed", { duration_ms: 5 });
    await t.flush();
    expect(calls).toHaveLength(0);
  });

  it("a rejecting fetch is swallowed", async () => {
    const t = new Telemetry({}, state(), (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch, ctx);
    t.record("x_event", {});
    await expect(t.flush()).resolves.toBeUndefined();
  });

  it("a hanging fetch is capped by the abort timer, not awaited forever", async () => {
    vi.useFakeTimers();
    try {
      // Never resolves AND ignores the signal — the worst-behaved fetch an
      // injection could hand us; the internal race must still resolve.
      const t = new Telemetry({}, state(), (() => new Promise(() => {})) as typeof fetch, ctx);
      t.record("x_event", {});
      const flushed = t.flush();
      await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS + 100);
      await expect(flushed).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a forbidden prop key drops the event instead of throwing at the user", async () => {
    const { calls, impl } = fakeFetch();
    const t = new Telemetry({}, state(), impl, ctx);
    t.record("bad_event", { source_path: "/tmp/x" });
    t.record("good_event", { duration_ms: 1 });
    await t.flush();
    const body = JSON.parse(String(calls[0].init.body)) as { batch: { event: string }[] };
    expect(body.batch.map((e) => e.event)).toEqual(["good_event"]);
  });
});

describe("NOTICE and maybeShowNotice", () => {
  it("names the off switches and says anonymous", () => {
    expect(NOTICE).toContain("ossclip telemetry off");
    expect(NOTICE).toContain("OSSCLIP_TELEMETRY=0");
    expect(NOTICE).toMatch(/anonymous/i);
    // The privacy floor, stated where the user first sees telemetry exists.
    expect(NOTICE).toMatch(/never/i);
  });

  it("prints once, persists the flag, then stays quiet", () => {
    const dir = mkdtempSync(join(tmpdir(), "ossclip-tel-"));
    const s = state();
    const out: string[] = [];
    maybeShowNotice(s, (line) => out.push(line), dir);
    maybeShowNotice(s, (line) => out.push(line), dir);
    expect(out).toHaveLength(1);
    expect(s.noticeShown).toBe(true);
    expect(loadState(dir).noticeShown).toBe(true);
  });
});
