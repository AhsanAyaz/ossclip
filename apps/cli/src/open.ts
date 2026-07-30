import { spawn } from "node:child_process";

/**
 * Open a URL in the default browser, per platform. The old code spawned
 * macOS's `open` unconditionally — on Linux and Windows that ENOENT became
 * an unhandled 'error' event and took the whole edit server down with it.
 *
 * Failure here is not an error: a headless box or WSL without a browser is
 * a normal place to run `ossclip edit` — print the URL and move on.
 */
export function openCommand(
  url: string,
  platform: NodeJS.Platform,
): { bin: string; args: string[] } {
  if (platform === "darwin") return { bin: "open", args: [url] };
  if (platform === "win32") {
    // `start` is a cmd built-in, not an executable; the empty string is
    // start's window-title slot so the URL isn't eaten as the title.
    return { bin: "cmd", args: ["/c", "start", "", url] };
  }
  return { bin: "xdg-open", args: [url] };
}

export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const { bin, args } = openCommand(url, platform);
  const child = spawn(bin, args, { stdio: "ignore", detached: false });
  child.on("error", () => {
    console.log(`▸ couldn't open a browser here — open ${url} yourself`);
  });
}
