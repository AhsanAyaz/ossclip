import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelPrice } from "./producer/usage";

export interface OssclipConfig {
  ffmpegPath: string;
  ffprobePath: string;
  whisperPath: string;
  modelDir: string;
  model: string;
  /**
   * Model for mechanical LLM calls (repair, scene props) — the editorial beat
   * sheet always uses the main model. "same" disables tiering (FINDINGS §37).
   */
  fastModel?: string;
  /**
   * Who is in the video — "Ahsan, host of the Code with Ahsan channel".
   * Lets the repair pass recognise a mangled proper noun instead of inventing
   * a plausible one, and stops grounding flagging the speaker's own name.
   */
  speaker?: string;
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

/** Everything ossclip owns on disk lives under here: config.json, models/, bin/, .env. */
export const CONFIG_DIR = join(homedir(), ".ossclip");

export function configFilePath(baseDir: string = CONFIG_DIR): string {
  return join(baseDir, "config.json");
}

/**
 * Merge a patch into `~/.ossclip/config.json`, creating it if needed.
 *
 * Read-merge-write over the RAW file, not a loaded OssclipConfig: users
 * hand-edit this file, and keys the patch doesn't touch (`pricing`,
 * `speaker`, comments-by-convention like `_note`) must survive a
 * `ossclip setup` run untouched.
 */
export function saveConfigPatch(patch: Partial<OssclipConfig>, baseDir: string = CONFIG_DIR): string {
  const path = configFilePath(baseDir);
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // absent or unparseable — a fresh object; setup never destroys a broken
    // file silently, so keep a .bak when the file existed but didn't parse
    try {
      const raw = readFileSync(path, "utf8");
      writeFileSync(`${path}.bak`, raw);
    } catch {
      // truly absent — nothing to back up
    }
  }
  mkdirSync(baseDir, { recursive: true });
  const merged = { ...existing, ...patch };
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  return path;
}

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
    fastModel: process.env.OSSCLIP_FAST_MODEL ?? fileCfg.fastModel,
    speaker: process.env.OSSCLIP_SPEAKER ?? fileCfg.speaker,
    browserExecutable: process.env.OSSCLIP_BROWSER ?? fileCfg.browserExecutable,
    pricing: fileCfg.pricing,
  };
}
