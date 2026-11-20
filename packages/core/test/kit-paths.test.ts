import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isWslEnv, kitFileUrl } from "../src/kit-paths";

/**
 * File URLs for the kit's timeline (Review Focus 4). Resolve runs on the
 * Windows side of a WSL machine, so a path ossclip sees as `/mnt/c/...` has
 * to reach it as `file:///C:/...`; the spike showed Resolve links that form.
 */

describe("kitFileUrl", () => {
  it("not WSL: the platform's own file URL", () => {
    expect(kitFileUrl("/home/me/My Video.mp4", { wsl: false })).toEqual({
      url: pathToFileURL("/home/me/My Video.mp4").href,
    });
  });

  it("WSL, a Windows drive: file:///<LETTER>:/ with each segment percent-encoded", () => {
    expect(kitFileUrl("/mnt/c/Users/me/My Video.mp4", { wsl: true }).url).toBe(
      "file:///C:/Users/me/My%20Video.mp4",
    );
    expect(kitFileUrl("/mnt/d/EGM/a#b/ü.mov", { wsl: true })).toEqual({
      url: "file:///D:/EGM/a%23b/%C3%BC.mov",
    });
  });

  it("WSL, a Windows drive path carries no warning", () => {
    expect(kitFileUrl("/mnt/c/x.mov", { wsl: true, distro: "Ubuntu" }).warning).toBeUndefined();
  });

  it("WSL, inside the Linux filesystem: a wsl.localhost URL and a warning", () => {
    expect(kitFileUrl("/home/me/x.mov", { wsl: true, distro: "Ubuntu" })).toEqual({
      url: "file://wsl.localhost/Ubuntu/home/me/x.mov",
      warning: "/home/me/x.mov is inside the Linux filesystem; Resolve may ask you to relink it",
    });
  });

  it("WSL: /mnt/wsl and other non-drive mounts are Linux paths, not drives", () => {
    const r = kitFileUrl("/mnt/wsl/share/x.mov", { wsl: true, distro: "Ubuntu" });
    expect(r.url).toBe("file://wsl.localhost/Ubuntu/mnt/wsl/share/x.mov");
    expect(r.warning).toBeDefined();
  });

  it("WSL with no distro name: the plain file URL, still with the warning", () => {
    expect(kitFileUrl("/home/me/x.mov", { wsl: true })).toEqual({
      url: "file:///home/me/x.mov",
      warning: "/home/me/x.mov is inside the Linux filesystem; Resolve may ask you to relink it",
    });
  });

  it("every URL is ASCII", () => {
    for (const p of ["/mnt/c/Vidéos/ü.mov", "/home/ø/ü.mov"]) {
      expect(kitFileUrl(p, { wsl: true, distro: "Ubuntu" }).url).toMatch(/^[\x21-\x7e]+$/);
    }
  });
});

describe("isWslEnv", () => {
  it("is false off Linux", () => {
    expect(isWslEnv("win32", { WSL_DISTRO_NAME: "Ubuntu" }, "Microsoft")).toBe(false);
    expect(isWslEnv("darwin", {}, null)).toBe(false);
  });

  it("is true on Linux with WSL's environment variables", () => {
    expect(isWslEnv("linux", { WSL_DISTRO_NAME: "Ubuntu" }, null)).toBe(true);
    expect(isWslEnv("linux", { WSL_INTEROP: "/run/WSL/1_interop" }, null)).toBe(true);
  });

  it("is true on Linux when /proc/version names the Microsoft kernel", () => {
    expect(
      isWslEnv("linux", {}, "Linux version 6.18.58.1-microsoft-standard-WSL2 (root@x) (gcc) #1 SMP"),
    ).toBe(true);
  });

  it("is false on plain Linux", () => {
    expect(isWslEnv("linux", {}, "Linux version 6.8.0-49-generic (buildd@lcy02) #49-Ubuntu SMP")).toBe(false);
    expect(isWslEnv("linux", {}, null)).toBe(false);
  });
});
