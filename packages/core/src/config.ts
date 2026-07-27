import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelPrice } from "./producer/usage";

export interface OssclipConfig {
  ffmpegPath: string;
  ffprobePath: string;
  whisperPath: string;
  modelDir: string;
  model: string;
  browserExecutable?: string;
  /**
   * USD per million tokens, keyed by model id or family substring — overrides
   * the built-in assumptions in `producer/usage.ts` so a run's cost line
   * reflects the account's actual rates instead of ours.
   */
  pricing?: Record<string, ModelPrice>;
}

const DEFAULTS: OssclipConfig = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  whisperPath: "whisper-cli",
  modelDir: join(homedir(), ".ossclip", "models"),
  // small.en over base.en: a large accuracy step for accented English at
  // modest cost — base.en turned "code churn" into a company name that then
  // reached the captions and a hook label (FINDINGS §14b).
  model: "small.en",
};

/**
 * Resolution order per key: env (OSSCLIP_FFMPEG, OSSCLIP_FFPROBE, OSSCLIP_WHISPER,
 * OSSCLIP_MODEL_DIR, OSSCLIP_MODEL, OSSCLIP_BROWSER) → ~/.ossclip/config.json → defaults.
 */
export function loadConfig(): OssclipConfig {
  let fileCfg: Partial<OssclipConfig> = {};
  try {
    fileCfg = JSON.parse(readFileSync(join(homedir(), ".ossclip", "config.json"), "utf8"));
  } catch {
    // no config file — fine
  }
  return {
    ffmpegPath: process.env.OSSCLIP_FFMPEG ?? fileCfg.ffmpegPath ?? DEFAULTS.ffmpegPath,
    ffprobePath: process.env.OSSCLIP_FFPROBE ?? fileCfg.ffprobePath ?? DEFAULTS.ffprobePath,
    whisperPath: process.env.OSSCLIP_WHISPER ?? fileCfg.whisperPath ?? DEFAULTS.whisperPath,
    modelDir: process.env.OSSCLIP_MODEL_DIR ?? fileCfg.modelDir ?? DEFAULTS.modelDir,
    model: process.env.OSSCLIP_MODEL ?? fileCfg.model ?? DEFAULTS.model,
    browserExecutable: process.env.OSSCLIP_BROWSER ?? fileCfg.browserExecutable,
    pricing: fileCfg.pricing,
  };
}
