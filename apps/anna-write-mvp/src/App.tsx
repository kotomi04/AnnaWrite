import {
  BookOpen,
  Check,
  ChevronDown,
  Clipboard,
  Download,
  Edit3,
  FileText,
  Library,
  Link,
  Loader2,
  MessageCircle,
  PenLine,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AuthorProfileStudio } from "./components/AuthorProfileStudio";
import { LlmTracePanel } from "./components/LlmTracePanel";
import { RequirementsPage } from "./components/RequirementsPage";
import { ToastStack } from "./components/Toast";
import { createEmptyProject, defaultAuthors, defaultPublishSettings, defaultSharedStyleSummary, emptyParameters } from "./data/seed";
import { streamAuthorProfileText } from "./services/authorProfileStream";
import { extractTextFromFile, extractTextFromUrl } from "./services/fileExtraction";
import { llmService } from "./services/llmService";
import { loadStoredState, saveAuthors, saveCurrentAuthor, saveCurrentProjectId, saveProject, saveProjects } from "./services/storage";
import type {
  Author,
  AuthorAnalysisResult,
  AuthorProfileGenerationState,
  AuthorSample,
  Draft,
  DraftBlock,
  EditHistory,
  LlmTraceEvent,
  MaterialStatus,
  MaterialType,
  SharedStyleSummary,
  SourceType,
  TextSelectionRange,
  ToastMessage,
  WritingProject,
} from "./types";
import {
  blockFromText,
  cloneDraft,
  countWords,
  draftPlainText,
  insertDraftTextBelowRange,
  makeDraftFromParagraphs,
  replaceDraftTextRange,
  updateDraftBlockText,
} from "./utils/draft";

type Screen = "tasks" | "home" | "library" | "authors" | "requirements" | "editor";
type ExportFormat = "Plain text" | "Markdown" | "HTML" | "Word document" | "PDF";
type ExportResult = { filename: string; content: string; mime: string; extension: string; encoding?: "utf8" | "base64" };
type ExportSaveStatus = "saved" | "downloaded" | "canceled";

interface FileSystemWritableFileStream {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
}

interface FileSystemFileHandle {
  createWritable: () => Promise<FileSystemWritableFileStream>;
}

declare global {
  interface Window {
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<FileSystemFileHandle>;
  }
}

interface RevisionState {
  open: boolean;
  action: string;
  instruction: string;
  original: string;
  suggestion: string;
  loading: boolean;
  range: TextSelectionRange | null;
}

interface AssistantSuggestion {
  instruction: string;
  before: Draft;
  draft: Draft;
}

interface ExportReceipt {
  filename: string;
  format: ExportFormat;
  status: ExportSaveStatus;
  locationLabel: string;
  detail: string;
  copyText: string;
  savedAt: string;
}

interface MaterialDraft {
  title: string;
  content: string;
  sourceType: SourceType;
  materialType: MaterialType;
  sourceUrl: string;
  fileName: string;
  rawContent: string;
  status: "idle" | "fetching" | "saved" | "extracted" | "failed";
  error: string;
}

const now = () => new Date().toISOString();

const quickChips = ["Make it shorter", "More emotional", "More professional", "More story-like", "Simpler English", "Add examples"];
const assistantPresets = [
  "Make this more natural",
  "Make it shorter",
  "Improve the opening",
  "Make the tone more academic",
  "Make it sound less AI-written",
  "Strengthen the ending",
  "Simplify the language",
  "Add more emotional detail",
];
const revisionPresets = ["More natural", "More concise", "More academic", "More emotional", "Less AI-like"];
const exportFormats: ExportFormat[] = ["Plain text", "Markdown", "HTML", "Word document", "PDF"];
const demoGoal = "Write a warm, clear newsletter about starting over in a new city. Make it personal, easy to read, and useful for readers who feel a little lost.";

function Background() {
  return (
    <div className="desktop-bg" aria-hidden="true">
      <div className="float-window one">
        <div className="float-header"><span className="float-dot" /><span className="float-dot" /><span className="float-dot" /></div>
        <div className="float-content"><span className="float-line w-3/4" /><span className="float-line w-11/12" /><span className="float-line w-1/2" /><span className="float-line h-16 w-4/5 rounded-2xl" /></div>
      </div>
      <div className="float-window two">
        <div className="float-header"><span className="float-dot" /><span className="float-dot" /><span className="float-dot" /></div>
        <div className="float-content"><span className="float-line w-full" /><span className="float-line w-2/3" /><span className="float-line w-4/5" /><span className="float-line w-full" /></div>
      </div>
      <div className="float-window three">
        <div className="float-header"><span className="float-dot" /><span className="float-dot" /><span className="float-dot" /></div>
        <div className="float-content"><span className="float-line w-7/12" /><span className="float-line w-11/12" /><span className="float-line w-8/12" /></div>
      </div>
    </div>
  );
}

function makeHistory(type: EditHistory["type"], before: EditHistory["before"], after: EditHistory["after"], instruction: string): EditHistory {
  return {
    id: `edit-${crypto.randomUUID()}`,
    type,
    before,
    after,
    instruction,
    timestamp: now(),
  };
}

function createBlankAuthor(name = "New Style"): Author {
  const createdAt = now();
  return {
    id: `author-${crypto.randomUUID()}`,
    name,
    description: "A clear, simple writing style.",
    type: "style",
    styleTags: ["clear", "simple", "calm"],
    bestFor: ["Essays", "Posts"],
    samples: [],
    styleSummary: "Clear, useful, and easy to read.",
    skillPrompt: "Write clearly with concrete examples and a calm tone.",
    sharedStyleSummary: {
      ...defaultSharedStyleSummary,
      shortSummary: "Clear, useful, and easy to read.",
      tone: ["clear", "simple", "calm"],
      promptFragment: "Write clearly with concrete examples and a calm tone.",
      updatedAt: createdAt,
    },
    parameters: emptyParameters,
    createdAt,
    updatedAt: createdAt,
  };
}

function nextBlankAuthorName(authors: Author[]) {
  const names = new Set(authors.map((author) => author.name.trim().toLowerCase()));
  if (!names.has("new style")) return "New Style";
  let index = 2;
  while (names.has(`new style ${index}`)) index += 1;
  return `New Style ${index}`;
}

function makeSample(title: string, content: string, sourceType: SourceType = "essay", options: Partial<AuthorSample> = {}): AuthorSample {
  const uploadedAt = options.uploadedAt || now();
  return {
    id: `sample-${crypto.randomUUID()}`,
    title: title.trim() || "Untitled sample",
    content: content.trim(),
    sourceType,
    materialType: options.materialType,
    sourceUrl: options.sourceUrl,
    fileName: options.fileName,
    rawContent: options.rawContent,
    status: options.status || "saved",
    error: options.error,
    wordCount: countWords(content),
    uploadedAt,
    updatedAt: options.updatedAt || uploadedAt,
    analysisNotes: options.analysisNotes,
  };
}

function emptyMaterialDraft(): MaterialDraft {
  return {
    title: "",
    content: "",
    sourceType: "essay",
    materialType: "article",
    sourceUrl: "",
    fileName: "",
    rawContent: "",
    status: "idle",
    error: "",
  };
}

function sharedSummaryFromAnalysis(result: AuthorAnalysisResult): SharedStyleSummary {
  const tone = result.voice.split(",").map((item) => item.trim()).filter(Boolean);
  return {
    shortSummary: result.style_summary,
    tone,
    structure: result.structure_habits,
    sentencePatterns: [result.sentence_rhythm, ...result.opening_patterns].filter(Boolean),
    vocabulary: tone,
    techniques: result.recommended_rules,
    doList: result.recommended_rules,
    avoidList: result.avoid,
    promptFragment: result.skill_prompt,
    updatedAt: now(),
  };
}

function styleTags(author: Author | null) {
  if (!author) return ["official", "precise", "evidence-first", "responsible"];
  const manualTags = author.styleTags?.map((tag) => tag.trim()).filter(Boolean) ?? [];
  if (manualTags.length) return manualTags.slice(0, 6);
  const signals = [
    ...(author.sharedStyleSummary?.tone ?? []),
    ...(author.parameters.voiceTone ?? []),
    ...author.bestFor,
  ].map((item) => item.trim()).filter(Boolean);
  return Array.from(new Set(signals)).slice(0, 6);
}

function styleSummaryBullets(author: Author | null) {
  const summary = author?.styleSummary || author?.sharedStyleSummary?.shortSummary || "Clear, useful writing with a calm default voice.";
  return summary
    .split(/(?<=[.!?。！？])\s+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function isBlankNewStyle(author: Author) {
  return /^new style( \d+)?$/i.test(author.name.trim()) && author.samples.length === 0 && author.description.trim().toLowerCase() === "a clear, simple writing style.";
}

function visibleStyleAuthors(authors: Author[]) {
  let keptBlank = false;
  return authors.filter((author) => {
    if (!isBlankNewStyle(author)) return true;
    if (keptBlank) return false;
    keptBlank = true;
    return true;
  });
}

function compactText(value: string | undefined, limit = 150) {
  const cleaned = (value || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, Math.max(0, limit - 1)).trim()}...`;
}

function compactStyleDescription(author: Author | null, limit = 150) {
  if (!author) return defaultSharedStyleSummary.shortSummary;
  return compactText(author.styleSummary || author.sharedStyleSummary?.shortSummary || author.description, limit) || "A reusable writing style.";
}

function materialTypeLabel(type?: MaterialType) {
  if (type === "link") return "Link";
  if (type === "file") return "File";
  if (type === "html") return "HTML";
  return "Article";
}

function materialStatusLabel(status?: MaterialStatus) {
  if (status === "fetching") return "Fetching";
  if (status === "extracted") return "Extracted";
  if (status === "failed") return "Needs text";
  return "Saved";
}

function materialStats(author: Author | null) {
  if (!author?.samples.length) return "No materials yet";
  const counts = author.samples.reduce<Record<string, number>>((acc, sample) => {
    const key = sample.materialType || "article";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([type, count]) => `${count} ${materialTypeLabel(type as MaterialType).toLowerCase()}${count > 1 ? "s" : ""}`)
    .join(" · ");
}

function utilityLabel(author: Author | null) {
  if (!author) return "Utility 90%";
  const utility = author.bestFor.find((item) => /utility/i.test(item));
  return utility ? utility.replace(/^High utility/i, "Utility") : "Custom style";
}

function sampleKindLabel(sample: AuthorSample) {
  if (sample.materialType === "link") return "Web article";
  if (sample.materialType === "html") return "Web page";
  if (sample.materialType === "file") return "Uploaded file";
  return "Pasted text";
}

function cleanMaterialText(value: string) {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeMaterialText(value: string) {
  const normalized = cleanMaterialText(value);
  if (!normalized) return "";
  const sentence = normalized.match(/[^。！？.!?]+[。！？.!?]?/)?.[0] || normalized;
  return sentence.length > 120 ? `${sentence.slice(0, 120)}...` : sentence;
}

function summarizeSampleForCard(sample: AuthorSample) {
  const summary = summarizeMaterialText(sample.content || sample.error || "");
  if (!summary) return "No content yet. Edit this material to add text.";
  return summary.length > 92 ? `${summary.slice(0, 92)}...` : summary;
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function titleFromGoal(goal: string) {
  const cleaned = goal.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Untitled Draft";
  return cleaned.replace(/^write\s+(an?|the)?\s*/i, "").slice(0, 72).replace(/[.!?。！？]$/, "") || "Untitled Draft";
}

function taskTitle(project: WritingProject) {
  const title = project.title?.trim();
  if (title && title !== "Untitled writing") return title;
  const draftTitle = project.draft?.title?.trim();
  if (draftTitle && draftTitle !== "Untitled Draft") return draftTitle;
  return titleFromGoal(project.brief);
}

function taskSubtitle(project: WritingProject) {
  const parts = [project.writingType, project.channel, project.language].filter(Boolean);
  return parts.join(" · ") || "Writing task";
}

function taskStage(project: WritingProject) {
  if (project.draft?.blocks.length) return "Draft ready";
  if (project.requirementCards.length) return "Outline ready";
  if (project.brief.trim()) return "Brief started";
  return "New task";
}

function hasPersistableProjectContent(project: WritingProject) {
  return Boolean(
    project.brief.trim() ||
    project.requirementCards.length ||
    project.draft?.blocks.length ||
    (project.title && project.title !== "Untitled writing")
  );
}

function formatTaskDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function viewportRect(rect: DOMRect) {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function exportExtension(format: ExportFormat) {
  if (format === "Word document") return "docx";
  if (format === "PDF") return "pdf";
  if (format === "Markdown") return "md";
  if (format === "HTML") return "html";
  return "txt";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function draftBlockTexts(draft: Draft) {
  return draft.blocks.map((block) => block.sentences.map((sentence) => sentence.text).join(" ").trim()).filter(Boolean);
}

function draftDiffItems(before: Draft, after: Draft) {
  const beforeBlocks = [before.title, ...draftBlockTexts(before)];
  const afterBlocks = [after.title, ...draftBlockTexts(after)];
  const max = Math.max(beforeBlocks.length, afterBlocks.length);
  const changes: Array<{ label: string; before: string; after: string }> = [];
  for (let index = 0; index < max; index += 1) {
    const beforeText = beforeBlocks[index] || "";
    const afterText = afterBlocks[index] || "";
    if (beforeText.trim() === afterText.trim()) continue;
    changes.push({
      label: index === 0 ? "Title" : `Paragraph ${index}`,
      before: beforeText,
      after: afterText,
    });
  }
  return changes;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function buildDocxBase64(draft: Draft) {
  const { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } = await import("docx");
  const children = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.LEFT,
      spacing: { after: 360 },
      children: [new TextRun({ text: draft.title, bold: true, size: 36 })],
    }),
    ...draftBlockTexts(draft).map((text) => new Paragraph({
      spacing: { after: 260 },
      children: [new TextRun({ text, size: 24 })],
    })),
  ];
  const doc = new Document({
    creator: "AnnaWrite",
    description: "Draft exported from AnnaWrite",
    title: draft.title,
    sections: [{ properties: { page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } }, children }],
  });
  return Packer.toBase64String(doc);
}

async function buildPdfBase64(draft: Draft) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "pt", format: "letter" });
  const marginX = 72;
  const pageHeight = pdf.internal.pageSize.getHeight();
  const maxWidth = pdf.internal.pageSize.getWidth() - marginX * 2;
  let y = 74;

  pdf.setFont("times", "bold");
  pdf.setFontSize(22);
  pdf.text(pdf.splitTextToSize(draft.title, maxWidth), marginX, y);
  y += 52;
  pdf.setFont("times", "normal");
  pdf.setFontSize(12);

  draftBlockTexts(draft).forEach((paragraph) => {
    const lines = pdf.splitTextToSize(paragraph, maxWidth);
    lines.forEach((line: string) => {
      if (y > pageHeight - 72) {
        pdf.addPage();
        y = 72;
      }
      pdf.text(line, marginX, y);
      y += 17;
    });
    y += 12;
  });

  const out = pdf.output("arraybuffer") as ArrayBuffer;
  return arrayBufferToBase64(out);
}

async function buildExportFile(draft: Draft, settings: WritingProject["publishSettings"], cards: WritingProject["requirementCards"], format: ExportFormat): Promise<ExportResult> {
  const extension = exportExtension(format);
  const title = settings.documentTitle || draft.title || "annawrite-draft";
  const safeTitle = title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "annawrite-draft";
  const filename = `${safeTitle}.${extension}`;
  const bodyBlocks = draftBlockTexts(draft);
  const plainBody = bodyBlocks.join("\n\n");
  if (format === "Markdown") {
    const markdown = [`# ${draft.title}`, "", ...bodyBlocks].join("\n\n");
    return { filename, content: markdown, mime: "text/markdown;charset=utf-8", extension };
  }
  if (format === "Word document") {
    return {
      filename,
      content: await buildDocxBase64(draft),
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extension,
      encoding: "base64",
    };
  }
  if (format === "HTML") {
    const paragraphs = bodyBlocks.map((text) => `<p>${escapeHtml(text)}</p>`).join("\n");
    return {
      filename,
      mime: "text/html;charset=utf-8",
      extension,
      content: `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(draft.title)}</title><style>body{font-family:Georgia,serif;line-height:1.65;color:#272331;}article{max-width:760px;margin:40px auto;}h1{font-family:Arial,sans-serif;font-size:28px;}p{margin:0 0 14px;}</style></head><body><article><h1>${escapeHtml(draft.title)}</h1>${paragraphs}</article></body></html>`,
    };
  }
  if (format === "PDF") {
    return { filename, content: await buildPdfBase64(draft), mime: "application/pdf", extension, encoding: "base64" };
  }
  const body = [draft.title, "", plainBody].join("\n\n");
  return { filename, content: body, mime: "text/plain;charset=utf-8", extension };
}

