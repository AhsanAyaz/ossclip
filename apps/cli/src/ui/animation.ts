import { isInteractive } from "../interactive/tty";

/**
 * ANSI Color & Style Helpers (zero-dependency, ultra-fast string templates).
 */
export const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  blink: "\x1b[5m",
  inverse: "\x1b[7m",

  // Foreground
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",

  // Bright foreground
  brightBlack: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",

  // 256-color & RGB
  rgb: (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`,
  bgRgb: (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`,

  // Cursor control
  cursorHide: "\x1b[?25l",
  cursorShow: "\x1b[?25h",
  clearLine: "\x1b[2K\r",
  up: (lines = 1) => `\x1b[${lines}A`,
};

/**
 * Format SMPTE timecode (HH:MM:SS:FF) from seconds and fps.
 */
export function formatTimecode(seconds: number, fps = 30): string {
  const totalFrames = Math.max(0, Math.floor(seconds * fps));
  const ff = totalFrames % fps;
  const totalSecs = Math.floor(totalFrames / fps);
  const ss = totalSecs % 60;
  const totalMins = Math.floor(totalSecs / 60);
  const mm = totalMins % 60;
  const hh = Math.floor(totalMins / 60);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

/**
 * Strip ANSI escape codes to calculate visual string width.
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Unicode Audio Waves, Synth Oscilloscope & Braille spinners.
 */
const AUDIO_WAVE_CHARS = [" ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const SPINNERS = {
  dots: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  filmReel: ["◐", "◓", "◑", "◒"],
  sprockets: ["[░▒▓█▓▒░]", "[▒▓█▓▒░░]", "[▓█▓▒░░▒]", "[█▓▒░░▒▓]"],
  equalizer: [" ▂▃▅▆▇█", "▂▃▅▆▇█ ", "▃▅▆▇█ ▂", "▅▆▇█ ▂▃", "▆▇█ ▂▃▅", "▇█ ▂▃▅▆", "█ ▂▃▅▆▇"],
  neural: ["◈◇◇◇", "◇◈◇◇", "◇◇◈◇", "◇◇◇◈", "◇◇◈◇", "◇◈◇◇"],
};

/**
 * Render an organic multi-harmonic analog synthesizer oscilloscope wave.
 */
export function renderSynthWave(frame: number, width = 16): string {
  const BRAILLE_WAVE = ["⣀", "⠤", "⠒", "⠊", "⠉", "⠑", "⠒", "⠤", "⣀", "⡀", "⠄", "⠂", "⠁", "⠈", "⠐", "⠠", "⢀"];
  let wave = "";
  for (let i = 0; i < width; i++) {
    const phase = frame * 0.25 + i * 0.45;
    const harmonic = Math.sin(phase) * 0.65 + Math.sin(phase * 2.1 + frame * 0.1) * 0.35;
    const normalized = Math.max(0, Math.min(1, (harmonic + 1) / 2));
    const idx = Math.floor(normalized * (BRAILLE_WAVE.length - 1));
    const char = BRAILLE_WAVE[idx];

    // Phosphor glow gradient: Neon Amber to Electric Cyan
    const r = Math.round(255 - normalized * 180);
    const g = Math.round(160 + normalized * 70);
    const b = Math.round(40 + normalized * 210);
    wave += `${ansi.rgb(r, g, b)}${char}`;
  }
  return wave + ansi.reset;
}

/**
 * Generate a dynamic gradient progress bar with customizable character resolution.
 */
export function renderProgressBar(
  progress: number,
  width = 32,
  options: {
    filledChar?: string;
    emptyChar?: string;
    gradient?: "cyan-magenta" | "emerald" | "amber" | "cyberpunk";
  } = {},
): string {
  const clamped = Math.max(0, Math.min(1, progress));
  const filledCount = Math.round(clamped * width);
  const emptyCount = width - filledCount;
  const fillChar = options.filledChar ?? "█";
  const emptyChar = options.emptyChar ?? "░";

  let coloredFill = "";
  for (let i = 0; i < filledCount; i++) {
    const frac = i / Math.max(1, width - 1);
    if (options.gradient === "emerald") {
      // Emerald to neon cyan
      const r = Math.round(16 + frac * 20);
      const g = Math.round(185 + frac * 50);
      const b = Math.round(129 + frac * 120);
      coloredFill += `${ansi.rgb(r, g, b)}${fillChar}`;
    } else if (options.gradient === "amber") {
      // Amber to gold
      const r = Math.round(245 + frac * 10);
      const g = Math.round(158 + frac * 70);
      const b = Math.round(11 + frac * 30);
      coloredFill += `${ansi.rgb(r, g, b)}${fillChar}`;
    } else if (options.gradient === "cyberpunk") {
      // Neon yellow to magenta to cyan
      const r = Math.round(255 - frac * 150);
      const g = Math.round(70 + frac * 170);
      const b = Math.round(180 + frac * 75);
      coloredFill += `${ansi.rgb(r, g, b)}${fillChar}`;
    } else {
      // Default: Cyan to Electric Violet
      const r = Math.round(56 + frac * 180);
      const g = Math.round(189 - frac * 60);
      const b = Math.round(248 + frac * 7);
      coloredFill += `${ansi.rgb(r, g, b)}${fillChar}`;
    }
  }

  const empty = `${ansi.dim}${ansi.brightBlack}${emptyChar.repeat(emptyCount)}${ansi.reset}`;
  return `${coloredFill}${empty}${ansi.reset}`;
}

/**
 * Animated Terminal Stage / Activity Monitor
 */
export class StageAnimator {
  private timer: NodeJS.Timeout | null = null;
  private frameIndex = 0;
  private linesRendered = 0;
  private startedAt = Date.now();
  private isTty = isInteractive();

  constructor(
    private title: string,
    private subtitle: string,
    private type: "audio" | "whisper" | "ai" | "render" | "master" = "render",
  ) {}

  public start(intervalMs = 60): this {
    if (!this.isTty) return this;
    this.startedAt = Date.now();
    process.stdout.write(ansi.cursorHide);
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
    return this;
  }

  public update(subtitle: string): void {
    this.subtitle = subtitle;
    if (this.isTty) this.render();
  }

  private tick(): void {
    this.frameIndex++;
    this.render();
  }

  private render(): void {
    if (!this.isTty) return;
    const elapsedSec = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const cols = Math.min(100, process.stdout.columns || 80);

    let visual = "";
    const maxVisualWidth = Math.max(40, (process.stdout.columns || 80) - 4);
    const clamp = (s: string) => {
      const plain = stripAnsi(s);
      if (plain.length <= maxVisualWidth) return s;
      return s.slice(0, maxVisualWidth - 3) + "...";
    };

    if (this.type === "ai") {
      const spinner = SPINNERS.neural[this.frameIndex % SPINNERS.neural.length];
      const dots = SPINNERS.dots[this.frameIndex % SPINNERS.dots.length];
      visual =
        // The caller's title, not a hardcoded model name: this header once
        // said "GEMINI 3.7 FLASH" over a claude-cli run (2026-08-26 field
        // report) — the subtitle names the real provider, and the header
        // must not contradict it.
        `${ansi.bold}${ansi.brightMagenta}⚡ ${this.title}${ansi.reset} ` +
        `${ansi.cyan}[${spinner}]${ansi.reset} ${ansi.dim}(${elapsedSec}s)${ansi.reset}\n` +
        `  ${ansi.brightCyan}${dots}${ansi.reset} ${ansi.brightWhite}${clamp(this.subtitle)}${ansi.reset}`;
    } else if (this.type === "whisper") {
      const dots = SPINNERS.dots[this.frameIndex % SPINNERS.dots.length];
      const eq = SPINNERS.equalizer[this.frameIndex % SPINNERS.equalizer.length];
      visual =
        `${ansi.bold}${ansi.brightCyan}🎙️  WHISPER ASR ENGINE // NEURAL PHONEME STREAM${ansi.reset} ` +
        `${ansi.green}${eq}${ansi.reset} ${ansi.dim}(${elapsedSec}s)${ansi.reset}\n` +
        `  ${ansi.cyan}${dots}${ansi.reset} ${ansi.brightWhite}${clamp(this.subtitle)}${ansi.reset}`;
    } else if (this.type === "audio") {
      const synth = renderSynthWave(this.frameIndex, 12);
      visual =
        `${ansi.bold}${ansi.brightYellow}🔊 ANALOG SYNTH AUDIO OSCILLOSCOPE${ansi.reset} ` +
        `[${synth}] ${ansi.dim}(${elapsedSec}s)${ansi.reset}\n` +
        `  ${ansi.brightYellow}▸${ansi.reset} ${ansi.brightWhite}${clamp(this.subtitle)}${ansi.reset}`;
    } else if (this.type === "master") {
      const dots = SPINNERS.dots[this.frameIndex % SPINNERS.dots.length];
      visual =
        `${ansi.bold}${ansi.brightGreen}🎛️  MASTERING AUDIO // EBU R128 DUAL-PASS LOUDNORM${ansi.reset} ` +
        `${ansi.dim}(${elapsedSec}s)${ansi.reset}\n` +
        `  ${ansi.brightGreen}${dots}${ansi.reset} ${ansi.brightWhite}${clamp(this.subtitle)}${ansi.reset}`;
    } else {
      const film = SPINNERS.filmReel[this.frameIndex % SPINNERS.filmReel.length];
      visual =
        `${ansi.bold}${ansi.brightCyan}🎞️  ${this.title}${ansi.reset} ` +
        `${ansi.brightYellow}${film}${ansi.reset} ${ansi.dim}(${elapsedSec}s)${ansi.reset}\n` +
        `  ${ansi.brightWhite}${clamp(this.subtitle)}${ansi.reset}`;
    }

    this.clearRenderedLines();
    const rawLines = visual.split("\n");
    const lines = rawLines.map((l) => {
      const vis = stripAnsi(l);
      if (vis.length <= maxVisualWidth) return l;
      return l.slice(0, maxVisualWidth - 3) + "..." + ansi.reset;
    });
    for (const l of lines) {
      process.stdout.write(`${l}\n`);
    }
    this.linesRendered = lines.length;
  }

  private clearRenderedLines(): void {
    if (this.linesRendered > 0) {
      process.stdout.write(ansi.up(this.linesRendered) + "\r");
      for (let i = 0; i < this.linesRendered; i++) {
        process.stdout.write(ansi.clearLine);
        if (i < this.linesRendered - 1) process.stdout.write("\n");
      }
      if (this.linesRendered > 1) process.stdout.write(ansi.up(this.linesRendered - 1));
      process.stdout.write("\r");
    }
  }

  public stop(successMessage?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.isTty) return;
    this.clearRenderedLines();
    process.stdout.write(ansi.cursorShow);
    if (successMessage) {
      process.stdout.write(`${successMessage}\n`);
    }
    this.linesRendered = 0;
  }
}

