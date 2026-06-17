import type { AuthorAnalysisResult } from "../types";

export function formatStyleManualFromAnalysis(result: AuthorAnalysisResult) {
  const lines = [
    `Core identity: ${result.style_summary}`,
    `Tone: ${result.voice}`,
    `Structure: ${result.structure_habits.join(" -> ")}`,
    `Sentence rhythm: ${result.sentence_rhythm}`,
    `Openings: ${result.opening_patterns.join("; ")}`,
    `Transitions: ${result.transition_patterns.join("; ")}`,
    `Evidence/detail: ${result.detail_density}`,
    result.imagery_and_metaphor ? `Imagery/metaphor: ${result.imagery_and_metaphor}` : "",
    `Avoid: ${result.avoid.join("; ")}`,
    `Prompt rules: ${result.recommended_rules.join("; ")}`,
  ];
  return lines.filter((line) => !/: $/.test(line)).join("\n");
}
