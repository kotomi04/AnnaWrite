import type { Author, AuthorSample, RequirementCard, WritingProject } from "../types";
import { draftPlainText, selectedTextFromDraft } from "../utils/draft";

const STYLE_MANUAL_FRAME = [
  "Use the uploaded style guide or writing samples as the source of truth.",
  "Produce a practical writing operating manual, not a generic summary.",
  "Follow this frame: Core identity, overall tone, structure and narrative logic, sentence rhythm, evidence/detail rules, opening and transition patterns, avoid rules, and prompt rules.",
  "If the sample is an explicit style guide, preserve its intent and make the rules directly usable for future draft generation.",
  "Be specific: mention what to do, what to avoid, and how the style should feel on the page.",
];

const sampleExcerpt = (sample: AuthorSample, limit = 1200) => ({
  title: sample.title,
  source_type: sample.sourceType,
  material_type: sample.materialType || "article",
  source_url: sample.sourceUrl,
  file_name: sample.fileName,
  status: sample.status || "saved",
  excerpt: sample.content.slice(0, limit),
});

const authorContext = (author: Author | null, fallback: string) => author
  ? {
      name: author.name,
      description: author.description,
      style_summary: author.styleSummary,
      shared_style_summary: author.sharedStyleSummary,
      skill_prompt: author.skillPrompt,
      parameters: author.parameters,
      sample_excerpts: author.samples.map(sampleExcerpt),
    }
  : fallback;

export function buildAuthorAnalysisPrompt(author: Author, samples: AuthorSample[]) {
  return {
    system:
      "You analyze writing samples and produce a reusable author style manual. Return valid JSON only. Do not invent facts not visible in the samples.",
    user: {
      author_name: author.name,
      author_description: author.description,
      existing_shared_style_summary: author.sharedStyleSummary,
      analysis_frame: STYLE_MANUAL_FRAME,
      quality_bar: [
        "The style_summary must read like a concise professional style guide with clear sections.",
        "The skill_prompt must be directly usable by another LLM to write in this style.",
        "Never stop at generic labels like professional, clear, insightful, engaging, or well-written unless you immediately ground them in sample-specific behaviors.",
        "Quote or paraphrase concrete moves from the samples: opening devices, sentence length habits, transition phrases, evidence style, emotional temperature, and what the writer avoids.",
        "Each avoid rule and recommended rule must be actionable and specific to these samples.",
      ],
      samples: samples.map((sample) => sampleExcerpt(sample, 5000)),
      output_schema: {
        style_summary: "A compact manual with headings: Core identity, Tone, Structure, Sentence rhythm, Evidence/detail, Avoid, Prompt rules.",
        voice: "comma-separated tone parameters",
        structure_habits: ["specific structural rule"],
        sentence_rhythm: "specific sentence and paragraph rhythm",
        opening_patterns: ["specific opening pattern"],
        transition_patterns: ["specific transition pattern"],
        emotion_curve: "how the emotional or persuasive pressure moves",
        imagery_and_metaphor: "imagery, metaphor, or abstraction tendency",
        detail_density: "how much detail and what kind",
        dialogue_style: "dialogue tendency, if relevant",
        pacing: "pacing rule",
        avoid: ["specific avoid rule"],
        recommended_rules: ["specific do rule"],
        skill_prompt: "a reusable prompt fragment for writing in this author style",
      },
    },
  };
}