/**
 * High-Performance Live Render HUD for Remotion Video Rendering.
 * Emits dynamic timeline tracks, SMPTE timecode, FPS ticker, scene badges & progress.
 */
export class RenderTimelineHUD {
  private isTty = isInteractive();
  private startedAt = Date.now();
  private lastUpdateMs = 0;
  private currentProgress = 0;
  private totalDurationSec: number;
  private sceneNames: string[];
  private fps: number;
  private timer: NodeJS.Timeout | null = null;
  private frameCount = 0;
  private linesRendered = 0;
  private aspect: string;

  constructor(opts: {
    totalDurationSec: number;
    sceneNames?: string[];
    fps?: number;
    aspect?: string;
  }) {
    this.totalDurationSec = Math.max(1, opts.totalDurationSec);
    this.sceneNames = opts.sceneNames ?? [];
    this.fps = opts.fps ?? 30;
    this.aspect = opts.aspect ?? "9:16";
  }

  public start(): this {
    if (!this.isTty) return this;
    this.startedAt = Date.now();
    process.stdout.write(ansi.cursorHide);
    this.timer = setInterval(() => this.tick(), 60);
    this.render();
    return this;
  }

  public setProgress(progress: number): void {
    this.currentProgress = Math.max(0, Math.min(1, progress));
    this.lastUpdateMs = Date.now();
  }

