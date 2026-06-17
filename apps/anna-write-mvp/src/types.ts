export type Stage = "brief" | "requirements" | "draft" | "publish" | "home" | "editor";

export type ViewMode = Stage | "authors" | "styles";

export type Priority = "high" | "medium" | "low";

export type SourceType =
  | "article"
  | "story"
  | "essay"
  | "wechat"
  | "newsletter"
  | "chapter"
  | "other";

export type MaterialType = "link" | "file" | "article" | "html";

export type MaterialStatus = "saved" | "fetching" | "extracted" | "failed";

export interface SharedStyleSummary {
  shortSummary: string;
  tone: string[];
  structure: string[];
  sentencePatterns: string[];
  vocabulary: string[];
  techniques: string[];
  doList: string[];
  avoidList: string[];
  promptFragment: string;
  updatedAt: string;
}

export interface AuthorSample {
  id: string;
  title: string;
  content: string;
  sourceType: SourceType;
  materialType?: MaterialType;
  sourceUrl?: string;
  fileName?: string;
  rawContent?: string;
  status?: MaterialStatus;
  error?: string;
  wordCount: number;
  uploadedAt: string;
  updatedAt?: string;
  analysisNotes?: string;
}

export interface AuthorParameters {
  structureHabits: string[];
  voiceTone: string[];
  sentenceRhythm: string;
  narrativePerspective: string;
  openingPatterns: string[];
  transitionPatterns: string[];
  emotionCurve: string;
  detailDensity: string;
  dialogueTendency: string;
  imageryMetaphorTendency: string;
  pacingStyle: string;
  topicBoundaries: string[];
  avoidList: string[];
  recommendedRules: string[];
  channelRules: Record<string, string[]>;
}

export interface Author {
  id: string;
  name: string;
  description: string;
  type?: "author" | "style";
  styleTags?: string[];
  bestFor: string[];
  samples: AuthorSample[];
  styleSummary: string;
  skillPrompt: string;
  sharedStyleSummary?: SharedStyleSummary;
  parameters: AuthorParameters;
  createdAt: string;
  updatedAt: string;
}

export interface CommercialSettings {
  promotionalSubject: string;
  titleVisibility: "traffic-first" | "balanced" | "direct";
  contentPromotionRatio: string;
  conversionGoal: string;
}

export interface CurrentEventSettings {
  timeWindow: string;
  sourceLanguageScope: "Chinese" | "English" | "Chinese + English";
  requireSourceLinks: boolean;
  noFabricatedFacts: boolean;
}

export interface StorySettings {
  protagonist: string;
  setting: string;
  conflict: string;
  theme: string;
  endingDirection: string;
  pov: string;
  tense: string;
  genre: string;
  constraints: string;
}

export interface RequirementCard {
  id: string;
  type: string;
  title: string;
  content: string;
  authorLink: string;
  priority: Priority;
  order: number;
  editable: boolean;
}

export interface Sentence {
  id: string;
  text: string;
  selected?: boolean;
}

export interface DraftBlock {
  id: string;
  type: "paragraph" | "heading" | "quote" | "list";
  text: string;
  sentences: Sentence[];
}

export interface Draft {
  id: string;
  title: string;
  blocks: DraftBlock[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EditHistory {
  id: string;
  type: "selected_rewrite" | "full_rewrite";
  before: Draft;
  after: Draft;
  instruction: string;
  timestamp: string;
}

export interface PublishSettings {
  format: "DOCX" | "PDF" | "TXT" | "Markdown" | "HTML";
  documentTitle: string;
  subtitle: string;
  authorNameDisplay: string;
  dateDisplay: string;
  fontFamily: string;
  titleFont: string;
  bodyFont: string;
  titleSize: number;
  bodySize: number;
  lineHeight: number;
  paragraphSpacing: number;
  margins: number;
  headingStyle: string;
  includeMetadata: boolean;
  includeRequirementSummary: boolean;
  includeAuthorStyleNote: boolean;
  includeVersionNumber: boolean;
  preset: string;
}

export interface WritingProject {
  id: string;
  title: string;
  brief: string;
  authorId: string | null;
  writingType: string;
  channel: string;
  audience: string;
  goal: string;
  mustInclude: string;
  avoid: string;
  references: string;
  language: string;
  lengthTarget: string;
  customWordCount: string;
  tone: string;
  outputGoal: string;
  readerEmotionTarget: string;
  intentionType: string;
  commercialSettings: CommercialSettings;
  currentEventSettings: CurrentEventSettings;
  storySettings: StorySettings;
  reviewRequirementsFirst: boolean;
  requirementCards: RequirementCard[];
  requirementTitle: string;
  draft: Draft | null;
  versions: EditHistory[];
  publishSettings: PublishSettings;
  createdAt: string;
  updatedAt: string;
}

export interface RequirementGenerationResult {
  working_title: string;
  core_angle: string;
  cards: RequirementCard[];
}

export interface AuthorAnalysisResult {
  style_summary: string;
  voice: string;
  structure_habits: string[];
  sentence_rhythm: string;
  opening_patterns: string[];
  transition_patterns: string[];
  emotion_curve: string;
  imagery_and_metaphor: string;
  detail_density: string;
  dialogue_style: string;
  pacing: string;
  avoid: string[];
  recommended_rules: string[];
  skill_prompt: string;
}

export interface AuthorProfileGenerationState {
  active: boolean;
  status: string;
  log: string[];
}

export interface SelectionState {
  sentenceIds: string[];
}

export interface TextSelectionRange {
  blockId: string;
  endBlockId?: string;
  blockIds?: string[];
  start: number;
  end: number;
  text: string;
  source?: "sentence" | "native";
  rect?: {
    top: number;
    left: number;
    width: number;
    height: number;
  };
  rects?: Array<{
    top: number;
    left: number;
    width: number;
    height: number;
  }>;
}

export interface ToastMessage {
  id: string;
  tone: "info" | "success" | "warning";
  text: string;
}

export interface LlmTraceEvent {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  input: string;
  output?: string;
  startedAt: string;
  finishedAt?: string;
}
