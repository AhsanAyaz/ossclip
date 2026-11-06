import { describe, expect, it } from "vitest";
import { checkEditRequest } from "../src/edit-origin";

const ok = { ok: true };

describe("checkEditRequest", () => {
  it.each([
    ["127.0.0.1:5174"],
    ["localhost:5174"],
    ["LOCALHOST:5174"],
    ["[::1]:5174"],
    ["127.0.0.1"],
    // The dev editor's proxy and the e2e ports carry their own port.
    ["127.0.0.1:5273"],
  ])("Host %s with no Origin is answered", (host) => {
    expect(checkEditRequest({ host })).toEqual(ok);
  });

  it.each([["evil.example:5174"], ["127.0.0.1.evil.example:5174"], ["192.168.1.10:5174"], ["0.0.0.0:5174"], [""]])(
    "Host %s is refused (DNS rebinding)",
    (host) => {
      const v = checkEditRequest({ host });
      expect(v.ok).toBe(false);
    },
  );

  it("a missing Host is refused", () => {
    expect(checkEditRequest({}).ok).toBe(false);
  });

  it.each([["http://127.0.0.1:5174"], ["http://localhost:5173"], ["http://[::1]:5174"]])(
    "Origin %s (the editor itself) is answered",
    (origin) => {
      expect(checkEditRequest({ host: "127.0.0.1:5174", origin })).toEqual(ok);
    },
  );

  it.each([["https://evil.example"], ["null"], ["http://localhost.evil.example"], ["not a url"]])(
    "Origin %s is refused even with a loopback Host",
    (origin) => {
      const v = checkEditRequest({ host: "127.0.0.1:5174", origin });
      expect(v).toMatchObject({ ok: false });
    },
  );
});
