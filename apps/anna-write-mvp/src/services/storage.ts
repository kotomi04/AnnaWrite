import type {
  Author,
  AuthorSample,
  Draft,
  MaterialType,
  SharedStyleSummary,
  SourceType,
  WritingProject,
} from "../types";
import { createEmptyProject, defaultAuthors, defaultSharedStyleSummary, emptyParameters } from "../data/seed";

const AUTHORS_KEY = "annawrite:authors";
const PROJECT_KEY = "annawrite:current-project";
const PROJECTS_KEY = "annawrite:projects";
const CURRENT_PROJECT_ID_KEY = "annawrite:current-project-id";
const CURRENT_AUTHOR_KEY = "annawrite:current-author";

const retiredPresetIds = new Set([
  "author-anthropic-announcement",
  "author-founder-letter",
  "author-observational-story",
  "author-clean-essay",
  "author-social-editor",
]);

export interface StoredState {
  authors: Author[];
  currentAuthorId: string | null;
  project: WritingProject;
  projects: WritingProject[];
  currentProjectId: string | null;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function stableId(prefix: string, parts: Array<string | undefined>) {
  const value = parts.filter(Boolean).join("|") || prefix;
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return `${prefix}-${hash.toString(36)}`;
}

const sourceToMaterial = (_sourceType: SourceType): MaterialType => "article";

function normalizeSample(sample: AuthorSample): AuthorSample {
  const content = sample.content ?? "";
  const uploadedAt = sample.uploadedAt || new Date().toISOString();
  return {
    ...sample,
    id: sample.id || `sample-${crypto.randomUUID()}`,
    title: sample.title || sample.fileName || sample.sourceUrl || "Untitled material",
    content,
    sourceType: sample.sourceType || "essay",
    materialType: sample.materialType || sourceToMaterial(sample.sourceType || "essay"),
    rawContent: sample.rawContent ?? content,
    status: sample.status || "saved",
    wordCount: sample.wordCount || content.trim().split(/\s+/).filter(Boolean).length,
    uploadedAt,
    updatedAt: sample.updatedAt || uploadedAt,
  };
}

function fallbackSharedStyleSummary(author: Author): SharedStyleSummary {
  const voice = author.parameters?.voiceTone?.length ? author.parameters.voiceTone : defaultSharedStyleSummary.tone;
  const structure = author.parameters?.structureHabits?.length ? author.parameters.structureHabits : defaultSharedStyleSummary.structure;
  const avoidList = author.parameters?.avoidList?.length ? author.parameters.avoidList : defaultSharedStyleSummary.avoidList;
  const doList = author.parameters?.recommendedRules?.length ? author.parameters.recommendedRules : defaultSharedStyleSummary.doList;
  return {
    ...defaultSharedStyleSummary,
    shortSummary: author.styleSummary || author.description || defaultSharedStyleSummary.shortSummary,
    tone: voice.slice(0, 6),
    structure: structure.slice(0, 8),
    avoidList: avoidList.slice(0, 8),
    doList: doList.slice(0, 8),
    promptFragment: author.skillPrompt || defaultSharedStyleSummary.promptFragment,
    updatedAt: author.updatedAt || new Date().toISOString(),
  };
}

function normalizeAuthor(author: Author): Author {
  const createdAt = author.createdAt || new Date().toISOString();
  const updatedAt = author.updatedAt || createdAt;
  const normalized: Author = {
    ...author,
    id: author.id || `author-${crypto.randomUUID()}`,
    name: author.name || "Untitled Style",
    description: author.description || "A reusable writing style.",
    type: author.type || "style",
    styleTags: Array.isArray(author.styleTags) ? author.styleTags.filter(Boolean) : undefined,
    bestFor: Array.isArray(author.bestFor) ? author.bestFor : [],
    samples: Array.isArray(author.samples) ? author.samples.map(normalizeSample) : [],
    styleSummary: author.styleSummary || author.description || "",
    skillPrompt: author.skillPrompt || "",
    parameters: { ...emptyParameters, ...(author.parameters || {}) },
    createdAt,
    updatedAt,
  };
  return {
    ...normalized,
    sharedStyleSummary: author.sharedStyleSummary || fallbackSharedStyleSummary(normalized),
  };
}

function normalizeDraft(draft: Draft, fallbackId?: string): Draft {
  const createdAt = draft.createdAt || new Date().toISOString();
  const updatedAt = draft.updatedAt || createdAt;
  const blockText = Array.isArray(draft.blocks) ? draft.blocks.map((block) => block.text).join("\n") : "";
  return {
    ...draft,
    id: draft.id || fallbackId || stableId("draft", [draft.title, blockText, createdAt]),
    title: draft.title || "Untitled draft",
    blocks: Array.isArray(draft.blocks) ? draft.blocks : [],
    version: draft.version || 1,
    createdAt,
    updatedAt,
  };
}

function normalizeProject(project: WritingProject, authors: Author[], fallbackAuthorId: string | null): WritingProject {
  const base = createEmptyProject(fallbackAuthorId);
  const merged = {
    ...base,
    ...project,
    commercialSettings: { ...base.commercialSettings, ...(project.commercialSettings || {}) },
    currentEventSettings: { ...base.currentEventSettings, ...(project.currentEventSettings || {}) },
    storySettings: { ...base.storySettings, ...(project.storySettings || {}) },
    publishSettings: { ...base.publishSettings, ...(project.publishSettings || {}) },
    requirementCards: Array.isArray(project.requirementCards) ? project.requirementCards : [],
    versions: Array.isArray(project.versions) ? project.versions : [],
  };
  const safeAuthorId = merged.authorId && authors.some((author) => author.id === merged.authorId)
    ? merged.authorId
    : fallbackAuthorId;
  const projectId = merged.id || stableId("project", [merged.title, merged.brief, merged.createdAt]);
  return {
    ...merged,
    id: projectId,
    authorId: safeAuthorId,
    draft: merged.draft ? normalizeDraft(merged.draft, `${projectId}-draft`) : null,
    createdAt: merged.createdAt || new Date().toISOString(),
    updatedAt: merged.updatedAt || merged.createdAt || new Date().toISOString(),
  };
}

function hasProjectContent(project: WritingProject) {
  return Boolean(
    project.brief.trim() ||
    project.requirementCards.length ||
    project.draft?.blocks.length ||
    (project.title && project.title !== "Untitled writing")
  );
}

export function loadStoredState(): StoredState {
  const storedAuthors = readJson<Author[] | null>(AUTHORS_KEY, null);
  const defaultIds = new Set(defaultAuthors.map((author) => author.id));
  const userAuthors = storedAuthors
    ? storedAuthors.filter((author) => !retiredPresetIds.has(author.id) && !defaultIds.has(author.id))
    : [];
  const authors = [...defaultAuthors, ...userAuthors].map(normalizeAuthor);
  const storedCurrentAuthorId = readJson<string | null>(CURRENT_AUTHOR_KEY, null);
  const currentAuthorId = authors.some((author) => author.id === storedCurrentAuthorId)
    ? storedCurrentAuthorId
    : defaultAuthors[0]?.id ?? null;

  const currentProjectId = readJson<string | null>(CURRENT_PROJECT_ID_KEY, null);
  const hasStoredCurrentProject = localStorage.getItem(PROJECT_KEY) !== null;
  const rawProject = readJson<WritingProject>(PROJECT_KEY, createEmptyProject(currentAuthorId));
  const rawProjects = readJson<WritingProject[]>(PROJECTS_KEY, []);
  const normalizedProject = normalizeProject(rawProject, authors, currentAuthorId);
  const byId = new Map<string, WritingProject>();
  [
    ...(hasStoredCurrentProject || hasProjectContent(normalizedProject) ? [normalizedProject] : []),
    ...rawProjects.map((item) => normalizeProject(item, authors, currentAuthorId)),
  ]
    .sort((first, second) => new Date(second.updatedAt).getTime() - new Date(first.updatedAt).getTime())
    .forEach((item) => byId.set(item.id, item));
  const projects = Array.from(byId.values());
  const selectedProject = projects.find((item) => item.id === currentProjectId) ?? projects[0] ?? normalizedProject;

  return {
    authors,
    currentAuthorId,
    project: selectedProject,
    projects,
    currentProjectId: selectedProject.id,
  };
}

export function saveAuthors(authors: Author[]) {
  localStorage.setItem(AUTHORS_KEY, JSON.stringify(authors));
}

export function saveCurrentAuthor(authorId: string | null) {
  localStorage.setItem(CURRENT_AUTHOR_KEY, JSON.stringify(authorId));
}

export function saveProject(project: WritingProject) {
  localStorage.setItem(PROJECT_KEY, JSON.stringify(project));
}

export function saveProjects(projects: WritingProject[]) {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
}

export function saveCurrentProjectId(projectId: string | null) {
  localStorage.setItem(CURRENT_PROJECT_ID_KEY, JSON.stringify(projectId));
}

export function clearStoredState() {
  localStorage.removeItem(AUTHORS_KEY);
  localStorage.removeItem(PROJECT_KEY);
  localStorage.removeItem(PROJECTS_KEY);
  localStorage.removeItem(CURRENT_PROJECT_ID_KEY);
  localStorage.removeItem(CURRENT_AUTHOR_KEY);
}