export function buildRequirementPrompt(project: WritingProject, author: Author | null) {
  return {
    system:
      "You are a precise writing strategist. Before drafting, produce an editable chapter outline as valid JSON. The outline must be a readable article/chapter table of contents, not a requirement checklist.",
    user: {
      selected_author: authorContext(author, "No selected author. Use a clear default writer."),
      brief: {
        writing_brief: project.brief,
        writing_type: project.writingType,
        channel: project.channel,
        audience: project.audience,
        goal: project.goal,
        must_include: project.mustInclude,
        avoid: project.avoid,
        references: project.references,
        language: project.language,
        length_target: project.customWordCount || project.lengthTarget,
        tone: project.tone,
        output_goal: project.outputGoal,
        reader_emotion_target: project.readerEmotionTarget,
        intention_type: project.intentionType,
        commercial_settings: project.commercialSettings,
        current_event_settings: project.currentEventSettings,
        story_settings: project.storySettings,
      },
      required_schema: {
        working_title: "string",
        core_angle: "string",
        cards: [
          {
            id: "string",
            type: "opening|chapter|ending",
            title: "section title, such as 开篇：... / 第一章：... / 结尾：...",
            content: "one paragraph describing what this section should write",
            author_link: "brief author/style note for this section",
            priority: "high|medium|low",
            editable: true,
          },
        ],
      },
      guardrails: [
        "Decide the number of outline sections yourself based on the brief. Do not force exactly 5 sections.",
        "Use 3-8 sections in most cases: usually an opening, several body chapters, and an ending, but adapt when the topic needs more or fewer sections.",
        "Use Chinese section titles unless the user explicitly requests another language.",
        "Use the app_author style as a reference for readable chapter jobs, not as a fixed five-part template.",
        "Before returning JSON, choose a section_count that fits the brief. Short/simple briefs can use 3-4 sections; broader topics can use 6-8 sections.",
        "Each content field should explain the writing job of that section, not list abstract requirements.",
        "If current-event related, require source links before asserting facts.",
        "For commercial or hybrid writing, follow the requested visibility and content-to-promotion ratio.",
        "Tie author notes to selected author samples by name where possible.",
      ],
    },
  };
}

export function buildOutlineRevisionPrompt(project: WritingProject, author: Author | null, instruction: string) {
  return {
    system:
      "You revise an editable chapter outline from the user's comment. Return the full revised outline as valid JSON only. Do not draft the article.",
    user: {
      selected_author: authorContext(author, "No selected author. Use a clear default writer."),
      user_comment: instruction,
      current_plan: {
        working_title: project.requirementTitle || project.title,
        core_angle: project.goal,
        sections: project.requirementCards,
      },
      brief: {
        writing_brief: project.brief,
        writing_type: project.writingType,
        channel: project.channel,
        audience: project.audience,
        goal: project.goal,
        must_include: project.mustInclude,
        avoid: project.avoid,
        references: project.references,
        language: project.language,
        length_target: project.customWordCount || project.lengthTarget,
        tone: project.tone,
        output_goal: project.outputGoal,
        reader_emotion_target: project.readerEmotionTarget,
        intention_type: project.intentionType,
        commercial_settings: project.commercialSettings,
        current_event_settings: project.currentEventSettings,
        story_settings: project.storySettings,
      },
      required_schema: {
        working_title: "string",
        core_angle: "string",
        cards: [
          {
            id: "string",
            type: "opening|chapter|ending",
            title: "section title",
            content: "one paragraph describing what this section should write",
            author_link: "brief author/style note for this section",
            priority: "high|medium|low",
            editable: true,
          },
        ],
      },
      guardrails: [
        "Return the complete revised outline, not only changed sections.",
        "Apply the user's comment materially. Add, delete, merge, split, or reorder sections only when it improves the outline or the user asks for it.",
        "Keep the app_author outline style: each section should read like a chapter job, for example 开篇：..., 第一章：..., 结尾：....",
        "Do not force exactly 5 sections. Choose the right number for the brief and user comment.",
        "Preserve useful existing section intent unless the comment asks to change it.",
        "Use Chinese section titles unless the user explicitly requests another language.",
        "Keep factual claims grounded in the provided references.",
      ],
    },
  };
}

