import { describe, expect, it } from "vitest";
import { assertInteractive, isInteractive, unwrap } from "../src/interactive/tty";

const deps = (over: Partial<Parameters<typeof isInteractive>[0]> = {}) => ({
  env: {} as NodeJS.ProcessEnv,
  stdinIsTty: true,
  stdoutIsTty: true,
  ...over,
});

describe("isInteractive", () => {
  it("is true only when both streams are a TTY", () => {
    expect(isInteractive(deps())).toBe(true);
    expect(isInteractive(deps({ stdinIsTty: false }))).toBe(false);
    expect(isInteractive(deps({ stdoutIsTty: false }))).toBe(false);
  });

  it("stands down inside CI even on a TTY", () => {
    expect(isInteractive(deps({ env: { CI: "true" } as NodeJS.ProcessEnv }))).toBe(false);
  });

  it("honours the explicit escape hatch", () => {
    const env = { OSSCLIP_NO_INTERACTIVE: "1" } as NodeJS.ProcessEnv;
    expect(isInteractive(deps({ env }))).toBe(false);
  });

  // An empty CI= is what some shells export when the var is merely declared;
  // treating that as "in CI" would silence prompts on a real terminal.
  it("ignores an empty CI", () => {
    expect(isInteractive(deps({ env: { CI: "" } as NodeJS.ProcessEnv }))).toBe(true);
  });
});

describe("unwrap", () => {
  it("passes a real answer straight through", () => {
    expect(unwrap("./take.mp4", () => { throw new Error("should not cancel"); })).toBe("./take.mp4");
  });

  it("routes a cancelled value to the cancel path", () => {
    const sentinel = Symbol("clack:cancel");
    expect(() =>
      unwrap(
        sentinel as unknown as string,
        () => {
          throw new Error("cancelled");
        },
        (v) => v === sentinel,
      ),
    ).toThrow("cancelled");
  });

  // Pins the trap this test file was built wrong around: clack's sentinel is a
  // module-local Symbol("clack:cancel"), so a same-described symbol built
  // anywhere else is NOT it, and must pass through untouched.
  it("does not treat a look-alike symbol as clack's sentinel", () => {
    const lookAlike = Symbol("clack:cancel");
    expect(
      unwrap(lookAlike as unknown as symbol, () => {
        throw new Error("should not cancel");
      }),
    ).toBe(lookAlike);
  });
});

describe("assertInteractive", () => {
  it("throws a developer-facing error when there is no TTY", () => {
    // A prompt reached without a TTY is a programming error: it must fail in
    // this suite rather than hang in somebody's CI.
    expect(() => assertInteractive("produce wizard", () => false)).toThrow(/without a TTY/);
  });

  it("is silent when interactive", () => {
    expect(() => assertInteractive("produce wizard", () => true)).not.toThrow();
  });
});