  private tick(): void {
    this.frameCount++;
    this.render();
  }

  private render(): void {
    if (!this.isTty) return;
    const now = Date.now();
    const elapsedSec = Math.max(0.1, (now - this.startedAt) / 1000);
    const progress = this.currentProgress;
    const totalFrames = Math.round(this.totalDurationSec * this.fps);
    const renderedFrames = Math.round(progress * totalFrames);
    const renderFps = (renderedFrames / elapsedSec).toFixed(1);
    const realtimeMultiplier = (renderedFrames / (elapsedSec * this.fps)).toFixed(2);
    const etaSec = progress > 0.02 ? Math.max(0, (elapsedSec / progress) * (1 - progress)).toFixed(1) : "...";

    const currentTimecode = formatTimecode(progress * this.totalDurationSec, this.fps);
    const totalTimecode = formatTimecode(this.totalDurationSec, this.fps);

    // Compute exact bounded terminal box dimensions (guaranteed never to wrap)
    const termCols = Math.min(74, Math.max(50, (process.stdout.columns || 80) - 2));
    const innerWidth = termCols - 4; // between ║ ... ║
    const barWidth = Math.max(12, Math.min(22, innerWidth - 28));

    // Dynamic track representation
    const reel = SPINNERS.filmReel[this.frameCount % SPINNERS.filmReel.length];
    const synthWaveA1 = renderSynthWave(this.frameCount, 12);

    // Identify active scene
    let activeSceneLabel = "Main Composition";
    if (this.sceneNames.length > 0) {
      const sceneIndex = Math.min(
        this.sceneNames.length - 1,
        Math.floor(progress * this.sceneNames.length),
      );
      activeSceneLabel = `Scene ${sceneIndex + 1}/${this.sceneNames.length}: ${this.sceneNames[sceneIndex]}`;
    }

    const pctString = (progress * 100).toFixed(1).padStart(5, " ");
    const bar = renderProgressBar(progress, barWidth, { gradient: "cyberpunk" });

    const padLine = (content: string) => {
      const vis = stripAnsi(content).length;
      const pad = Math.max(0, innerWidth - vis);
      return `${ansi.bold}║${ansi.reset} ${content}${" ".repeat(pad)} ${ansi.bold}║${ansi.reset}`;
    };

    const headerContent = `${ansi.yellow}${reel}${ansi.reset} ${ansi.bold}${ansi.brightCyan}${currentTimecode}${ansi.reset} / ${ansi.dim}${totalTimecode}${ansi.reset} │ ${ansi.brightMagenta}${this.aspect}${ansi.reset} │ ${ansi.green}${realtimeMultiplier}x Speed${ansi.reset}`;
    const trackV1Content = `${ansi.brightWhite}V1:${ansi.reset} [${bar}] ${ansi.bold}${ansi.brightYellow}${pctString}%${ansi.reset} │ Frame: ${renderedFrames}/${totalFrames}`;
    const trackA1Content = `${ansi.brightWhite}A1:${ansi.reset} [${synthWaveA1}] │ ${renderFps}fps │ ETA:${ansi.brightYellow}${etaSec}s${ansi.reset}`;
    const sceneContent = `${ansi.dim}Scene:${ansi.reset} ${ansi.brightMagenta}${activeSceneLabel.slice(0, innerWidth - 8)}${ansi.reset}`;

    const topBorder = `${ansi.bold}${ansi.brightCyan}╔══ 🎞️  REMOTION RENDER ENGINE ${"═".repeat(Math.max(2, innerWidth - 27))}╗${ansi.reset}`;
    const bottomBorder = `${ansi.bold}${ansi.brightCyan}╚${"═".repeat(innerWidth + 2)}╝${ansi.reset}`;

    const lines = [
      topBorder,
      padLine(headerContent),
      padLine(trackV1Content),
      padLine(trackA1Content),
      padLine(sceneContent),
      bottomBorder,
    ];

    this.clearRenderedLines();
    for (const l of lines) {
      process.stdout.write(`${l}\n`);
    }
    this.linesRendered = lines.length;
  }