export function buildOutlineSectionRevisionPrompt(project: WritingProject, author: Author | null, card: RequirementCard, instruction: string) {
  return {
    system:
      "You revise exactly one section in an editable chapter outline. Return valid JSON for that single section only. Do not revise other sections and do not draft the article.",
    user: {
      selected_author: authorContext(author, "No selected author. Use a clear default writer."),
      user_comment: instruction,
      target_section: card,
      full_outline_for_context: project.requirementCards,
      brief: {
        writing_brief: project.brief,
        writing_type: project.writingType,
        channel: project.channel,
        audience: project.audience,
        goal: project.goal,
        must_include: project.mustInclude,
        avoid: project.avoid,
        references: project.references,
        language: project.language,
        length_target: project.customWordCount || project.lengthTarget,
        tone: project.tone,
        intention_type: project.intentionType,
        commercial_settings: project.commercialSettings,
        story_settings: project.storySettings,
      },
      output_schema: {
        id: "string",
        type: "opening|chapter|ending",
        title: "section title",
        content: "one paragraph describing what this section should write",
        author_link: "brief author/style note for this section",
        priority: "high|medium|low",
        editable: true,
      },
      guardrails: [
        "Revise only the target section.",
        "Keep the same id and order.",
        "Apply the user's comment visibly.",
        "Keep the section title in the app_author outline style when possible.",
        "Preserve useful intent from the original section unless the comment asks to change it.",
        "Return strict JSON for one section only.",
      ],
    },
  };
}

export function buildDraftPrompt(project: WritingProject, author: Author | null, cards: RequirementCard[]) {
  return {
    system:
      "You generate a complete first draft from the approved chapter outline. Return structured JSON with title and paragraphs. Do not add unsupported current-event facts.",
    user: {
      selected_author: authorContext(author, "No selected author. Use a clean default writer."),
      brief: project.brief,
      writing_type: project.writingType,
      channel: project.channel,
      audience: project.audience,
      goal: project.goal,
      must_include: project.mustInclude,
      avoid: project.avoid,
      references: project.references,
      outline_sections: cards,
      length_target: project.customWordCount || project.lengthTarget,
      language: project.language,
      tone: project.tone,
      content_intention: project.intentionType,
      story_settings: project.storySettings,
      commercial_settings: project.commercialSettings,
      output_constraints: [
        "Use the author profile as style context, not as a factual source.",
        "Follow the approved outline sections in order.",
        "Keep unverified current-event claims out unless references contain source links.",
      ],
      output_schema: {
        title: "string",
        paragraphs: ["string"],
      },
    },
  };
}

export function buildSelectedRewritePrompt(
  project: WritingProject,
  author: Author | null,
  selectedSentenceIds: string[],
  instruction: string,
) {
  return {
    system:
      "You are a precise local editor. You must only rewrite the selected text. Do not rewrite the full article. Do not add explanations. Return only valid JSON with replacement_text.",
    user: {
      full_draft_for_context: draftPlainText(project.draft),
      selected_text: selectedTextFromDraft(project.draft, selectedSentenceIds),
      selection_location_metadata: { sentence_ids: selectedSentenceIds },
      user_revision_instruction: instruction,
      author_style_summary: author?.styleSummary ?? "No selected author.",
      shared_style_summary: author?.sharedStyleSummary,
      author_skill_prompt: author?.skillPrompt ?? "Use a clean default writer.",
      style_examples: author?.samples.map(sampleExcerpt).slice(0, 3) ?? [],
      outline_sections: project.requirementCards,
      constraints: [
        "Only rewrite the selected range.",
        "Preserve all unselected content exactly.",
        "Return only replacement text for the selected range.",
        "Match the selected author style when available.",
        "Follow the current outline sections.",
      ],
      expected_output: {
        replacement_text: "string",
        reason: "brief internal-facing reason, optional",
      },
    },
  };
}

export function buildWholeDraftRefinePrompt(project: WritingProject, author: Author | null, instruction: string) {
  return {
    system:
      "You revise the whole draft because the user explicitly requested a full-draft change. Return JSON with title and paragraphs.",
    user: {
      current_draft: draftPlainText(project.draft),
      user_feedback: instruction,
      author_style_summary: author?.styleSummary ?? "No selected author.",
      shared_style_summary: author?.sharedStyleSummary,
      author_skill_prompt: author?.skillPrompt ?? "Use a clean default writer.",
      outline_sections: project.requirementCards,
      output_schema: { title: "string", paragraphs: ["string"] },
    },
  };
}