function exportBlob(file: ExportResult) {
  return new Blob([file.encoding === "base64" ? base64ToBytes(file.content) : file.content], { type: file.mime });
}

function triggerBrowserDownload(file: ExportResult, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function saveExportFile(file: ExportResult): Promise<{ status: ExportSaveStatus; locationLabel: string; detail: string }> {
  const blob = exportBlob(file);
  const picker = window.showSaveFilePicker;
  if (picker) {
    try {
      const mime = file.mime.split(";")[0] || "application/octet-stream";
      const handle = await picker({
        suggestedName: file.filename,
        types: [{ description: `${file.extension.toUpperCase()} file`, accept: { [mime]: [`.${file.extension}`] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return {
        status: "saved",
        locationLabel: "Saved with system dialog",
        detail: "The file was saved to the location you chose.",
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return {
          status: "canceled",
          locationLabel: "Export canceled",
          detail: "No file was saved because the save dialog was canceled.",
        };
      }
      // Fall through to browser download when the picker exists but is blocked by the host.
    }
  }

  triggerBrowserDownload(file, blob);
  return {
    status: "downloaded",
    locationLabel: "Browser download",
    detail: "Your browser or Anna host controls the final location. Check Downloads if no save prompt appeared.",
  };
}

export default function App() {
  const stored = useMemo(() => loadStoredState(), []);
  const initialAuthorId = stored.currentAuthorId ?? defaultAuthors[0]?.id ?? null;
  const [authors, setAuthors] = useState<Author[]>(stored.authors);
  const [currentAuthorId, setCurrentAuthorId] = useState<string | null>(initialAuthorId);
  const [projects, setProjects] = useState<WritingProject[]>(stored.projects);
  const [project, setProject] = useState<WritingProject>(stored.project);
  const [screen, setScreen] = useState<Screen>("tasks");
  const [writingGoal, setWritingGoal] = useState(stored.project.brief);
  const [quickDirectives, setQuickDirectives] = useState<string[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedRange, setSelectedRange] = useState<TextSelectionRange | null>(null);
  const [revision, setRevision] = useState<RevisionState>({ open: false, action: "", instruction: "", original: "", suggestion: "", loading: false, range: null });
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantSuggestion, setAssistantSuggestion] = useState<AssistantSuggestion | null>(null);
  const [lastExport, setLastExport] = useState<ExportReceipt | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("Markdown");
  const [selectedStyleDetails, setSelectedStyleDetails] = useState<string | null>(currentAuthorId);
  const [styleEditOpen, setStyleEditOpen] = useState(false);
  const [sampleDraft, setSampleDraft] = useState<MaterialDraft>(() => emptyMaterialDraft());
  const [authorProfileGen, setAuthorProfileGen] = useState<AuthorProfileGenerationState | null>(null);
  const [sampleViewer, setSampleViewer] = useState<AuthorSample | null>(null);
  const [editingSampleIds, setEditingSampleIds] = useState<Set<string>>(() => new Set());
  const [fetchingLinkMaterials, setFetchingLinkMaterials] = useState(false);
  const [isModified, setIsModified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [llmTraces, setLlmTraces] = useState<LlmTraceEvent[]>([]);
  const [llmConnecting, setLlmConnecting] = useState(true);
  const documentRef = useRef<HTMLDivElement | null>(null);
  const authorProfileAbortRef = useRef<AbortController | null>(null);

  const currentAuthor = useMemo(() => authors.find((author) => author.id === currentAuthorId) ?? null, [authors, currentAuthorId]);
  const selectedStyle = useMemo(() => authors.find((author) => author.id === selectedStyleDetails) ?? currentAuthor, [authors, selectedStyleDetails, currentAuthor]);
  const activeTrace = useMemo(() => llmTraces.find((trace) => trace.status === "running"), [llmTraces]);
  const draft = project.draft;
  const hasDraft = Boolean(draft?.blocks.length);
  const hasOutline = project.requirementCards.length > 0;
  const llmStatusTone = activeTrace || llmConnecting ? "working" : llmService.getStatusTone();
  const llmStatusLabel = activeTrace ? "AI working" : llmConnecting ? "Connecting LLM" : llmService.getStatusLabel();

  useEffect(() => {
    saveAuthors(authors);
  }, [authors]);

  useEffect(() => {
    saveCurrentAuthor(currentAuthorId);
  }, [currentAuthorId]);

  useEffect(() => {
    const hasContent = hasPersistableProjectContent(project);
    saveProject(project);
    saveCurrentProjectId(hasContent ? project.id : null);

    setProjects((items) => {
      const tracked = items.some((item) => item.id === project.id);
      if (!tracked && !hasContent) return items;
      if (items[0] === project) return items;
      const next = [project, ...items.filter((item) => item.id !== project.id)];
      return next;
    });
  }, [project]);

  useEffect(() => {
    saveProjects(projects);
  }, [projects]);

  useEffect(() => {
    let cancelled = false;
    setLlmConnecting(true);
    llmService.warmupRuntime()
      .catch(() => false)
      .finally(() => {
        if (cancelled) return;
        setLlmConnecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const scrollContainer = document.querySelector<HTMLElement>(".workspace-body .page-scroll");
    scrollContainer?.scrollTo({ top: 0 });
  }, [screen]);

  const toast = (text: string, tone: ToastMessage["tone"] = "info") => {
    const message = { id: `toast-${crypto.randomUUID()}`, text, tone };
    setToasts((items) => [...items, message]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== message.id)), 2600);
  };

  const startLlmTrace = (name: string, input: string) => {
    const trace: LlmTraceEvent = { id: `llm-${crypto.randomUUID()}`, name, status: "running", input, startedAt: now() };
    setLlmTraces((items) => [trace, ...items].slice(0, 20));
    return trace.id;
  };

  const finishLlmTrace = (id: string, output: string, status: LlmTraceEvent["status"] = "done") => {
    setLlmTraces((items) => items.map((trace) => (trace.id === id ? { ...trace, status, output, finishedAt: now() } : trace)));
  };

  const updateProject = (patch: Partial<WritingProject>) => {
    setProject((current) => ({ ...current, ...patch, updatedAt: now() }));
  };

  const saveAuthor = (author: Author) => {
    setAuthors((items) => items.map((item) => (item.id === author.id ? author : item)));
  };

  const setAuthor = (authorId: string | null) => {
    setCurrentAuthorId(authorId);
    setSelectedStyleDetails(authorId);
    updateProject({ authorId });
    toast(authorId ? "Style selected" : "Default style selected", "success");
  };

  const syncDraftFromEditor = (sourceDraft = project.draft) => {
    if (!sourceDraft) return null;
    let next = sourceDraft;
    documentRef.current?.querySelectorAll<HTMLElement>("[data-block-id]").forEach((node) => {
      const blockId = node.dataset.blockId;
      if (!blockId) return;
      next = updateDraftBlockText(next, blockId, node.innerText.trim());
    });
    return next;
  };

  const buildProjectForWriting = (): WritingProject => {
    const goal = writingGoal.trim() || "Write a short reflective essay about a quiet change in daily life.";
    const title = project.title && project.title !== "Untitled writing" ? project.title : titleFromGoal(goal);
    return {
      ...project,
      brief: goal,
      title,
      writingType: project.writingType || "Article",
      channel: project.channel || "Blog",
      language: project.language || "English",
      lengthTarget: project.lengthTarget || "Medium",
      tone: project.tone || "Natural",
      mustInclude: [project.mustInclude, quickDirectives.join("; ")].filter(Boolean).join("; "),
      authorId: currentAuthorId,
      publishSettings: {
        ...project.publishSettings,
        documentTitle: title,
        authorNameDisplay: currentAuthor?.name ?? "",
      },
      updatedAt: now(),
    };
  };

  const generateDraftFromProject = async (sourceProject: WritingProject) => {
    setBusy(true);
    const traceId = startLlmTrace("generateDraft", `${currentAuthor?.name ?? "Default Style"} · ${(sourceProject.requirementTitle || sourceProject.brief).slice(0, 120)}`);
    try {
      const nextDraft = await llmService.generateDraft(sourceProject, currentAuthor);
      finishLlmTrace(traceId, `${llmService.getProviderLabel()} · ${nextDraft.blocks.length} paragraphs`);
      setProject({
        ...sourceProject,
        title: nextDraft.title,
        draft: nextDraft,
        publishSettings: { ...sourceProject.publishSettings, documentTitle: nextDraft.title },
        updatedAt: now(),
      });
      setIsModified(false);
      setSelectedRange(null);
      setScreen("editor");
      toast("Draft ready", "success");
    } catch (error) {
      finishLlmTrace(traceId, error instanceof Error ? error.message : "Draft generation failed.", "error");
      toast("Draft failed", "warning");
    } finally {
      setBusy(false);
    }
  };

  const generateDraftFromGoal = async () => {
    const nextProject = buildProjectForWriting();
    setBusy(true);
    const traceId = startLlmTrace("generateOutline", `${currentAuthor?.name ?? "Default Style"} · ${nextProject.brief.slice(0, 120)}`);
    try {
      const outline = await llmService.generateRequirementCards(nextProject, currentAuthor);
      const plannedProject: WritingProject = {
        ...nextProject,
        title: outline.working_title || nextProject.title,
        requirementTitle: outline.working_title || nextProject.title,
        requirementCards: outline.cards,
        draft: null,
        publishSettings: { ...nextProject.publishSettings, documentTitle: outline.working_title || nextProject.title },
        updatedAt: now(),
      };
      finishLlmTrace(traceId, `${llmService.getProviderLabel()} · ${outline.cards.length} outline sections`);
      setProject(plannedProject);

      if (plannedProject.reviewRequirementsFirst) {
        setScreen("requirements");
        toast("Outline ready", "success");
        return;
      }

      setBusy(false);
      await generateDraftFromProject(plannedProject);
    } catch (error) {
      finishLlmTrace(traceId, error instanceof Error ? error.message : "Outline generation failed.", "error");
      toast("Outline failed", "warning");
    } finally {
      setBusy(false);
    }
  };

  const regenerateRequirementCard = async (card: WritingProject["requirementCards"][number]) => {
    setBusy(true);
    const traceId = startLlmTrace("regenerateOutlineSection", card.title);
    try {
      const nextCard = await llmService.regenerateRequirementCard(card, project, currentAuthor);
      updateProject({
        requirementCards: project.requirementCards.map((item) => (item.id === card.id ? nextCard : item)),
      });
      finishLlmTrace(traceId, `${llmService.getProviderLabel()} · section regenerated`);
      toast("Outline section updated", "success");
    } catch (error) {
      finishLlmTrace(traceId, error instanceof Error ? error.message : "Section regeneration failed.", "error");
      toast("Section update failed", "warning");
    } finally {
      setBusy(false);
    }
  };

  const reviseOutlineWithComment = async (instruction: string) => {
    setBusy(true);
    const traceId = startLlmTrace("reviseOutline", `${instruction} · ${(project.requirementTitle || project.title || project.brief).slice(0, 120)}`);
    try {
      const outline = await llmService.reviseOutline(project, currentAuthor, instruction);
      finishLlmTrace(traceId, `${llmService.getProviderLabel()} · ${outline.cards.length} revised outline sections`);
      toast("Outline suggestion ready", "success");
      return outline.cards;
    } catch (error) {
      finishLlmTrace(traceId, error instanceof Error ? error.message : "Outline revision failed.", "error");
      toast("Outline revision failed", "warning");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const reviseOutlineSectionWithComment = async (card: WritingProject["requirementCards"][number], instruction: string) => {
    setBusy(true);
    const traceId = startLlmTrace("reviseOutlineSection", `${card.title} · ${instruction}`);
    try {
      const nextCard = await llmService.reviseRequirementCard(card, project, currentAuthor, instruction);
      finishLlmTrace(traceId, `${llmService.getProviderLabel()} · section suggestion ready`);
      toast("Section suggestion ready", "success");
      return nextCard;
    } catch (error) {
      finishLlmTrace(traceId, error instanceof Error ? error.message : "Section revision failed.", "error");
      toast("Section revision failed", "warning");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const startBlankDraft = () => {
    const title = titleFromGoal(writingGoal) || "Untitled Draft";
    const nextDraft = makeDraftFromParagraphs(title, [""]);
    updateProject({
      brief: writingGoal,
      title,
      draft: nextDraft,
      authorId: currentAuthorId,
      publishSettings: { ...project.publishSettings, documentTitle: title, authorNameDisplay: currentAuthor?.name ?? "" },
    });
    setIsModified(false);
    setScreen("editor");
  };

  const newWriting = () => {
    const nextProject = createEmptyProject(currentAuthorId);
    setProject(nextProject);
    setProjects((items) => [nextProject, ...items.filter((item) => item.id !== nextProject.id)]);
    setWritingGoal("");
    setQuickDirectives([]);
    setSelectedRange(null);
    setAssistantSuggestion(null);
    setIsModified(false);
    setScreen("home");
    toast("New task created", "success");
  };

  const openTask = (projectId: string) => {
    const nextProject = projects.find((item) => item.id === projectId);
    if (!nextProject) return;
    setProject(nextProject);
    setProjects((items) => [nextProject, ...items.filter((item) => item.id !== nextProject.id)]);
    setWritingGoal(nextProject.brief);
    setCurrentAuthorId(nextProject.authorId);
    setSelectedStyleDetails(nextProject.authorId);
    saveCurrentProjectId(nextProject.id);
    setProjects((items) => [nextProject, ...items.filter((item) => item.id !== nextProject.id)]);
    setSelectedRange(null);
    setAssistantSuggestion(null);
    setIsModified(false);
    setScreen(nextProject.draft?.blocks.length ? "editor" : nextProject.requirementCards.length ? "requirements" : "home");
  };

  const updateDraftTitle = (title: string) => {
    if (!project.draft) return;
    updateProject({
      title,
      draft: { ...project.draft, title, updatedAt: now() },
      publishSettings: { ...project.publishSettings, documentTitle: title },
    });
    setIsModified(true);
  };

  const updateBlockFromEditor = (blockId: string, text: string) => {
    if (!project.draft) return;
    updateProject({ draft: updateDraftBlockText(project.draft, blockId, text) });
    setIsModified(true);
  };

  const fillDemo = () => {
    const demoAuthor = authors[0]?.id ?? null;
    setCurrentAuthorId(demoAuthor);
    setSelectedStyleDetails(demoAuthor);
    updateProject({
      authorId: demoAuthor,
      writingType: "Newsletter",
      channel: "Email",
      language: "English",
      lengthTarget: "Medium",
      tone: "Warm",
      avoid: "Avoid corporate language. Keep the sentences natural.",
      brief: demoGoal,
    });
    setWritingGoal(demoGoal);
    setQuickDirectives(["More emotional", "Simpler English", "Add examples"]);
    setAdvancedOpen(false);
    toast("Demo filled", "success");
  };

  const captureSelection = () => {
    const selection = window.getSelection();
    const documentNode = documentRef.current;
    if (!selection || selection.rangeCount === 0 || !documentNode) {
      return;
    }
    const range = selection.getRangeAt(0);
    const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE ? (range.startContainer as Element) : range.startContainer.parentElement;
    const endElement = range.endContainer.nodeType === Node.ELEMENT_NODE ? (range.endContainer as Element) : range.endContainer.parentElement;
    const selectionTouchesDocument = Boolean(startElement && endElement && documentNode.contains(startElement) && documentNode.contains(endElement));
    if (selection.isCollapsed) {
      if (selectionTouchesDocument) setSelectedRange(null);
      return;
    }
    if (!selectionTouchesDocument) return;
    const rawText = selection.toString();
    const text = rawText.trim();
    if (!text) {
      if (selectionTouchesDocument) setSelectedRange(null);
      return;
    }
    const startBlock = startElement?.closest<HTMLElement>("[data-block-id]");
    const endBlock = endElement?.closest<HTMLElement>("[data-block-id]");
    if (!startBlock || !endBlock || !documentNode.contains(startBlock) || !documentNode.contains(endBlock)) {
      setSelectedRange(null);
      return;
    }
    const preStart = document.createRange();
    preStart.selectNodeContents(startBlock);
    preStart.setEnd(range.startContainer, range.startOffset);
    const preEnd = document.createRange();
    preEnd.selectNodeContents(endBlock);
    preEnd.setEnd(range.endContainer, range.endOffset);
    const rect = range.getBoundingClientRect();
    const rects = Array.from(range.getClientRects())
      .filter((item) => item.width > 2 && item.height > 2)
      .map(viewportRect);
    const documentBlocks = Array.from(documentNode.querySelectorAll<HTMLElement>("[data-block-id]"));
    const startIndex = documentBlocks.indexOf(startBlock);
    const endIndex = documentBlocks.indexOf(endBlock);
    const blockIds = startIndex >= 0 && endIndex >= startIndex
      ? documentBlocks.slice(startIndex, endIndex + 1).map((block) => block.dataset.blockId || "").filter(Boolean)
      : [startBlock.dataset.blockId || ""].filter(Boolean);
    setSelectedRange({
      blockId: startBlock.dataset.blockId || "",
      endBlockId: endBlock.dataset.blockId || startBlock.dataset.blockId || "",
      blockIds,
      start: preStart.toString().length,
      end: preEnd.toString().length,
      text,
      source: "native",
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      rects,
    });
  };

  const openRevision = (action: string, instruction = "") => {
    if (!selectedRange) {
      toast("Select text first", "warning");
      return;
    }
    setRevision({ open: true, action, instruction, original: selectedRange.text, suggestion: "", loading: false, range: selectedRange });
  };

  const generateRevision = async (state = revision) => {
    if (!state.range || !project.draft) return;
    const liveDraft = syncDraftFromEditor(project.draft) ?? project.draft;
    const liveProject = { ...project, draft: liveDraft };
    const instruction = state.instruction.trim() || state.action || "Improve this selected text";
    setRevision((current) => ({ ...current, loading: true, suggestion: "" }));
    const traceId = startLlmTrace("rewriteSelectedRange", `${instruction} · ${state.original.slice(0, 120)}`);
    try {
      const result = await llmService.rewriteSelectedRange(liveProject, currentAuthor, state.original, instruction);
      finishLlmTrace(traceId, `${llmService.getProviderLabel()} · selected suggestion`);
      setRevision((current) => ({ ...current, loading: false, suggestion: result.replacement_text }));
    } catch (error) {
      finishLlmTrace(traceId, error instanceof Error ? error.message : "Revision failed.", "error");
      setRevision((current) => ({ ...current, loading: false }));
      toast("Revision failed", "warning");
    }
  };

  const replaceSelectedText = () => {
    if (!project.draft || !revision.range || !revision.suggestion.trim()) return;
    const before = cloneDraft(project.draft);
    const after = replaceDraftTextRange(before, revision.range, revision.suggestion.trim());
    const edit = makeHistory("selected_rewrite", before, after, revision.instruction || revision.action);
    updateProject({ draft: after, versions: [edit, ...project.versions] });
    setRevision({ open: false, action: "", instruction: "", original: "", suggestion: "", loading: false, range: null });
    setSelectedRange(null);
    setIsModified(true);
    toast("Replaced selected text", "success");
  };

  const insertSuggestionBelow = () => {
    if (!project.draft || !revision.range || !revision.suggestion.trim()) return;
    const before = cloneDraft(project.draft);
    const after = insertDraftTextBelowRange(before, revision.range, revision.suggestion.trim());
    const edit = makeHistory("selected_rewrite", before, after, `Insert below: ${revision.instruction || revision.action}`);
    updateProject({ draft: after, versions: [edit, ...project.versions] });
    setRevision({ open: false, action: "", instruction: "", original: "", suggestion: "", loading: false, range: null });
    setSelectedRange(null);
    setIsModified(true);
    toast("Inserted suggestion", "success");
  };

  const runAssistant = async (instruction: string) => {
    if (!project.draft) {
      toast("Create a draft first", "warning");
      return;
    }
    const finalInstruction = instruction.trim();
    if (!finalInstruction) return;
    const liveDraft = syncDraftFromEditor(project.draft) ?? project.draft;
    const liveProject = { ...project, draft: liveDraft };
    setProject(liveProject);
    setAssistantInput("");

    if (selectedRange) {
      const nextState: RevisionState = { open: true, action: finalInstruction, instruction: finalInstruction, original: selectedRange.text, suggestion: "", loading: true, range: selectedRange };
      setRevision(nextState);
      await generateRevision(nextState);
      return;
    }

    setBusy(true);
    const traceId = startLlmTrace("assistant.refineDraft", finalInstruction);
    try {
      const next = await llmService.refineWholeDraft(liveProject, currentAuthor, finalInstruction);
      finishLlmTrace(traceId, `${llmService.getProviderLabel()} · preview ready`);
      setAssistantSuggestion({ instruction: finalInstruction, before: liveDraft, draft: { ...next, id: liveDraft.id, version: liveDraft.version + 1 } });
      toast("Preview ready", "success");
    } catch (error) {
      finishLlmTrace(traceId, error instanceof Error ? error.message : "Assistant failed.", "error");
      toast("Assistant failed", "warning");
    } finally {
      setBusy(false);
    }
  };

  const applyAssistantSuggestion = () => {
    if (!assistantSuggestion || !project.draft) return;
    const before = cloneDraft(project.draft);
    const edit = makeHistory("full_rewrite", before, assistantSuggestion.draft, assistantSuggestion.instruction);
    updateProject({ draft: assistantSuggestion.draft, versions: [edit, ...project.versions] });
    setAssistantSuggestion(null);
    setIsModified(true);
    toast("Draft updated", "success");
  };

  const undoLastEdit = () => {
    const [lastEdit, ...remaining] = project.versions;
    if (!lastEdit) {
      toast("No edits to undo", "warning");
      return;
    }
    updateProject({ draft: lastEdit.before, versions: remaining });
    setAssistantSuggestion(null);
    setRevision({ open: false, action: "", instruction: "", original: "", suggestion: "", loading: false, range: null });
    setSelectedRange(null);
    setIsModified(true);
    toast("Last AI edit undone", "success");
  };

  const createAuthor = () => {
    const author = createBlankAuthor(nextBlankAuthorName(authors));
    setSampleDraft(emptyMaterialDraft());
    setAuthorProfileGen(null);
    authorProfileAbortRef.current?.abort();
    setEditingSampleIds(new Set());
    setAuthors((items) => [...items, author]);
    setSelectedStyleDetails(author.id);
    setStyleEditOpen(true);
  };

  const deleteAuthor = (authorId: string) => {
    setAuthors((items) => items.filter((author) => author.id !== authorId));
    if (currentAuthorId === authorId) setAuthor(null);
    setSelectedStyleDetails(null);
    toast("Style deleted", "warning");
  };

  const updateSampleForStyle = (sampleId: string, patch: Partial<AuthorSample>) => {
    if (!selectedStyle) return;
    saveAuthor({
      ...selectedStyle,
      samples: selectedStyle.samples.map((sample) => (
        sample.id === sampleId
          ? { ...sample, ...patch, updatedAt: now(), wordCount: patch.content !== undefined ? countWords(patch.content) : sample.wordCount }
          : sample
      )),
      updatedAt: now(),
    });
  };

  const deleteSampleFromStyle = (sampleId: string) => {
    if (!selectedStyle) return;
    saveAuthor({ ...selectedStyle, samples: selectedStyle.samples.filter((sample) => sample.id !== sampleId), updatedAt: now() });
    setEditingSampleIds((items) => {
      const next = new Set(items);
      next.delete(sampleId);
      return next;
    });
    toast("Material deleted", "warning");
  };

  const setSampleEditing = (sampleId: string, editing: boolean) => {
    setEditingSampleIds((items) => {
      const next = new Set(items);
      if (editing) next.add(sampleId);
      else next.delete(sampleId);
      return next;
    });
  };

  const addSampleToStyle = () => {
    if (!selectedStyle || !sampleDraft.content.trim()) return;
    saveAuthor({
      ...selectedStyle,
      samples: [
        ...selectedStyle.samples,
        makeSample(sampleDraft.title, sampleDraft.content, sampleDraft.sourceType, {
          materialType: sampleDraft.materialType,
          sourceUrl: sampleDraft.sourceUrl,
          fileName: sampleDraft.fileName,
          rawContent: sampleDraft.rawContent || sampleDraft.content,
          status: sampleDraft.status === "extracted" ? "extracted" : "saved",
        }),
      ],
      updatedAt: now(),
    });
    setSampleDraft(emptyMaterialDraft());
    toast("Sample added", "success");
  };

  const extractFileSample = async (file: File | null) => {
    if (!file) return;
    setSampleDraft((current) => ({ ...current, status: "fetching", error: "", fileName: file.name, materialType: "file", title: current.title || file.name.replace(/\.[^.]+$/, "") }));
    const result = await extractTextFromFile(file);
    setSampleDraft((current) => ({
      ...current,
      materialType: "file",
      fileName: file.name,
      title: current.title || result.title || file.name.replace(/\.[^.]+$/, ""),
      content: result.text || current.content,
      rawContent: result.rawContent || result.text || current.rawContent,
      status: result.status,
      error: result.error || "",
    }));
    toast(result.status === "failed" ? "File extraction failed" : "File text extracted", result.status === "failed" ? "warning" : "success");
  };

  const extractUrlSample = async () => {
    const url = sampleDraft.sourceUrl.trim();
    if (!url) {
      toast("Enter a URL first", "warning");
      return;
    }
    setSampleDraft((current) => ({ ...current, status: "fetching", error: "", materialType: "link" }));
    const result = await extractTextFromUrl(url);
    setSampleDraft((current) => ({
      ...current,
      materialType: "link",
      title: current.title || result.title || (() => {
        try {
          return new URL(url).hostname;
        } catch {
          return url;
        }
      })(),
      content: result.text || current.content,
      rawContent: result.rawContent || result.text || current.rawContent,
      status: result.status,
      error: result.error || "",
    }));
    toast(result.status === "failed" ? "URL extraction failed" : "URL text extracted", result.status === "failed" ? "warning" : "success");
  };

  const addLinkMaterial = async () => {
    if (!selectedStyle || fetchingLinkMaterials) return;
    const url = sampleDraft.sourceUrl.trim();
    if (!url) {
      toast("Paste a URL first", "warning");
      return;
    }
    setFetchingLinkMaterials(true);
    try {
      const result = await extractTextFromUrl(url);
      const sample = makeSample(result.title || sampleDraft.title || (() => {
        try {
          return new URL(url).hostname;
        } catch {
          return url;
        }
      })(), result.text || sampleDraft.content || `Source URL: ${url}`, "article", {
        materialType: "link",
        sourceUrl: url,
        rawContent: result.rawContent || result.text || sampleDraft.content,
        status: result.status,
        error: result.error,
      });
      saveAuthor({ ...selectedStyle, samples: [sample, ...selectedStyle.samples], updatedAt: now() });
      setSampleDraft((current) => ({ ...emptyMaterialDraft(), content: current.content }));
      toast(result.status === "failed" ? "URL saved; paste text if extraction failed" : "Article text fetched", result.status === "failed" ? "warning" : "success");
    } finally {
      setFetchingLinkMaterials(false);
    }
  };

  const analyzeAuthor = async (author: Author) => {
    if (!author.samples.length) {
      toast("Add a sample first", "warning");
      return;
    }
    setBusy(true);
    const traceId = startLlmTrace("generateAuthorSkill", `${author.name} · ${author.samples.length} samples`);
    try {
      const result = await llmService.generateAuthorSkill(author, author.samples);
      finishLlmTrace(traceId, `${llmService.getProviderLabel()} · style updated`);
      saveAuthor({
        ...author,
        styleSummary: result.style_summary,
        skillPrompt: result.skill_prompt,
        sharedStyleSummary: sharedSummaryFromAnalysis(result),
        styleTags: result.voice.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 6),
        parameters: {
          ...author.parameters,
          structureHabits: result.structure_habits,
          voiceTone: result.voice.split(",").map((item) => item.trim()).filter(Boolean),
          sentenceRhythm: result.sentence_rhythm,
          openingPatterns: result.opening_patterns,
          transitionPatterns: result.transition_patterns,
          emotionCurve: result.emotion_curve,
          detailDensity: result.detail_density,
          dialogueTendency: result.dialogue_style,
          imageryMetaphorTendency: result.imagery_and_metaphor,
          pacingStyle: result.pacing,
          avoidList: result.avoid,
          recommendedRules: result.recommended_rules,
        },
        updatedAt: now(),
      });
      toast("Style analyzed", "success");
    } catch (error) {
      finishLlmTrace(traceId, error instanceof Error ? error.message : "Style analysis failed.", "error");
      toast("Style analysis failed", "warning");
    } finally {
      setBusy(false);
    }
  };

  const buildAuthorProfile = async () => {
    if (!selectedStyle) return;
    const usableSamples = selectedStyle.samples.filter((sample) => sample.content.trim());
    if (!usableSamples.length) {
      toast("Add readable samples first", "warning");
      return;
    }
    authorProfileAbortRef.current?.abort();
    const controller = new AbortController();
    authorProfileAbortRef.current = controller;
    const traceId = startLlmTrace("generateAuthorProfile", `${selectedStyle.name} · ${usableSamples.length} materials`);
    setAuthorProfileGen({ active: true, status: "Preparing samples…", log: ["Preparing samples…"] });
    try {
      const manual = await streamAuthorProfileText({
        author: selectedStyle,
        samples: usableSamples,
        signal: controller.signal,
        onStatus: (status) => setAuthorProfileGen((current) => (
          current ? { ...current, status } : { active: true, status, log: [] }
        )),
        onLog: (message) => setAuthorProfileGen((current) => (
          current ? { ...current, log: [...current.log, message].slice(-8) } : { active: true, status: message, log: [message] }
        )),
        onTextChange: (partial) => saveAuthor({ ...selectedStyle, description: partial, styleSummary: partial, updatedAt: now() }),
      });
      const result = await llmService.generateAuthorSkill({ ...selectedStyle, description: manual, styleSummary: manual }, usableSamples);
      saveAuthor({
        ...selectedStyle,
        description: manual,
        styleSummary: manual,
        skillPrompt: result.skill_prompt,
        sharedStyleSummary: sharedSummaryFromAnalysis(result),
        styleTags: result.voice.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 6),
        parameters: {
          ...selectedStyle.parameters,
          structureHabits: result.structure_habits,
          voiceTone: result.voice.split(",").map((item) => item.trim()).filter(Boolean),
          sentenceRhythm: result.sentence_rhythm,
          openingPatterns: result.opening_patterns,
          transitionPatterns: result.transition_patterns,
          emotionCurve: result.emotion_curve,
          detailDensity: result.detail_density,
          dialogueTendency: result.dialogue_style,
          imageryMetaphorTendency: result.imagery_and_metaphor,
          pacingStyle: result.pacing,
          avoidList: result.avoid,
          recommendedRules: result.recommended_rules,
        },
        updatedAt: now(),
      });
      finishLlmTrace(traceId, `${llmService.getProviderLabel()} · author profile ready`);
      setAuthorProfileGen((current) => current ? { ...current, active: false, status: "Profile ready" } : null);
      toast("Author profile ready", "success");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        finishLlmTrace(traceId, "Author profile generation canceled.", "error");
        setAuthorProfileGen((current) => current ? { ...current, active: false, status: "Canceled", log: [...current.log, "Canceled."] } : null);
        toast("Profile generation stopped", "info");
      } else {
        finishLlmTrace(traceId, error instanceof Error ? error.message : "Author profile generation failed.", "error");
        setAuthorProfileGen((current) => current ? { ...current, active: false, status: "Failed", log: [...current.log, "Failed."] } : null);
        toast("Profile generation failed", "warning");
      }
    }
  };

  const cancelAuthorProfileGeneration = () => {
    authorProfileAbortRef.current?.abort();
    authorProfileAbortRef.current = null;
  };

  const exportCurrentFormat = async (targetFormat = exportFormat) => {
    if (!project.draft) return;
    setExportFormat(targetFormat);
    const liveDraft = syncDraftFromEditor(project.draft) ?? project.draft;
    const settings = {
      ...defaultPublishSettings,
      ...project.publishSettings,
      documentTitle: liveDraft.title,
      format: targetFormat === "Plain text" ? "TXT" : targetFormat === "Markdown" ? "Markdown" : "HTML",
    } as typeof project.publishSettings;
    setProject((current) => ({ ...current, draft: liveDraft, publishSettings: settings, updatedAt: now() }));
    const file = await buildExportFile(liveDraft, settings, project.requirementCards, targetFormat);
    const saved = await saveExportFile(file);
    if (saved.status === "canceled") {
      toast("Export canceled", "info");
      return;
    }
    const copyText = file.encoding === "base64" ? [liveDraft.title, "", draftBlockTexts(liveDraft).join("\n\n")].join("\n\n") : file.content;
    setLastExport({
      filename: file.filename,
      format: targetFormat,
      status: saved.status,
      locationLabel: saved.locationLabel,
      detail: saved.detail,
      copyText,
      savedAt: now(),
    });
    setExportOpen(false);
    setIsModified(false);
    toast(saved.status === "saved" ? `Saved: ${file.filename}` : `Download started: ${file.filename}`, "success");
  };

  const openExportModal = () => setExportOpen(true);

  return (
    <>
      <Background />
      <main className="app-shell">
        <section className="app-window app-window-light" aria-label="AnnaWrite workspace">
          <header className="minimal-header topbar">
            <button className="app-lockup brand" onClick={() => setScreen("tasks")}>
              <span className="app-icon brand-mark"><PenLine size={18} /></span>
              <span>
                <strong>AnnaWrite</strong>
                <small>{currentAuthor?.name ?? "Default Style"}</small>
              </span>
            </button>
            <nav className="minimal-nav topbar-actions">
              <span className={`llm-status-pill ${llmStatusTone}`}>{llmStatusLabel}</span>
              <button className={`btn ${screen === "library" ? "btn-ghost" : "btn-secondary"}`} onClick={() => setScreen("library")}>
                <Library size={14} />
                Library
              </button>
              <button className={`btn ${screen === "authors" ? "btn-ghost" : "btn-secondary"}`} onClick={() => {
                setStyleEditOpen(false);
                setScreen("authors");
              }}>
                <Library size={14} />
                Author 管理
              </button>
              <button className="btn btn-secondary" onClick={newWriting}>
                <Plus size={14} />
                New
              </button>
            </nav>
          </header>

          <div className="workspace-body">
            {busy ? (
              <div className="busy veil">
                <div className="busy-indicator">
                  <Loader2 className="animate-spin text-violet" size={22} />
                  <strong>Working...</strong>
                </div>
              </div>
            ) : null}

            {screen === "tasks" ? (
              <TaskLaunchScreen
                projects={projects}
                currentProjectId={project.id}
                onCreateTask={newWriting}
                onOpenLibrary={() => setScreen("library")}
                onOpenTask={openTask}
              />
            ) : screen === "library" ? (
              <LibraryProjectsPage
                projects={projects}
                currentProjectId={project.id}
                onCreateTask={newWriting}
                onOpenTask={openTask}
              />
            ) : screen === "authors" ? (
              <AuthorManagementPage
                authors={authors}
                currentAuthorId={currentAuthorId}
                selectedStyle={selectedStyle}
                styleEditOpen={styleEditOpen}
                sampleDraft={sampleDraft}
                authorProfileGen={authorProfileGen}
                editingSampleIds={editingSampleIds}
                fetchingLinkMaterials={fetchingLinkMaterials}
                onSetAuthor={setAuthor}
                onSelectDetails={setSelectedStyleDetails}
                onCreateAuthor={createAuthor}
                onDeleteAuthor={deleteAuthor}
                onSaveAuthor={saveAuthor}
                onAnalyzeAuthor={analyzeAuthor}
                onSetStyleEditOpen={setStyleEditOpen}
                onSampleDraftChange={setSampleDraft}
                onAddSample={addSampleToStyle}
                onAddLinkMaterial={addLinkMaterial}
                onExtractFileSample={extractFileSample}
                onExtractUrlSample={extractUrlSample}
                onUpdateSample={updateSampleForStyle}
                onDeleteSample={deleteSampleFromStyle}
                onSetSampleEditing={setSampleEditing}
                onBuildAuthorProfile={buildAuthorProfile}
                onCancelAuthorProfileGeneration={cancelAuthorProfileGeneration}
                onOpenSample={setSampleViewer}
                onStartWriting={() => setScreen("home")}
              />
            ) : screen === "requirements" ? (
              <RequirementsPage
                project={project}
                currentAuthor={currentAuthor}
                onProjectChange={updateProject}
                onRegenerateCard={regenerateRequirementCard}
                onReviseOutline={reviseOutlineWithComment}
                onReviseCard={reviseOutlineSectionWithComment}
                onGenerateDraft={() => generateDraftFromProject(project)}
                onOpenDraft={() => setScreen("editor")}
                onBackHome={() => setScreen("home")}
                hasDraft={hasDraft}
                busy={busy}
              />
            ) : screen === "editor" && draft ? (
              <EditorScreen
                project={project}
                currentAuthor={currentAuthor}
                selectedRange={selectedRange}
                documentRef={documentRef}
                isModified={isModified}
                exportFormat={exportFormat}
                lastExport={lastExport}
                canUndo={project.versions.length > 0}
                lastEditType={project.versions[0]?.type}
                assistantOpen={assistantOpen}
                assistantInput={assistantInput}
                assistantSuggestion={assistantSuggestion}
                onTitleChange={updateDraftTitle}
                onDraftChange={(nextDraft) => {
                  updateProject({ draft: nextDraft });
                  setIsModified(true);
                }}
                onCaptureSelection={captureSelection}
                onClearSelection={() => setSelectedRange(null)}
                onExportCurrentFormat={exportCurrentFormat}
                onExportFormatChange={setExportFormat}
                onAssistantOpenChange={setAssistantOpen}
                onAssistantInputChange={setAssistantInput}
                onRunAssistant={runAssistant}
                onApplyAssistant={applyAssistantSuggestion}
                onCancelAssistant={() => setAssistantSuggestion(null)}
                onBackHome={() => setScreen("home")}
                onBackOutline={() => setScreen(project.requirementCards.length ? "requirements" : "home")}
              />
            ) : (
              <HomeScreen
                authors={authors}
                currentAuthor={currentAuthor}
                currentAuthorId={currentAuthorId}
                writingGoal={writingGoal}
                quickDirectives={quickDirectives}
                advancedOpen={advancedOpen}
                project={project}
                hasDraft={hasDraft}
                hasOutline={hasOutline}
                onSetAuthor={setAuthor}
                onOpenAuthorManagement={() => setScreen("authors")}
                onGoalChange={setWritingGoal}
                onToggleDirective={(chip) => setQuickDirectives((items) => (items.includes(chip) ? items.filter((item) => item !== chip) : [...items, chip]))}
                onAdvancedOpenChange={setAdvancedOpen}
                onProjectChange={updateProject}
                onDemo={fillDemo}
                onGenerate={generateDraftFromGoal}
                onBlank={startBlankDraft}
                onOpenOutline={() => setScreen("requirements")}
                onContinue={() => setScreen("editor")}
              />
            )}

            <LlmTracePanel traces={llmTraces} activeTrace={activeTrace} />
            <ToastStack messages={toasts} />
          </div>
        </section>
      </main>

      {revision.open ? (
        <RevisionModal
          revision={revision}
          onChange={(patch) => setRevision((current) => ({ ...current, ...patch }))}
          onGenerate={() => generateRevision()}
          onReplace={replaceSelectedText}
          onInsertBelow={insertSuggestionBelow}
          onClose={() => setRevision({ open: false, action: "", instruction: "", original: "", suggestion: "", loading: false, range: null })}
        />
      ) : null}

      {exportOpen ? (
        <ExportFormatModal
          format={exportFormat}
          onFormatChange={setExportFormat}
          onClose={() => setExportOpen(false)}
          onConfirm={exportCurrentFormat}
        />
      ) : null}

      {sampleViewer ? <SampleModal sample={sampleViewer} onClose={() => setSampleViewer(null)} /> : null}
    </>
  );
}

function TaskLaunchScreen({
  projects,
  currentProjectId: _currentProjectId,
  onCreateTask,
  onOpenLibrary,
  onOpenTask,
}: {
  projects: WritingProject[];
  currentProjectId: string;
  onCreateTask: () => void;
  onOpenLibrary: () => void;
  onOpenTask: (projectId: string) => void;
}) {
  const latestTask = projects[0] ?? null;
  return (
    <div className="page-scroll">
      <section className="launch-page">
        <div className="launch-head">
          <h1>Choose task</h1>
        </div>

        <div className="task-actions">
          <button className="task-action-card" onClick={onCreateTask}>
            <span className="task-action-icon">
              <Plus size={22} />
            </span>
            <strong>Create new</strong>
          </button>

          <button className="task-action-card" onClick={onOpenLibrary}>
            <span className="task-action-icon">
              <Library size={22} />
            </span>
            <strong>Open project</strong>
          </button>
        </div>

        <section>
          <div className="recent-projects-head">
            <h2>Recent projects</h2>
            {latestTask ? (
              <button className="text-button" onClick={() => onOpenTask(latestTask.id)}>
                Open latest
              </button>
            ) : null}
          </div>

          {projects.length === 0 ? (
            <div className="empty-projects"><strong>No local tasks yet.</strong><p>Create a new task to start writing.</p></div>
          ) : (
            <div className="recent-projects">
              {projects.map((item) => (
                <button key={item.id} className="recent-project-row" onClick={() => onOpenTask(item.id)}>
                  <span>
                    <strong>{taskTitle(item)}</strong>
                    <small>{formatTaskDate(item.updatedAt)}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </section>
    </div>
  );
}

function LibraryProjectsPage({
  projects,
  currentProjectId,
  onCreateTask,
  onOpenTask,
}: {
  projects: WritingProject[];
  currentProjectId: string;
  onCreateTask: () => void;
  onOpenTask: (projectId: string) => void;
}) {
  const currentProject = projects.find((item) => item.id === currentProjectId) ?? projects[0] ?? null;

  return (
    <div className="page-scroll">
      <section className="library-page">
        <div className="library-header">
          <div className="library-title-row">
            <button className="btn btn-secondary" onClick={() => currentProject && onOpenTask(currentProject.id)}>Back</button>
            <h1>Local projects</h1>
          </div>
          <button className="btn btn-primary" onClick={onCreateTask}>
            <Plus size={14} />
            New task
          </button>
        </div>

        <section className="current-task-panel">
          <div>
            <span>Current task</span>
            <strong>{currentProject ? taskTitle(currentProject) : "No task selected"}</strong>
          </div>
          {currentProject ? (
            <button className="btn btn-secondary" onClick={() => onOpenTask(currentProject.id)}>
              Open
            </button>
          ) : null}
        </section>

        {projects.length === 0 ? (
          <section className="empty-projects library-empty">
            <strong>No local projects yet.</strong>
            <p>Create a new task and it will appear here automatically.</p>
          </section>
        ) : (
          <section className="project-list">
            {projects.map((item) => (
              <button key={item.id} className={`project-row ${item.id === currentProjectId ? "active" : ""}`} onClick={() => onOpenTask(item.id)}>
                <span>
                  <strong>{taskTitle(item)}</strong>
                  <small>{formatTaskDate(item.updatedAt)}</small>
                </span>
              </button>
            ))}
          </section>
        )}
      </section>
    </div>
  );
}

function HomeScreen({
  authors,
  currentAuthor,
  currentAuthorId,
  writingGoal,
  project,
  hasDraft,
  hasOutline,
  onSetAuthor,
  onOpenAuthorManagement,
  onGoalChange,
  onProjectChange,
  onGenerate,
  onOpenOutline,
  onContinue,
}: {
  authors: Author[];
  currentAuthor: Author | null;
  currentAuthorId: string | null;
  writingGoal: string;
  quickDirectives: string[];
  advancedOpen: boolean;
  project: WritingProject;
  hasDraft: boolean;
  hasOutline: boolean;
  onSetAuthor: (id: string | null) => void;
  onOpenAuthorManagement: () => void;
  onGoalChange: (value: string) => void;
  onToggleDirective: (chip: string) => void;
  onAdvancedOpenChange: (open: boolean) => void;
  onProjectChange: (patch: Partial<WritingProject>) => void;
  onDemo: () => void;
  onGenerate: () => void;
  onBlank: () => void;
  onOpenOutline: () => void;
  onContinue: () => void;
}) {
  const selectedStyleDescription = compactStyleDescription(currentAuthor, 130);
  const selectedStyleTags = styleTags(currentAuthor);
  return (
    <div className="home-screen page-scroll">
      <nav className="writing-progress" aria-label="写作进度">
        <button className="progress-step current" type="button">
          <span className="progress-dot" />
          需求确认
        </button>
        <button className={`progress-step ${hasOutline ? "done" : ""}`} type="button" onClick={hasOutline ? onOpenOutline : undefined} disabled={!hasOutline}>
          <span className="progress-dot" />
          Outline
        </button>
        <button className="progress-step" type="button" disabled>
          <span className="progress-dot" />
          正文
        </button>
      </nav>

      <div className="home-layout">
        <section className="composer-panel">
          <div>
            <span className="panel-kicker">写作入口</span>
            <h1>Start with the writing need.</h1>
          </div>

          <aside className="selected-style-card style-select-card">
            <div>
              <span>Selected style</span>
              <strong>{currentAuthor?.name ?? "Default Style"}</strong>
            </div>
            <label className="style-select-field">
              <select value={currentAuthorId ?? "default"} onChange={(event) => onSetAuthor(event.target.value === "default" ? null : event.target.value)}>
                <option value="default">Default</option>
                {visibleStyleAuthors(authors).map((author) => (
                  <option key={author.id} value={author.id}>
                    {author.name}
                  </option>
                ))}
              </select>
            </label>
            <p>{selectedStyleDescription}</p>
            <div className="selected-style-tags">
              {selectedStyleTags.slice(0, 5).map((tag) => <small key={tag}>{tag}</small>)}
            </div>
            <button className="text-button" type="button" onClick={onOpenAuthorManagement}>
              Manage styles
            </button>
          </aside>

          <label className="field">
            <span>写作需求</span>
            <textarea
              className="field-input"
              value={writingGoal}
              onChange={(event) => {
                onGoalChange(event.target.value);
                onProjectChange({ brief: event.target.value });
              }}
              placeholder="例如：写一篇介绍新品的公众号文章，语气真诚、有一点专业感，结尾引导预约。"
            />
          </label>

          <div className="form-actions">
            <button className="btn btn-primary" onClick={onGenerate}>
              <Sparkles size={14} />
              开始写作
            </button>
            <label className="checkbox-option">
              <input type="checkbox" checked={project.reviewRequirementsFirst} onChange={(event) => onProjectChange({ reviewRequirementsFirst: event.target.checked })} />
              <span>先确认目录</span>
            </label>
            {hasOutline ? (
              <button className="btn btn-secondary" onClick={onOpenOutline}>
                <FileText size={14} />
                Continue outline
              </button>
            ) : null}
            {hasDraft ? (
              <button className="btn btn-secondary" onClick={onContinue}>
                <FileText size={14} />
                Continue draft
              </button>
            ) : null}
          </div>
        </section>

        <aside className="context-panel">
          <div>
            <div className="mb-3 text-sm font-extrabold text-ink">Current author</div>
            {currentAuthor ? (
              <div className="grid gap-3">
                <div>
                  <strong className="block text-2xl font-extrabold text-ink">{currentAuthor.name}</strong>
                  <p className="mt-2 text-sm leading-6 text-muted">{currentAuthor.description}</p>
                </div>
                <div className="tag-row">
                  {styleTags(currentAuthor).map((tag) => <span key={tag}>{tag}</span>)}
                </div>
                <div className="rounded-2xl bg-white/65 p-4 text-sm leading-6 text-graphite">
                  {currentAuthor.styleSummary}
                </div>
              </div>
            ) : (
              <p className="text-sm leading-6 text-muted">默认不使用 author；需要时可以从左侧下拉选择已有 author。</p>
            )}
          </div>

          <div className="border-t border-white/60 pt-5">
            <div className="mb-3 text-sm font-extrabold text-ink">Task context</div>
            <div className="grid gap-2 text-sm text-muted">
              <div className="flex justify-between gap-3"><span>Type</span><strong className="text-ink">{project.writingType}</strong></div>
              <div className="flex justify-between gap-3"><span>Channel</span><strong className="text-ink">{project.channel}</strong></div>
              <div className="flex justify-between gap-3"><span>Language</span><strong className="text-ink">{project.language}</strong></div>
              <div className="flex justify-between gap-3"><span>Length</span><strong className="text-ink">{project.lengthTarget}</strong></div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function AuthorManagementPage({
  authors,
  currentAuthorId,
  selectedStyle,
  styleEditOpen,
  sampleDraft,
  authorProfileGen,
  editingSampleIds,
  fetchingLinkMaterials,
  onSetAuthor,
  onSelectDetails,
  onCreateAuthor,
  onDeleteAuthor,
  onSaveAuthor,
  onAnalyzeAuthor,
  onSetStyleEditOpen,
  onSampleDraftChange,
  onAddSample,
  onAddLinkMaterial,
  onExtractFileSample,
  onExtractUrlSample,
  onUpdateSample,
  onDeleteSample,
  onSetSampleEditing,
  onBuildAuthorProfile,
  onCancelAuthorProfileGeneration,
  onOpenSample,
  onStartWriting,
}: {
  authors: Author[];
  currentAuthorId: string | null;
  selectedStyle: Author | null;
  styleEditOpen: boolean;
  sampleDraft: MaterialDraft;
  authorProfileGen: AuthorProfileGenerationState | null;
  editingSampleIds: Set<string>;
  fetchingLinkMaterials: boolean;
  onSetAuthor: (id: string | null) => void;
  onSelectDetails: (id: string | null) => void;
  onCreateAuthor: () => void;
  onDeleteAuthor: (id: string) => void;
  onSaveAuthor: (author: Author) => void;
  onAnalyzeAuthor: (author: Author) => void;
  onSetStyleEditOpen: (open: boolean) => void;
  onSampleDraftChange: (draft: MaterialDraft | ((current: MaterialDraft) => MaterialDraft)) => void;
  onAddSample: () => void;
  onAddLinkMaterial: () => void;
  onExtractFileSample: (file: File | null) => void;
  onExtractUrlSample: () => void;
  onUpdateSample: (sampleId: string, patch: Partial<AuthorSample>) => void;
  onDeleteSample: (sampleId: string) => void;
  onSetSampleEditing: (sampleId: string, editing: boolean) => void;
  onBuildAuthorProfile: () => void;
  onCancelAuthorProfileGeneration: () => void;
  onOpenSample: (sample: AuthorSample) => void;
  onStartWriting: () => void;
}) {
  const [styleQuery, setStyleQuery] = useState("");
  const [styleFilter, setStyleFilter] = useState("All");
  const [deleteConfirmStyle, setDeleteConfirmStyle] = useState<Author | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const filterOptions = ["All", "WeChat", "LinkedIn", "PR", "Academic", "Blog", "Story"];
  const shownAuthors = visibleStyleAuthors(authors).filter((author) => {
    const haystack = [
      author.name,
      author.description,
      author.styleSummary,
      author.bestFor.join(" "),
      styleTags(author).join(" "),
    ].join(" ").toLowerCase();
    const queryMatch = !styleQuery.trim() || haystack.includes(styleQuery.trim().toLowerCase());
    const filterKeywords: Record<string, string[]> = {
      All: [],
      WeChat: ["wechat", "公众号", "public account"],
      LinkedIn: ["linkedin"],
      PR: ["press", "pr", "launch", "announcement"],
      Academic: ["academic", "thesis", "research"],
      Blog: ["blog", "seo", "newsletter"],
      Story: ["story", "fiction", "narrative"],
    };
    const keywords = filterKeywords[styleFilter] ?? [];
    return queryMatch && (!keywords.length || keywords.some((keyword) => haystack.includes(keyword)));
  });
  const hasReadableMaterials = Boolean(selectedStyle?.samples.some((sample) => sample.content.trim()));
  const openStylePreview = (authorId: string | null) => {
    if (authorId === null) onSetAuthor(null);
    else onSelectDetails(authorId);
    onSetStyleEditOpen(false);
  };
  const useStyle = (authorId: string | null) => {
    onSetAuthor(authorId);
    onStartWriting();
  };
  const renderSampleList = () => {
    if (!selectedStyle?.samples.length) return <div className="empty-list">No materials yet. Add files, links, or pasted text.</div>;
    return selectedStyle.samples.map((sample) => {
      const editing = editingSampleIds.has(sample.id);
      return (
        <article className="material-editor-card" key={sample.id}>
          <header className="material-summary-row">
            <div className="material-summary-copy">
              <strong>{sample.title || sampleKindLabel(sample)}</strong>
              <small>{sampleKindLabel(sample)} · {materialStatusLabel(sample.status)} · {formatShortDate(sample.uploadedAt)}</small>
              <p>{summarizeSampleForCard(sample)}</p>
            </div>
            <div className="material-row-actions">
              <span className="pill">{sample.content.length} chars</span>
              <button className="text-button" type="button" onClick={() => onSetSampleEditing(sample.id, !editing)}>{editing ? "Done" : "Edit"}</button>
              <button className="text-button" type="button" onClick={() => onOpenSample(sample)}>Preview</button>
              <button className="text-button danger" type="button" onClick={() => onDeleteSample(sample.id)}>Delete</button>
            </div>
          </header>
          {editing ? (
            <div className="material-edit-fields">
              <label className="field compact-field">
                <span>Material name</span>
                <input value={sample.title} onChange={(event) => onUpdateSample(sample.id, { title: event.target.value })} />
              </label>
              <label className="field compact-field">
                <span>Source URL</span>
                <input value={sample.sourceUrl ?? ""} onChange={(event) => onUpdateSample(sample.id, { sourceUrl: event.target.value, materialType: "link" })} placeholder="Optional URL" />
              </label>
              <label className="field compact-field">
                <span>Content</span>
                <textarea value={sample.content} onChange={(event) => onUpdateSample(sample.id, { content: event.target.value, rawContent: event.target.value })} rows={6} />
              </label>
            </div>
          ) : null}
        </article>
      );
    });
  };

  return (
    <div className="page-scroll author-workspace-view">
      <div className="manager-header">
        <div>
          <span className="panel-kicker">Style Library</span>
          <h1>Choose a writing style</h1>
          <p>Pick a voice, manage author materials, and build reusable style profiles.</p>
        </div>
        <button className="primary-button compact" onClick={onCreateAuthor}>New style</button>
      </div>

      <div className={`manager-layout ${styleEditOpen ? "builder-layout" : "style-library-layout"}`}>
        <section className={styleEditOpen ? "author-list-panel" : "style-grid-panel"}>
          <div className="section-heading">
            <span>{styleEditOpen ? "Saved styles" : "Styles"}</span>
            <strong>{shownAuthors.length + (styleEditOpen ? 0 : 1)}</strong>
          </div>
          {!styleEditOpen ? (
            <div className="style-library-tools">
              <input className="style-search" value={styleQuery} onChange={(event) => setStyleQuery(event.target.value)} placeholder="Search styles..." />
              <div className="style-filter-row">
                {filterOptions.map((option) => (
                  <button className={styleFilter === option ? "active" : ""} key={option} type="button" onClick={() => setStyleFilter(option)}>{option}</button>
                ))}
              </div>
            </div>
          ) : null}
          <div className={styleEditOpen ? "author-list" : "style-library-grid"}>
            {!styleEditOpen ? (
              <article className={`style-library-card ${currentAuthorId === null ? "current" : ""} ${!selectedStyle ? "preview" : ""}`}>
                <button className="style-card-main" type="button" onClick={() => openStylePreview(null)}>
                  <span className="style-card-label">Default</span>
                  <h2>Default Style</h2>
                  <p>Clear, simple writing for fast drafts.</p>
                  <div className="tag-row">{styleTags(null).map((tag) => <span key={tag}>{tag}</span>)}</div>
                </button>
                <div className="style-card-footer">
                  {currentAuthorId === null ? <span className="current-badge">Current</span> : <span className="sample-count">Ready</span>}
                  <button className="primary-button compact" type="button" onClick={() => useStyle(null)}>Use style</button>
                </div>
              </article>
            ) : null}
            {shownAuthors.map((author) => styleEditOpen ? (
              <button className={`author-card ${author.id === selectedStyle?.id ? "active" : ""}`} key={author.id} type="button" onClick={() => {
                onSelectDetails(author.id);
                onSetStyleEditOpen(false);
              }}>
                <span>
                  <strong>{author.name}</strong>
                  <small>{author.samples.length} sample{author.samples.length === 1 ? "" : "s"}</small>
                </span>
                <span className="pill">{formatShortDate(author.createdAt)}</span>
              </button>
            ) : (
              <article className={`style-library-card ${author.id === currentAuthorId ? "current" : ""} ${author.id === selectedStyle?.id ? "preview" : ""}`} key={author.id}>
                <button className="style-card-main" type="button" onClick={() => openStylePreview(author.id)}>
                  <span className="style-card-label">{utilityLabel(author)} · {author.samples.length} sample{author.samples.length === 1 ? "" : "s"}</span>
                  <h2>{author.name}</h2>
                  <p>{compactStyleDescription(author)}</p>
                  <div className="tag-row">{styleTags(author).slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div>
                </button>
                <div className="style-card-footer">
                  {author.id === currentAuthorId ? <span className="current-badge">Current</span> : <span className="sample-count">{materialStats(author)}</span>}
                  <div className="style-card-buttons">
                    <button className="secondary-button icon-button" type="button" onClick={() => {
                      onSelectDetails(author.id);
                      onSetStyleEditOpen(true);
                    }} aria-label={`Edit ${author.name}`}><Edit3 size={14} /></button>
                    <button className="primary-button compact" type="button" onClick={() => useStyle(author.id)}>Use style</button>
                  </div>
                </div>
              </article>
            ))}
            {!shownAuthors.length ? <div className="empty-list">No matching styles.</div> : null}
          </div>
        </section>

        {styleEditOpen && selectedStyle ? (
          <section className="detail-panel form-panel">
            <div className="section-heading">
              <span>{isBlankNewStyle(selectedStyle) ? "New style" : "Edit style"}</span>
              <span className="autosave-indicator"><Check size={13} />Saved locally</span>
            </div>
            <div className="author-form">
              <label className="field">
                <span>Style name</span>
                <input value={selectedStyle.name} onChange={(event) => onSaveAuthor({ ...selectedStyle, name: event.target.value, updatedAt: now() })} />
              </label>
              <label className="field compact-field">
                <span>Style tags</span>
                <input
                  value={(selectedStyle.styleTags ?? []).join(", ")}
                  onChange={(event) => {
                    const tags = event.target.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 8);
                    onSaveAuthor({ ...selectedStyle, styleTags: tags, updatedAt: now() });
                  }}
                  placeholder="warm, concise, scene-led"
                />
              </label>
              <section className="profile-builder">
                <AuthorProfileStudio
                  profileText={selectedStyle.description || selectedStyle.styleSummary}
                  generation={authorProfileGen}
                  hasReadableMaterials={hasReadableMaterials}
                  onBuildProfile={onBuildAuthorProfile}
                  onCancelGeneration={onCancelAuthorProfileGeneration}
                  onTextChange={(value) => onSaveAuthor({ ...selectedStyle, description: value, styleSummary: value, updatedAt: now() })}
                />
              </section>

              <div className="material-builder">
                <div className="section-heading tight">
                  <span>Writing samples</span>
                  <strong>{selectedStyle.samples.length}</strong>
                </div>
                <div className="material-source-section open">
                  <div className="source-head">
                    <span>Files</span>
                    <span className="source-meta"><strong>{selectedStyle.samples.filter((sample) => sample.materialType === "file").length}</strong></span>
                  </div>
                  <div className="field compact-field">
                    <span>Import files</span>
                    <div className="custom-file-control">
                      <button className="secondary-button compact" type="button" onClick={() => fileInputRef.current?.click()}>
                        <Upload size={14} />
                        Choose files
                      </button>
                      <small>{sampleDraft.fileName || "Word, PDF, TXT, Markdown, HTML"}</small>
                      <input
                        ref={fileInputRef}
                        className="hidden-file-input"
                        type="file"
                        accept=".txt,.md,.markdown,.html,.htm,.rtf,.docx,.pdf"
                        onChange={(event) => {
                          onExtractFileSample(event.target.files?.[0] ?? null);
                          event.currentTarget.value = "";
                        }}
                      />
                    </div>
                  </div>
                </div>
                <div className="material-source-section open">
                  <div className="source-head">
                    <span>Web pages</span>
                    <span className="source-meta"><strong>{selectedStyle.samples.filter((sample) => sample.materialType === "link" || sample.materialType === "html").length}</strong></span>
                  </div>
                  <label className="field compact-field">
                    <span>Fetch from URL</span>
                    <textarea value={sampleDraft.sourceUrl} onChange={(event) => onSampleDraftChange({ ...sampleDraft, sourceUrl: event.target.value, materialType: "link" })} rows={2} placeholder="Paste an article/page URL." />
                    <div className="material-toolbar">
                      <button className="secondary-button compact" type="button" onClick={onExtractUrlSample} disabled={sampleDraft.status === "fetching" || !sampleDraft.sourceUrl.trim()}>
                        {sampleDraft.status === "fetching" ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
                        Extract
                      </button>
                      <button className="secondary-button compact" type="button" onClick={onAddLinkMaterial} disabled={fetchingLinkMaterials || !sampleDraft.sourceUrl.trim()}>
                        {fetchingLinkMaterials ? <Loader2 className="animate-spin" size={14} /> : <Link size={14} />}
                        {fetchingLinkMaterials ? "Fetching..." : "Add URL"}
                      </button>
                    </div>
                  </label>
                </div>
                <div className="material-source-section open">
                  <div className="source-head">
                    <span>Text</span>
                    <span className="source-meta"><strong>{selectedStyle.samples.filter((sample) => !sample.materialType || sample.materialType === "article").length}</strong></span>
                  </div>
                  <label className="field compact-field">
                    <span>Sample title</span>
                    <input value={sampleDraft.title} onChange={(event) => onSampleDraftChange({ ...sampleDraft, title: event.target.value })} placeholder="Material name" />
                  </label>
                  <label className="field compact-field">
                    <span>Content</span>
                    <textarea value={sampleDraft.content} onChange={(event) => onSampleDraftChange({ ...sampleDraft, content: event.target.value, status: sampleDraft.status === "idle" ? "saved" : sampleDraft.status })} rows={6} placeholder="Paste sample text or extracted content here." />
                  </label>
                  {sampleDraft.error ? <p className="material-error">{sampleDraft.error}</p> : null}
                  <button className="primary-button compact" type="button" onClick={onAddSample} disabled={!sampleDraft.content.trim()}>Add text</button>
                </div>
                <div className="material-list-editor">
                  {renderSampleList()}
                </div>
              </div>

              <div className="form-actions sticky-actions">
                <button className="primary-button" type="button" onClick={() => {
                  onSetAuthor(selectedStyle.id);
                  onStartWriting();
                }}>Use style</button>
                <button className="secondary-button" type="button" onClick={() => onSetStyleEditOpen(false)}>Done</button>
                <button className="secondary-button danger-button compact" type="button" onClick={() => setDeleteConfirmStyle(selectedStyle)}>Delete</button>
              </div>
            </div>
          </section>
        ) : (
          <section className="detail-panel style-preview-panel">
            <div className="style-preview-hero">
              <div className="preview-title-row">
                <div>
                  <span className="panel-kicker">Preview</span>
                  <h2>{selectedStyle?.name ?? "Default Style"}</h2>
                </div>
                {selectedStyle ? <span className="pill">{utilityLabel(selectedStyle)}</span> : <span className="pill">Ready</span>}
              </div>
              <p>{compactStyleDescription(selectedStyle, 190)}</p>
              <div className="tag-row">{styleTags(selectedStyle).slice(0, 5).map((tag) => <span key={tag}>{tag}</span>)}</div>
            </div>
            <div className="preview-actions">
              <button className="primary-button" type="button" onClick={() => useStyle(selectedStyle?.id ?? null)}>Use this style</button>
              {selectedStyle ? <button className="secondary-button" type="button" onClick={() => onSetStyleEditOpen(true)}>Edit style</button> : null}
            </div>
            {selectedStyle?.sharedStyleSummary ? (
              <details className="advanced-style-details">
                <summary>Advanced style summary</summary>
                <div className="mt-3 grid gap-2 text-xs leading-5 text-muted">
                  <p><strong className="text-ink">Tone:</strong> {selectedStyle.sharedStyleSummary.tone.join(", ")}</p>
                  <p><strong className="text-ink">Structure:</strong> {selectedStyle.sharedStyleSummary.structure.join(" -> ")}</p>
                  <p><strong className="text-ink">Do:</strong> {selectedStyle.sharedStyleSummary.doList.join("; ")}</p>
                  <p><strong className="text-ink">Avoid:</strong> {selectedStyle.sharedStyleSummary.avoidList.join("; ")}</p>
                </div>
              </details>
            ) : null}
            <section className="preview-section">
              <div className="section-heading tight">
                <span>Samples</span>
                <strong>{selectedStyle?.samples.length ?? 0}</strong>
              </div>
              {selectedStyle?.samples.length ? (
                <div className="sample-preview-list">
                  {selectedStyle.samples.slice(0, 3).map((sample) => (
                    <button className="sample-preview-item" type="button" key={sample.id} onClick={() => onOpenSample(sample)}>
                      <strong>{sample.title || sampleKindLabel(sample)}</strong>
                      <small>{sampleKindLabel(sample)} · {sample.wordCount || countWords(sample.content)} words</small>
                    </button>
                  ))}
                </div>
              ) : <p className="muted-note">Default works without setup. Create a style when you want AnnaWrite to follow your own samples.</p>}
            </section>
            {selectedStyle ? <button className="text-button danger" type="button" onClick={() => setDeleteConfirmStyle(selectedStyle)}>Delete style</button> : null}
          </section>
        )}
      </div>

      {deleteConfirmStyle ? (
        <div className="confirm-backdrop" role="dialog" aria-modal="true">
          <div className="delete-confirm-modal">
            <div>
              <span className="panel-kicker">Delete style</span>
              <h2>Delete "{deleteConfirmStyle.name}"?</h2>
              <p>This removes the style and its samples from localStorage. This cannot be undone.</p>
            </div>
            <div className="confirm-actions">
              <button className="secondary-button" type="button" onClick={() => setDeleteConfirmStyle(null)}>Cancel</button>
              <button className="secondary-button danger-button" type="button" onClick={() => {
                const id = deleteConfirmStyle.id;
                setDeleteConfirmStyle(null);
                onDeleteAuthor(id);
              }}>
                Delete style
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AuthorStyleCard({ author, active, onUse, onView, onEdit }: { author: Author | null; active: boolean; onUse: () => void; onView: () => void; onEdit?: () => void }) {
  return (
    <article className={`author-style-card ${active ? "active" : ""}`}>
      {onEdit ? (
        <button className="card-edit" onClick={onEdit} aria-label="Edit style">
          <Edit3 size={14} />
        </button>
      ) : null}
      <h3>{author?.name ?? "Default Style"}</h3>
      <p>{author?.description ?? "Clear, natural writing for quick drafts."}</p>
      <div className="tag-row">{styleTags(author).map((tag) => <span key={tag}>{tag}</span>)}</div>
      <div className="card-actions">
        <button className="btn btn-primary" onClick={onUse}>Use this style</button>
        <button className="btn btn-secondary" onClick={onView}>View samples</button>
      </div>
    </article>
  );
}

function EditorScreen({
  project,
  currentAuthor,
  selectedRange,
  documentRef,
  isModified,
  exportFormat,
  lastExport,
  canUndo,
  lastEditType,
  assistantOpen,
  assistantInput,
  assistantSuggestion,
  onTitleChange,
  onDraftChange,
  onCaptureSelection,
  onClearSelection,
  onExportCurrentFormat,
  onExportFormatChange,
  onAssistantOpenChange,
  onAssistantInputChange,
  onRunAssistant,
  onApplyAssistant,
  onCancelAssistant,
  onBackHome,
  onBackOutline,
}: {
  project: WritingProject;
  currentAuthor: Author | null;
  selectedRange: TextSelectionRange | null;
  documentRef: React.RefObject<HTMLDivElement | null>;
  isModified: boolean;
  exportFormat: ExportFormat;
  lastExport: ExportReceipt | null;
  canUndo: boolean;
  lastEditType?: EditHistory["type"];
  assistantOpen: boolean;
  assistantInput: string;
  assistantSuggestion: AssistantSuggestion | null;
  onTitleChange: (title: string) => void;
  onDraftChange: (draft: Draft) => void;
  onCaptureSelection: () => void;
  onClearSelection: () => void;
  onExportCurrentFormat: (format?: ExportFormat) => void;
  onExportFormatChange: (format: ExportFormat) => void;
  onAssistantOpenChange: (open: boolean) => void;
  onAssistantInputChange: (value: string) => void;
  onRunAssistant: (instruction: string) => void;
  onApplyAssistant: () => void;
  onCancelAssistant: () => void;
  onBackHome: () => void;
  onBackOutline: () => void;
}) {
  const draft = project.draft;
  const draftCommentRef = useRef<HTMLTextAreaElement | null>(null);
  const [draftCommentOpen, setDraftCommentOpen] = useState(false);
  const [draftComment, setDraftComment] = useState("");
  const [draftCommentHistory, setDraftCommentHistory] = useState<string[]>([]);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [draftContextMenu, setDraftContextMenu] = useState<{ left: number; top: number } | null>(null);
  const draftHighlightName = "annawrite-draft-selection";

  useEffect(() => {
    if (!selectedRange || !draftCommentOpen) return;
    window.setTimeout(() => draftCommentRef.current?.focus(), 0);
  }, [draftCommentOpen, selectedRange?.blockId, selectedRange?.start, selectedRange?.end]);

  useEffect(() => () => {
    const cssHighlights = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    cssHighlights?.delete(draftHighlightName);
  }, []);

  if (!draft) return null;

  const startWholeDraftComment = () => {
    const cssHighlights = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    cssHighlights?.delete(draftHighlightName);
    onClearSelection();
    setDraftComment("");
    setDraftCommentOpen(true);
    setDraftCommentHistory([]);
    setDraftContextMenu(null);
  };

  const clearDraftCommentTools = () => {
    const cssHighlights = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    cssHighlights?.delete(draftHighlightName);
    setDraftComment("");
    setDraftCommentOpen(false);
    setDraftCommentHistory([]);
    onClearSelection();
    onCancelAssistant();
    setDraftContextMenu(null);
  };

  const sendDraftComment = () => {
    const comment = draftComment.trim();
    if (!comment) return;
    setDraftCommentHistory((items) => [comment, ...items].slice(0, 4));
    setDraftComment("");
    onRunAssistant(comment);
    setDraftContextMenu(null);
  };

  const chooseExportFormat = (format: ExportFormat) => {
    setExportMenuOpen(false);
    onExportFormatChange(format);
    onExportCurrentFormat(format);
  };

  const handleDraftContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() || "";
    if (!selectedText) {
      setDraftContextMenu(null);
      return;
    }
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
    const cssHighlights = (globalThis as { CSS?: { highlights?: Map<string, unknown> }; Highlight?: new (range: Range) => unknown }).CSS?.highlights;
    if (range && cssHighlights && globalThis.Highlight) {
      cssHighlights.set(draftHighlightName, new globalThis.Highlight(range));
    }
    onCaptureSelection();
    event.preventDefault();
    setDraftContextMenu({
      left: Math.min(event.clientX, window.innerWidth - 120),
      top: Math.min(event.clientY, window.innerHeight - 48),
    });
  };

  const openDraftCommentForSelection = () => {
    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
    const cssHighlights = (globalThis as { CSS?: { highlights?: Map<string, unknown> }; Highlight?: new (range: Range) => unknown }).CSS?.highlights;
    if (range && cssHighlights && globalThis.Highlight) {
      cssHighlights.set(draftHighlightName, new globalThis.Highlight(range));
    }
    onCaptureSelection();
    setDraftComment("");
    setDraftCommentOpen(true);
    setDraftCommentHistory([]);
    setDraftContextMenu(null);
    window.setTimeout(() => draftCommentRef.current?.focus(), 0);
  };

  return (
    <div className="editor-shell page-scroll">
      <section className="outline-page draft-page mx-auto max-w-6xl">
        <nav className="writing-progress" aria-label="Writing progress">
          <button className="progress-step done" type="button" onClick={onBackHome}>
            <span className="progress-dot" />
            <span>需求确认</span>
          </button>
          <button className="progress-step done" type="button" onClick={onBackOutline}>
            <span className="progress-dot" />
            <span>Outline</span>
          </button>
          <button className="progress-step current" type="button">
            <span className="progress-dot" />
            <span>正文</span>
          </button>
        </nav>

        <div className="outline-header draft-header">
          <div>
            <div className="panel-kicker">写作草稿</div>
            <h1
              className="editable-project-title draft-title-input"
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              onBlur={(event) => onTitleChange(event.currentTarget.innerText.trim() || "写作草稿")}
            >
              {draft.title}
            </h1>
            <p>{project.brief || `${currentAuthor?.name ?? "Default Style"} · ${project.language || "English"}`}</p>
          </div>
          <div className="outline-top-actions">
            <div className="export-menu">
              <button className="btn btn-secondary" type="button" onClick={() => setExportMenuOpen((open) => !open)}>
                <Download size={14} />
                导出
                <ChevronDown size={14} />
              </button>
              {exportMenuOpen ? (
                <div className="export-options" role="menu">
                  {exportFormats.map((format) => (
                    <button
                      className={format === exportFormat ? "active" : ""}
                      type="button"
                      role="menuitem"
                      key={format}
                      onClick={() => chooseExportFormat(format)}
                    >
                      {format}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button className="btn btn-secondary" onClick={onBackOutline}>返回目录</button>
          </div>
        </div>

        <div className="outline-workspace draft-workspace">
          <main
            className="outline-document draft-document"
            ref={documentRef}
            contentEditable
            suppressContentEditableWarning
            onMouseUp={onCaptureSelection}
            onKeyUp={onCaptureSelection}
            onContextMenu={handleDraftContextMenu}
            onBlur={() => {
              let nextDraft = draft;
              documentRef.current?.querySelectorAll<HTMLElement>("[data-block-id]").forEach((node) => {
                const blockId = node.dataset.blockId;
                if (!blockId) return;
                nextDraft = updateDraftBlockText(nextDraft, blockId, node.innerText.trim());
              });
              onDraftChange(nextDraft);
            }}
          >
            <div className="doc-meta" contentEditable={false}>{currentAuthor?.name ?? "Default Style"} · {project.language || "English"} · {isModified ? "Modified" : "Saved locally"}</div>
            {draft.blocks.map((block) => (
              <p
                key={block.id}
                data-block-id={block.id}
                className="doc-paragraph"
              >
                {renderParagraphText(block)}
              </p>
            ))}
            {draftContextMenu ? (
              <div className="outline-context-menu" contentEditable={false} style={{ left: draftContextMenu.left, top: draftContextMenu.top }}>
                <button type="button" onClick={openDraftCommentForSelection}>修改</button>
              </div>
            ) : null}
          </main>

          <aside className="outline-ai-panel draft-ai-panel">
            <div className="profile-panel-head">
              <strong>AI 修改</strong>
              <button className="text-button" type="button" onClick={clearDraftCommentTools}>清空</button>
            </div>
            <p className="ai-panel-hint">
              {draftCommentOpen && selectedRange
                ? "已选中正文内容。在 comment 里写下你想怎么改，然后点击发送。"
                : draftCommentOpen
                  ? "已选中全文正文。写下整体修改意见后，点击发送。"
                  : "选中正文里的任意一段文字，点击右键选择「修改」，就可以在这里写 comment 和 AI 互动。"}
            </p>
            {!draftCommentOpen && !selectedRange ? (
              <button className="btn btn-secondary" type="button" onClick={startWholeDraftComment}>
                全文 comment
              </button>
            ) : null}
            {!draftCommentOpen && selectedRange ? (
              <button className="btn btn-secondary" type="button" onClick={openDraftCommentForSelection}>
                修改
              </button>
            ) : null}
            {draftCommentOpen && selectedRange ? (
              <div className="selected-text">
                <strong>Selected text</strong>
                <span>{selectedRange.text}</span>
              </div>
            ) : null}
            {draftCommentOpen ? (
              <div className="outline-comment-tools">
                <label className="field compact-field">
                  <span>Comment</span>
                  <textarea
                    ref={draftCommentRef}
                    className="field-input compact-textarea"
                    value={draftComment}
                    onMouseDown={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      setDraftComment(event.target.value);
                      onAssistantInputChange(event.target.value);
                    }}
                    placeholder="例如：更具体一点；语气更像小红书；加一个转化引导。"
                  />
                </label>
                <button className="btn btn-secondary" onClick={sendDraftComment} disabled={!draftComment.trim()}>
                  发送
                </button>
                {draftCommentHistory.length ? (
                  <div className="comment-history" aria-label="Recent draft comments">
                    {draftCommentHistory.map((comment, index) => (
                      <article className="readonly-comment" key={`${comment}-${index}`}>
                        <span>Comment</span>
                        <p>{comment}</p>
                      </article>
                    ))}
                  </div>
                ) : null}
                {assistantSuggestion ? (
                  <div className="inline-ai-suggestion outline-suggestion">
                    <div className="profile-panel-head">
                      <strong>建议版本</strong>
                      <button className="text-button" type="button" onClick={onCancelAssistant}>取消</button>
                    </div>
                    <DraftDiffPreview before={assistantSuggestion.before} after={assistantSuggestion.draft} />
                    <button className="btn btn-primary" type="button" onClick={onApplyAssistant}>应用到正文</button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="sidebar-card draft-info-card">
              <h3>Document</h3>
              <div className="info-row"><span>Words</span><strong>{countWords(draftPlainText(draft))}</strong></div>
              <div className="info-row"><span>Version</span><strong>v{draft.version}</strong></div>
              <div className="info-row"><span>Style</span><strong>{currentAuthor?.name ?? "Default"}</strong></div>
              {canUndo ? <div className="info-row"><span>Last AI edit</span><strong>{lastEditType === "full_rewrite" ? "Full draft" : "Selected text"}</strong></div> : null}
            </div>
            {lastExport ? <ExportReceiptCard receipt={lastExport} onDownloadAgain={onExportCurrentFormat} /> : null}
          </aside>
        </div>
      </section>
    </div>
  );
}

function renderParagraphText(block: DraftBlock) {
  return block.sentences.map((sentence) => sentence.text).join(" ");
}

function ExportReceiptCard({ receipt, onDownloadAgain }: { receipt: ExportReceipt; onDownloadAgain: () => void }) {
  const [copied, setCopied] = useState(false);
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(receipt.copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="sidebar-card export-receipt">
      <span className="eyebrow">Exported</span>
      <strong>{receipt.filename}</strong>
      <div className="info-row"><span>Format</span><strong>{receipt.format}</strong></div>
      <div className="info-row"><span>Method</span><strong>{receipt.status === "saved" ? "Saved" : "Downloaded"}</strong></div>
      <p><b>{receipt.locationLabel}</b><br />{receipt.detail}</p>
      <button className="btn btn-secondary w-full" onClick={copyText}>
        <Clipboard size={14} />
        {copied ? "Copied text" : "Copy text"}
      </button>
      <button className="btn btn-secondary w-full" onClick={onDownloadAgain}>
        <Download size={14} />
        Download again
      </button>
    </div>
  );
}

function SelectionToolbar({ range, onOpenRevision, onClear }: { range: TextSelectionRange; onOpenRevision: (action: string, instruction?: string) => void; onClear: () => void }) {
  return (
    <div className="selection-toolbar">
      <button onClick={() => onOpenRevision("Rewrite")}>Rewrite</button>
      <button onClick={() => onOpenRevision("Shorten selected")}>Shorten</button>
      <button onClick={() => onOpenRevision("Expand selected")}>Expand</button>
      <button onClick={() => onOpenRevision("Improve")}>Improve</button>
      <button onClick={() => onOpenRevision("Change tone")}>Tone</button>
      <button className="icon-mini" onClick={onClear}><X size={13} /></button>
    </div>
  );
}

function FloatingAIAssistant({ open, input, suggestion, selectedText, onOpenChange, onInputChange, onRun, onApply, onCancel }: {
  open: boolean;
  input: string;
  suggestion: AssistantSuggestion | null;
  selectedText?: string;
  onOpenChange: (open: boolean) => void;
  onInputChange: (value: string) => void;
  onRun: (instruction: string) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  if (!open) {
    return (
      <button className="assistant-fab" onClick={() => onOpenChange(true)}>
        <MessageCircle size={18} />
        AI Assistant
      </button>
    );
  }
  return (
    <section className="assistant-panel">
      <div className="assistant-head">
        <strong>AI Assistant</strong>
        <button className="icon-button" onClick={() => onOpenChange(false)}><X size={14} /></button>
      </div>
      {selectedText ? <div className="selected-note">Selected: {selectedText.slice(0, 90)}{selectedText.length > 90 ? "..." : ""}</div> : null}
      <div className="assistant-presets">
        {assistantPresets.map((preset) => <button key={preset} onClick={() => onRun(preset)}>{preset}</button>)}
      </div>
      {suggestion ? (
        <div className="assistant-preview">
          <span className="eyebrow">Diff preview</span>
          <strong>{suggestion.draft.title}</strong>
          <DraftDiffPreview before={suggestion.before} after={suggestion.draft} />
          <div className="flex gap-2">
            <button className="btn btn-primary flex-1" onClick={onApply}>Apply changes</button>
            <button className="btn btn-secondary" onClick={() => onRun(suggestion.instruction)}><RefreshCw size={14} />Regenerate</button>
            <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          </div>
        </div>
      ) : null}
      <form className="assistant-input" onSubmit={(event) => {
        event.preventDefault();
        onRun(input);
      }}>
        <input value={input} onChange={(event) => onInputChange(event.target.value)} placeholder="Ask AI to revise this draft..." />
        <button type="submit"><Send size={15} /></button>
      </form>
    </section>
  );
}

function DraftDiffPreview({ before, after }: { before: Draft; after: Draft }) {
  const changes = draftDiffItems(before, after);
  if (!changes.length) return <p>No visible text changes. Try regenerating with a stronger instruction.</p>;
  return (
    <div className="draft-diff">
      {changes.slice(0, 3).map((change) => (
        <article key={change.label}>
          <span>{change.label}</span>
          <div className="diff-before">{change.before || "Empty"}</div>
          <div className="diff-after">{change.after || "Empty"}</div>
        </article>
      ))}
      {changes.length > 3 ? <small>+ {changes.length - 3} more changed sections</small> : null}
    </div>
  );
}

function RevisionModal({ revision, onChange, onGenerate, onReplace, onInsertBelow, onClose }: {
  revision: RevisionState;
  onChange: (patch: Partial<RevisionState>) => void;
  onGenerate: () => void;
  onReplace: () => void;
  onInsertBelow: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop revision-backdrop">
      <section className="revision-modal">
        <div className="modal-head">
          <div>
            <span className="eyebrow">Revise</span>
            <h2>{revision.action || "Selected text"}</h2>
          </div>
          <button className="icon-button" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="compare-grid">
          <div><span>Original</span><p>{revision.original}</p></div>
          <div>
            <span>{revision.suggestion ? "AI Suggestion · preview" : "AI Suggestion"}</span>
            <p>{revision.loading ? "Generating..." : revision.suggestion || "Generate a suggestion first."}</p>
          </div>
        </div>
        <textarea className="field-input" value={revision.instruction} onChange={(event) => onChange({ instruction: event.target.value })} placeholder="How should AI revise this sentence?" />
        <div className="quick-chip-row">
          {revisionPresets.map((preset) => <button className="chip" key={preset} onClick={() => onChange({ instruction: preset })}>{preset}</button>)}
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-secondary" onClick={onGenerate} disabled={revision.loading}>{revision.suggestion ? "Try again" : "Generate"}</button>
          <button className="btn btn-secondary" onClick={onInsertBelow} disabled={!revision.suggestion}>Insert below</button>
          <button className="btn btn-primary" onClick={onReplace} disabled={!revision.suggestion}>Replace selected text</button>
        </div>
      </section>
    </div>
  );
}

function ExportFormatModal({ format, onFormatChange, onClose, onConfirm }: { format: ExportFormat; onFormatChange: (format: ExportFormat) => void; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-backdrop">
      <section className="export-modal">
        <div className="modal-head">
          <div><span className="eyebrow">Export</span><h2>Choose format</h2></div>
          <button className="icon-button" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="export-grid">
          {exportFormats.map((item) => (
            <button className={format === item ? "active" : ""} key={item} onClick={() => onFormatChange(item)}>
              <FileText size={18} />
              {item}
            </button>
          ))}
        </div>
        <p className="export-path">AnnaWrite will open a save dialog when the host allows it. If not, the file is sent to the browser download flow.</p>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onConfirm}>Save / Download</button>
        </div>
      </section>
    </div>
  );
}

function SampleModal({ sample, onClose }: { sample: AuthorSample; onClose: () => void }) {
  return (
    <div className="modal-backdrop">
      <section className="sample-modal">
        <div className="modal-head">
          <div><span className="eyebrow">{sample.sourceType}</span><h2>{sample.title}</h2></div>
          <button className="icon-button" onClick={onClose}><X size={16} /></button>
        </div>
        <pre>{sample.content}</pre>
      </section>
    </div>
  );
}
