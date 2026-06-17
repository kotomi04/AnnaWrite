import type { Draft, DraftBlock, Sentence, TextSelectionRange } from "../types";

const now = () => new Date().toISOString();

export const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export function countWords(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (/[\u4e00-\u9fff]/.test(trimmed)) return trimmed.replace(/\s/g, "").length;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

export function splitIntoSentences(text: string): Sentence[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const parts = normalized.match(/[^.!?。！？]+[.!?。！？]?["'”’)?]?/g) ?? [normalized];
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ({ id: uid("sentence"), text: part }));
}

export function blockFromText(text: string, type: DraftBlock["type"] = "paragraph"): DraftBlock {
  const sentences = splitIntoSentences(text);
  return {
    id: uid("block"),
    type,
    text: sentences.map((sentence) => sentence.text).join(" "),
    sentences,
  };
}

export function makeDraftFromParagraphs(title: string, paragraphs: string[]): Draft {
  return {
    id: uid("draft"),
    title,
    blocks: paragraphs.filter(Boolean).map((paragraph) => blockFromText(paragraph)),
    version: 1,
    createdAt: now(),
    updatedAt: now(),
  };
}

export function cloneDraft(draft: Draft): Draft {
  return JSON.parse(JSON.stringify(draft)) as Draft;
}

export function draftPlainText(draft: Draft | null) {
  if (!draft) return "";
  return [draft.title, ...draft.blocks.map((block) => block.sentences.map((sentence) => sentence.text).join(" "))].join("\n\n");
}

export function selectedTextFromDraft(draft: Draft | null, sentenceIds: string[]) {
  if (!draft || sentenceIds.length === 0) return "";
  const selected = new Set(sentenceIds);
  const pieces: string[] = [];
  draft.blocks.forEach((block) => {
    block.sentences.forEach((sentence) => {
      if (selected.has(sentence.id)) pieces.push(sentence.text);
    });
  });
  return pieces.join(" ");
}

export function replaceSelectedText(draft: Draft, sentenceIds: string[], replacementText: string): Draft {
  const selected = new Set(sentenceIds);
  const next = cloneDraft(draft);
  const replacement = splitIntoSentences(replacementText);
  let inserted = false;

  next.blocks = next.blocks.map((block) => {
    const sentences: Sentence[] = [];
    block.sentences.forEach((sentence) => {
      if (!selected.has(sentence.id)) {
        sentences.push(sentence);
        return;
      }
      if (!inserted) {
        sentences.push(...replacement);
        inserted = true;
      }
    });
    return {
      ...block,
      sentences,
      text: sentences.map((sentence) => sentence.text).join(" "),
    };
  });

  return {
    ...next,
    version: next.version + 1,
    updatedAt: now(),
  };
}

export function updateDraftBlockText(draft: Draft, blockId: string, text: string): Draft {
  const blocks = draft.blocks.map((block) => {
    if (block.id !== blockId) return block;
    const next = blockFromText(text, block.type);
    return { ...next, id: block.id };
  });
  return {
    ...draft,
    blocks,
    updatedAt: now(),
  };
}

export function replaceDraftTextRange(draft: Draft, range: TextSelectionRange, replacementText: string): Draft {
  const startIndex = draft.blocks.findIndex((block) => block.id === range.blockId);
  const endBlockId = range.endBlockId || range.blockId;
  const endIndex = draft.blocks.findIndex((block) => block.id === endBlockId);
  if (startIndex < 0 || endIndex < 0) return draft;

  if (startIndex === endIndex) {
    const blocks = draft.blocks.map((block) => {
      if (block.id !== range.blockId) return block;
      const text = block.sentences.map((sentence) => sentence.text).join(" ");
      const start = Math.max(0, Math.min(range.start, text.length));
      const end = Math.max(start, Math.min(range.end, text.length));
      const nextText = `${text.slice(0, start)}${replacementText}${text.slice(end)}`.replace(/\s+/g, " ").trim();
      const next = blockFromText(nextText, block.type);
      return { ...next, id: block.id };
    });
    return {
      ...draft,
      blocks,
      version: draft.version + 1,
      updatedAt: now(),
    };
  }

  const firstBlock = draft.blocks[startIndex];
  const lastBlock = draft.blocks[endIndex];
  const firstText = firstBlock.sentences.map((sentence) => sentence.text).join(" ");
  const lastText = lastBlock.sentences.map((sentence) => sentence.text).join(" ");
  const start = Math.max(0, Math.min(range.start, firstText.length));
  const end = Math.max(0, Math.min(range.end, lastText.length));
  const nextText = `${firstText.slice(0, start)} ${replacementText} ${lastText.slice(end)}`.replace(/\s+/g, " ").trim();
  const nextBlock = { ...blockFromText(nextText, firstBlock.type), id: firstBlock.id };
  const blocks = [
    ...draft.blocks.slice(0, startIndex),
    nextBlock,
    ...draft.blocks.slice(endIndex + 1),
  ];
  return {
    ...draft,
    blocks,
    version: draft.version + 1,
    updatedAt: now(),
  };
}

export function insertDraftTextBelowRange(draft: Draft, range: TextSelectionRange, insertedText: string): Draft {
  const index = draft.blocks.findIndex((block) => block.id === (range.endBlockId || range.blockId));
  const nextBlock = blockFromText(insertedText);
  const blocks = [...draft.blocks];
  blocks.splice(index >= 0 ? index + 1 : blocks.length, 0, nextBlock);
  return {
    ...draft,
    blocks,
    version: draft.version + 1,
    updatedAt: now(),
  };
}

export function replaceDraftBody(draft: Draft, paragraphs: string[], nextTitle?: string): Draft {
  return {
    ...draft,
    title: nextTitle ?? draft.title,
    blocks: paragraphs.map((paragraph) => blockFromText(paragraph)),
    version: draft.version + 1,
    updatedAt: now(),
  };
}

export function draftToMarkdown(draft: Draft, includeTitle = true) {
  const body = draft.blocks
    .map((block) => {
      const text = block.sentences.map((sentence) => sentence.text).join(" ");
      if (block.type === "heading") return `## ${text}`;
      if (block.type === "quote") return `> ${text}`;
      if (block.type === "list") return text.split(/\s*;\s*/).map((item) => `- ${item}`).join("\n");
      return text;
    })
    .join("\n\n");
  return includeTitle ? `# ${draft.title}\n\n${body}` : body;
}
