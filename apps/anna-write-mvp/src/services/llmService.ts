import type {
  Author,
  AuthorAnalysisResult,
  AuthorSample,
  Draft,
  RequirementCard,
  RequirementGenerationResult,
  WritingProject,
} from "../types";
import {
  buildAuthorAnalysisPrompt,
  buildDraftPrompt,
  buildOutlineRevisionPrompt,
  buildOutlineSectionRevisionPrompt,
  buildRequirementPrompt,
  buildSelectedRewritePrompt,
  buildWholeDraftRefinePrompt,
} from "./promptBuilders";
import {
  annaCompleteText,
  getAnnaRuntime,
  getAnnaRuntimeHint,
  getLastAnnaRuntimeError,
  hasAnnaRuntimeGlobal,
  isAnnaEntryPreview,
  parseJsonFromText,
} from "./annaRuntime";
import { draftPlainText, makeDraftFromParagraphs, selectedTextFromDraft } from "../utils/draft";

const wait = (ms = 520) => new Promise((resolve) => setTimeout(resolve, ms));
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
let lastProvider: "anna" | "mock" = "mock";

function compact(value?: string) {
  return value?.trim() || "the central idea";
}

function isStory(project: WritingProject) {
  return /story|novel|chapter|fiction/i.test(project.writingType) || /fiction|story/i.test(project.intentionType);
}

function isWechat(project: WritingProject) {
  return /wechat/i.test(project.channel) || /wechat/i.test(project.writingType);
}

function isCommercial(project: WritingProject) {
  return /commercial|promotional|hybrid/i.test(project.intentionType);
}

function authorNudge(author: Author | null) {
  if (!author) return "Use a clear default writer: specific, useful, and calm.";
  const sampleName = author.samples[1]?.title || author.samples[0]?.title || "the uploaded samples";
  return `Adapt to ${author.name}: ${author.styleSummary} Use a visible move from ${sampleName} where it fits.`;
}

function makeCard(order: number, type: string, title: string, content: string, authorLink: string, priority: "high" | "medium" | "low" = "medium"): RequirementCard {
  return {
    id: id("card"),
    type,
    title,
    content,
    authorLink,
    priority,
    order,
    editable: true,
  };
}

async function completeJson<T>(name: string, prompt: { system: string; user: unknown }, maxTokens = 2600): Promise<T | null> {
  try {
    const text = await annaCompleteText({
      name,
      system: `${prompt.system}

Return strict JSON only. No Markdown fences. No commentary outside JSON.`,
      user: prompt.user,
      maxTokens,
    });
    if (!text) {
      lastProvider = "mock";
      return null;
    }
    lastProvider = "anna";
    return parseJsonFromText<T>(text);
  } catch (error) {
    console.warn(`[AnnaWrite] Anna LLM failed for ${name}; using mock fallback.`, error);
    lastProvider = "mock";
    return null;
  }
}