  private clearRenderedLines(): void {
    if (this.linesRendered > 0) {
      process.stdout.write(ansi.up(this.linesRendered) + "\r");
      for (let i = 0; i < this.linesRendered; i++) {
        process.stdout.write(ansi.clearLine);
        if (i < this.linesRendered - 1) process.stdout.write("\n");
      }
      if (this.linesRendered > 1) process.stdout.write(ansi.up(this.linesRendered - 1));
      process.stdout.write("\r");
    }
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.isTty) return;
    this.clearRenderedLines();
    process.stdout.write(ansi.cursorShow);
    const totalSec = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const multiplier = (this.totalDurationSec / Math.max(0.1, (Date.now() - this.startedAt) / 1000)).toFixed(2);
    process.stdout.write(
      `  ${ansi.green}✓${ansi.reset} ${ansi.bold}${ansi.brightWhite}Render complete in ${totalSec}s${ansi.reset} ` +
      `(${ansi.brightGreen}${multiplier}x realtime speed${ansi.reset} · ${Math.round(this.totalDurationSec * this.fps)} frames @ ${this.fps}fps)\n`,
    );
    this.linesRendered = 0;
  }
}

/**
 * Render the ultimate celebration & project stats banner.
 */
export function printProductionCompleteBanner(summary: {
  outPath: string;
  coverPath?: string;
  /** The `<out>.youtube.md` SEO pack, when the run wrote one (Y2). */
  youtubePath?: string;
  /** The `<out>.thumbnail.png` AI thumbnail, when the run wrote one (Y3). */
  thumbnailPath?: string;
  sourceDurationSec: number;
  outputDurationSec: number;
  sceneCount: number;
  llmProvider?: string;
  renderTimeSec?: number;
}): void {
  const savedSec = Math.max(0, summary.sourceDurationSec - summary.outputDurationSec);
  const cutPct = summary.sourceDurationSec > 0
    ? Math.round((savedSec / summary.sourceDurationSec) * 100)
    : 0;

  const providerLabel = summary.llmProvider
    ? summary.llmProvider === "gemini"
      ? "Gemini 3.7 Flash API"
      : summary.llmProvider === "antigravity"
        ? "Google Antigravity (Gemini 3.7 Flash)"
        : summary.llmProvider
    : "Local Fast-Cut Engine";

  const box = [
    `${ansi.bold}${ansi.brightCyan}╔════════════════════════════════════════════════════════════════════════════════╗${ansi.reset}`,
    `${ansi.bold}║${ansi.reset}   ${ansi.bold}${ansi.brightYellow}🎬  MASTER REEL PRODUCED SUCCESSFULLY${ansi.reset}                                 ${ansi.bold}║${ansi.reset}`,
    `${ansi.bold}╠════════════════════════════════════════════════════════════════════════════════╣${ansi.reset}`,
    `${ansi.bold}║${ansi.reset}  ${ansi.brightCyan}▸ Video:${ansi.reset}   ${ansi.bold}${ansi.brightWhite}${summary.outPath}${ansi.reset}`,
    ...(summary.coverPath
      ? [`${ansi.bold}║${ansi.reset}  ${ansi.brightMagenta}▸ Cover:${ansi.reset}   ${ansi.white}${summary.coverPath}${ansi.reset}`]
      : []),
    ...(summary.youtubePath
      ? [`${ansi.bold}║${ansi.reset}  ${ansi.brightRed}▸ YouTube:${ansi.reset} ${ansi.white}${summary.youtubePath}${ansi.reset}`]
      : []),
    ...(summary.thumbnailPath
      ? [`${ansi.bold}║${ansi.reset}  ${ansi.brightYellow}▸ Thumb:${ansi.reset}   ${ansi.white}${summary.thumbnailPath}${ansi.reset}`]
      : []),
    `${ansi.bold}║${ansi.reset}  ${ansi.green}▸ Engine:${ansi.reset}  ${ansi.bold}${ansi.brightCyan}${providerLabel}${ansi.reset} + ${ansi.brightWhite}Remotion${ansi.reset} + ${ansi.brightWhite}Whisper.cpp${ansi.reset}`,
    `${ansi.bold}║${ansi.reset}  ${ansi.yellow}▸ Cut:${ansi.reset}     ${ansi.bold}${summary.outputDurationSec.toFixed(1)}s${ansi.reset} (trimmed from ${summary.sourceDurationSec.toFixed(1)}s · ${ansi.green}-${cutPct}% dead air/flubs${ansi.reset})`,
    `${ansi.bold}║${ansi.reset}  ${ansi.blue}▸ Scenes:${ansi.reset}  ${ansi.bold}${summary.sceneCount}${ansi.reset} dynamic AI graphic overlay${summary.sceneCount === 1 ? "" : "s"} placed`,
    ...(summary.renderTimeSec !== undefined
      ? [`${ansi.bold}║${ansi.reset}  ${ansi.brightGreen}▸ Render:${ansi.reset}  ${summary.renderTimeSec.toFixed(1)}s (${(summary.outputDurationSec / summary.renderTimeSec).toFixed(2)}x realtime export)`]
      : []),
    `${ansi.bold}╚════════════════════════════════════════════════════════════════════════════════╝${ansi.reset}`,
  ];

  console.log("");
  for (const l of box) {
    console.log(l);
  }
}
