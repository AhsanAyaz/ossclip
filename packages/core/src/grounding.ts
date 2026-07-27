import type { Scene } from "./scene-schema";
import type { Transcript } from "./schema";

/**
 * Copy-grounding post-check (FINDINGS §14a): label-ish props must reuse
 * nouns the take actually contains. The producer prompt demands grounding in
 * the moment's slice; this check is deliberately looser — it flags a token
 * only when it appears NOWHERE in the transcript — so what it does flag is a
 * high-confidence hallucination ("REVENUE" on a code-churn stat), visible in
 * the report without watching the video.
 */

export interface GroundingIssue {
  sceneId: string;
  component: string;
  field: string;
  token: string;
}

/**
 * Fields that carry factual labels, per component. Conversational/stylized
 * copy (ChatMock messages, TerminalMock lines) is invented by design and is
 * not checked.
 */
const CHECKED_FIELDS: Record<string, string[]> = {
  TitleCard: ["eyebrow", "title", "sub"],
  StatCard: ["label", "caption"],
  RuleCard: ["kicker", "text", "struck"],
  StrikethroughReveal: ["lines"],
  FlowDiagram: ["nodes"],
  ScreenshotFrame: ["label"],
};

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "at", "for", "and", "or", "vs",
  "no", "not", "non", "per", "than", "then", "with", "without", "into",
  "over", "under", "more", "less", "most", "least", "your", "our", "my",
  "his", "her", "their", "its", "it", "is", "are", "was", "be", "this",
  "that", "these", "those", "you", "we", "they", "one", "two", "all",
  "every", "each", "when", "how", "why", "what", "now", "today", "rule",
  "step", "do", "dont", "done",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Numbers, units and short glue don't need transcript support. */
function needsSupport(token: string): boolean {
  if (token.length < 3) return false;
  if (/\d/.test(token)) return false;
  return !STOPWORDS.has(token);
}

function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

export function checkGrounding(
  scenes: readonly Scene[],
  transcript: Transcript,
): GroundingIssue[] {
  const spoken = new Set(transcript.words.flatMap((w) => tokenize(w.text)));
  const supported = (token: string): boolean =>
    spoken.has(token) ||
    spoken.has(`${token}s`) ||
    (token.endsWith("s") && spoken.has(token.slice(0, -1)));

  const issues: GroundingIssue[] = [];
  for (const scene of scenes) {
    const fields = CHECKED_FIELDS[scene.component] ?? [];
    const merged = { ...scene.props, ...scene.overrides };
    for (const field of fields) {
      for (const text of stringsOf(merged[field])) {
        for (const token of tokenize(text)) {
          if (needsSupport(token) && !supported(token)) {
            issues.push({ sceneId: scene.id, component: scene.component, field, token });
          }
        }
      }
    }
  }
  return issues;
}