function normalizeList(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function normalizeAnalysis(value: Partial<AuthorAnalysisResult>): AuthorAnalysisResult {
  return {
    style_summary: String(value.style_summary || ""),
    voice: String(value.voice || ""),
    structure_habits: normalizeList(value.structure_habits),
    sentence_rhythm: String(value.sentence_rhythm || ""),
    opening_patterns: normalizeList(value.opening_patterns),
    transition_patterns: normalizeList(value.transition_patterns),
    emotion_curve: String(value.emotion_curve || ""),
    imagery_and_metaphor: String(value.imagery_and_metaphor || ""),
    detail_density: String(value.detail_density || ""),
    dialogue_style: String(value.dialogue_style || ""),
    pacing: String(value.pacing || ""),
    avoid: normalizeList(value.avoid),
    recommended_rules: normalizeList(value.recommended_rules),
    skill_prompt: String(value.skill_prompt || ""),
  };
}

function normalizeRequirementResult(value: Partial<RequirementGenerationResult>): RequirementGenerationResult {
  const raw = value as Partial<RequirementGenerationResult> & { sections?: unknown[] };
  const cards = Array.isArray(value.cards) ? value.cards : Array.isArray(raw.sections) ? raw.sections : [];
  return {
    working_title: String(value.working_title || "Untitled writing plan"),
    core_angle: String(value.core_angle || ""),
    cards: cards.map((rawCard, order) => {
      const card = rawCard as Partial<RequirementCard> & { author_link?: string; author_note?: string; summary?: string; description?: string };
      return {
        id: String(card.id || id("card")),
        type: String(card.type || (order === 0 ? "opening" : order === cards.length - 1 ? "ending" : "chapter")),
        title: String(card.title || `第${order + 1}节`),
        content: String(card.content || card.summary || card.description || ""),
        authorLink: String(card.authorLink || card.author_link || card.author_note || ""),
        priority: ["high", "medium", "low"].includes(String(card.priority)) ? (String(card.priority) as "high" | "medium" | "low") : "medium",
        order,
        editable: card.editable !== false,
      };
    }),
  };
}

function normalizeCard(value: Partial<RequirementCard>, fallback: RequirementCard): RequirementCard {
  const raw = value as Partial<RequirementCard> & { author_link?: string };
  return {
    ...fallback,
    id: String(raw.id || fallback.id),
    type: String(raw.type || fallback.type),
    title: String(raw.title || fallback.title),
    content: String(raw.content || fallback.content),
    authorLink: String(raw.authorLink || raw.author_link || fallback.authorLink),
    priority: ["high", "medium", "low"].includes(String(raw.priority)) ? (String(raw.priority) as "high" | "medium" | "low") : fallback.priority,
    editable: raw.editable !== false,
  };
}

function articleCards(project: WritingProject, author: Author | null) {
  const topic = compact(project.brief).replace(/[.!?。！？]$/, "");
  const sample = author?.samples[1]?.title || author?.samples[0]?.title || "";
  const authorNote = author ? `参考 ${author.name}${sample ? `《${sample}》` : ""} 的节奏：${author.styleSummary}` : "使用清晰、具体、低废话的默认写作风格。";
  const middleCards = [
    makeCard(0, "opening", "开篇：把读者带入问题", `用「${topic}」作为切入点，说明这篇内容要解决什么问题，以及为什么现在值得读。`, authorNote, "high"),
    makeCard(1, "chapter", "第一章：交代核心信息", "讲清楚主题、产品、事件或观点的基本背景，让读者快速建立判断所需的上下文。", project.references ? "只使用用户提供的 references 作为具体事实来源。" : authorNote),
    makeCard(2, "chapter", "第二章：展开价值与细节", "围绕重点展开卖点、方法、案例或证据，把最重要的内容讲具体，避免只停留在概念层。", project.mustInclude ? `必须自然包含：${project.mustInclude}` : authorNote, "high"),
    makeCard(3, "chapter", "第三章：回应疑问或补充对比", "补充读者可能关心的顾虑、选择标准、适用场景或差异点，让文章更完整、更可信。", project.avoid ? `避免：${project.avoid}` : authorNote),
    makeCard(4, "chapter", "第四章：给出判断或方法", "把前文信息收束成可执行的判断、方法或选择标准，让读者知道应该如何理解和使用这些信息。", authorNote),
    makeCard(5, "chapter", "第五章：补充场景与边界", "说明适用场景、限制条件或容易误解的地方，让文章更完整，也更可信。", project.avoid ? `避免：${project.avoid}` : authorNote),
  ];
  const ending = makeCard(0, "ending", "结尾：总结并引导下一步", "收束全文重点，给出明确行动建议，例如预约、购买、留言、转发或继续了解。", isCommercial(project) ? `转化目标：${project.commercialSettings.conversionGoal || "自然引导下一步"}` : authorNote, "high");
  const briefLength = `${project.brief} ${project.mustInclude} ${project.references}`.trim().length;
  const targetText = `${project.lengthTarget} ${project.customWordCount} ${project.writingType} ${project.goal}`.toLowerCase();
  let count = briefLength < 80 || /short|brief|短|简短|小红书/.test(targetText) ? 3 : briefLength > 220 || /long|深度|report|guide|长/.test(targetText) ? 6 : 4;
  if (isCommercial(project)) count = Math.max(count, 4);
  const selected = [middleCards[0], ...middleCards.slice(1, Math.max(1, count - 1)), ending];
  return selected.map((card, order) => ({ ...card, order, type: order === 0 ? "opening" : order === selected.length - 1 ? "ending" : "chapter" }));
}

function wechatCards(project: WritingProject, author: Author | null) {
  return articleCards(project, author).map((card) => ({
    ...card,
    authorLink: `${card.authorLink}\n微信公众号语境下注意标题承诺和开篇兑现，段落要适合手机阅读。`,
  }));
}

function storyCards(project: WritingProject, author: Author | null) {
  const s = project.storySettings;
  const sample = author?.samples[0]?.title || "the selected samples";
  const cards = [
    makeCard(0, "opening", "开篇：把读者带入问题", `用「${s.protagonist || compact(project.brief)}」和「${s.setting || "一个具体场景"}」作为切入点，把读者带入故事的核心压力。`, `开篇参考 ${sample}：用具体画面，不要先解释主题。`, "high"),
    makeCard(1, "chapter", "第一章：交代核心信息", `交代人物、地点、欲望和表层目标，让读者理解这个故事为什么开始。主题：${s.theme || "让主题藏在行动里"}。`, "欲望要通过动作和选择显现。"),
    makeCard(2, "chapter", "第二章：展开价值与细节", s.conflict || "展开主要冲突、关系压力和关键细节，让故事从场景推进，而不是靠解释推进。", author?.parameters.detailDensity || "用细节承载情绪。", "high"),
    makeCard(3, "chapter", "第三章：回应疑问或补充对比", "补充人物犹豫、误解、代价或另一个选择，让读者看到冲突的复杂性。", author?.parameters.pacingStyle || "保持节奏克制，不要过早解释。"),
    makeCard(4, "chapter", "第四章：推高选择代价", "让人物必须做出一个更难的选择，显示关系、目标或自我认知发生变化。", author?.parameters.emotionCurve || "情绪转折要通过动作和场景完成。"),
    makeCard(4, "ending", "结尾：总结并引导下一步", s.endingDirection || "用一个动作、物件或画面收束，让结尾回应开篇但不把情绪说破。", author?.parameters.emotionCurve || "结尾要短、有回声。", "high"),
  ];
  const briefLength = `${project.brief} ${s.conflict} ${s.endingDirection}`.trim().length;
  const targetText = `${project.lengthTarget} ${project.customWordCount}`.toLowerCase();
  const count = briefLength < 80 || /short|短|简短/.test(targetText) ? 3 : briefLength > 220 || /long|长/.test(targetText) ? 6 : 4;
  const selected = [cards[0], ...cards.slice(1, Math.max(1, count - 1)), cards[cards.length - 1]];
  return selected.map((card, order) => ({ ...card, order, type: order === 0 ? "opening" : order === selected.length - 1 ? "ending" : "chapter" }));
}

export const llmService = {
  // TODO: route these functions to OpenAI, Anna-hosted LLM, or another provider when credentials are configured.
  // The UI only calls this service layer, so provider wiring should stay out of React components.
  getProviderLabel() {
    if (lastProvider === "anna") return "Anna LLM";
    if (isAnnaEntryPreview()) return getAnnaRuntimeHint();
    return hasAnnaRuntimeGlobal() ? `Mock fallback (${getLastAnnaRuntimeError() || "Anna LLM unavailable"})` : "Mock fallback";
  },

  getStatusLabel() {
    if (lastProvider === "anna") return "Anna LLM connected";
    if (isAnnaEntryPreview()) return "Preview only";
    const error = getLastAnnaRuntimeError();
    if (error) return `LLM error: ${error.slice(0, 42)}`;
    if (hasAnnaRuntimeGlobal()) return "Anna LLM ready";
    return "Mock mode";
  },

  getStatusTone(): "ready" | "mock" | "fallback" {
    if (lastProvider === "anna") return "ready";
    if (isAnnaEntryPreview()) return "fallback";
    if (getLastAnnaRuntimeError()) return "fallback";
    if (hasAnnaRuntimeGlobal()) return "ready";
    return "mock";
  },

  async warmupRuntime() {
    const runtime = await getAnnaRuntime();
    return Boolean(runtime?.llm?.complete);
  },

  async analyzeAuthorSamples(author: Author, samples: AuthorSample[]): Promise<AuthorAnalysisResult> {
    const prompt = buildAuthorAnalysisPrompt(author, samples);
    const real = await completeJson<Partial<AuthorAnalysisResult>>("analyzeAuthorSamples", prompt, 2600);
    if (real) return normalizeAnalysis(real);

    await wait();
    const joined = samples.map((sample) => sample.content).join("\n\n");
    const hasDialogue = /["“”]/.test(joined);
    const hasChinese = /[\u4e00-\u9fff]/.test(joined);
    return {
      style_summary: `${author.name} tends to open from concrete material, then move into judgment. The samples suggest a ${hasChinese ? "Chinese-first" : "English-first"} rhythm with visible scene detail and restrained explanation.`,
      voice: "observant, controlled, specific, low-hype",
      structure_habits: ["Concrete opening", "Named tension", "Layered middle", "Short earned close"],
      sentence_rhythm: "Mostly medium sentences, broken by short emphasis lines when the point lands.",
      opening_patterns: ["Start with a place or product friction", "Use a specific object before a general claim", "Name what changed before explaining why"],
      transition_patterns: ["That is why", "The practical effect is", "What changes is not only"],
      emotion_curve: "Quiet curiosity becomes pressure, then resolves into a clear but understated landing.",
      imagery_and_metaphor: "Prefers tactile images, rooms, windows, weather, and remembered objects over abstract slogans.",
      detail_density: "Medium-high; detail should prove the feeling rather than decorate it.",
      dialogue_style: hasDialogue ? "Sparse and subtextual; dialogue works best when characters avoid saying the real thing." : "Rare; use only when speech changes the pressure of a scene.",
      pacing: "Measured, with each paragraph carrying one turn.",
      avoid: ["unsupported certainty", "generic hype", "overexplained emotion", "empty dramatic words"],
      recommended_rules: ["Open with something concrete", "Let the middle clarify the stake", "Close with a sentence that feels inevitable"],
      skill_prompt:
        "Operate as this author: begin with a concrete observation, keep the language specific and restrained, avoid unsupported claims, let examples carry emotion, and close with a concise line that follows from the piece.",
    };
  },

  async generateAuthorSkill(author: Author, samples: AuthorSample[]) {
    return this.analyzeAuthorSamples(author, samples);
  },

  async reviseAuthorProfile(author: Author, samples: AuthorSample[], currentDescription: string, instruction: string): Promise<string> {
    const real = await completeJson<{ description?: string }>(
      "reviseAuthorProfile",
      {
        system:
          "You revise an author style profile. Keep it concise, specific, and useful as a writing operating manual. Return strict JSON only.",
        user: {
          author_name: author.name,
          current_profile: currentDescription,
          user_revision_instruction: instruction,
          sample_excerpts: samples.map((sample) => ({
            title: sample.title,
            material_type: sample.materialType || "article",
            source_url: sample.sourceUrl,
            excerpt: sample.content.slice(0, 2200),
          })),
          output_schema: {
            description: "revised author profile text",
          },
        },
      },
      2200,
    );
    if (real?.description?.trim()) return real.description.trim();

    await wait(360);
    const divider = /[.!?。！？]$/.test(currentDescription.trim()) ? "" : ".";
    return `${currentDescription.trim()}${divider}\nRevision focus: ${instruction.trim()}`;
  },

  async generateRequirementCards(project: WritingProject, author: Author | null): Promise<RequirementGenerationResult> {
    const prompt = buildRequirementPrompt(project, author);
    const real = await completeJson<Partial<RequirementGenerationResult>>("generateRequirementCards", prompt, 3600);
    if (real) return normalizeRequirementResult(real);

    await wait();
    const cards = isStory(project) ? storyCards(project, author) : isWechat(project) ? wechatCards(project, author) : articleCards(project, author);
    return {
      working_title: isStory(project)
        ? `${project.storySettings.protagonist || "Someone"} at the Edge of ${project.storySettings.setting || "the Known Place"}`
        : isWechat(project)
          ? `The Real Shift Behind ${compact(project.brief).slice(0, 44)}`
          : `A clearer way to think about ${compact(project.brief).slice(0, 54)}`,
      core_angle: isStory(project)
        ? "A scene-led draft where concrete details carry the emotional turn."
        : "A specific, reader-aware piece that pays off the opening promise without unsupported claims.",
      cards,
    };
  },

  async regenerateRequirementCard(card: RequirementCard, project: WritingProject, author: Author | null): Promise<RequirementCard> {
    const prompt = buildRequirementPrompt(project, author);
    const real = await completeJson<Partial<RequirementCard>>(
      "regenerateRequirementCard",
      {
        system: "Regenerate exactly one writing requirement card as strict JSON. Preserve the card schema.",
        user: {
          card,
          context: prompt.user,
          output_schema: {
            id: "string",
            type: "string",
            title: "string",
            content: "string",
            author_link: "string",
            priority: "high|medium|low",
            editable: true,
          },
        },
      },
      1200,
    );
    if (real) return normalizeCard(real, card);

    await wait(320);
    return {
      ...card,
      content: `${card.content} Tighten this requirement around one concrete reader payoff and one author-style constraint.`,
      authorLink: author ? `Re-check ${author.name}'s samples before drafting this section.` : "Use the default writer with clear, specific prose.",
    };
  },

  async reviseOutline(project: WritingProject, author: Author | null, instruction: string): Promise<RequirementGenerationResult> {
    const prompt = buildOutlineRevisionPrompt(project, author, instruction);
    const real = await completeJson<Partial<RequirementGenerationResult>>("reviseOutline", prompt, 3600);
    if (real) return normalizeRequirementResult(real);

    await wait(520);
    const lower = instruction.toLowerCase();
    const authorNote = author ? `按 ${author.name} 的风格校准：${author.styleSummary}` : "保持清晰、具体、少空话的默认写法。";
    const cards = (project.requirementCards.length ? project.requirementCards : articleCards(project, author)).map((card, order) => {
      let title = card.title;
      let content = card.content;
      let authorLink = card.authorLink || authorNote;

      if (/小红书|xiaohongshu/.test(lower)) {
        title = order === 0 ? "开篇：用真实场景抓住读者" : title.replace(/^第(.+?)章：?/, "第$1章：");
        content = `${content.replace(/[。.]$/, "")}，加入更强的场景感、个人判断和可被收藏的具体信息。`;
        authorLink = `${authorLink}\n小红书语境下要更轻、更具体，少解释概念，多给画面和判断。`;
      } else if (/转化|购买|预约|咨询|conversion/.test(lower)) {
        content = `${content.replace(/[。.]$/, "")}，并自然铺垫读者下一步行动，不要硬插广告。`;
        authorLink = `${authorLink}\n把转化目标藏进内容逻辑里，让行动建议来自前文价值。`;
      } else if (/具体|细节|example|案例|证据/.test(lower)) {
        content = `${content.replace(/[。.]$/, "")}，补入一个可验证的例子、细节或判断依据。`;
      } else if (/简洁|short|concise|短/.test(lower)) {
        content = content.split(/[。.!?！？]/).filter(Boolean).slice(0, 1).join("。") || content;
        authorLink = `${authorLink}\n压缩章节任务，只保留最关键的写作动作。`;
      } else {
        content = `${content.replace(/[。.]$/, "")}，并根据用户意见调整：${instruction}`;
      }

      return {
        ...card,
        title,
        content,
        authorLink,
        order,
      };
    });

    return {
      working_title: project.requirementTitle || project.title || "Revised writing outline",
      core_angle: `Revised according to user comment: ${instruction}`,
      cards,
    };
  },

  async reviseRequirementCard(card: RequirementCard, project: WritingProject, author: Author | null, instruction: string): Promise<RequirementCard> {
    const prompt = buildOutlineSectionRevisionPrompt(project, author, card, instruction);
    const real = await completeJson<Partial<RequirementCard>>("reviseOutlineSection", prompt, 1400);
    if (real) return normalizeCard({ ...real, id: card.id, order: card.order }, card);

    await wait(360);
    const lower = instruction.toLowerCase();
    let title = card.title;
    let content = card.content;
    let authorLink = card.authorLink;

    if (/标题|title/.test(lower)) title = title.includes("：") ? title.replace(/：.+$/, `：${instruction.replace(/^.*?(改成|变成|叫)/, "").slice(0, 24)}`) : `${title}：${instruction.slice(0, 18)}`;
    if (/具体|细节|案例|example/.test(lower)) content = `${content.replace(/[。.]$/, "")}，补充一个更具体的细节、案例或证据，让这一节不只停留在概念层。`;
    else if (/短|简洁|short|concise/.test(lower)) content = content.split(/[。.!?！？]/).filter(Boolean).slice(0, 1).join("。") || content;
    else if (/小红书|xiaohongshu/.test(lower)) content = `${content.replace(/[。.]$/, "")}，改成更有场景感和个人判断的表达，保留可收藏的信息密度。`;
    else if (/转化|购买|预约|咨询|conversion/.test(lower)) content = `${content.replace(/[。.]$/, "")}，在这一节里自然铺垫读者下一步行动。`;
    else content = `${content.replace(/[。.]$/, "")}，并按这条意见修改：${instruction}`;

    authorLink = [authorLink, author ? `按 ${author.name} 的风格重新校准这一节。` : "保持默认写法清楚、具体、少空话。"].filter(Boolean).join("\n");
    return {
      ...card,
      title,
      content,
      authorLink,
    };
  },

  async generateDraft(project: WritingProject, author: Author | null): Promise<Draft> {
    const prompt = buildDraftPrompt(project, author, project.requirementCards);
    const real = await completeJson<{ title?: string; paragraphs?: string[] }>("generateDraft", prompt, 4200);
    if (real?.paragraphs?.length) return makeDraftFromParagraphs(String(real.title || project.requirementTitle || "Untitled Draft"), real.paragraphs.map(String));

    await wait(700);
    if (isStory(project)) {
      const protagonist = project.storySettings.protagonist || "Lin";
      const setting = project.storySettings.setting || "the old station";
      const conflict = project.storySettings.conflict || "a message that changes what can be left behind";
      return makeDraftFromParagraphs(project.requirementTitle || "The Timetable Still Clicked", [
        `${setting} had a way of making time sound mechanical. Every hour, somewhere above the empty platform, the old board clicked and rearranged itself for trains that no longer came.`,
        `${protagonist} stood under the leaking awning with one hand inside a coat pocket. The letter there had traveled farther than she had. Its paper had softened at the fold, as if it had been opened by rain instead of fingers.`,
        `The problem was not the letter. The problem was ${conflict}, and the small, unreasonable hope that a place could stay closed long enough for a person to change her mind.`,
        `Across the platform, a child drew circles in the dust with the toe of his shoe. He did not look lost. He looked like someone waiting for a sound only the building could still make.`,
        `When the loudspeaker coughed, ${protagonist} finally opened the envelope. There were only three lines inside, but the last one made the station feel occupied again.`,
        "Outside, rain moved through the rails. The board clicked once more, and this time she read the destination before it disappeared.",
      ]);
    }

    const authorLine = author ? `The selected author changes the piece in a subtle way: ${author.styleSummary}` : "With no selected author, the draft uses a clean default voice.";
    const title = project.requirementTitle || `A Better Draft for ${compact(project.brief).slice(0, 42)}`;
    const topic = compact(project.brief).split(/[.!?。！？]/)[0].trim();
    return makeDraftFromParagraphs(title, [
      `The useful starting point is not a bigger prompt. It is a clearer brief about ${topic}, plus enough context for the draft to know what kind of work it is meant to do.`,
      `${authorLine} That means the opening should not rush into explanation. It should give the reader a scene, a friction, or a clear claim before it asks for attention.`,
      `For ${project.audience || "the intended reader"}, the main reward is ${project.goal || "clarity"}. The draft has to earn that reward quickly: define the tension, show why it matters now, and avoid the kind of polished vagueness that makes generated writing feel empty.`,
      project.mustInclude
        ? `The required material is not an appendix. It belongs inside the argument: ${project.mustInclude}. Each item should do a job, either proving the point, sharpening the example, or making the reader's next step easier.`
        : "The strongest examples should be concrete enough to survive outside the paragraph. If an example cannot be pictured, tested, or remembered, it probably needs to be replaced.",
      isCommercial(project)
        ? `Because this piece has a promotional layer, the ratio matters. ${project.commercialSettings.contentPromotionRatio} should control how early the offer appears and how much space it receives. The reader should feel the content first, then understand why the next step is relevant.`
        : "The piece should stay content-first. Any recommendation or closing invitation should grow out of the argument rather than interrupt it.",
      `The ending should return to the promise in the title. Do not summarize mechanically. Land on a sentence that makes the reader feel the standard of the piece: specific, useful, and hard to confuse with a generic draft.`,
    ]);
  },

  async rewriteSelectedText(project: WritingProject, author: Author | null, selectedSentenceIds: string[], instruction: string) {
    const prompt = buildSelectedRewritePrompt(project, author, selectedSentenceIds, instruction);
    const real = await completeJson<{ replacement_text?: string; reason?: string }>("rewriteSelectedText", prompt, 900);
    if (real?.replacement_text) {
      return {
        replacement_text: String(real.replacement_text),
        reason: real.reason ? String(real.reason) : "Anna LLM selected-range edit.",
      };
    }

    await wait(420);
    const selected = selectedTextFromDraft(project.draft, selectedSentenceIds);
    const trimmed = selected.replace(/\s+/g, " ").trim();
    let replacement = trimmed;
    const lower = instruction.toLowerCase();
    if (lower.includes("short")) replacement = trimmed.split(/\s+/).slice(0, Math.max(8, Math.ceil(trimmed.split(/\s+/).length * 0.55))).join(" ") + ".";
    else if (lower.includes("expand")) replacement = `${trimmed} It also needs a visible consequence, so the reader can see what changes when that starting point is missing.`;
    else if (lower.includes("emotional")) replacement = trimmed.includes("prompt")
      ? "The useful starting point is the moment the writer stops feeling alone with a blank box."
      : `${trimmed.replace(/\.$/, "")}, with enough pressure in the image that the feeling arrives without explanation.`;
    else if (lower.includes("concrete")) replacement = trimmed.includes("prompt")
      ? "The useful starting point is a small writing desk with the brief, examples, and limits already in view."
      : `${trimmed.replace(/\.$/, "")}, grounded in one visible object or action the reader can picture.`;
    else if (lower.includes("literary")) replacement = trimmed.replace(/\.$/, "") + ", leaving the feeling to arrive after the image.";
    else if (lower.includes("clear")) replacement = `Put simply, ${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`;
    else if (lower.includes("author")) replacement = author
      ? `${trimmed.replace(/\.$/, "")}, but held in ${author.name}'s quieter rhythm: concrete first, judgment second.`
      : trimmed;
    else replacement = `${trimmed.replace(/\.$/, "")}, sharpened around the instruction: ${instruction || "make this more specific"}.`;
    return {
      replacement_text: replacement,
      reason: "Mock local edit replaced only the selected range.",
    };
  },

  async rewriteSelectedRange(project: WritingProject, author: Author | null, selectedText: string, instruction: string) {
    const real = await completeJson<{ replacement_text?: string; reason?: string }>(
      "rewriteSelectedRange",
      {
        system:
          "You are a precise local editor. Rewrite only the selected text. Do not rewrite the full draft. Return strict JSON with replacement_text only.",
        user: {
          full_draft_for_context: draftPlainText(project.draft),
          selected_text: selectedText,
          user_revision_instruction: instruction,
          author_style_summary: author?.styleSummary ?? "No selected author.",
          author_skill_prompt: author?.skillPrompt ?? "Use a clean default writer.",
          output_format: project.publishSettings.format,
          constraints: [
            "Return only a replacement for the selected text.",
            "Preserve the meaning unless the user asks otherwise.",
            "Match the selected author style when available.",
            "Do not add explanations outside JSON.",
          ],
          expected_output: {
            replacement_text: "string",
            reason: "brief optional reason",
          },
        },
      },
      900,
    );
    if (real?.replacement_text) {
      return {
        replacement_text: String(real.replacement_text),
        reason: real.reason ? String(real.reason) : "Anna LLM selected text edit.",
      };
    }

    await wait(360);
    const trimmed = selectedText.replace(/\s+/g, " ").trim();
    const lower = instruction.toLowerCase();
    let replacement = trimmed;
    if (lower.includes("short") || lower.includes("concise")) replacement = trimmed.split(/\s+/).slice(0, Math.max(8, Math.ceil(trimmed.split(/\s+/).length * 0.58))).join(" ") + ".";
    else if (lower.includes("expand")) replacement = `${trimmed} Add one concrete consequence so the reader can see why it matters.`;
    else if (lower.includes("academic")) replacement = `In more precise terms, ${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`;
    else if (lower.includes("emotional")) replacement = `${trimmed.replace(/\.$/, "")}, with more of the human pressure left visible.`;
    else if (lower.includes("natural") || lower.includes("ai")) replacement = trimmed.replace(/\butilize\b/gi, "use").replace(/\bin order to\b/gi, "to");
    else replacement = `${trimmed.replace(/\.$/, "")}, revised to ${instruction || "read more clearly"}.`;
    return {
      replacement_text: replacement,
      reason: "Mock selected range edit.",
    };
  },

  async refineWholeDraft(project: WritingProject, author: Author | null, instruction: string): Promise<Draft> {
    const prompt = buildWholeDraftRefinePrompt(project, author, instruction);
    const real = await completeJson<{ title?: string; paragraphs?: string[] }>("refineWholeDraft", prompt, 4200);
    if (real?.paragraphs?.length) return makeDraftFromParagraphs(String(real.title || project.draft?.title || "Untitled Draft"), real.paragraphs.map(String));

    await wait(620);
    const current = project.draft ?? (await this.generateDraft(project, author));
    const lower = instruction.toLowerCase();
    const paragraphs = current.blocks.map((block, index) => {
      const text = block.sentences.map((sentence) => sentence.text).join(" ");
      if (lower.includes("suspense") && index === 0) return `Something in the opening should feel slightly unfinished. ${text}`;
      if (lower.includes("less marketing")) return text.replace(/promotional layer/g, "practical layer").replace(/offer/g, "next step");
      if (lower.includes("example") && index === 2) return `${text} For example, one brief can become a reflective essay, a practical post, or a story chapter depending on which requirements are approved before drafting.`;
      if (lower.includes("ending") && index === current.blocks.length - 1) return "A strong ending should not wave from the doorway. It should close the room with one sentence the reader wants to keep.";
      return text;
    });
    return makeDraftFromParagraphs(current.title, paragraphs);
  },

  async generateTitles(project: WritingProject, author: Author | null) {
    const real = await completeJson<{ titles?: string[] }>(
      "generateTitles",
      {
        system: "Generate strong title options for the writing project. Return strict JSON only.",
        user: {
          selected_author: author
            ? {
                name: author.name,
                style_summary: author.styleSummary,
                skill_prompt: author.skillPrompt,
              }
            : null,
          project,
          output_schema: { titles: ["string"] },
        },
      },
      1600,
    );
    if (real?.titles?.length) return real.titles.map(String).slice(0, 12);

    await wait(320);
    const topic = compact(project.brief).replace(/\.$/, "");
    if (isWechat(project)) {
      return [
        `The Real Shift Behind ${topic}`,
        `Why ${topic} Suddenly Matters Now`,
        `I Thought ${topic} Was the Point. It Wasn't.`,
        `${topic}: The Part Most People Miss`,
        `Before You Write About ${topic}, Read This First`,
      ];
    }
    if (isStory(project)) {
      return ["The Timetable Still Clicked", "Rain at the Closed Station", "The Letter That Arrived Late", "A City No One Could Reach", "Before the Board Went Dark"];
    }
    return [
      `A Clearer Way to Write About ${topic}`,
      `The Brief Comes First, the Judgment Stays Attached`,
      `Why This Draft Needs Requirements Before Prose`,
      `From Writing Brief to Publishable Draft`,
      `${author?.name ?? "A Default Writer"} on ${topic}`,
    ];
  },

  async generatePublishVariants(project: WritingProject) {
    await wait(260);
    return {
      markdown: "Markdown version ready.",
      html: "HTML version ready.",
      txt: "Plain text version ready.",
    };
  },
};
