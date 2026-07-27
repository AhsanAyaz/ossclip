import type { Scene } from "./scene-schema";
import type { Transcript } from "./schema";
import { soundsSimilar } from "./phonetics";

/**
 * Copy-grounding post-check (FINDINGS §14a): label-ish props must reuse
 * nouns the take actually contains. The producer prompt demands grounding in
 * the moment's slice; this check is deliberately looser — it flags a token
 * only when it appears NOWHERE in the transcript — so what it does flag is a
 * high-confidence hallucination ("REVENUE" on a code-churn stat), visible in
 * the report without watching the video.
 *
 * Run this against the REPAIRED transcript, never the raw one. §17 was this
 * check fighting the mishearing mitigation: the producer correctly wrote
 * "code churn" for a take transcribed as "coach and", and the check reported
 * the repair as an invention. Repairing once, up front, removes the conflict
 * at its source — which is why no phonetic tolerance lives here. Tolerance
 * was tried and rejected: matching copy against the take by sound absolves
 * real hallucinations too ("CODECHUN REVENUE" reads as a repair of "code
 * churn"), and a second mitigation pulling against the first is exactly what
 * produced §17.
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

/**
 * Function words carry no factual claim, so flagging them is pure noise —
 * this check is only worth anything if it is precise (FINDINGS §30, where
 * `caption "but"` was reported as ungrounded copy). Kept to grammar and
 * generic connectives: domain nouns stay checkable, because inventing one is
 * exactly the failure this exists to catch.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "at", "for", "and", "or", "vs",
  "no", "not", "non", "per", "than", "then", "with", "without", "into",
  "over", "under", "more", "less", "most", "least", "your", "our", "my",
  "his", "her", "their", "its", "it", "is", "are", "was", "be", "this",
  "that", "these", "those", "you", "we", "they", "one", "two", "all",
  "every", "each", "when", "how", "why", "what", "now", "today", "rule",
  "step", "do", "dont", "done",
  // §30: conjunctions, auxiliaries, prepositions and degree words.
  "but", "so", "yet", "if", "else", "because", "while", "since", "until",
  "from", "about", "after", "before", "during", "between", "through",
  "up", "down", "off", "out", "away", "back", "here", "there", "again",
  "just", "very", "really", "quite", "even", "still", "only", "also", "too",
  "am", "were", "been", "being", "has", "have", "had", "can", "cant",
  "will", "wont", "would", "should", "could", "may", "might", "must",
  "get", "gets", "got", "let", "lets", "make", "makes", "made",
  "some", "any", "many", "much", "few", "both", "own", "same", "other",
  "another", "such", "which", "who", "whom", "whose", "where",
  "always", "never", "often", "sometimes", "usually", "already", "soon",
  "actually", "basically", "literally", "probably", "maybe", "perhaps",
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
  /**
   * Who the speaker is (`--speaker`). Their own name and brand are legitimate
   * on screen even when the recognizer mangled every utterance of them, so the
   * hint counts as spoken vocabulary — otherwise the check fights the repair
   * pass, which is the §17 mistake in a new place.
   */
  speaker?: string,
): GroundingIssue[] {
  const spoken = new Set([
    ...transcript.words.flatMap((w) => tokenize(w.text)),
    ...(speaker ? tokenize(speaker) : []),
  ]);
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
