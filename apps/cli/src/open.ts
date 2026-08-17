import { spawn } from "node:child_process";

/**
 * Open a target — URL or file path, every platform's opener treats them
 * identically — in the OS default handler, per platform. The old code
 * spawned macOS's `open` unconditionally — on Linux and Windows that ENOENT
 * became an unhandled 'error' event and took the whole edit server down
 * with it.
 *
 * Failure here is not an error: a headless box or WSL without a browser is
 * a normal place to run `ossclip edit` — print the URL and move on.
 */
export function openCommand(
  target: string,
  platform: NodeJS.Platform,
): { bin: string; args: string[] } {
  if (platform === "darwin") return { bin: "open", args: [target] };
  if (platform === "win32") {
    // `start` is a cmd built-in, not an executable; the empty string is
    // start's window-title slot so the target isn't eaten as the title —
    // load-bearing for file paths with spaces, which spawn quotes and
    // `start` would otherwise read as its title argument.
    return { bin: "cmd", args: ["/c", "start", "", target] };
  }
  return { bin: "xdg-open", args: [target] };
}

export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const { bin, args } = openCommand(url, platform);
  const child = spawn(bin, args, { stdio: "ignore", detached: false });
  child.on("error", () => {
    console.log(`▸ couldn't open a browser here — open ${url} yourself`);
  });
}

/**
 * Open a file in the OS default viewer — the thumbnail confirm needs the
 * user to SEE the image before answering keep/regenerate, not squint at a
 * path. Same posture as openInBrowser: a missing xdg-open on a headless-ish
 * box logs one line and the interactive flow proceeds on the printed path.
 */
export function openInViewer(path: string, platform: NodeJS.Platform = process.platform): void {
  const { bin, args } = openCommand(path, platform);
  const child = spawn(bin, args, { stdio: "ignore", detached: false });
  child.on("error", () => {
    console.log(`▸ could not open viewer — ${path}`);
  });
}
