const TOOL_ID = "tool-qinghuasun-annavisual-brand-mvp-j6sdhjxy";
const AUTO_PLATFORM = "Auto";
const BRAND_STORAGE_KEY = "annaVisualBrandMvp.brands.v2";
const DESIGNER_STORAGE_KEY = "annaVisualBrandMvp.designers.v2";
const GENERATION_STORAGE_KEY = "annaVisualBrandMvp.generations.v2";
const SETTINGS_STORAGE_KEY = "annaVisualBrandMvp.settings.v2";
const PPT_MASTER_RULES = [
  "Output a direct front-facing full-frame 16:9 slide canvas, not a photo of a screen.",
  "No audience, room, projector, conference setting, monitor frame, or stage.",
  "Keep control-plane metadata invisible: do not render labels such as 16:9, page role, theme, version, or anchor id.",
  "Visible text must be content-plane only. For dense exact copy, use background-first generation and separate typography composition.",
  "Preserve a stable title zone, module/card logic, spacing rhythm, and deck-family typography.",
];
const IMAGE_GENERATION_TIMEOUT_MS = 180000;
const IMAGE_AUTOGEN_TIMEOUT_MS = 90000;
const PREVIEW_IMAGE_TIMEOUT_MS = 30000;

const $ = (selector) => document.querySelector(selector);
const page = $("#page");
const toasts = $("#toasts");

const state = {
  view: "image",
  stage: "brief",
  runtime: null,
  runtimeReady: false,
  capabilities: {
    llmReading: "unknown",
    imageGeneration: "unknown",
    imageEdit: "unknown",
    storage: "browser fallback",
    executaBridge: "unknown",
    mode: "Anna Chat Package Mode",
    note: "Checking runtime capabilities...",
  },
  brands: [],
  designers: [],
  generations: [],
  activeBrandId: "",
  activeDesignerId: "",
  selectedDirectionId: "",
  activeContextPanel: "",
  latestPackage: null,
  latestPrompt: "",
  latestEvidence: null,
  latestGeneratedImage: null,
  imageGenerationStatus: "idle",
  imageGenerationError: "",
  imageEditPrompt: "",
  generatedPreviews: {},
  previewStatus: {},
  previewErrors: {},
  autoGenerateFinalImage: true,
  loadingTitle: "",
  loadingDetail: "",
  designReading: null,
  designReadingStatus: "idle",
  designReadingFingerprint: "",
  designReadingRunId: 0,
  readingMode: "fast",
  brandDraftFiles: [],
  imageDraftFiles: [],
  generationEvidence: null,
  imageRequest: "",
  visualType: "Social",
  platform: AUTO_PLATFORM,
  size: "4:5",
  format: "PNG",
  visualChoices: {
    layout: "centered_hero",
    structure: "abstract_symbol",
    finish: "soft_matte",
  },
  directionEdits: {},
};

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

function compactText(value, max = 140) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trim()}...` : text;
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function toast(message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  toasts.appendChild(node);
  window.setTimeout(() => node.remove(), 2600);
}

function setRuntimeStatus(text) {
  const el = $("#runtimeStatus");
  if (el) el.textContent = text;
}

function getAnnaRuntime() {
  return window.anna || null;
}

function isDirectDevEntry() {
  return window.parent === window && location.pathname.includes("/anna-apps/");
}

function localHarnessUrl() {
  return `${location.origin}/`;
}

function hasHostImageGenerateApi() {
  const anna = getAnnaRuntime();
  return Boolean(anna?.image?.generate || anna?.host?.image?.generate || anna?.host_api?.image?.generate || anna?.llm?.image?.generate || anna?.call);
}

function hasHostImageEditApi() {
  const anna = getAnnaRuntime();
  return Boolean(anna?.image?.edit || anna?.host?.image?.edit || anna?.host_api?.image?.edit || anna?.llm?.image?.edit || anna?.call);
}

function refreshCapabilities(patch = {}) {
  const anna = getAnnaRuntime();
  const previous = state.capabilities || {};
  const llmReading = anna?.llm?.complete ? "available" : "unavailable";
  const storage = anna?.storage?.get && anna?.storage?.set ? "Anna storage" : "browser fallback";
  const imageGeneration = patch.imageGeneration
    || (previous.imageGeneration === "granted" ? "granted" : hasHostImageGenerateApi() ? "available" : "not granted");
  const imageEdit = patch.imageEdit
    || (previous.imageEdit === "granted" ? "granted" : hasHostImageEditApi() ? "available" : "not granted");
  const executaBridge = patch.executaBridge
    || previous.executaBridge
    || (anna?.tools?.invoke ? "v1 or unknown" : "unavailable");
  const live = imageGeneration === "granted" || imageGeneration === "available";
  state.capabilities = {
    llmReading,
    imageGeneration,
    imageEdit,
    storage,
    executaBridge,
    mode: live ? "Live Generate Mode" : "Anna Chat Package Mode",
    note: patch.note || (live
      ? "This runtime exposes an image generation entrypoint. If grant is approved, the MVP can generate inside the app."
      : "Direct image generation is not exposed here. The app will prepare a prompt/JSON package for Anna chat."),
  };
}

function isLiveGenerateMode() {
  return state.capabilities?.mode === "Live Generate Mode";
}

function isStrictReadingMode() {
  return state.readingMode === "strict";
}

async function connectRuntime() {
  if (isDirectDevEntry()) {
    setRuntimeStatus("Open harness");
    refreshCapabilities({
      note: "This app is opened directly. Open the local dev harness so it can inject LLM, storage, tools, and runtime bridge access.",
    });
    return null;
  }
  if (!window.AnnaAppRuntime) {
    setRuntimeStatus("No SDK");
    refreshCapabilities({ note: "Running without Anna SDK. Using browser fallback mode." });
    return null;
  }
  try {
    state.runtime = await window.AnnaAppRuntime.connect();
    window.anna = state.runtime;
    state.runtimeReady = true;
    setRuntimeStatus("Anna AI Ready");
    refreshCapabilities();
    await loadAllStorage();
    render();
    return state.runtime;
  } catch (error) {
    console.warn("Anna runtime connect failed", error);
    setRuntimeStatus("Local fallback");
    refreshCapabilities({ note: "Anna runtime connection failed. Using browser fallback mode." });
    return null;
  }
}

async function annaStorageGet(key) {
  const storage = getAnnaRuntime()?.storage;
  if (!storage?.get) return null;
  try {
    const result = await storage.get({ key });
    return result?.value ?? result ?? null;
  } catch (error) {
    try {
      const result = await storage.get(key);
      return result?.value ?? result ?? null;
    } catch (_) {
      return null;
    }
  }
}

async function annaStorageSet(key, value) {
  const storage = getAnnaRuntime()?.storage;
  if (!storage?.set) return false;
  try {
    await storage.set({ key, value });
    return true;
  } catch (error) {
    try {
      await storage.set(key, value);
      return true;
    } catch (_) {
      return false;
    }
  }
}

function readLocalJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function normalizeStoredJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function parseJsonFromText(text, fallback = null) {
  const raw = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    try {
      return JSON.parse(match[0]);
    } catch (__) {
      return fallback;
    }
  }
}

function writeLocalJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
  annaStorageSet(key, value);
}

async function loadAllStorage() {
  const localBrands = readLocalJson(BRAND_STORAGE_KEY, null);
  const localDesigners = readLocalJson(DESIGNER_STORAGE_KEY, null);
  const localGenerations = readLocalJson(GENERATION_STORAGE_KEY, null);
  const localSettings = readLocalJson(SETTINGS_STORAGE_KEY, null);
  const remoteBrands = await annaStorageGet(BRAND_STORAGE_KEY);
  const remoteDesigners = await annaStorageGet(DESIGNER_STORAGE_KEY);
  const remoteGenerations = await annaStorageGet(GENERATION_STORAGE_KEY);
  const remoteSettings = await annaStorageGet(SETTINGS_STORAGE_KEY);

  const brandData = normalizeStoredJson(remoteBrands, null) || localBrands || {};
  const designerData = normalizeStoredJson(remoteDesigners, null) || localDesigners || {};
  const generationData = normalizeStoredJson(remoteGenerations, null) || localGenerations || {};
  const settingsData = normalizeStoredJson(remoteSettings, null) || localSettings || {};

  state.brands = Array.isArray(brandData.brands) ? brandData.brands : [];
  state.designers = Array.isArray(designerData.designers) ? designerData.designers : [];
  state.generations = Array.isArray(generationData.generations) ? generationData.generations : [];
  state.activeBrandId = brandData.active_brand_id || state.brands[0]?.brand_id || "";
  state.activeDesignerId = designerData.active_designer_id || designerForBrand(state.activeBrandId)?.designer_id || "";
  state.readingMode = settingsData.reading_mode === "strict" ? "strict" : "fast";

  if (!state.brands.length) seedDemoData();
  persistAll();
}

function persistAll() {
  writeLocalJson(BRAND_STORAGE_KEY, {
    brands: state.brands,
    active_brand_id: state.activeBrandId,
  });
  writeLocalJson(DESIGNER_STORAGE_KEY, {
    designers: state.designers,
    active_designer_id: state.activeDesignerId,
  });
  writeLocalJson(GENERATION_STORAGE_KEY, {
    generations: state.generations.slice(0, 50),
  });
  writeLocalJson(SETTINGS_STORAGE_KEY, {
    reading_mode: state.readingMode,
  });
}

function seedDemoData() {
  const brand = {
    brand_id: "brand_anna_seed",
    brand_name: "Anna",
    status: "active",
    summary: "Premium soft-tech visual system for product, social, and concept images.",
    brand_profile: {
      description: "Premium soft-tech visual system for product, social, and concept images.",
      keywords: ["Soft-tech", "Premium", "Useful", "Calm"],
      avoid_keywords: ["chaotic", "neon", "generic AI orb", "fake logo"],
    },
    keywords: ["Soft-tech", "Premium", "Useful", "Calm"],
    avoid_keywords: ["chaotic", "neon", "generic AI orb", "fake logo"],
    colors: {
      primary: [
        { name: "Anna Lavender", hex: "#8b7cf8", role: "accent" },
        { name: "Graphite", hex: "#232333", role: "text/depth" },
        { name: "Warm White", hex: "#f7f4ef", role: "background" },
      ],
      secondary: [
        { name: "Soft Mint", hex: "#8bd8bd", role: "support accent" },
        { name: "Pale Violet", hex: "#b9a8ff", role: "surface" },
      ],
      rules: ["Use warm white or pale surfaces as the base.", "Use lavender as a controlled accent, not full-page decoration."],
    },
    logo_rules: [
      "Logo hard constraints: fixed asset overlay only.",
      "no recolored logo",
      "no stretched logo",
      "no rotated logo",
      "no generated logo",
      "no fake brand assets",
    ],
    logo_rule_detail: {
      policy: "fixed_asset_overlay",
      allowed: ["use approved logo as a separate overlay", "preserve clear space and aspect ratio"],
      forbidden: ["do not recolor", "do not stretch", "do not rotate", "do not redraw", "do not approximate"],
    },
    typography: {
      english: "Modern geometric sans, bold headline, compact labels.",
      chinese: "Clean sans-serif with strong hierarchy.",
    },
    visual_style: {
      tone: "calm, product-native, premium, useful",
      composition: "single focal system with balanced breathing room",
      materials_lighting: "soft glass, matte panels, gentle gradients, diffused shadows",
      transferable_rules: ["keep a clear focal hierarchy", "use source palette roles", "preserve quiet product-native spacing"],
      do_not_copy: ["do not copy exact uploaded layouts", "do not render logo or mascot inside the image model"],
    },
    visual_evidence_digest: {
      style_dna: ["calm product-native surfaces", "controlled lavender accent", "soft-tech depth"],
      composition_dna: ["single focal system", "balanced breathing room", "clear overlay zones without blank-looking voids"],
      materials_lighting: ["soft glass", "matte panels", "diffused shadows"],
      transfer_rules: ["keep focal hierarchy clear", "use source palette roles", "preserve quiet product-native spacing"],
      do_not_copy: ["do not copy exact uploaded layouts", "do not render logo or mascot inside the image model"],
      image_specific_observations: [],
    },
    references: [],
    source_assets: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const designer = {
    designer_id: "designer_anna_mira_seed",
    brand_id: brand.brand_id,
    name: "Mira",
    role: "Minimal Tech Designer",
    type: "social_media",
    platform: AUTO_PLATFORM,
    creative_intent: "Clean product-led compositions with calm space and restrained lavender accents.",
    style_bias: {
      composition: "spacious hero layouts",
      density: "low_to_medium",
      abstraction: "semi-abstract product metaphor",
      materials: ["soft glass", "matte panels", "light UI surfaces"],
      typography: "bold headline, minimal supporting copy",
      visual_metaphor: "connect cloud intelligence with local work surfaces, not a generic AI orb",
    },
    allowed_deviation: {
      colors: "brand palette only",
      logo: "fixed overlay only",
      layout: "can vary",
      visual_metaphor: "can vary within Brand rules",
    },
    hard_constraints: {
      cannot_change_logo_rules: true,
      cannot_make_banned_colors_primary: true,
      cannot_generate_logo_or_mascot: true,
      allowed_controls: ["composition", "visual metaphor", "abstraction", "information density", "platform expression", "material mood", "typography hierarchy"],
    },
    examples: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  state.brands = [brand];
  state.designers = [designer];
  state.activeBrandId = brand.brand_id;
  state.activeDesignerId = designer.designer_id;
}

function brand(id = state.activeBrandId) {
  return state.brands.find((item) => item.brand_id === id) || null;
}

function designersForBrand(brandId = state.activeBrandId) {
  return state.designers.filter((designer) => designer.brand_id === brandId);
}

function designerForBrand(brandId = state.activeBrandId) {
  return designersForBrand(brandId)[0] || null;
}

function designer(id = state.activeDesignerId) {
  const current = state.designers.find((item) => item.designer_id === id);
  if (current && current.brand_id === state.activeBrandId) return current;
  return designerForBrand(state.activeBrandId);
}

function selectedDesignerForForm() {
  if (!state.activeDesignerId) return null;
  return state.designers.find((item) => item.designer_id === state.activeDesignerId && item.brand_id === state.activeBrandId) || null;
}

async function invokeTool(method, args = {}, options = {}) {
  const anna = getAnnaRuntime();
  if (anna?.tools?.invoke) {
    try {
      return await Promise.race([
        anna.tools.invoke({ tool_id: TOOL_ID, method, args, timeoutMs: options.timeoutMs }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`tools.invoke timed out after ${options.timeoutMs || 5000}ms`)), options.timeoutMs || 5000)),
      ]);
    } catch (error) {
      console.warn("Tool unavailable, using local fallback", error);
      if (!options.silent) toast("Tool unavailable. Using local fallback.");
    }
  }
  return null;
}

async function aiComplete(prompt, systemPrompt, options = {}) {
  const anna = getAnnaRuntime();
  if (!anna?.llm?.complete) return null;
  try {
    const result = await Promise.race([
      anna.llm.complete({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: options.temperature ?? 0.25,
        max_tokens: options.max_tokens ?? 1600,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("llm.complete timed out")), options.timeout_ms ?? 22000)),
    ]);
    return result?.content?.text || result?.content || result?.text || "";
  } catch (error) {
    console.warn("LLM unavailable", error);
    return null;
  }
}

async function aiCompleteWithImages(prompt, systemPrompt, imageDataUrls = [], options = {}) {
  const anna = getAnnaRuntime();
  const images = (imageDataUrls || []).filter(Boolean).slice(0, 4);
  if (!anna?.llm?.complete || !images.length) return aiComplete(prompt, systemPrompt, options);
  const content = [
    { type: "text", text: prompt },
    ...images.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
  try {
    const result = await Promise.race([
      anna.llm.complete({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content },
        ],
        temperature: options.temperature ?? 0.2,
        max_tokens: options.max_tokens ?? 2200,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("multimodal llm.complete timed out")), options.timeout_ms ?? 18000)),
    ]);
    return result?.content?.text || result?.content || result?.text || "";
  } catch (error) {
    console.warn("Multimodal LLM unavailable; falling back to extracted evidence", error);
    return aiComplete(prompt, systemPrompt, options);
  }
}

function render() {
  $("#imageNav").classList.toggle("active", state.view === "image");
  $("#brandNav").classList.toggle("active", state.view === "brand");
  $("#designerNav").classList.toggle("active", state.view === "designer");
  if (state.view === "brand") renderBrandStudio();
  else if (state.view === "designer") renderDesignerStudio();
  else renderImageStudio();
  bindRuntimeHintEvents();
}

function progress() {
  const steps = ["Brief", "Visual Choices", "Direction", "Package"];
  const active = state.stage === "refine" ? 1 : state.stage === "direction" ? 2 : state.stage === "package" ? 3 : 0;
  return `<div class="progress">${steps.map((step, index) => `<span class="${index === active ? "on" : ""}"><b>${index + 1}</b>${step}</span>`).join("")}</div>`;
}

function capabilityTone(value) {
  const text = String(value || "").toLowerCase();
  if (/(available|granted|anna storage|v2|ready)/.test(text)) return "ok";
  if (/(unknown|fallback|v1)/.test(text)) return "warn";
  return "bad";
}

function renderCapabilityPanel(compact = false) {
  refreshCapabilities();
  const caps = state.capabilities;
  const items = [
    ["LLM reading", caps.llmReading],
    ["Image generation", caps.imageGeneration],
    ["Image edit", caps.imageEdit],
    ["Storage", caps.storage],
    ["Executa bridge", caps.executaBridge],
  ];
  return `
    <article class="capability-panel ${compact ? "compact" : ""}">
      <div class="capability-head">
        <div>
          <b>${escapeHtml(caps.mode)}</b>
          <span>${escapeHtml(caps.note)}</span>
        </div>
        <span class="mode-pill ${caps.mode === "Live Generate Mode" ? "live" : "package"}">${caps.mode === "Live Generate Mode" ? "Live" : "Chat Package"}</span>
      </div>
      <div class="capability-grid">
        ${items.map(([label, value]) => `
          <div class="capability-item ${capabilityTone(value)}">
            <span>${escapeHtml(label)}</span>
            <b>${escapeHtml(value)}</b>
          </div>
        `).join("")}
      </div>
      ${isDirectDevEntry() ? `
        <div class="runtime-fix">
          <div>
            <b>Runtime bridge is missing</b>
            <span>You are inside the app iframe URL. Open the dev harness root so the parent page can provide LLM and storage APIs.</span>
          </div>
          <button class="soft" data-open-harness="true">Open localhost harness</button>
        </div>
      ` : ""}
    </article>
  `;
}

function renderReadingModePanel(compact = false) {
  const strict = isStrictReadingMode();
  const llmAvailable = Boolean(getAnnaRuntime()?.llm?.complete);
  return `
    <article class="reading-mode-panel ${compact ? "compact" : ""}">
      <div class="reading-mode-copy">
        <b>Reading mode</b>
        <span>${strict
          ? llmAvailable
            ? "Strict waits for a complete LLM design reading before Visual Choices, Direction, and Package."
            : "Strict needs Anna runtime LLM access. Local fallback cannot enter the next step in Strict mode."
          : "Fast uses local source evidence immediately, then lets LLM improve the reading in the background."}</span>
      </div>
      <div class="reading-mode-toggle">
        <button class="${!strict ? "active" : ""}" data-reading-mode="fast">
          <b>Fast Mode</b>
          <span>quick first result</span>
        </button>
        <button class="${strict ? "active" : ""}" data-reading-mode="strict">
          <b>Strict LLM Mode</b>
          <span>${llmAvailable ? "wait for full LLM" : "needs Anna runtime"}</span>
        </button>
      </div>
    </article>
  `;
}

function bindReadingModeEvents() {
  page.querySelectorAll("[data-reading-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextMode = button.dataset.readingMode === "strict" ? "strict" : "fast";
      if (state.readingMode === nextMode) return;
      state.readingMode = nextMode;
      state.designReadingStatus = "idle";
      state.designReadingFingerprint = "";
      state.generatedPreviews = {};
      state.previewStatus = {};
      state.previewErrors = {};
      persistAll();
      render();
      toast(nextMode === "strict" ? "Strict LLM Mode enabled." : "Fast Mode enabled.");
    });
  });
}

function bindRuntimeHintEvents() {
  page.querySelectorAll("[data-open-harness]").forEach((button) => {
    button.addEventListener("click", () => {
      window.location.href = localHarnessUrl();
    });
  });
}

function swatches(colors = []) {
  return `<div class="swatches">${colors.slice(0, 5).map((item) => `<span class="swatch" title="${escapeHtml(item.hex || item)}" style="background:${escapeHtml(item.hex || item)}"></span>`).join("")}</div>`;
}

function paletteForBrand(item) {
  return [...(item?.colors?.primary || []), ...(item?.colors?.secondary || [])];
}

function normalizeHex(value) {
  const raw = typeof value === "string" ? value : value?.hex;
  const hex = String(raw || "").trim();
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex : "";
}

function uniqueHexList(values = []) {
  const seen = new Set();
  return values
    .map(normalizeHex)
    .filter(Boolean)
    .filter((hex) => {
      const key = hex.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function currentVisualPalette() {
  const evidenceColors = [
    ...(state.generationEvidence?.palette || []),
    ...((state.generationEvidence?.images || []).flatMap((image) => (image.palette || []).map((color) => color.hex))),
  ];
  const brandColors = paletteForBrand(brand()).map((item) => item.hex);
  const latestBrandEvidence = state.latestEvidence?.palette || [];
  const merged = uniqueHexList([...evidenceColors, ...brandColors, ...latestBrandEvidence]);
  return (merged.length ? merged : ["#f7f4ef", "#232333", "#8b7cf8", "#94d9c1", "#ffffff"]).slice(0, 6);
}

function thumbPalette(offset = 0, colors = currentVisualPalette()) {
  const palette = uniqueHexList(colors);
  const fallback = ["#f7f4ef", "#232333", "#8b7cf8", "#94d9c1"];
  const source = palette.length ? palette : fallback;
  return [0, 1, 2, 3].map((step) => source[(offset + step) % source.length] || fallback[step]);
}

function focusPoint(region = state.generationEvidence?.images?.[0]?.advanced_visual_metrics?.visual_focus_region || "center") {
  const points = {
    "top-left": ["24%", "22%"],
    "top-center": ["50%", "20%"],
    "top-right": ["76%", "22%"],
    "middle-left": ["24%", "50%"],
    center: ["50%", "50%"],
    "middle-right": ["76%", "50%"],
    "bottom-left": ["24%", "78%"],
    "bottom-center": ["50%", "80%"],
    "bottom-right": ["76%", "78%"],
  };
  return points[region] || points.center;
}

function inferMotifsFromRequest(text = state.imageRequest) {
  const source = String(text || "").toLowerCase();
  const motifs = [];
  if (/browser|web|网址|网页|浏览器/.test(source)) motifs.push("browser");
  if (/file|workspace|local|desktop|文件|本地|工作区/.test(source)) motifs.push("file");
  if (/word|document|doc|docs|文档/.test(source)) motifs.push("doc");
  if (/security|secure|safe|legal|law|安全|法律/.test(source)) motifs.push("shield");
  if (/ai|agent|anna|claude|模型|智能/.test(source)) motifs.push("ai");
  if (/post|linkedin|x|social|社媒/.test(source)) motifs.push("social");
  if (/workflow|process|flow|流程/.test(source)) motifs.push("workflow");
  return motifs.length ? motifs.slice(0, 4) : ["brand", "focus"];
}

function activeDesignReading() {
  return state.designReading || buildFallbackDesignReading();
}

function activeMotifs() {
  return (activeDesignReading()?.visual_motifs || inferMotifsFromRequest()).slice(0, 4);
}

function classToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function currentThumbEvidence() {
  return state.generationEvidence?.images?.[0] || state.latestEvidence?.images?.[0] || null;
}

function thumbKind(variant, visual) {
  const token = classToken(variant);
  if (token.includes("reference")) return "reference";
  if (token.includes("designer")) return "designer";
  if (token.includes("platform")) return "platform";
  if (token.includes("direction_a")) return "reference";
  if (token.includes("direction_b")) return "designer";
  if (token.includes("direction_c")) return "platform";
  if (token.includes("centered_hero")) return "centered";
  if (token.includes("split_editorial")) return "split";
  if (token.includes("modular_grid")) return "modules";
  if (token.includes("abstract_symbol")) return "symbol";
  if (token.includes("product_scene")) return "scene";
  if (token.includes("ui_collage")) return "collage";
  if (token.includes("glass_light")) return "glass";
  if (token.includes("paper_grain")) return "paper";
  if (token.includes("soft_matte")) return "matte";
  if (visual === "grid") return "collage";
  if (visual === "poster") return "split";
  if (visual === "hero") return "symbol";
  return "scene";
}

function densityAlpha(evidence = currentThumbEvidence()) {
  const density = evidence?.advanced_visual_metrics?.density_grid_3x3 || [];
  const maxDensity = Math.max(...density, 32);
  return (0.14 + Math.min(100, maxDensity) / 260).toFixed(2);
}

function thumbLayers(kind) {
  const commonMarks = '<div class="source-marks"><i></i><i></i><i></i></div>';
  const layers = {
    centered: `
      <div class="semantic-layer centered-layer">
        <span class="safe-zone"></span><span class="hero-core"></span><span class="hero-ring"></span><span class="hero-shadow"></span>
      </div>${commonMarks}
    `,
    split: `
      <div class="semantic-layer split-layer">
        <span class="copy-zone"><i></i><i></i><i></i></span><span class="image-zone"></span><span class="split-divider"></span>
      </div>${commonMarks}
    `,
    modules: `
      <div class="semantic-layer modules-layer">
        <span></span><span></span><span></span><span></span><span></span><span></span>
      </div>${commonMarks}
    `,
    symbol: `
      <div class="semantic-layer symbol-layer">
        <span class="symbol-orbit"></span><span class="symbol-core"></span><span class="symbol-cut"></span>
      </div>${commonMarks}
    `,
    scene: `
      <div class="semantic-layer scene-layer">
        <span class="scene-window"></span><span class="scene-object"></span><span class="scene-floor"></span><span class="scene-connector"></span>
      </div>${commonMarks}
    `,
    collage: `
      <div class="semantic-layer collage-layer">
        <span class="window main"><i></i><i></i><i></i></span><span class="window side"></span><span class="window chip"></span>
      </div>${commonMarks}
    `,
    matte: `
      <div class="semantic-layer matte-layer">
        <span class="material-slab"></span><span class="material-soft"></span><span class="matte-shadow"></span>
      </div>${commonMarks}
    `,
    glass: `
      <div class="semantic-layer glass-layer">
        <span class="glass-pane a"></span><span class="glass-pane b"></span><span class="glass-highlight"></span>
      </div>${commonMarks}
    `,
    paper: `
      <div class="semantic-layer paper-layer">
        <span class="paper-sheet"></span><span class="paper-title"></span><span class="paper-line a"></span><span class="paper-line b"></span>
      </div>${commonMarks}
    `,
    reference: `
      <div class="semantic-layer reference-layer">
        <span class="scan-cell"></span><span class="scan-cell"></span><span class="scan-cell"></span><span class="scan-cell"></span><span class="scan-cell hot"></span><span class="scan-cell"></span><span class="scan-cell"></span><span class="scan-cell"></span><span class="scan-cell"></span>
        <span class="reference-focal"></span>
      </div>${commonMarks}
    `,
    designer: `
      <div class="semantic-layer designer-layer">
        <span class="metaphor-path"></span><span class="designer-symbol"></span><span class="designer-card"></span>
      </div>${commonMarks}
    `,
    platform: `
      <div class="semantic-layer platform-layer">
        <span class="crop-frame"></span><span class="safe-copy"></span><span class="platform-subject"></span><span class="platform-bar"></span>
      </div>${commonMarks}
    `,
  };
  return layers[kind] || layers.scene;
}

function motifLayer(motifs = activeMotifs()) {
  return `<div class="motif-layer">${motifs.slice(0, 4).map((motif, index) => `<span class="motif motif-${escapeHtml(classToken(motif))}" style="--m:${index}"><i></i></span>`).join("")}</div>`;
}

function thumb(config = {}) {
  const colors = thumbPalette(config.offset || 0, config.palette || currentVisualPalette());
  const c1 = config.c1 || colors[0];
  const c2 = config.c2 || colors[1];
  const c3 = config.c3 || colors[2];
  const c4 = config.c4 || colors[3];
  const visual = config.visual || "product";
  const variant = config.variant || visual;
  const kind = thumbKind(variant, visual);
  const evidence = currentThumbEvidence();
  const sourceThumb = config.sourceThumb || evidence?.source_thumb_data_url || "";
  const sourceStyle = sourceThumb ? `background-image:url('${escapeHtml(sourceThumb.replace(/'/g, "%27"))}')` : "";
  const [fx, fy] = focusPoint(config.focusRegion);
  return `
    <div class="thumb semantic-thumb thumb-${escapeHtml(classToken(variant))} thumb-kind-${kind}" style="--c1:${escapeHtml(c1)};--c2:${escapeHtml(c2)};--c3:${escapeHtml(c3)};--c4:${escapeHtml(c4)};--fx:${fx};--fy:${fy};--density:${densityAlpha(evidence)}">
      <div class="source-thumb" style="${sourceStyle}"></div>
      <div class="density-map"></div>
      ${thumbLayers(kind)}
      ${motifLayer(config.motifs || activeMotifs())}
      ${config.caption ? `<span class="thumb-caption">${escapeHtml(compactText(config.caption, 28))}</span>` : ""}
    </div>
  `;
}

function fit(score = 92) {
  return `<div class="fit"><span>Brand fit</span><div class="fit-bar"><span style="width:${Math.max(0, Math.min(100, score))}%"></span></div><b>${score}</b></div>`;
}

function optionButtons(key, options, value) {
  return `<div class="context-options">${options.map((option) => {
    const raw = Array.isArray(option) ? option[0] : option;
    const label = Array.isArray(option) ? option[1] : option;
    return `<button class="mini-option ${raw === value ? "active" : ""}" data-option-key="${escapeHtml(key)}" data-option-value="${escapeHtml(raw)}">${escapeHtml(label)}</button>`;
  }).join("")}</div>`;
}

function contextChip(panel, label, value, important = false) {
  return `<button class="context-chip ${important ? "important" : ""} ${state.activeContextPanel === panel ? "active" : ""}" data-context-panel="${panel}"><span>${escapeHtml(label)}</span>${value ? `- ${escapeHtml(value)}` : ""}</button>`;
}

function renderContextPanel() {
  const currentBrand = brand();
  const currentDesigner = designer();
  const panels = {
    brand: `
      <div class="context-line"><b>Brand</b><p>${escapeHtml(currentBrand?.summary || "Select a Brand first.")}</p>${optionButtons("activeBrandId", state.brands.map((item) => [item.brand_id, item.brand_name]), state.activeBrandId)}</div>
      <div class="context-line"><b>Rules</b><p>${escapeHtml((currentBrand?.logo_rules || []).slice(0, 2).join("; ") || "No rules yet.")}</p><button class="tiny" data-open-view="brand">Open</button></div>
    `,
    designer: `
      <div class="context-line"><b>Designer</b><p>${escapeHtml(currentDesigner?.creative_intent || "Create a Designer from the selected Brand.")}</p>${optionButtons("activeDesignerId", designersForBrand().map((item) => [item.designer_id, item.name]), state.activeDesignerId)}</div>
      <div class="context-line"><b>Boundary</b><p>Designer can change composition and metaphor, but cannot override Brand hard rules.</p><button class="tiny" data-open-view="designer">Open</button></div>
    `,
    type: `<div class="context-line"><b>Type</b><p>Controls output strategy and prompt discipline.</p>${optionButtons("visualType", ["Social", "Poster", "PPT 16:9", "Article Hero", "Product Visual"], state.visualType)}</div>`,
    platform: `<div class="context-line"><b>Platform</b><p>Used for crop and density decisions.</p>${optionButtons("platform", ["LinkedIn", "X", "Website", "Presentation", AUTO_PLATFORM], state.platform)}</div>`,
    size: `<div class="context-line"><b>Size</b><p>Canvas ratio for image model instructions.</p>${optionButtons("size", ["4:5", "1:1", "16:9", "9:16", "Banner"], state.size)}</div>`,
    format: `<div class="context-line"><b>Format</b><p>Export preference and downstream model note.</p>${optionButtons("format", ["PNG", "JPG", "Transparent PNG"], state.format)}</div>`,
  };
  return state.activeContextPanel ? `<div class="context-panel">${panels[state.activeContextPanel] || ""}</div>` : "";
}

function contextSelector() {
  const currentBrand = brand();
  const currentDesigner = designer();
  return `
    <div class="context-label">Generation context</div>
    <div class="context-chips">
      ${contextChip("brand", "Brand", currentBrand?.brand_name || "None", true)}
      ${contextChip("designer", "Designer", currentDesigner?.name || "None", true)}
      ${contextChip("type", "Type", state.visualType)}
      ${contextChip("platform", "Platform", state.platform)}
      ${contextChip("size", "Size", state.size)}
      ${contextChip("format", "Format", state.format)}
    </div>
    ${renderContextPanel()}
  `;
}

function renderImageStudio() {
  if (state.stage === "loading") return renderLoadingStep();
  if (state.stage === "refine") return renderVisualRefine();
  if (state.stage === "direction") return renderDirections();
  if (state.stage === "package") return renderPackage();
  const currentBrand = brand();
  const currentDesigner = designer();
  page.innerHTML = `
    <section class="page">
      ${progress()}
      ${renderCapabilityPanel(true)}
      ${renderReadingModePanel(true)}
      <div class="brief-shell">
        <h2>What visual should Anna create?</h2>
        <p class="description">Select Brand and Designer, add a short goal, then upload any draft or style image you want Anna to read.</p>
        <div class="brief">
          <div class="brief-row">
            <textarea id="imageBrief" placeholder="Short goal, must-say message, hard requirements...">${escapeHtml(state.imageRequest)}</textarea>
            <div class="brief-actions">
              <button class="primary" id="createDirectionsBtn">Start design</button>
              <button class="soft" id="skipDirectionsBtn">Generate package</button>
              <button class="tiny" id="resetImageBtn">Reset</button>
            </div>
          </div>
        </div>
        <article class="reference-panel">
          <div class="reference-copy">
            <b>Design drafts</b>
            <span>Optional. Upload screenshots, posters, layouts, or style references for this image.</span>
          </div>
          <label class="upload-pill">
            <input type="file" id="imageDraftInput" multiple accept="image/*,.pdf" />
            Add images
          </label>
          <div class="evidence-strip" id="imageEvidenceStrip">${renderGenerationEvidence()}</div>
        </article>
        ${state.generationEvidence || state.designReading ? renderDesignReadingPanel("compact") : ""}
        ${contextSelector()}
        <div class="section two">
          <article class="glass profile">
            <div class="profile-top">
              <div class="profile-main">
                <div class="logo" style="--a:${paletteForBrand(currentBrand)[0]?.hex || "#8b7cf8"};--b:${paletteForBrand(currentBrand)[2]?.hex || "#f7f4ef"}"></div>
                <div>
                  <h3>${escapeHtml(currentBrand?.brand_name || "No Brand")}</h3>
                  <p>${escapeHtml(currentBrand?.summary || "Create and confirm a Brand before generating.")}</p>
                </div>
              </div>
              <span class="badge">${escapeHtml(currentBrand?.status || "missing")}</span>
            </div>
            ${swatches(paletteForBrand(currentBrand))}
          </article>
          <article class="glass profile">
            <div class="profile-top">
              <div class="profile-main">
                <div class="logo" style="--a:#c9bcff;--b:#fffaf1"></div>
                <div>
                  <h3>${escapeHtml(currentDesigner?.name || "No Designer")}</h3>
                  <p>${escapeHtml(currentDesigner?.creative_intent || "Create a Designer from the selected Brand.")}</p>
                </div>
              </div>
              <span class="badge">Brand bound</span>
            </div>
            <div class="chips">${(currentDesigner?.style_bias?.materials || ["source-led"]).slice(0, 4).map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div>
          </article>
        </div>
      </div>
    </section>
  `;
  bindImageBrief();
  bindReadingModeEvents();
  bindDesignReadingActions();
}

function renderLoadingStep() {
  page.innerHTML = `
    <section class="page loading-page">
      ${progress()}
      ${renderCapabilityPanel(true)}
      ${renderReadingModePanel(true)}
      <article class="glass loading-card">
        <div class="loading-orb"></div>
        <h2>${escapeHtml(state.loadingTitle || "Preparing visual generation")}</h2>
        <p>${escapeHtml(state.loadingDetail || "Anna is reading the request, source design, Brand, and Designer before showing the next screen.")}</p>
        <div class="loading-rail"><span></span></div>
      </article>
    </section>
  `;
  bindReadingModeEvents();
}

function bindImageBrief() {
  $("#imageBrief")?.addEventListener("input", (event) => {
    state.imageRequest = event.target.value;
  });
  $("#imageDraftInput")?.addEventListener("change", analyzeGenerationDrafts);
  $("#createDirectionsBtn")?.addEventListener("click", createDirections);
  $("#skipDirectionsBtn")?.addEventListener("click", () => generatePackage(null, { autoImage: true }));
  $("#resetImageBtn")?.addEventListener("click", () => {
    state.stage = "brief";
    state.imageRequest = "";
    state.imageDraftFiles = [];
    state.generationEvidence = null;
    state.designReading = null;
    state.designReadingStatus = "idle";
    state.designReadingFingerprint = "";
    state.designReadingRunId += 1;
    state.visualChoices = { layout: "centered_hero", structure: "abstract_symbol", finish: "soft_matte" };
    state.directionEdits = {};
    state.generatedPreviews = {};
    state.previewStatus = {};
    state.previewErrors = {};
    state.latestPackage = null;
    render();
  });
  bindContextEvents();
}

async function analyzeGenerationDrafts(event) {
  state.imageDraftFiles = Array.from(event.target.files || []);
  if (!state.imageDraftFiles.length) {
    state.generationEvidence = null;
    state.designReading = null;
    state.designReadingFingerprint = "";
    state.designReadingStatus = "idle";
    state.designReadingRunId += 1;
    state.generatedPreviews = {};
    state.previewStatus = {};
    state.previewErrors = {};
    render();
    return;
  }
  $("#imageEvidenceStrip").innerHTML = '<span class="muted">Reading image structure...</span>';
  state.generationEvidence = await extractFilesEvidence(state.imageDraftFiles);
  state.designReadingFingerprint = "";
  state.generatedPreviews = {};
  state.previewStatus = {};
  state.previewErrors = {};
  ensureDesignReading("design draft uploaded");
  render();
  toast(`${state.generationEvidence.images.length || state.generationEvidence.files.length} design reference(s) read.`);
}

function renderGenerationEvidence() {
  const evidence = state.generationEvidence;
  if (!evidence) return '<span class="muted">No design draft added yet.</span>';
  const colors = evidence.palette.slice(0, 5).map((hex) => `<span class="swatch tiny-swatch" style="background:${escapeHtml(hex)}"></span>`).join("");
  const first = evidence.images?.[0];
  return `
    <div class="mini-evidence">
      <div>${colors}</div>
      <b>${evidence.files.length} file${evidence.files.length > 1 ? "s" : ""}</b>
      <span>${escapeHtml(first?.advanced_visual_metrics?.visual_focus_region || "style evidence")} · ${escapeHtml(compactText(first?.composition_structure || evidence.composition_structure, 68))}</span>
    </div>
  `;
}

function renderDesignReadingPanel(mode = "compact") {
  const reading = activeDesignReading();
  const material = reading.material_reading || {};
  const intent = reading.user_intent_reading || {};
  const compact = mode === "compact";
  const statusLabel = state.designReadingStatus === "reading"
    ? "LLM is reading the request and uploaded design image before choices"
    : state.designReadingStatus === "strict_failed"
    ? "Strict LLM Mode could not complete. Stay here or switch to Fast Mode."
    : state.designReadingStatus === "enhancing"
    ? "Ready from source evidence; optional LLM refinement is running"
    : reading.source === "llm_design_reading"
      ? "LLM reading applied"
      : "Ready from request, Brand, Designer, and source-image evidence";
  const statusBadge = state.designReadingStatus === "ready"
    ? "llm"
    : state.designReadingStatus === "reading"
      ? "reading"
      : state.designReadingStatus === "strict_failed"
      ? "needs llm"
    : state.designReadingStatus === "enhancing"
      ? "ready"
      : state.designReadingStatus === "idle"
        ? "idle"
        : "ready";
  return `
    <article class="ai-reading ${compact ? "compact" : ""}">
      <div class="ai-reading-head">
        <div>
          <b>AI Design Reading</b>
          <span>${escapeHtml(statusLabel)}</span>
        </div>
        <span class="badge">${escapeHtml(statusBadge)}</span>
      </div>
      <div class="reading-grid">
        <div><strong>Intent</strong><p>${escapeHtml(compactText(intent.goal || state.imageRequest || "No request yet.", compact ? 96 : 160))}</p></div>
        <div><strong>Source style</strong><p>${escapeHtml(compactText(material.composition || material.image_content || "Brand evidence only.", compact ? 96 : 160))}</p></div>
        <div><strong>Color / material</strong><p>${escapeHtml(compactText(material.color_roles || material.material_lighting || "Use Brand palette.", compact ? 96 : 160))}</p></div>
        <div><strong>Transfer</strong><p>${escapeHtml(compactText(listify(material.transferable_rules).join("; ") || material.relevance || "Preserve visual DNA, not exact layout.", compact ? 96 : 160))}</p></div>
      </div>
      ${state.designReadingStatus === "strict_failed" ? `
        <div class="ai-reading-actions">
          <button class="primary" data-fast-continue="true">Switch to Fast and continue</button>
          ${getAnnaRuntime()?.llm?.complete ? '<button class="soft" data-retry-strict="true">Retry Strict LLM</button>' : ""}
        </div>
      ` : ""}
    </article>
  `;
}

function bindDesignReadingActions() {
  page.querySelectorAll("[data-fast-continue]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.readingMode = "fast";
      state.designReadingStatus = "idle";
      state.designReadingFingerprint = "";
      persistAll();
      toast("Fast Mode enabled. Continuing with local evidence.");
      await createDirections();
    });
  });
  page.querySelectorAll("[data-retry-strict]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.designReadingStatus = "idle";
      state.designReadingFingerprint = "";
      render();
      await createDirections();
    });
  });
}

function bindContextEvents() {
  page.querySelectorAll("[data-context-panel]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeContextPanel = state.activeContextPanel === button.dataset.contextPanel ? "" : button.dataset.contextPanel;
      render();
    });
  });
  page.querySelectorAll("[data-option-key]").forEach((button) => {
    button.addEventListener("click", () => {
      updateContext(button.dataset.optionKey, button.dataset.optionValue);
    });
  });
  page.querySelectorAll("[data-open-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.openView;
      state.activeContextPanel = "";
      render();
    });
  });
}

function updateContext(key, value) {
  state[key] = value;
  if (key === "activeBrandId") {
    const nextDesigner = designerForBrand(value);
    state.activeDesignerId = nextDesigner?.designer_id || "";
  }
  state.activeContextPanel = "";
  persistAll();
  render();
}

function requireBrandForGeneration() {
  if (!brand()) {
    toast("Create or select a Brand first.");
    state.view = "brand";
    render();
    return false;
  }
  if (state.activeDesignerId && !designer()) {
    toast("The selected Designer does not belong to this Brand.");
    state.activeDesignerId = "";
    render();
    return false;
  }
  const guard = validateDesignerAgainstBrand(designer(), brand());
  if (!guard.ok) {
    toast(guard.issues[0] || "Designer violates Brand hard rules.");
    state.view = "designer";
    render();
    return false;
  }
  return true;
}

async function createDirections() {
  if (!requireBrandForGeneration()) return;
  state.imageRequest = $("#imageBrief")?.value.trim() || state.imageRequest;
  if (!state.imageRequest && !state.generationEvidence) return toast("Add a short goal or upload a design draft first.");
  state.stage = "loading";
  state.loadingTitle = isStrictReadingMode() ? "Waiting for full LLM reading" : "Preparing your design";
  state.loadingDetail = isStrictReadingMode()
    ? "Strict LLM Mode will not enter Visual Choices until the LLM has fully analyzed the request, source design, Brand, and Designer."
    : "Fast Mode uses local source evidence immediately, then lets the LLM improve the reading in the background.";
  render();
  if (isStrictReadingMode()) {
    const reading = await prepareDesignReading("start design", { strict: true });
    if (!reading) {
      state.stage = "brief";
      state.loadingTitle = "";
      state.loadingDetail = "";
      render();
      return;
    }
  } else {
    ensureDesignReading("start design");
  }
  state.loadingTitle = "Generating the first visual preview";
  state.loadingDetail = "This is a short attempt. If the current Anna runtime has no image grant, the app will continue with a stable fallback.";
  render();
  state.selectedDirectionId = "direction_a";
  await generateCurrentChoicePreview({ silent: true, timeoutMs: 9000 });
  state.stage = "refine";
  state.loadingTitle = "";
  state.loadingDetail = "";
  render();
}

const VISUAL_CHOICE_GROUPS = [
  {
    key: "layout",
    title: "Layout structure",
    options: [
      { id: "centered_hero", title: "Centered Hero", note: "one clear focal image", visual: "product" },
      { id: "split_editorial", title: "Split Editorial", note: "image + message zones", visual: "poster" },
      { id: "modular_grid", title: "Modular Grid", note: "cards and UI rhythm", visual: "grid" },
    ],
  },
  {
    key: "structure",
    title: "Image language",
    options: [
      { id: "abstract_symbol", title: "Abstract Symbol", note: "concept-led, clean", visual: "hero" },
      { id: "product_scene", title: "Product Scene", note: "real workflow feel", visual: "product" },
      { id: "ui_collage", title: "UI Collage", note: "browser/files/system hints", visual: "grid" },
    ],
  },
  {
    key: "finish",
    title: "Surface finish",
    options: [
      { id: "soft_matte", title: "Soft Matte", note: "premium quiet depth", visual: "product" },
      { id: "glass_light", title: "Glass Light", note: "transparent layered glow", visual: "hero" },
      { id: "paper_grain", title: "Paper Grain", note: "editorial texture", visual: "poster" },
    ],
  },
];

function baseChoiceLabel(key, value = state.visualChoices[key]) {
  const group = VISUAL_CHOICE_GROUPS.find((item) => item.key === key);
  return group?.options.find((option) => option.id === value)?.title || value;
}

function choiceGuidance(key, optionOrValue) {
  const id = typeof optionOrValue === "string" ? optionOrValue : optionOrValue?.id;
  return activeDesignReading()?.visual_choice_guidance?.[key]?.[id] || null;
}

function choiceLabel(key, value = state.visualChoices[key]) {
  return choiceGuidance(key, value)?.label || baseChoiceLabel(key, value);
}

function designReadingFingerprint() {
  return JSON.stringify({
    request: state.imageRequest,
    brand: state.activeBrandId,
    designer: state.activeDesignerId,
    files: (state.generationEvidence?.files || []).map((file) => `${file.file_name}:${file.size_kb}`),
    choices: state.visualChoices,
  });
}

function buildFallbackDesignReading() {
  const currentBrand = brand();
  const currentDesigner = designer();
  const evidence = state.generationEvidence;
  const first = evidence?.images?.[0];
  const request = state.imageRequest || "the current image task";
  const motifs = inferMotifsFromRequest(request);
  const materialSummary = first
    ? `${first.screen_content}; ${first.composition_structure}; ${first.color_proportion}; ${first.materials_lighting}`
    : summarizeEvidenceDigest(currentBrand?.visual_evidence_digest) || currentBrand?.summary || "No uploaded design draft yet.";
  const choiceBase = {
    layout: {
      centered_hero: { label: motifs.includes("browser") ? "Centered Browser Hero" : "Centered Hero", reason: `Put the main visual metaphor for "${compactText(request, 48)}" into one controlled focal point using ${first?.advanced_visual_metrics?.visual_focus_region || "brand"} rhythm.` },
      split_editorial: { label: "Editorial Split System", reason: "Separate message hierarchy from the visual subject while preserving the source spacing and palette roles." },
      modular_grid: { label: motifs.includes("file") ? "Workspace Module Grid" : "Modular Grid", reason: "Translate source design elements into reusable cards, panels, and interface rhythm." },
    },
    structure: {
      abstract_symbol: { label: "Brand Metaphor Symbol", reason: `Compress the user request into a simple brand-safe symbol using ${currentBrand?.brand_name || "Brand"} design DNA.` },
      product_scene: { label: "Product Workflow Scene", reason: "Show a concrete workflow or product moment without turning it into stock photography." },
      ui_collage: { label: motifs.includes("browser") ? "Browser + File Collage" : "UI Collage", reason: "Use browser/file/system fragments as visual evidence, not as copied screenshots." },
    },
    finish: {
      soft_matte: { label: "Source-Matte Finish", reason: first?.textures_materials?.[0] ? `Carry over ${first.textures_materials[0]} and soft depth.` : "Use quiet premium surfaces and restrained depth." },
      glass_light: { label: "Transparent Light Finish", reason: "Use translucent layers only if they support the source palette and concept clarity." },
      paper_grain: { label: "Editorial Grain Finish", reason: "Add subtle paper/design-board texture without making the image look messy." },
    },
  };
  return {
    source: "local_fallback_reading",
    status: state.designReadingStatus,
    user_intent_reading: {
      goal: request,
      audience: state.platform === AUTO_PLATFORM ? "platform-adaptive audience" : state.platform,
      must_say: request,
      emotional_target: currentDesigner?.creative_intent || currentBrand?.summary || "brand-consistent, clear, professional",
    },
    material_reading: {
      image_content: first?.screen_content || "No current design draft uploaded; use saved Brand evidence.",
      composition: first?.composition_structure || currentBrand?.visual_style?.composition || "source-led composition",
      primary_elements: first?.main_visual_elements || currentBrand?.visual_evidence_digest?.style_dna || [],
      typography_layout: first?.typography_layout || currentBrand?.typography?.english || "brand typography hierarchy",
      brand_assets: first?.brand_assets || ["logo remains fixed overlay"],
      color_roles: first?.color_proportion || paletteForBrand(currentBrand).map((item) => `${item.hex} ${item.role || ""}`).join("; "),
      material_lighting: first?.materials_lighting || currentBrand?.visual_style?.materials_lighting || "brand material and lighting cues",
      transferable_rules: first?.transferable_rules || currentBrand?.visual_style?.transferable_rules || [],
      do_not_copy: first?.do_not_copy || currentBrand?.visual_style?.do_not_copy || [],
      relevance: first?.relevance_to_user_request || "Use as source design evidence for this generation.",
    },
    visual_motifs: motifs,
    visual_choice_guidance: choiceBase,
    directions: [
      {
        id: "direction_a",
        title: "Source DNA Translation",
        concept: `Translate ${materialSummary} into a visual for: ${compactText(request, 90)}.`,
        composition: first?.composition_structure || `${baseChoiceLabel("layout")} layout that preserves source rhythm and brand spacing.`,
        tags: ["source-led", first?.advanced_visual_metrics?.visual_focus_region || "brand-evidence", currentDesigner?.style_bias?.density || "low_to_medium"],
        thumbnail_kind: "reference",
      },
      {
        id: "direction_b",
        title: "Designer-Led Metaphor",
        concept: `Use ${currentDesigner?.name || "the selected Designer"} to turn the requirement into ${baseChoiceLabel("structure")} while preserving Brand hard rules.`,
        composition: `${baseChoiceLabel("layout")} structure with ${baseChoiceLabel("finish")} material behavior and no fake brand assets.`,
        tags: [currentDesigner?.style_bias?.abstraction || "designer-metaphor", "brand-bound", "editable"],
        thumbnail_kind: "designer",
      },
      {
        id: "direction_c",
        title: "Platform-Ready Composition",
        concept: `Package the source design DNA into a ${state.size} ${state.platform} image with immediate readability and correct crop behavior.`,
        composition: `${state.size} crop-safe composition with clear focal hierarchy and platform-safe typography zones.`,
        tags: [state.size, state.platform, "output-safe"],
        thumbnail_kind: "platform",
      },
    ],
    prompt_package_visual_plan: `Final package should combine the user request, ${currentBrand?.brand_name || "Brand"} rules, ${currentDesigner?.name || "Designer"} bias, and source material reading: ${materialSummary}.`,
  };
}

function normalizeDesignReading(reading) {
  const fallback = buildFallbackDesignReading();
  const value = reading && typeof reading === "object" ? reading : {};
  const normalized = {
    ...fallback,
    ...value,
    user_intent_reading: { ...fallback.user_intent_reading, ...(value.user_intent_reading || {}) },
    material_reading: { ...fallback.material_reading, ...(value.material_reading || {}) },
    visual_choice_guidance: {
      layout: { ...fallback.visual_choice_guidance.layout, ...(value.visual_choice_guidance?.layout || {}) },
      structure: { ...fallback.visual_choice_guidance.structure, ...(value.visual_choice_guidance?.structure || {}) },
      finish: { ...fallback.visual_choice_guidance.finish, ...(value.visual_choice_guidance?.finish || {}) },
    },
    directions: Array.isArray(value.directions) && value.directions.length ? value.directions : fallback.directions,
    visual_motifs: Array.isArray(value.visual_motifs) && value.visual_motifs.length ? value.visual_motifs : fallback.visual_motifs,
    source: value.source || fallback.source,
  };
  normalized.material_reading.primary_elements = listify(normalized.material_reading.primary_elements);
  normalized.material_reading.brand_assets = listify(normalized.material_reading.brand_assets);
  normalized.material_reading.transferable_rules = listify(normalized.material_reading.transferable_rules);
  normalized.material_reading.do_not_copy = listify(normalized.material_reading.do_not_copy);
  normalized.visual_motifs = listify(normalized.visual_motifs);
  normalized.directions = normalized.directions.map((item, index) => ({
    ...item,
    id: item.id || `direction_${String.fromCharCode(97 + index)}`,
    tags: listify(item.tags),
  }));
  return normalized;
}

function applyFallbackDesignReading(status = "ready_local") {
  const fallback = normalizeDesignReading(buildFallbackDesignReading());
  fallback.source = "local_fallback_reading";
  fallback.status = status;
  state.designReading = fallback;
  state.designReadingStatus = status;
  state.designReadingFingerprint = designReadingFingerprint();
  return state.designReading;
}

function startDesignReadingEnhancement(reason = "background", fingerprint = designReadingFingerprint()) {
  if (!getAnnaRuntime()?.llm?.complete) return;
  const runId = ++state.designReadingRunId;
  state.designReadingStatus = "enhancing";
  if (state.designReading) state.designReading.status = "enhancing";
  render();
  window.setTimeout(() => {
    if (runId !== state.designReadingRunId || state.designReadingStatus !== "enhancing") return;
    state.designReadingStatus = "ready_local";
    if (state.designReading) state.designReading.status = "ready_local";
    render();
  }, 10000);
  refreshDesignReading(reason, { runId, fingerprint }).catch((error) => {
    console.warn("Design reading enhancement failed", error);
    if (runId !== state.designReadingRunId) return;
    state.designReadingStatus = "ready_local";
    if (state.designReading) state.designReading.status = "ready_local";
    render();
  });
}

async function refreshDesignReading(reason = "update", options = {}) {
  if (!brand()) return null;
  const strict = Boolean(options.strict);
  const expectedFingerprint = options.fingerprint || designReadingFingerprint();
  const runId = options.runId || ++state.designReadingRunId;
  const fallback = state.designReadingFingerprint === expectedFingerprint && state.designReading
    ? state.designReading
    : applyFallbackDesignReading("ready_local");
  const prompt = {
    reason,
    user_request: state.imageRequest,
    selected_visual_choices: {
      layout: baseChoiceLabel("layout"),
      structure: baseChoiceLabel("structure"),
      finish: baseChoiceLabel("finish"),
    },
    brand: {
      name: brand()?.brand_name,
      summary: brand()?.summary,
      keywords: brand()?.keywords,
      avoid_keywords: brand()?.avoid_keywords,
      palette: paletteForBrand(brand()),
      logo_rules: brand()?.logo_rules,
      visual_style: brand()?.visual_style,
      saved_visual_evidence_digest: brand()?.visual_evidence_digest,
    },
    designer: designer() ? {
      name: designer().name,
      creative_intent: designer().creative_intent,
      style_bias: designer().style_bias,
      allowed_deviation: designer().allowed_deviation,
    } : null,
    uploaded_design_evidence: state.generationEvidence ? {
      files: state.generationEvidence.files,
      palette: state.generationEvidence.palette,
      composition_structure: state.generationEvidence.composition_structure,
      materials_lighting: state.generationEvidence.materials_lighting,
      image_specific_observations: state.generationEvidence.visual_evidence_digest?.image_specific_observations,
    } : null,
    required_json_shape: {
      user_intent_reading: "goal, audience, must_say, emotional_target",
      material_reading: "image_content, composition, primary_elements, typography_layout, brand_assets, color_roles, material_lighting, transferable_rules, do_not_copy, relevance",
      visual_motifs: ["browser", "file", "ai", "workflow"],
      visual_choice_guidance: {
        layout: { centered_hero: "label + reason", split_editorial: "label + reason", modular_grid: "label + reason" },
        structure: { abstract_symbol: "label + reason", product_scene: "label + reason", ui_collage: "label + reason" },
        finish: { soft_matte: "label + reason", glass_light: "label + reason", paper_grain: "label + reason" },
      },
      directions: "3 items with id direction_a/b/c, title, concept, composition, tags, thumbnail_kind reference/designer/platform",
      prompt_package_visual_plan: "how final prompt/json/style draft should use request + design draft + brand/designer",
    },
  };
  const result = await aiCompleteWithImages(
    `Return compact JSON only. Do not reveal hidden chain-of-thought; provide observable design reading and concrete decisions that are directly useful for image generation quality. Prioritize concrete visual facts over generic adjectives. For every direction, specify the subject, composition, source-design transfer, color/material behavior, and what must not be copied.\n\n${JSON.stringify(prompt, null, 2)}`,
    "You are AnnaVisual's senior image-design director for production image generation. Your job is not to make pretty text; it is to read the user's design draft/reference image and produce decisions that make the downstream image model generate a better image. Analyze visible content, composition, visual elements, typography, brand assets, color roles, material, lighting, transferable rules, do-not-copy rules, and relevance to the current request. Every visual choice and direction must be semantically tied to the request and the source design evidence.",
    designReadingImageDataUrls(),
    { temperature: 0.22, max_tokens: 2600, timeout_ms: options.timeoutMs || (strict ? 35000 : 18000) },
  );
  if (runId !== state.designReadingRunId || expectedFingerprint !== designReadingFingerprint()) return state.designReading;
  const parsed = parseJsonFromText(result, null);
  if (strict && !parsed) {
    state.designReading = fallback;
    state.designReading.source = "strict_llm_failed";
    state.designReading.status = "strict_failed";
    state.designReadingStatus = "strict_failed";
    state.designReadingFingerprint = expectedFingerprint;
    render();
    return null;
  }
  state.designReading = normalizeDesignReading(parsed || fallback);
  state.designReading.source = parsed ? "llm_design_reading" : "local_fallback_reading";
  state.designReading.status = parsed ? "ready" : "ready_local";
  state.designReadingStatus = parsed ? "ready" : "ready_local";
  state.designReadingFingerprint = expectedFingerprint;
  render();
  return state.designReading;
}

function ensureDesignReading(reason = "before direction") {
  const fingerprint = designReadingFingerprint();
  if (state.designReading && state.designReadingFingerprint === fingerprint) return state.designReading;
  const reading = applyFallbackDesignReading("ready_local");
  startDesignReadingEnhancement(reason, fingerprint);
  return reading;
}

async function prepareDesignReading(reason = "start design", options = {}) {
  const fingerprint = designReadingFingerprint();
  const strict = options.strict ?? isStrictReadingMode();
  if (state.designReading && state.designReadingFingerprint === fingerprint && state.designReadingStatus === "ready") return state.designReading;
  if (strict && !getAnnaRuntime()?.llm?.complete) {
    state.designReadingStatus = "strict_failed";
    toast("Strict LLM Mode needs LLM reading access. Switch to Fast Mode or open this inside Anna runtime.");
    return null;
  }
  const fallback = normalizeDesignReading(buildFallbackDesignReading());
  fallback.source = "local_fallback_reading";
  fallback.status = "reading";
  state.designReading = fallback;
  state.designReadingStatus = "reading";
  state.designReadingFingerprint = fingerprint;
  render();
  const reading = await refreshDesignReading(reason, {
    fingerprint,
    runId: ++state.designReadingRunId,
    blocking: true,
    strict,
    timeoutMs: options.timeoutMs,
  });
  if (strict && (!reading || state.designReadingStatus !== "ready" || state.designReading?.source !== "llm_design_reading")) {
    state.designReadingStatus = "strict_failed";
    if (state.designReading) state.designReading.status = "strict_failed";
    render();
    toast("Strict LLM Mode did not receive a complete LLM reading. Try again or switch to Fast Mode.");
    return null;
  }
  if (!strict && state.designReadingStatus !== "ready") {
    state.designReadingStatus = "ready_local";
    if (state.designReading) state.designReading.status = "ready_local";
  }
  return reading || state.designReading;
}

function renderVisualRefine() {
  const visualPalette = currentVisualPalette();
  const previewVisual = state.visualChoices.structure === "ui_collage" ? "grid" : state.visualChoices.layout === "split_editorial" ? "poster" : "hero";
  page.innerHTML = `
    <section class="page visual-flow">
      ${progress()}
      ${renderCapabilityPanel(true)}
      <div class="section-title">
        <div>
          <h2>Shape the image</h2>
          <span>Choose visual structures instead of answering long text questions.</span>
        </div>
        <div class="row">
          <button class="soft" id="backToBriefBtn">Back</button>
          <button class="primary" id="goDirectionBtn">Choose direction</button>
        </div>
      </div>
      <div class="visual-refine-grid">
        <aside class="glass visual-preview">
          ${generatedThumb(previewKeyForCurrentChoices(), { visual: previewVisual, variant: `${state.visualChoices.layout}_${state.visualChoices.structure}_${state.visualChoices.finish}`, palette: visualPalette, focusRegion: state.generationEvidence?.images?.[0]?.advanced_visual_metrics?.visual_focus_region, caption: choiceLabel("structure"), motifs: activeMotifs() })}
          <h3>${escapeHtml(choiceLabel("layout"))}</h3>
          <p>${escapeHtml(choiceLabel("structure"))} · ${escapeHtml(choiceLabel("finish"))}</p>
          ${state.previewErrors[previewKeyForCurrentChoices()] ? `<p class="mode-note">Preview is a structure sketch because direct image generation is not available in this runtime.</p>` : ""}
          ${renderGenerationEvidence()}
          ${renderDesignReadingPanel("compact")}
        </aside>
        <div class="choice-stack">
          ${VISUAL_CHOICE_GROUPS.map(renderChoiceGroup).join("")}
        </div>
      </div>
    </section>
  `;
  $("#backToBriefBtn")?.addEventListener("click", () => {
    state.stage = "brief";
    render();
  });
  $("#goDirectionBtn")?.addEventListener("click", () => {
    goToDirection();
  });
  page.querySelectorAll("[data-choice-key]").forEach((card) => {
    card.addEventListener("click", () => {
      state.visualChoices[card.dataset.choiceKey] = card.dataset.choiceValue;
      render();
    });
  });
}

async function goToDirection() {
  state.stage = "loading";
  state.loadingTitle = "Generating direction previews";
  state.loadingDetail = "Anna is preparing three visual routes from the selected structure. The screen will switch when the previews are ready or the short timeout is reached.";
  render();
  await generateDirectionPreviewSet({ silent: true, timeoutMs: 11000 });
  state.stage = "direction";
  state.loadingTitle = "";
  state.loadingDetail = "";
  render();
}

function renderChoiceGroup(group) {
  const groupIndex = VISUAL_CHOICE_GROUPS.findIndex((item) => item.key === group.key);
  const visualPalette = currentVisualPalette();
  return `
    <section class="choice-group">
      <h3>${escapeHtml(group.title)}</h3>
      <div class="visual-choice-grid">
        ${group.options.map((option, optionIndex) => `
          ${(() => {
            const guidance = choiceGuidance(group.key, option) || {};
            return `
          <button class="choice-card ${state.visualChoices[group.key] === option.id ? "selected" : ""}" data-choice-key="${group.key}" data-choice-value="${option.id}">
            ${thumb({ visual: option.visual, variant: option.id, palette: thumbPalette((groupIndex * 2) + optionIndex, visualPalette), focusRegion: state.generationEvidence?.images?.[0]?.advanced_visual_metrics?.visual_focus_region, caption: guidance.label || option.title, motifs: activeMotifs() })}
            <b>${escapeHtml(guidance.label || option.title)}</b>
            <span>${escapeHtml(compactText(guidance.reason || option.note, 92))}</span>
          </button>
            `;
          })()}
        `).join("")}
      </div>
    </section>
  `;
}

function applyDirectionEdit(direction) {
  return { ...direction, ...(state.directionEdits[direction.id] || {}) };
}

function buildDirections() {
  const currentDesigner = designer();
  const palette = currentVisualPalette();
  const reference = state.generationEvidence?.images?.[0];
  const layout = choiceLabel("layout");
  const structure = choiceLabel("structure");
  const finish = choiceLabel("finish");
  const reading = activeDesignReading();
  const fallbackDirections = [
    {
      id: "direction_a",
      title: "Source DNA Translation",
      description: `Use the uploaded design evidence and user request "${compactText(state.imageRequest, 72)}" as the visual anchor, then adapt it into a ${layout} with ${finish} finish.`,
      composition: reference?.composition_structure || `${layout} composition guided by source visual density and Brand spacing.`,
      template: `${structure} / ${layout}`,
      tags: ["source-led", reference?.advanced_visual_metrics?.visual_focus_region || "visual evidence", currentDesigner?.style_bias?.density || "low-to-medium"],
      visual: "product",
      palette: thumbPalette(0, palette),
      thumbnail_kind: "reference",
      fit: 96,
    },
    {
      id: "direction_b",
      title: "Designer Metaphor",
      description: `Translate the request through ${currentDesigner?.name || "Designer"} as a ${structure}, while keeping Brand hard rules fixed.`,
      composition: `${layout} structure with designer-led metaphor and ${finish} material language.`,
      template: `${structure} / ${finish}`,
      tags: [currentDesigner?.style_bias?.abstraction || "semi-abstract", "designer-led", "campaign ready"],
      visual: "hero",
      palette: thumbPalette(1, palette),
      thumbnail_kind: "designer",
      fit: 92,
    },
    {
      id: "direction_c",
      title: state.visualType === "PPT 16:9" ? "Slide-Native System" : "Platform Composition",
      description: state.visualType === "PPT 16:9"
        ? "A direct front-facing 16:9 slide artifact with stable title rhythm, module logic, and no environmental framing."
        : `Adapt ${layout} into a crop-safe platform image with minimal text and strong image hierarchy.`,
      composition: state.visualType === "PPT 16:9" ? "front-facing slide canvas with stable module rhythm" : `${state.size} crop with ${layout} focal system`,
      template: `${state.platform} / ${state.size}`,
      tags: [state.size, state.platform, "production prompt"],
      visual: state.visualType === "PPT 16:9" ? "grid" : "poster",
      palette: thumbPalette(2, palette),
      thumbnail_kind: "platform",
      fit: 94,
    },
  ];
  const readingDirections = Array.isArray(reading?.directions) && reading.directions.length ? reading.directions : fallbackDirections;
  return fallbackDirections.map((fallback, index) => {
    const source = readingDirections[index] || fallback;
    const thumbnailKind = source.thumbnail_kind || fallback.thumbnail_kind;
    return applyDirectionEdit({
      ...fallback,
      id: fallback.id,
      title: source.title || fallback.title,
      description: source.concept || source.description || fallback.description,
      composition: source.composition || fallback.composition,
      tags: Array.isArray(source.tags) && source.tags.length ? source.tags.slice(0, 5) : fallback.tags,
      thumbnail_kind: thumbnailKind,
      visual: thumbnailKind === "platform" ? "poster" : thumbnailKind === "designer" ? "hero" : fallback.visual,
      palette: thumbPalette(index, palette),
    });
  });
}

function renderDirections() {
  const directions = buildDirections();
  const selected = directions.find((item) => item.id === state.selectedDirectionId) || directions[0];
  if (!state.selectedDirectionId) state.selectedDirectionId = selected.id;
  page.innerHTML = `
    <section class="page">
      ${progress()}
      ${renderCapabilityPanel(true)}
      <div class="section-title">
        <div>
          <h2>Choose a direction</h2>
          <span>Pick one visual route. You can tune the selected template below.</span>
        </div>
        <div class="row">
          <button class="soft" id="backToRefineBtn">Back</button>
          <button class="primary" id="generateFromDirectionBtn">Generate package</button>
        </div>
      </div>
      <div class="direction-grid">
        ${directions.map((item) => `
          <article class="direction ${state.selectedDirectionId === item.id ? "selected" : ""}" data-direction-id="${item.id}">
            ${generatedThumb(`direction_${item.id}`, { visual: item.visual, variant: item.thumbnail_kind || item.id, palette: item.palette, focusRegion: state.generationEvidence?.images?.[0]?.advanced_visual_metrics?.visual_focus_region, caption: item.title, motifs: activeMotifs() })}
            <span class="select-mark">${state.selectedDirectionId === item.id ? "Selected" : "Choose"}</span>
            <h3>${escapeHtml(item.title)}</h3>
            <p>${escapeHtml(item.description)}</p>
            <small>${escapeHtml(item.composition || item.template || "")}</small>
            <div class="chips">${item.tags.map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join("")}</div>
            ${fit(item.fit)}
          </article>
        `).join("")}
      </div>
      ${renderDesignReadingPanel("full")}
      ${renderDirectionEditor(selected)}
    </section>
  `;
  page.querySelectorAll("[data-direction-id]").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedDirectionId = card.dataset.directionId;
      render();
    });
  });
  page.querySelectorAll("[data-direction-edit]").forEach((input) => {
    input.addEventListener("input", (event) => {
      const field = event.target.dataset.directionEdit;
      state.directionEdits[state.selectedDirectionId] = {
        ...(state.directionEdits[state.selectedDirectionId] || {}),
        [field]: field === "tags" ? splitList(event.target.value) : event.target.value,
      };
    });
  });
  $("#backToRefineBtn")?.addEventListener("click", () => {
    state.stage = "refine";
    render();
  });
  $("#generateFromDirectionBtn")?.addEventListener("click", () => {
    generatePackage(buildDirections().find((item) => item.id === state.selectedDirectionId) || buildDirections()[0], { autoImage: true });
  });
}

function renderDirectionEditor(direction) {
  return `
    <article class="direction-editor">
      <div>
        <b>Edit selected template</b>
        <span>Generated from user request + AI Design Reading + Brand + Designer. Edits update the final prompt.</span>
      </div>
      <div class="field-grid compact-fields">
        <label>AI direction title<input data-direction-edit="title" value="${escapeHtml(direction.title)}" /></label>
        <label>Evidence tags<input data-direction-edit="tags" value="${escapeHtml((direction.tags || []).join(", "))}" /></label>
        <label class="wide">Concept from request + source design<textarea data-direction-edit="description">${escapeHtml(direction.description)}</textarea></label>
        <label class="wide">Composition / source-transfer rules<textarea data-direction-edit="composition">${escapeHtml(direction.composition || "")}</textarea></label>
      </div>
    </article>
  `;
}

function sanitizeEvidenceForPackage(evidence) {
  if (!evidence) return null;
  const clone = JSON.parse(JSON.stringify(evidence));
  (clone.images || []).forEach((image) => {
    delete image.source_thumb_data_url;
    delete image.analysis_image_data_url;
    delete image.analysis_image_mime;
  });
  return clone;
}

function buildSourceImageAudit() {
  const evidence = sanitizeEvidenceForPackage(state.generationEvidence);
  const reading = activeDesignReading();
  const material = reading.material_reading || {};
  const images = (evidence?.images || []).map((image) => ({
    file_name: image.file_name,
    content: image.screen_content || material.image_content || "uploaded design reference",
    composition: image.composition_structure || material.composition || "source-led composition",
    focus_region: image.advanced_visual_metrics?.visual_focus_region || "unknown",
    density_grid_3x3: image.advanced_visual_metrics?.density_grid_3x3 || [],
    main_visual_elements: image.main_visual_elements || material.primary_elements || [],
    typography_layout: image.typography_layout || material.typography_layout || "",
    brand_assets: image.brand_assets || material.brand_assets || [],
    color_proportion: image.color_proportion || material.color_roles || "",
    materials_lighting: image.materials_lighting || material.material_lighting || "",
    transferable_rules: image.transferable_rules || material.transferable_rules || [],
    do_not_copy: image.do_not_copy || material.do_not_copy || [],
    relevance_to_user_request: image.relevance_to_user_request || material.relevance || "",
  }));
  return {
    purpose: "Objective reading of uploaded/source images before creative adaptation.",
    source: images.length ? "current uploaded design draft" : "saved Brand evidence",
    images,
    summary: {
      content: material.image_content || images[0]?.content || "No current uploaded design image.",
      composition: material.composition || evidence?.composition_structure || brand()?.visual_style?.composition || "",
      colors: material.color_roles || evidence?.palette?.join(", ") || paletteForBrand(brand()).map((item) => `${item.hex} ${item.role || ""}`).join("; "),
      typography: material.typography_layout || brand()?.typography?.english || "",
      material_lighting: material.material_lighting || evidence?.materials_lighting || brand()?.visual_style?.materials_lighting || "",
      transferable_rules: listify(material.transferable_rules).length ? listify(material.transferable_rules) : evidence?.transferable_rules || [],
      do_not_copy: listify(material.do_not_copy).length ? listify(material.do_not_copy) : evidence?.do_not_copy || [],
    },
  };
}

function validateDesignerAgainstBrand(currentDesigner = designer(), currentBrand = brand()) {
  if (!currentBrand) return { ok: false, issues: ["No Brand selected."], warnings: [], enforced_rules: [] };
  const issues = [];
  const warnings = [];
  const enforced = [
    "Logo rule stays fixed_asset_overlay.",
    "Mascot/IP rule stays fixed overlay or confirmed variant only.",
    "Brand avoid keywords remain active.",
    "Brand palette remains the allowed color source.",
  ];
  if (currentDesigner && currentDesigner.brand_id !== currentBrand.brand_id) issues.push("Designer belongs to a different Brand.");
  const designerText = JSON.stringify(currentDesigner || {}).toLowerCase();
  const bannedSignals = ["recolor logo", "redraw logo", "fake logo", "generate logo", "stretch logo", "rotate logo", "generated mascot"];
  bannedSignals.forEach((signal) => {
    if (designerText.includes(signal)) issues.push(`Designer contains forbidden asset behavior: ${signal}`);
  });
  (currentBrand.avoid_keywords || []).forEach((keyword) => {
    if (keyword && designerText.includes(String(keyword).toLowerCase())) {
      warnings.push(`Designer mentions Brand avoid keyword; the final prompt will still forbid it: ${keyword}`);
    }
  });
  return {
    ok: issues.length === 0,
    issues,
    warnings,
    enforced_rules: enforced,
    designer_allowed_scope: ["composition", "visual metaphor", "abstraction", "information density", "platform expression", "material mood", "typography hierarchy"],
    designer_forbidden_scope: ["logo rules", "mascot identity", "banned colors", "fake brand assets", "Brand hard constraints"],
  };
}

function buildGenerationStrategy(direction) {
  const currentBrand = brand();
  const currentDesigner = designer();
  return {
    purpose: "How to translate source design DNA into the user's new image request.",
    user_request: state.imageRequest,
    selected_direction: direction?.title || "",
    translate: [
      `Use ${choiceLabel("layout")} as the composition frame.`,
      `Use ${choiceLabel("structure")} as the image language.`,
      `Use ${choiceLabel("finish")} as the surface/lighting behavior.`,
      "Preserve source color roles, focal rhythm, material cues, and typography hierarchy without copying the exact layout.",
    ],
    brand_hard_constraints: [
      "Brand palette must remain the color authority; Designer cannot introduce off-brand primary colors.",
      "Logo and mascot are fixed overlay assets only.",
      "Never generate, redraw, recolor, stretch, rotate, split, outline, or approximate logo/mascot.",
      "Brand Do/Don't rules outrank Designer preferences.",
    ],
    designer_allowed_scope: [
      "Designer may control composition, visual metaphor, abstraction level, information density, platform expression, material mood, and typography hierarchy.",
      "Designer may not override logo rules, banned colors, mascot identity, or Brand hard constraints.",
    ],
    platform_strategy: `${state.platform} / ${state.size}: keep crop-safe focal hierarchy and avoid fake placeholder whitespace.`,
    negative_strategy: [
      ...(currentBrand?.avoid_keywords || []),
      "fake logo",
      "generated mascot",
      "off-brand primary colors",
      "copied source screenshot layout",
      "unreadable baked-in text",
    ],
    designer_guard_result: validateDesignerAgainstBrand(currentDesigner, currentBrand),
  };
}

function buildGenerationContext(direction) {
  const currentBrand = brand();
  const currentDesigner = designer();
  const reading = activeDesignReading();
  const sourceImageAudit = buildSourceImageAudit();
  const generationStrategy = buildGenerationStrategy(direction);
  return {
    user_goal: {
      request: state.imageRequest,
      visual_type: state.visualType,
      platform: state.platform,
      size: state.size,
      format: state.format,
      visual_choices: {
        layout: choiceLabel("layout"),
        image_language: choiceLabel("structure"),
        finish: choiceLabel("finish"),
      },
    },
    llm_design_reading: reading,
    source_image_audit: sourceImageAudit,
    generation_strategy: generationStrategy,
    brand_rules: {
      brand_id: currentBrand.brand_id,
      name: currentBrand.brand_name,
      status: currentBrand.status,
      summary: currentBrand.summary,
      keywords: currentBrand.keywords,
      avoid_keywords: currentBrand.avoid_keywords,
      palette: paletteForBrand(currentBrand),
      logo_rules: currentBrand.logo_rules,
      logo_rule_detail: currentBrand.logo_rule_detail,
      brand_profile: currentBrand.brand_profile,
      visual_style: currentBrand.visual_style,
      source_assets: currentBrand.source_assets || [],
      visual_evidence_digest: currentBrand.visual_evidence_digest || null,
    },
    uploaded_design_draft_evidence: sanitizeEvidenceForPackage(state.generationEvidence),
    designer_direction: currentDesigner ? {
      designer_id: currentDesigner.designer_id,
      brand_id: currentDesigner.brand_id,
      name: currentDesigner.name,
      role: currentDesigner.role,
      creative_intent: currentDesigner.creative_intent,
      style_bias: currentDesigner.style_bias,
      allowed_deviation: currentDesigner.allowed_deviation,
      examples: (currentDesigner.examples || []).slice(0, 3),
    } : null,
    selected_direction: direction || buildDirections()[0],
  };
}

function pptMasterRules() {
  if (state.visualType !== "PPT 16:9") return "";
  return `PPT discipline: ${PPT_MASTER_RULES.join(" ")}`;
}

function summarizeEvidenceDigest(digest) {
  if (!digest) return "No saved source evidence; rely on Brand rules only.";
  const observations = (digest.image_specific_observations || [])
    .slice(0, 3)
    .map((item) => `${item.file_name}: ${item.composition}; ${item.materials_lighting}; transfer ${item.transferable_rules?.slice(0, 2).join(", ")}`)
    .join(" | ");
  return [
    `Style DNA: ${(digest.style_dna || []).slice(0, 4).join(", ")}`,
    `Composition DNA: ${(digest.composition_dna || []).slice(0, 4).join(", ")}`,
    `Materials/light: ${(digest.materials_lighting || []).slice(0, 4).join(", ")}`,
    observations ? `Image observations: ${observations}` : "",
  ].filter(Boolean).join(". ");
}

function buildFinalPrompt(context) {
  const palette = context.brand_rules.palette.map((item) => `${item.name || "color"} ${item.hex} as ${item.role || "brand color"}`).join("; ");
  const reading = context.llm_design_reading || {};
  const materialReading = reading.material_reading || {};
  const intentReading = reading.user_intent_reading || {};
  const sourceAudit = context.source_image_audit || {};
  const strategy = context.generation_strategy || {};
  const designerText = context.designer_direction
    ? `Designer direction: ${context.designer_direction.name} (${context.designer_direction.role}) uses ${context.designer_direction.style_bias.composition}, ${context.designer_direction.style_bias.abstraction}, ${context.designer_direction.style_bias.materials.join(", ")}, and ${context.designer_direction.style_bias.typography}.`
    : "Designer direction: no Designer selected; use Brand rules only.";
  const evidence = context.brand_rules.visual_style || {};
  const digestSummary = summarizeEvidenceDigest(context.brand_rules.visual_evidence_digest);
  const draftSummary = summarizeGenerationEvidence(context.uploaded_design_draft_evidence);
  const request = context.user_goal.request || "the uploaded design draft and selected visual choices";
  const negative = [
    ...(context.brand_rules.avoid_keywords || []),
    ...(context.brand_rules.logo_rules || []).filter((rule) => /^no\s|do not|Logo hard/i.test(rule)),
    "no generated logo",
    "no generated mascot",
    "no fake brand assets",
    "no copied source layout",
  ];
  return [
    `Goal: create a ${context.user_goal.size} ${context.user_goal.platform} ${context.user_goal.visual_type} visual for ${context.brand_rules.name} that communicates: ${request}.`,
    `AI design reading: user intent is ${intentReading.goal || request}; must-say/emotion is ${intentReading.must_say || request} / ${intentReading.emotional_target || context.brand_rules.summary}.`,
    `Source image audit: ${sourceAudit.summary?.content || "brand/source image evidence"}; composition ${sourceAudit.summary?.composition || "source-led"}; colors ${sourceAudit.summary?.colors || palette}; typography ${sourceAudit.summary?.typography || "brand hierarchy"}; material/light ${sourceAudit.summary?.material_lighting || "source-led"}.`,
    `Generation strategy: ${listify(strategy.translate).join("; ")} Brand hard constraints: ${listify(strategy.brand_hard_constraints).join("; ")} Designer may only control ${listify(strategy.designer_allowed_scope).join(", ")}.`,
    `Material reading from uploaded/source images: content ${materialReading.image_content || "brand evidence"}; composition ${materialReading.composition || "source-led"}; key elements ${listify(materialReading.primary_elements).join(", ") || "brand visual elements"}; typography ${materialReading.typography_layout || "brand hierarchy"}; color roles ${materialReading.color_roles || palette}; material/light ${materialReading.material_lighting || "source-led"}.`,
    `Brand hard rules: ${context.brand_rules.summary}. Logo and mascot are fixed asset overlays only; never redraw, recolor, stretch, rotate, split, outline, or approximate them.`,
    designerText,
    `User visual choices: ${context.user_goal.visual_choices.layout}; ${context.user_goal.visual_choices.image_language}; ${context.user_goal.visual_choices.finish}.`,
    `Selected direction: ${context.selected_direction.title}. ${context.selected_direction.description}`,
    context.selected_direction.composition ? `Direction composition: ${context.selected_direction.composition}.` : "",
    `Visual evidence: tone ${evidence.tone || "source-led"}; composition ${evidence.composition || "clear focal hierarchy"}; materials/lighting ${evidence.materials_lighting || "source-led surfaces and diffused depth"}.`,
    `Source reference reading: ${digestSummary}.`,
    draftSummary ? `Uploaded design draft reading: ${draftSummary}.` : "",
    `Transfer rules: ${listify(materialReading.transferable_rules).concat(listify(evidence.transferable_rules)).join("; ") || "preserve palette roles, spacing rhythm, surface treatment, and typography hierarchy from Brand evidence"}.`,
    listify(materialReading.do_not_copy).length ? `Do-not-copy rules from source reading: ${listify(materialReading.do_not_copy).join("; ")}.` : "",
    `Composition: build one strong hero system with integrated hierarchy and balanced breathing room. Avoid rigid blank placeholder zones unless the user explicitly asks for a text-heavy layout.`,
    `Color system: ${palette}. Use color proportions intentionally: background/surface first, accent second, text/depth last.`,
    `Overlay plan: Do not generate the logo or mascot; plan exact fixed asset overlays as intentional layout placements.`,
    pptMasterRules(),
    `Avoid: ${Array.from(new Set(negative)).slice(0, 12).join("; ")}.`,
  ].filter(Boolean).join(" ");
}

function summarizeGenerationEvidence(evidence) {
  if (!evidence?.files?.length) return "";
  const first = evidence.images?.[0];
  return [
    `${evidence.files.length} current design reference file(s)`,
    first?.composition_structure,
    first?.color_proportion ? `palette ${first.color_proportion}` : "",
    first?.typography_layout,
    first?.materials_lighting,
  ].filter(Boolean).join("; ");
}

function containsAny(text, terms = []) {
  const normalized = String(text || "").toLowerCase();
  return terms.some((term) => normalized.includes(String(term || "").toLowerCase()));
}

function requestTerms(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const terms = text.split(/[^a-zA-Z0-9\u4e00-\u9fa5#]+/).map((item) => item.trim()).filter((item) => item.length >= 3);
  return terms.length ? terms.slice(0, 8) : [text.slice(0, 24)];
}

function buildPromptQualityReport(prompt, context) {
  const text = String(prompt || "");
  const normalized = text.toLowerCase();
  const paletteHexes = (context.brand_rules.palette || []).map((item) => item.hex).filter(Boolean);
  const requiredHexCount = Math.min(2, paletteHexes.length);
  const usedHexCount = paletteHexes.filter((hex) => normalized.includes(String(hex).toLowerCase())).length;
  const requestTokens = requestTerms(context.user_goal.request);
  const hasDraftEvidence = Boolean(context.uploaded_design_draft_evidence?.files?.length || context.brand_rules.visual_evidence_digest);
  const checks = {
    enough_detail: text.length >= 650,
    user_goal: !requestTokens.length || requestTokens.some((term) => normalized.includes(term.toLowerCase())),
    brand_name: !context.brand_rules.name || normalized.includes(String(context.brand_rules.name).toLowerCase()),
    brand_palette: requiredHexCount === 0 || usedHexCount >= requiredHexCount,
    logo_asset_policy: containsAny(text, ["logo", "wordmark", "标志"]) && containsAny(text, ["fixed", "overlay", "do not generate", "never redraw", "不要生成", "固定", "叠加"]),
    source_design_reading: !hasDraftEvidence || containsAny(text, ["uploaded", "source", "reference", "material reading", "visual evidence", "素材", "参考"]),
    source_image_audit: containsAny(text, ["source image audit", "objective reading", "uploaded/source images", "source-led"]),
    generation_strategy: containsAny(text, ["generation strategy", "translate", "designer may only", "hard constraints"]),
    composition: containsAny(text, ["composition", "layout", "focal", "hierarchy", "构图", "版式", "视觉层级"]),
    material_light: containsAny(text, ["material", "lighting", "surface", "shadow", "光影", "材质", "表面"]),
    negative_constraints: containsAny(text, ["avoid", "no ", "do not", "never", "禁止", "不要"]),
    designer_brand_match: !context.designer_direction || context.designer_direction.brand_id === context.brand_rules.brand_id,
  };
  const missing = Object.entries(checks).filter(([, pass]) => !pass).map(([key]) => key);
  return {
    score: Object.values(checks).filter(Boolean).length,
    total: Object.keys(checks).length,
    accepted: missing.length === 0,
    checks,
    missing,
  };
}

function promptPassesQualityGate(candidatePrompt, packageData) {
  const context = {
    user_goal: packageData.user_goal,
    brand_rules: packageData.brand_rules,
    designer_direction: packageData.designer_direction,
    uploaded_design_draft_evidence: packageData.uploaded_design_draft_evidence,
    selected_direction: packageData.selected_direction,
  };
  const report = buildPromptQualityReport(candidatePrompt, context);
  return report.accepted ? { accepted: true, report } : { accepted: false, report };
}

function buildPackage(direction) {
  const context = buildGenerationContext(direction);
  const prompt = buildFinalPrompt(context);
  const reading = context.llm_design_reading || activeDesignReading();
  const sourceAssets = context.brand_rules.source_assets || [];
  const currentDraftAssets = context.uploaded_design_draft_evidence?.files || [];
  const promptQuality = buildPromptQualityReport(prompt, context);
  return {
    schema_version: "anna_visual_brand_designer_package.v1",
    package_type: "brand_plus_designer_compact_image_package",
    generated_at: new Date().toISOString(),
    generation_id: uid("generation"),
    priority_order: [
      "User request",
      "Brand hard rules",
      "Selected Designer direction",
      "Source visual evidence",
      "Platform / output constraints",
    ],
    ...context,
    prompt_package_visual_plan: reading.prompt_package_visual_plan || "",
    source_reference_inputs: [
      ...sourceAssets.map((asset, index) => ({
      order: index + 1,
      file_id: asset.file_id,
      file_name: asset.file_name,
      file_type: asset.file_type,
        usage: asset.file_type?.startsWith("image/") ? "saved Brand reference attachment" : "source guideline/reference document",
      })),
      ...currentDraftAssets.map((asset, index) => ({
        order: sourceAssets.length + index + 1,
        file_id: asset.file_id,
        file_name: asset.file_name,
        file_type: asset.file_type,
        usage: "current image design draft/reference attachment",
      })),
    ],
    attachment_manifest: [
      "Attach original Brand reference images first when the downstream image model supports multimodal inputs.",
      "Attach current image design drafts after Brand references when present.",
      "Then paste this compact JSON or final prompt.",
      "Do not ask the image model to redraw logo or mascot; use fixed overlays after generation.",
    ],
    abstract_style_draft: {
      purpose: "Optional companion style-board prompt if the image model benefits from an abstract style reference.",
      prompt: buildStyleDraftPrompt(context),
    },
    final_prompt_object: {
      prompt,
      negative_instructions: [
        "no generated logo",
        "no generated mascot",
        "no fake brand assets",
        "no copied source layout",
        "no unreadable tiny text",
      ],
      prompt_quality: promptQuality,
    },
    anna_chat_instruction: "Upload any original brand references if needed, then paste final_prompt_object.prompt or this JSON package.",
  };
}

function buildStyleDraftPrompt(context) {
  const palette = context.brand_rules.palette.map((item) => `${item.hex} (${item.role || "brand color"})`).join(", ");
  const digest = context.brand_rules.visual_evidence_digest || {};
  const reading = context.llm_design_reading || {};
  const material = reading.material_reading || {};
  return [
    "Create an abstract design-style reference board, not the final ad.",
    `Summarize ${context.brand_rules.name}'s visual DNA using palette ${palette}.`,
    `Use the LLM design reading: ${material.image_content || "brand evidence"}; ${material.composition || "source-led composition"}; ${material.color_roles || "brand colors"}; ${material.material_lighting || "source-led material/light"}.`,
    `Reflect the user request through motifs: ${(reading.visual_motifs || activeMotifs()).join(", ")}.`,
    `Show composition principles: ${(digest.composition_dna || [context.brand_rules.visual_style?.composition]).filter(Boolean).join(", ")}.`,
    `Show material and lighting cues: ${(digest.materials_lighting || [context.brand_rules.visual_style?.materials_lighting]).filter(Boolean).join(", ")}.`,
    "Avoid logo, mascot, final copy, exact copied layouts, and blank placeholder zones.",
  ].join(" ");
}

async function generatePackage(direction, options = {}) {
  if (!requireBrandForGeneration()) return;
  if (state.stage === "brief") state.imageRequest = $("#imageBrief")?.value.trim() || state.imageRequest;
  if (!state.imageRequest && !state.generationEvidence) return toast("Add a short goal or upload a design draft first.");
  state.stage = "loading";
  state.loadingTitle = "Building the final image package";
  state.loadingDetail = isStrictReadingMode()
    ? "Strict LLM Mode is locking the complete LLM design reading before it writes the final prompt package."
    : "Fast Mode is using the current source reading now, then refining the prompt if LLM response is available.";
  render();
  if (isStrictReadingMode()) {
    const reading = await prepareDesignReading("generate prompt package", { strict: true });
    if (!reading) {
      state.stage = "brief";
      state.loadingTitle = "";
      state.loadingDetail = "";
      render();
      return;
    }
  } else {
    ensureDesignReading("generate prompt package");
  }
  const selected = direction || buildDirections().find((item) => item.id === state.selectedDirectionId) || buildDirections()[0];
  const localPackage = buildPackage(selected);
  state.latestPackage = localPackage;
  state.latestPrompt = localPackage.final_prompt_object.prompt;
  state.latestGeneratedImage = null;
  state.imageGenerationStatus = "idle";
  state.imageGenerationError = "";
  state.imageEditPrompt = "";
  state.generations.unshift({
    generation_id: localPackage.generation_id,
    brand_id: localPackage.brand_rules.brand_id,
    designer_id: localPackage.designer_direction?.designer_id || null,
    user_request: state.imageRequest,
    final_prompt: state.latestPrompt,
    compact_json: localPackage,
    created_at: localPackage.generated_at,
  });
  persistAll();
  const aiPrompt = await maybeImprovePrompt(localPackage);
  if (aiPrompt && state.latestPackage?.generation_id === localPackage.generation_id) {
    if (!aiPrompt || state.latestPackage?.generation_id !== localPackage.generation_id) return;
    const qualityGate = promptPassesQualityGate(aiPrompt, localPackage);
    if (!qualityGate.accepted) {
      state.latestPackage.final_prompt_object.prompt_quality = {
        ...state.latestPackage.final_prompt_object.prompt_quality,
        llm_refinement_rejected: true,
        rejected_missing: qualityGate.report.missing,
      };
      persistAll();
      toast("LLM refinement skipped; local prompt kept stronger.");
    } else {
      state.latestPackage.final_prompt_object.prompt = aiPrompt;
      state.latestPackage.final_prompt_object.prompt_quality = {
        ...qualityGate.report,
        llm_refinement_accepted: true,
      };
      state.latestPrompt = aiPrompt;
      const saved = state.generations.find((item) => item.generation_id === localPackage.generation_id);
      if (saved) {
        saved.final_prompt = aiPrompt;
        saved.compact_json = state.latestPackage;
      }
      persistAll();
    }
  }
  if (options.autoImage !== false && state.latestPackage?.generation_id === localPackage.generation_id && !state.latestGeneratedImage?.url) {
    await generateImageFromPackage({ silent: true, timeoutMs: IMAGE_AUTOGEN_TIMEOUT_MS });
  }
  state.stage = "package";
  state.loadingTitle = "";
  state.loadingDetail = "";
  persistAll();
  render();
  toast(state.latestGeneratedImage?.url ? "Image and package ready." : "Package ready. Image generation needs runtime access.");
}

async function maybeImprovePrompt(packageData) {
  const result = await aiComplete(
    `Rewrite this image prompt to be concise, concrete, and generation-ready. Preserve all Brand and Designer constraints. You must keep: user goal, brand name, at least two palette hex colors, uploaded/source design reading, composition rule, material/lighting rule, fixed logo/mascot overlay policy, and negative constraints. Return only the prompt string.\n\n${JSON.stringify(packageData, null, 2)}`,
    "You are a senior visual art director. Write compact, strict, brand-safe image generation prompts. Never remove hard brand rules, source image evidence, logo policy, color hexes, or negative constraints.",
    { temperature: 0.22, max_tokens: 900, timeout_ms: 12000 },
  );
  return result ? String(result).replace(/^```(?:text)?|```$/g, "").trim() : "";
}

function renderPackage() {
  const pkg = state.latestPackage;
  page.innerHTML = `
    <section class="page">
      ${progress()}
      ${renderCapabilityPanel(false)}
      <div class="section-title">
        <div>
          <h2>Prompt package</h2>
          <span>Use this prompt and compact JSON with Anna chat or another image model.</span>
        </div>
        <div class="row">
          <button class="soft" id="backToDirectionsBtn">Back</button>
          <button class="primary" id="copyPromptBtn">Copy prompt</button>
        </div>
      </div>
      <div class="package-grid">
        <div>
          ${renderImageOutputPanel(pkg)}
          <article class="glass profile">
            <h3>Final prompt</h3>
            <p class="description">${escapeHtml(pkg?.final_prompt_object?.prompt || "No prompt yet.")}</p>
            <div class="row">
              <button class="soft" id="copyJsonBtn">Copy JSON</button>
              <button class="soft" id="sendToAnnaBtn">Send to Anna chat</button>
              <button class="tiny" id="saveBrandReferenceBtn">Save to Brand</button>
              <button class="tiny" id="saveDesignerExampleBtn">Save to Designer</button>
            </div>
          </article>
          <div class="section">
            <h3>Structured JSON</h3>
            <pre class="code-box" id="packageJson">${escapeHtml(JSON.stringify(pkg, null, 2))}</pre>
          </div>
        </div>
        <aside class="glass profile">
          ${generatedThumb(`direction_${pkg?.selected_direction?.id || state.selectedDirectionId}`, { visual: "hero", variant: pkg?.selected_direction?.thumbnail_kind || "package", palette: currentVisualPalette(), caption: pkg?.selected_direction?.title || "Prompt package", motifs: activeMotifs() })}
          <h3>${escapeHtml(brand()?.brand_name || "Brand")} / ${escapeHtml(designer()?.name || "No Designer")}</h3>
          <p class="muted">${escapeHtml(state.visualType)} - ${escapeHtml(state.platform)} - ${escapeHtml(state.size)}</p>
          <p class="muted">${escapeHtml(compactText(pkg?.prompt_package_visual_plan || activeDesignReading()?.prompt_package_visual_plan || "", 180))}</p>
          ${fit(95)}
          ${renderDesignReadingPanel("compact")}
        </aside>
      </div>
    </section>
  `;
  $("#backToDirectionsBtn")?.addEventListener("click", () => {
    state.stage = "direction";
    render();
  });
  $("#copyPromptBtn")?.addEventListener("click", () => copyText(pkg.final_prompt_object.prompt, "Prompt copied."));
  $("#copyPromptBtnInline")?.addEventListener("click", () => copyText(pkg.final_prompt_object.prompt, "Prompt copied."));
  $("#copyJsonBtn")?.addEventListener("click", () => copyText(JSON.stringify(pkg, null, 2), "JSON copied."));
  $("#generateImageBtn")?.addEventListener("click", generateImageFromPackage);
  $("#editGeneratedImageBtn")?.addEventListener("click", editGeneratedImage);
  $("#imageEditPrompt")?.addEventListener("input", (event) => {
    state.imageEditPrompt = event.target.value;
  });
  $("#sendToAnnaBtn")?.addEventListener("click", sendToAnnaChat);
  $("#saveBrandReferenceBtn")?.addEventListener("click", saveBrandReference);
  $("#saveDesignerExampleBtn")?.addEventListener("click", saveDesignerExample);
}

function renderImageOutputPanel(pkg) {
  refreshCapabilities();
  const generated = state.latestGeneratedImage;
  const hasImage = Boolean(generated?.url);
  const busy = state.imageGenerationStatus === "generating" || state.imageGenerationStatus === "editing";
  const liveMode = isLiveGenerateMode();
  const statusCopy = {
    idle: liveMode ? "Ready to call Anna image generation." : "Direct image grant is not open here. Use Anna Chat Package Mode.",
    generating: "Generating with Anna image provider...",
    editing: "Editing generated image...",
    ready: "Image generated. Save it as a Brand Reference or Designer Example.",
    fallback: "Image API unavailable here. Use the prompt package in Anna chat.",
    error: "Image generation needs grant/provider setup or returned an error.",
  }[state.imageGenerationStatus] || "Ready to generate.";
  return `
    <article class="glass profile image-output">
      <div class="image-output-head">
        <div>
          <span class="eyebrow">Anna image</span>
          <h3>${liveMode ? "Live Generate Mode" : "Anna Chat Package Mode"}</h3>
          <p>${escapeHtml(statusCopy)}</p>
        </div>
        <span class="badge">${escapeHtml(state.imageGenerationStatus)}</span>
      </div>
      ${hasImage ? `
        <figure class="generated-preview">
          <img src="${escapeHtml(generated.url)}" alt="Generated AnnaVisual output" />
          <figcaption>${escapeHtml(generated.model || "Anna image model")} · ${escapeHtml(generated.width || "?")}×${escapeHtml(generated.height || "?")}</figcaption>
        </figure>
      ` : `
        <div class="generated-placeholder">
          ${generatedThumb(`direction_${pkg?.selected_direction?.id || state.selectedDirectionId}`, { visual: "hero", variant: pkg?.selected_direction?.thumbnail_kind || "package", palette: currentVisualPalette(), caption: "Direction sketch", motifs: activeMotifs() })}
          <p>${liveMode ? "Uses the current final prompt plus compact Brand + Designer package." : "This is a structure sketch, not a generated result. Copy the prompt/JSON and upload the source design references in Anna chat."}</p>
        </div>
      `}
      ${state.imageGenerationError ? `<p class="error-note">${escapeHtml(state.imageGenerationError)}</p>` : ""}
      ${!liveMode && !hasImage ? `<p class="mode-note">Live generation is separate from package export. This app will only generate images here after Anna grants image generation to this runtime.</p>` : ""}
      <div class="row">
        <button class="${liveMode ? "primary" : "soft"}" id="generateImageBtn" ${busy ? "disabled" : ""}>${busy ? "Working..." : liveMode ? hasImage ? "Regenerate image" : "Generate image" : "Check live grant"}</button>
        <button class="soft" id="copyPromptBtnInline" ${busy ? "disabled" : ""}>Copy prompt fallback</button>
      </div>
      ${hasImage ? `
        <div class="edit-box">
          <label>Edit request<textarea id="imageEditPrompt" placeholder="Example: make the hero subject more premium, keep layout and brand colors unchanged.">${escapeHtml(state.imageEditPrompt)}</textarea></label>
          <button class="soft" id="editGeneratedImageBtn" ${busy ? "disabled" : ""}>Edit image</button>
        </div>
      ` : ""}
    </article>
  `;
}

function previewKeyForCurrentChoices() {
  return `choice_${state.visualChoices.layout}_${state.visualChoices.structure}_${state.visualChoices.finish}`;
}

function generatedThumb(key, fallbackConfig = {}) {
  const image = state.generatedPreviews[key];
  const status = state.previewStatus[key] || "idle";
  if (image?.url) {
    return `
      <figure class="thumb generated-thumb">
        <img src="${escapeHtml(image.url)}" alt="${escapeHtml(fallbackConfig.caption || "AI generated preview")}" />
        <span class="thumb-caption">${escapeHtml(compactText(fallbackConfig.caption || "AI preview", 28))}</span>
      </figure>
    `;
  }
  const pending = status === "generating";
  const failed = status === "fallback" || state.previewErrors[key];
  return `
    <div class="preview-fallback ${pending ? "working" : ""}">
      ${thumb(fallbackConfig)}
      <span class="preview-pill">${pending ? "Generating preview" : failed ? "Structure sketch" : "Structure sketch"}</span>
    </div>
  `;
}

function buildImageDirectorPrompt({ mode, title, concept, composition, tags = [] }) {
  const currentBrand = brand();
  const currentDesigner = designer();
  const reading = activeDesignReading();
  const material = reading.material_reading || {};
  const palette = currentVisualPalette().slice(0, 6).join(", ");
  const localEvidence = summarizeGenerationEvidence(state.generationEvidence);
  return [
    `Generate a real visual preview image for AnnaVisual, not a UI mockup and not an explanatory diagram.`,
    `Preview mode: ${mode}. Title: ${title}.`,
    `User request: ${state.imageRequest || "use uploaded design draft and Brand rules"}.`,
    `Brand: ${currentBrand?.brand_name || "Brand"}; palette: ${palette}. Use these colors by role and proportion, not randomly.`,
    `Designer: ${currentDesigner?.name || "No Designer"}; intent: ${currentDesigner?.creative_intent || currentBrand?.summary || "brand-consistent"}.`,
    `Source design reading: ${material.image_content || "uploaded/source design evidence"}; ${material.composition || ""}; ${material.color_roles || ""}; ${material.material_lighting || ""}.`,
    localEvidence ? `Current uploaded design draft evidence: ${localEvidence}.` : "",
    `Concept: ${concept}.`,
    `Composition: ${composition}.`,
    tags.length ? `Semantic tags to express visually: ${tags.join(", ")}.` : "",
    `Output as a polished image-model preview that could guide final generation. Keep it brand-safe, visually meaningful, and directly connected to the request.`,
    `No generated logo, no generated mascot, no fake brand assets, no random abstract blobs, no screenshot copy, no placeholder text, no long readable text.`,
  ].filter(Boolean).join(" ");
}

function buildChoicePreviewPrompt() {
  return buildImageDirectorPrompt({
    mode: "selected visual-structure preview",
    title: `${choiceLabel("layout")} / ${choiceLabel("structure")} / ${choiceLabel("finish")}`,
    concept: `Show how the user request can become ${choiceLabel("structure")} using ${choiceLabel("layout")} and ${choiceLabel("finish")}.`,
    composition: activeDesignReading()?.material_reading?.composition || state.generationEvidence?.composition_structure || "source-led composition rhythm",
    tags: [choiceLabel("layout"), choiceLabel("structure"), choiceLabel("finish"), ...activeMotifs()],
  });
}

function buildPreviewPayload(prompt, key, size = "1024x1024") {
  return {
    prompt,
    n: 1,
    size,
    reference_image_urls: collectReferenceImageUrls(),
    reference_images: collectLocalReferenceImages(),
    modelPreferences: { hints: ["preview", "design-reference"] },
    metadata: {
      app: "anna-visual-brand-mvp",
      preview_key: key,
      brand_id: state.activeBrandId,
      designer_id: state.activeDesignerId || null,
    },
  };
}

function withTimeout(promise, ms, fallback = null) {
  if (!ms) return promise;
  return Promise.race([
    promise,
    new Promise((resolve) => window.setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function generatePreviewImage(key, prompt, size = "1024x1024", options = {}) {
  if (state.previewStatus[key] === "generating" || state.generatedPreviews[key]?.url) return state.generatedPreviews[key] || null;
  state.previewStatus[key] = "generating";
  state.previewErrors[key] = "";
  if (!options.silent) render();
  try {
    const image = await requestAnnaImage(
      buildPreviewPayload(prompt, key, size),
      `preview-${key}`,
      { package_type: "ai_preview", key },
      { timeoutMs: options.timeoutMs || PREVIEW_IMAGE_TIMEOUT_MS },
    );
    state.generatedPreviews[key] = image;
    state.previewStatus[key] = "ready";
    persistAll();
    if (!options.silent) render();
    return image;
  } catch (error) {
    console.warn("Preview image generation failed", error);
    state.previewStatus[key] = "fallback";
    state.previewErrors[key] = imageErrorMessage(error, "Preview image generation unavailable in this runtime.");
    if (!options.silent) render();
    return null;
  }
}

function generateCurrentChoicePreview(options = {}) {
  const key = previewKeyForCurrentChoices();
  return withTimeout(generatePreviewImage(key, buildChoicePreviewPrompt(), "1024x1024", options), options.timeoutMs || 0, null);
}

function generateDirectionPreviewSet(options = {}) {
  const directions = buildDirections();
  const tasks = directions.map((item) => {
    const key = `direction_${item.id}`;
    const prompt = buildImageDirectorPrompt({
      mode: "visual direction candidate",
      title: item.title,
      concept: item.description,
      composition: item.composition || item.template || "source-led brand composition",
      tags: item.tags || [],
    });
    return generatePreviewImage(key, prompt, "1024x1024", options);
  });
  return withTimeout(Promise.allSettled(tasks), options.timeoutMs || 0, null);
}

function imageSizeForRequest(size = state.size) {
  const normalized = String(size || "").toLowerCase();
  if (normalized.includes("16:9") || normalized.includes("banner")) return "1792x1024";
  if (normalized.includes("9:16")) return "1024x1792";
  if (normalized.includes("4:5")) return "1024x1280";
  return "1024x1024";
}

function collectReferenceImageUrls(pkg = state.latestPackage) {
  const urls = [];
  const add = (value) => {
    if (typeof value === "string" && /^https?:\/\//.test(value) && !urls.includes(value)) urls.push(value);
  };
  (pkg?.source_reference_inputs || []).forEach((item) => {
    add(item.url);
    add(item.download_url);
    add(item.presigned_url);
  });
  (brand()?.references || []).slice(0, 2).forEach((item) => {
    add(item.image_url);
    add(item.url);
  });
  (designer()?.examples || []).slice(0, 2).forEach((item) => {
    add(item.image_url);
    add(item.url);
  });
  return urls.slice(0, 3);
}

function collectLocalReferenceImages() {
  return (state.generationEvidence?.images || [])
    .map((image) => ({
      file_name: image.file_name,
      mime_type: image.analysis_image_mime || "image/jpeg",
      data_url: image.analysis_image_data_url || image.source_thumb_data_url || "",
    }))
    .filter((item) => item.data_url)
    .slice(0, 3);
}

function designReadingImageDataUrls() {
  return collectLocalReferenceImages().map((item) => item.data_url);
}

function buildImageGenerationPayload(pkg = state.latestPackage) {
  return {
    prompt: pkg?.final_prompt_object?.prompt || state.latestPrompt,
    n: 1,
    size: imageSizeForRequest(pkg?.user_goal?.size || state.size),
    reference_image_urls: collectReferenceImageUrls(pkg),
    reference_images: collectLocalReferenceImages(),
    modelPreferences: { hints: [] },
    metadata: {
      app: "anna-visual-brand-mvp",
      generation_id: pkg?.generation_id,
      brand_id: pkg?.brand_rules?.brand_id,
      designer_id: pkg?.designer_direction?.designer_id || null,
      source: "AnnaVisual Brand + Designer package",
    },
  };
}

function normalizeImageResult(result, source = "host-image") {
  const payload = result?.image_result || result?.data?.image_result || result?.result || result;
  const images = payload?.images || payload?.image_result?.images || [];
  const first = Array.isArray(images) ? images[0] : null;
  if (!first?.url) return null;
  return {
    url: first.url,
    mimeType: first.mimeType || first.mime_type || "image/png",
    width: first.width || null,
    height: first.height || null,
    model: payload.model || result?.model || source,
    quota_used: payload.quota_used || null,
    generated_at: new Date().toISOString(),
    source,
  };
}

function imageErrorMessage(error, fallback = "Image API unavailable. Prompt package remains ready.") {
  const code = error?.code || error?.error?.code || error?.details?.code || "";
  const message = error?.message || error?.error?.message || fallback;
  if (
    code === "ANNA_IMAGE_HOST_API_UNAVAILABLE" ||
    /llm[._]generate_image|generate_image is not defined|ANNA_IMAGE_HOST_API_UNAVAILABLE|Host image API unavailable/i.test(message)
  ) {
    return "当前 Anna runtime 没有开放可直接调用的生图 Host API。请在 staging/admin 给这个 App 开 image grant，或继续使用下方 prompt/JSON 到 Anna chat 生图。";
  }
  if (/APP_NOT_GRANTED|image_grant not enabled|image_not_granted/i.test(message)) {
    return "Anna 已经接到生图 Host API，但这个 App 还没有 image_grant。请在 staging/admin 给该 App 开 image_grant.generate / image_grant.edit。";
  }
  if (/APP_QUOTA_EXCEEDED|quota/i.test(message)) {
    return "Anna 生图额度已用尽或当前 grant 没有可用额度。请检查该 App 的 image quota。";
  }
  const map = {
    APP_NOT_GRANTED: "Image generation is not granted for this app yet. Enable image_grant.generate / image_grant.edit in Anna Admin, then try again.",
    APP_QUOTA_EXCEEDED: "Image quota is exhausted for the current grant.",
    APP_INVALID_REQUEST: "The image provider rejected this request. Check prompt length, image size, or reference image format.",
    APP_PROVIDER_ERROR: "The upstream image provider returned an error. Retry shortly or use Anna Chat Package Mode.",
    not_implemented: "This Anna runtime has not wired image generation yet. Update the dev kit/runtime or use Anna Chat Package Mode.",
    IMAGE_NOT_GRANTED: "Image generation is not granted for this app/tool yet. Enable image grant in Anna Admin, then try again.",
    IMAGE_NOT_NEGOTIATED: "This runtime has not negotiated image generation yet. Rebundle with the updated Executa image capability.",
    IMAGE_NO_MODEL_AVAILABLE: "No image provider is configured for this Anna account.",
    IMAGE_QUOTA_EXCEEDED: "Image quota is exhausted for the current grant.",
    IMAGE_USER_DENIED: "Image generation was denied by the user confirmation prompt.",
    UPLOAD_NOT_GRANTED: "Upload grant is not enabled, so reference images cannot be attached yet.",
  };
  return map[code] || message;
}

async function directHostImageGenerate(payload, options = {}) {
  const anna = getAnnaRuntime();
  const opts = { timeoutMs: options.timeoutMs || IMAGE_GENERATION_TIMEOUT_MS };
  if (anna?.image?.generate) return anna.image.generate(payload, opts);
  if (anna?.host?.image?.generate) return anna.host.image.generate(payload, opts);
  if (anna?.host_api?.image?.generate) return anna.host_api.image.generate(payload, opts);
  if (anna?.llm?.image?.generate) return anna.llm.image.generate(payload, opts);
  if (anna?.call) return anna.call("image", "generate", payload, opts);
  throw new Error("ANNA_IMAGE_HOST_API_UNAVAILABLE");
}

async function directHostImageEdit(payload, options = {}) {
  const anna = getAnnaRuntime();
  const opts = { timeoutMs: options.timeoutMs || IMAGE_GENERATION_TIMEOUT_MS };
  if (anna?.image?.edit) return anna.image.edit(payload, opts);
  if (anna?.host?.image?.edit) return anna.host.image.edit(payload, opts);
  if (anna?.host_api?.image?.edit) return anna.host_api.image.edit(payload, opts);
  if (anna?.llm?.image?.edit) return anna.llm.image.edit(payload, opts);
  if (anna?.call) return anna.call("image", "edit", payload, opts);
  throw new Error("ANNA_IMAGE_HOST_API_UNAVAILABLE");
}

async function executaImageGenerate(payload, pkg = state.latestPackage, options = {}) {
  const toolResult = await invokeTool("generate_image", {
    package: pkg,
    prompt: payload.prompt,
    size: payload.size,
    n: payload.n,
    reference_image_urls: payload.reference_image_urls,
    reference_images: payload.reference_images,
    modelPreferences: payload.modelPreferences,
    metadata: payload.metadata,
  }, { timeoutMs: options.timeoutMs || IMAGE_GENERATION_TIMEOUT_MS, silent: true });
  return toolResult?.result || toolResult?.data || toolResult;
}

async function executaImageEdit(payload, pkg = state.latestPackage) {
  const toolResult = await invokeTool("edit_image", {
    package: pkg,
    image_url: payload.image_url,
    prompt: payload.prompt,
    n: payload.n,
    mask_url: payload.mask_url || null,
    metadata: payload.metadata,
  }, { timeoutMs: IMAGE_GENERATION_TIMEOUT_MS, silent: true });
  return toolResult?.result || toolResult?.data || toolResult;
}

async function requestAnnaImage(payload, source = "image", pkg = state.latestPackage, options = {}) {
  let directError = null;
  try {
    const directResult = await directHostImageGenerate(payload, { timeoutMs: options.timeoutMs || IMAGE_GENERATION_TIMEOUT_MS });
    const image = normalizeImageResult(directResult, `host-${source}`);
    if (image) {
      refreshCapabilities({ imageGeneration: "granted", note: "Live image generation succeeded inside this Anna runtime." });
      return image;
    }
  } catch (error) {
    directError = error;
    console.warn("Direct host image generation unavailable", error);
    if ((payload.reference_images || []).length) {
      try {
        const retryPayload = { ...payload };
        delete retryPayload.reference_images;
        const retryResult = await directHostImageGenerate(retryPayload, { timeoutMs: options.timeoutMs || IMAGE_GENERATION_TIMEOUT_MS });
        const image = normalizeImageResult(retryResult, `host-${source}`);
        if (image) {
          refreshCapabilities({ imageGeneration: "granted", note: "Live image generation succeeded after removing inline references." });
          return image;
        }
      } catch (retryError) {
        directError = retryError;
      }
    }
  }
  const bridgeResult = await executaImageGenerate(payload, pkg || { package_type: "preview_image_request" }, options);
  if (bridgeResult?.status === "image_unavailable" || bridgeResult?.success === false) {
    const code = bridgeResult?.error?.code || bridgeResult?.code || "";
    refreshCapabilities({
      imageGeneration: "not granted",
      executaBridge: code === "IMAGE_NOT_NEGOTIATED" ? "v1/not negotiated" : "v2 unavailable",
      note: imageErrorMessage(bridgeResult),
    });
    throw bridgeResult?.error ? bridgeResult : directError || bridgeResult;
  }
  const image = normalizeImageResult(bridgeResult, `executa-${source}`);
  if (!image) {
    refreshCapabilities({
      imageGeneration: "not granted",
      note: imageErrorMessage(directError || new Error("Image provider returned no image URL.")),
    });
    throw directError || new Error("Image provider returned no image URL.");
  }
  refreshCapabilities({ imageGeneration: "granted", executaBridge: "v2", note: "Image generated through the Anna Executa image bridge." });
  return image;
}

async function generateImageFromPackage(options = {}) {
  if (!state.latestPackage) return toast("Generate a prompt package first.");
  state.imageGenerationStatus = "generating";
  state.imageGenerationError = "";
  if (!options.silent) render();
  const payload = buildImageGenerationPayload(state.latestPackage);
  try {
    const image = await withTimeout(
      requestAnnaImage(payload, "final-image", state.latestPackage, { timeoutMs: options.timeoutMs || IMAGE_GENERATION_TIMEOUT_MS }),
      options.timeoutMs || 0,
      null,
    );
    if (!image) throw new Error("Image generation timed out in this runtime.");
    state.latestGeneratedImage = image;
    state.imageGenerationStatus = "ready";
    state.latestPackage.generated_image = image;
    persistAll();
    if (!options.silent) render();
    toast("Image generated.");
  } catch (error) {
    console.warn("Image generation failed", error);
    state.imageGenerationStatus = "fallback";
    state.imageGenerationError = imageErrorMessage(error);
    if (!options.silent) render();
    if (!options.silent) toast("Image API unavailable. Prompt package is still ready.");
  }
}

async function editGeneratedImage() {
  if (!state.latestGeneratedImage?.url) return toast("Generate an image first.");
  const editPrompt = state.imageEditPrompt.trim();
  if (!editPrompt) return toast("Describe what to improve first.");
  state.imageGenerationStatus = "editing";
  state.imageGenerationError = "";
  render();
  const payload = {
    image_url: state.latestGeneratedImage.url,
    prompt: `${editPrompt}\n\nPreserve the approved Brand + Designer constraints from this package: ${state.latestPackage?.final_prompt_object?.prompt || state.latestPrompt}`,
    n: 1,
    mask_url: null,
    metadata: {
      app: "anna-visual-brand-mvp",
      source_generation_id: state.latestPackage?.generation_id,
      edit_of: state.latestGeneratedImage.url,
    },
  };
  try {
    let image = null;
    try {
      const directResult = await directHostImageEdit(payload, { timeoutMs: IMAGE_GENERATION_TIMEOUT_MS });
      image = normalizeImageResult(directResult, "host-image-edit");
      if (image) refreshCapabilities({ imageEdit: "granted", note: "Live image editing succeeded inside this Anna runtime." });
    } catch (directError) {
      console.warn("Direct host image edit unavailable", directError);
      const bridgeResult = await executaImageEdit(payload, state.latestPackage);
      if (bridgeResult?.status === "image_unavailable" || bridgeResult?.success === false) {
        const code = bridgeResult?.error?.code || bridgeResult?.code || "";
        refreshCapabilities({
          imageEdit: "not granted",
          executaBridge: code === "IMAGE_NOT_NEGOTIATED" ? "v1/not negotiated" : "v2 unavailable",
          note: imageErrorMessage(bridgeResult, "Image edit is not available in this runtime."),
        });
        throw bridgeResult;
      }
      image = normalizeImageResult(bridgeResult, "executa-image-edit-bridge");
      if (image) refreshCapabilities({ imageEdit: "granted", executaBridge: "v2", note: "Image edited through the Anna Executa image bridge." });
    }
    if (!image) throw new Error("Image edit provider returned no image URL.");
    state.latestGeneratedImage = image;
    state.imageGenerationStatus = "ready";
    state.latestPackage.generated_image = image;
    persistAll();
    render();
    toast("Edited image ready.");
  } catch (error) {
    console.warn("Image edit failed", error);
    state.imageGenerationStatus = "error";
    state.imageGenerationError = imageErrorMessage(error, "Image edit unavailable. Keep using the generated prompt package.");
    render();
  }
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch (_) {
    toast("Copy failed. Select the text manually.");
  }
}

async function sendToAnnaChat() {
  const anna = getAnnaRuntime();
  const content = `[AnnaVisual] Generate image from this Brand + Designer package:\n\n${JSON.stringify(state.latestPackage, null, 2)}`;
  if (anna?.chat?.write_message) {
    try {
      await anna.chat.write_message({ role: "user", content });
      toast("Sent to Anna chat.");
      return;
    } catch (_) {
      await copyText(content, "Anna chat unavailable. Request copied.");
      return;
    }
  }
  await copyText(content, "Request copied for Anna chat.");
}

function saveBrandReference() {
  const currentBrand = brand();
  if (!currentBrand || !state.latestPackage) return;
  currentBrand.references = currentBrand.references || [];
  currentBrand.references.unshift({
    reference_id: uid("ref"),
    title: compactText(state.imageRequest, 80),
    prompt: state.latestPrompt,
    image_url: state.latestGeneratedImage?.url || "",
    image_meta: state.latestGeneratedImage || null,
    package_id: state.latestPackage.generation_id,
    saved_at: new Date().toISOString(),
  });
  currentBrand.updated_at = new Date().toISOString();
  persistAll();
  toast("Saved to Brand references.");
}

function saveDesignerExample() {
  const currentDesigner = designer();
  if (!currentDesigner || !state.latestPackage) return toast("Select a Designer first.");
  currentDesigner.examples = currentDesigner.examples || [];
  currentDesigner.examples.unshift({
    example_id: uid("example"),
    brand_id: currentDesigner.brand_id,
    prompt: state.latestPrompt,
    image_url: state.latestGeneratedImage?.url || "",
    image_meta: state.latestGeneratedImage || null,
    package_id: state.latestPackage.generation_id,
    saved_at: new Date().toISOString(),
  });
  currentDesigner.updated_at = new Date().toISOString();
  persistAll();
  toast("Saved as Designer example.");
}

function renderBrandStudio() {
  const current = brand();
  page.innerHTML = `
    <section class="page studio-page">
      <div class="studio-hero">
        <div>
          <h2>Brands</h2>
          <p>Create a reusable Brand system from uploaded materials, then call it from Image generation or Designer creation.</p>
        </div>
        <div class="studio-hero-actions">
          <span class="badge">${state.brands.length} saved</span>
          <button class="primary" id="newBrandBtn">New Brand</button>
        </div>
      </div>
      <div class="studio-layout">
        <form class="glass studio-panel" id="brandForm">
          <div class="form-section">
            <div class="form-section-head">
              <div>
                <b>Brand core</b>
                <span id="brandStorageInfo">Storage: Anna storage first, browser fallback.</span>
              </div>
              <button type="button" class="soft" id="downloadBrandJsonBtn">Download JSON</button>
            </div>
            <div class="field-grid relaxed">
              <label>Brand name<input id="brandNameInput" value="${escapeHtml(current?.brand_name || "")}" placeholder="Anna" /></label>
              <label>Status<select id="brandStatusInput"><option ${current?.status !== "active" ? "selected" : ""}>draft</option><option ${current?.status === "active" ? "selected" : ""}>active</option></select></label>
              <label class="wide">Brand summary<textarea id="brandSummaryInput" placeholder="What should never change about this brand?">${escapeHtml(current?.summary || "")}</textarea></label>
            </div>
          </div>

          <div class="form-section">
            <div class="form-section-head">
              <div>
                <b>Style rules</b>
                <span>Keep this compact. The image prompt will use it as hard guidance.</span>
              </div>
            </div>
            <div class="field-grid relaxed">
              <label>Keywords<input id="brandKeywordsInput" value="${escapeHtml((current?.keywords || []).join(", "))}" placeholder="premium, clean, technical" /></label>
              <label>Avoid<input id="brandAvoidInput" value="${escapeHtml((current?.avoid_keywords || []).join(", "))}" placeholder="neon, chaotic, fake logo" /></label>
              <label class="wide">Visual style<textarea id="brandStyleInput" placeholder="Tone, composition, materials, logo policy...">${escapeHtml(current?.visual_style?.tone || "")}</textarea></label>
            </div>
          </div>

          <div class="form-section">
            <div class="form-section-head">
              <div>
                <b>Source materials</b>
                <span>Upload logo, PDF, screenshots, posters, or design references.</span>
              </div>
            </div>
            <div class="upload-box">
              <label>Brand materials<input type="file" id="brandFileInput" multiple accept="image/*,.pdf" /></label>
              <div class="file-list" id="brandFileList">${renderFileList(state.brandDraftFiles)}</div>
            </div>
          </div>

          <div class="studio-actions">
            <button type="button" class="primary" id="analyzeSaveBrandBtn">Analyze & save Brand</button>
            <button type="button" class="soft" id="saveBrandBtn">Save Brand</button>
            <button type="button" class="soft" id="confirmBrandBtn">Confirm Brand</button>
          </div>
        </form>
        <aside class="library-panel">
          <div class="section-title compact-title">
            <div>
              <h3>Brand Library</h3>
              <span>Select one Brand for generation.</span>
            </div>
            <span class="badge">${state.brands.length}</span>
          </div>
          <div class="library-list" id="brandList">
            ${state.brands.map(renderBrandCard).join("")}
          </div>
        </aside>
      </div>
    </section>
  `;
  bindBrandStudio();
}

function renderFileList(files) {
  if (!files?.length) return '<span class="muted">No files selected.</span>';
  return files.map((file) => `<div class="file-chip"><span>${escapeHtml(file.name)}</span><span>${Math.round((file.size || 0) / 1024)} KB</span></div>`).join("");
}

function renderBrandCard(item) {
  const colors = paletteForBrand(item);
  return `
    <article class="profile ${item.brand_id === state.activeBrandId ? "current" : ""}" data-brand-card="${item.brand_id}">
      <div class="profile-top">
        <div class="profile-main">
          <div class="logo" style="--a:${colors[0]?.hex || "#8b7cf8"};--b:${colors[2]?.hex || "#f7f4ef"}"></div>
          <div>
            <h3>${escapeHtml(item.brand_name)}</h3>
            <p>${escapeHtml(compactText(item.summary, 92))}</p>
          </div>
        </div>
        <span class="badge">${escapeHtml(item.status)}</span>
      </div>
      ${swatches(colors)}
      <p class="meta">${(item.source_assets || []).length} source files - ${(item.references || []).length} references</p>
      <div class="row">
        <button class="soft" data-use-brand="${item.brand_id}">${item.brand_id === state.activeBrandId ? "Current Brand" : "Use Brand"}</button>
        <button class="tiny danger" data-delete-brand="${item.brand_id}">Delete</button>
      </div>
    </article>
  `;
}

function bindBrandStudio() {
  $("#newBrandBtn")?.addEventListener("click", () => {
    state.activeBrandId = "";
    state.brandDraftFiles = [];
    render();
  });
  $("#brandFileInput")?.addEventListener("change", (event) => {
    state.brandDraftFiles = Array.from(event.target.files || []);
    $("#brandFileList").innerHTML = renderFileList(state.brandDraftFiles);
  });
  $("#analyzeSaveBrandBtn")?.addEventListener("click", analyzeAndSaveBrand);
  $("#saveBrandBtn")?.addEventListener("click", () => saveBrandFromForm(false));
  $("#confirmBrandBtn")?.addEventListener("click", () => saveBrandFromForm(true));
  $("#downloadBrandJsonBtn")?.addEventListener("click", downloadActiveBrand);
  page.querySelectorAll("[data-use-brand]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeBrandId = button.dataset.useBrand;
      state.activeDesignerId = designerForBrand(state.activeBrandId)?.designer_id || "";
      persistAll();
      render();
    });
  });
  page.querySelectorAll("[data-delete-brand]").forEach((button) => {
    button.addEventListener("click", () => deleteBrand(button.dataset.deleteBrand));
  });
}

async function analyzeAndSaveBrand() {
  const evidence = await extractFilesEvidence(state.brandDraftFiles);
  state.latestEvidence = evidence;
  const toolResult = await invokeTool("analyze_brand_material", {
    source_files: evidence.files,
    brand_hint: $("#brandNameInput").value,
    user_request: state.imageRequest,
    platform: state.platform,
    material_evidence: evidence,
  });
  saveBrandFromForm(false, evidence, toolResult?.data?.visual_manual || null);
}

function saveBrandFromForm(confirm = false, evidence = state.latestEvidence, visualManual = null) {
  const name = $("#brandNameInput").value.trim() || "Untitled";
  const existing = brand(state.activeBrandId);
  const extractedPalette = evidence?.palette?.length ? evidence.palette : paletteForBrand(existing).map((item) => item.hex);
  const palette = extractedPalette.length ? extractedPalette : ["#f7f4ef", "#232333", "#8b7cf8"];
  const brandObject = {
    brand_id: existing?.brand_id || uid("brand"),
    brand_name: name,
    status: confirm ? "active" : ($("#brandStatusInput").value || "draft"),
    summary: $("#brandSummaryInput").value.trim() || visualManual?.visual_identity?.core_impression?.summary || `Brand system for ${name}.`,
    keywords: splitList($("#brandKeywordsInput").value) || visualManual?.visual_identity?.core_impression?.keywords || [],
    avoid_keywords: splitList($("#brandAvoidInput").value).length ? splitList($("#brandAvoidInput").value) : ["fake logo", "off-brand colors", "generic AI style"],
    brand_profile: {
      description: $("#brandSummaryInput").value.trim() || visualManual?.visual_identity?.core_impression?.summary || `Brand system for ${name}.`,
      keywords: splitList($("#brandKeywordsInput").value) || visualManual?.visual_identity?.core_impression?.keywords || [],
      avoid_keywords: splitList($("#brandAvoidInput").value).length ? splitList($("#brandAvoidInput").value) : ["fake logo", "off-brand colors", "generic AI style"],
    },
    colors: {
      primary: palette.slice(0, 3).map((hex, index) => ({ name: ["Primary", "Depth", "Surface"][index] || "Color", hex, role: ["accent", "text/depth", "background"][index] || "brand color" })),
      secondary: palette.slice(3, 5).map((hex) => ({ name: "Support", hex, role: "support" })),
      rules: ["Use extracted color roles intentionally.", "Avoid random colors outside the Brand palette."],
    },
    logo_rules: [
      "Logo hard constraints: fixed asset overlay only.",
      "no recolored logo",
      "no stretched logo",
      "no rotated logo",
      "no generated logo",
      "no fake brand assets",
    ],
    logo_rule_detail: {
      policy: "fixed_asset_overlay",
      allowed: ["use approved logo as a separate overlay", "preserve clear space and aspect ratio"],
      forbidden: ["do not recolor", "do not stretch", "do not rotate", "do not redraw", "do not approximate"],
    },
    typography: {
      english: "Modern sans-serif with strong headline hierarchy.",
      chinese: "Clean sans-serif with stable title/body rhythm.",
    },
    visual_style: {
      tone: $("#brandStyleInput").value.trim() || evidence?.style_summary || "source-led, clean, brand-consistent",
      composition: evidence?.composition_structure || "source-led focal hierarchy",
      materials_lighting: evidence?.materials_lighting || "source-led materials and lighting",
      transferable_rules: evidence?.transferable_rules || ["preserve spacing rhythm", "preserve color roles", "preserve surface language"],
      do_not_copy: evidence?.do_not_copy || ["do not copy exact reference layout", "do not generate fake brand assets"],
    },
    visual_evidence_digest: evidence?.visual_evidence_digest || existing?.visual_evidence_digest || {
      style_dna: [],
      composition_dna: [],
      materials_lighting: [],
      transfer_rules: [],
      do_not_copy: [],
      image_specific_observations: [],
    },
    source_assets: evidence?.files || existing?.source_assets || [],
    references: existing?.references || [],
    visual_manual: visualManual || existing?.visual_manual || null,
    updated_at: new Date().toISOString(),
    created_at: existing?.created_at || new Date().toISOString(),
  };
  const index = state.brands.findIndex((item) => item.brand_id === brandObject.brand_id);
  if (index >= 0) state.brands[index] = brandObject;
  else state.brands.unshift(brandObject);
  state.activeBrandId = brandObject.brand_id;
  if (!designerForBrand(brandObject.brand_id)) createDefaultDesigner(brandObject);
  persistAll();
  render();
  toast(confirm ? "Brand confirmed." : "Brand saved.");
}

function createDefaultDesigner(brandObject) {
  const designerObject = {
    designer_id: uid("designer"),
    brand_id: brandObject.brand_id,
    name: `${brandObject.brand_name} Social Designer`,
    role: "Brand-bound Visual Designer",
    type: "social_media",
    platform: state.platform,
    creative_intent: `Translate ${brandObject.brand_name} rules into platform-ready visual systems.`,
    style_bias: {
      composition: brandObject.visual_style.composition || "source-led balanced composition",
      density: "low_to_medium",
      abstraction: "semi-abstract product metaphor",
      materials: splitList(brandObject.visual_style.materials_lighting).slice(0, 4),
      typography: brandObject.typography.english,
      visual_metaphor: "turn user goals into brand-safe visual metaphors",
    },
    allowed_deviation: {
      colors: "brand palette only",
      logo: "fixed overlay only",
      layout: "can vary",
      visual_metaphor: "can vary within Brand rules",
    },
    hard_constraints: {
      cannot_change_logo_rules: true,
      cannot_make_banned_colors_primary: true,
      cannot_generate_logo_or_mascot: true,
      allowed_controls: ["composition", "visual metaphor", "abstraction", "information density", "platform expression", "material mood", "typography hierarchy"],
    },
    examples: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  state.designers.unshift(designerObject);
  state.activeDesignerId = designerObject.designer_id;
  return designerObject;
}

function deleteBrand(id) {
  if (state.brands.length <= 1) return toast("Keep at least one Brand.");
  state.brands = state.brands.filter((item) => item.brand_id !== id);
  state.designers = state.designers.filter((item) => item.brand_id !== id);
  if (state.activeBrandId === id) {
    state.activeBrandId = state.brands[0]?.brand_id || "";
    state.activeDesignerId = designerForBrand(state.activeBrandId)?.designer_id || "";
  }
  persistAll();
  render();
}

function downloadActiveBrand() {
  const current = brand();
  if (!current) return;
  const blob = new Blob([JSON.stringify(current, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${current.brand_name.replace(/[^a-z0-9_-]+/gi, "_")}_brand.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function renderDesignerStudio() {
  const currentBrand = brand();
  const currentDesigner = selectedDesignerForForm();
  page.innerHTML = `
    <section class="page studio-page">
      <div class="studio-hero">
        <div>
          <h2>Designers</h2>
          <p>Designer is the creative layer under a Brand. It can change composition and metaphor, but not hard Brand rules.</p>
        </div>
        <div class="studio-hero-actions">
          <span class="badge">${escapeHtml(currentBrand?.brand_name || "No Brand")}</span>
          <button class="primary" id="newDesignerBtn">New Designer</button>
        </div>
      </div>
      <div class="studio-layout">
        <form class="glass studio-panel" id="designerForm">
          <div class="form-section">
            <div class="form-section-head">
              <div>
                <b>Designer base</b>
                <span>Choose the Brand first, then define the visual behavior.</span>
              </div>
              <span class="badge">Brand required</span>
            </div>
            <div class="field-grid relaxed">
              <label>Brand<select id="designerBrandSelect">${state.brands.map((item) => `<option value="${item.brand_id}" ${item.brand_id === state.activeBrandId ? "selected" : ""}>${escapeHtml(item.brand_name)}</option>`).join("")}</select></label>
              <label>Name<input id="designerNameInput" value="${escapeHtml(currentDesigner?.name || "")}" placeholder="Anna Social Designer" /></label>
              <label>Type<select id="designerTypeInput">${["social_media", "article_concept", "product_visual", "ppt_cover", "abstract_concept"].map((type) => `<option ${currentDesigner?.type === type ? "selected" : ""}>${type}</option>`).join("")}</select></label>
              <label>Platform<select id="designerPlatformInput">${["LinkedIn", "X", "Website", "Presentation", AUTO_PLATFORM].map((item) => `<option ${currentDesigner?.platform === item ? "selected" : ""}>${item}</option>`).join("")}</select></label>
            </div>
          </div>

          <div class="form-section">
            <div class="form-section-head">
              <div>
                <b>Creative behavior</b>
                <span>These settings control visual choices in image generation.</span>
              </div>
            </div>
            <div class="field-grid relaxed">
              <label>Composition<input id="designerCompositionInput" value="${escapeHtml(currentDesigner?.style_bias?.composition || "")}" /></label>
              <label>Density<select id="designerDensityInput">${["low", "low_to_medium", "medium", "high"].map((item) => `<option ${currentDesigner?.style_bias?.density === item ? "selected" : ""}>${item}</option>`).join("")}</select></label>
              <label>Abstraction<input id="designerAbstractionInput" value="${escapeHtml(currentDesigner?.style_bias?.abstraction || "")}" /></label>
              <label>Materials<input id="designerMaterialsInput" value="${escapeHtml((currentDesigner?.style_bias?.materials || []).join(", "))}" /></label>
              <label class="wide">Creative intent<textarea id="designerIntentInput">${escapeHtml(currentDesigner?.creative_intent || "")}</textarea></label>
              <label class="wide">Visual metaphor bias<textarea id="designerMetaphorInput">${escapeHtml(currentDesigner?.style_bias?.visual_metaphor || "")}</textarea></label>
            </div>
          </div>

          <div class="studio-actions">
            <button type="button" class="primary" id="saveDesignerBtn">Save Designer</button>
            <button type="button" class="soft" id="generateDesignerFromBrandBtn">Generate from Brand</button>
          </div>
        </form>
        <aside class="library-panel">
          <div class="section-title compact-title">
            <div>
              <h3>${escapeHtml(currentBrand?.brand_name || "Brand")} Designers</h3>
              <span>Only Designers from this Brand are shown.</span>
            </div>
            <span class="badge">${designersForBrand().length}</span>
          </div>
          <div class="library-list">
            ${designersForBrand().map(renderDesignerCard).join("") || '<div class="glass empty"><p>Create a Designer from this Brand.</p></div>'}
          </div>
        </aside>
      </div>
    </section>
  `;
  bindDesignerStudio();
}

function renderDesignerCard(item) {
  return `
    <article class="profile ${item.designer_id === state.activeDesignerId ? "current" : ""}">
      <div class="profile-top">
        <div class="profile-main">
          <div class="logo" style="--a:#c9bcff;--b:#fffaf1"></div>
          <div>
            <h3>${escapeHtml(item.name)}</h3>
            <p><b>${escapeHtml(item.role || "Designer")}</b><br>${escapeHtml(compactText(item.creative_intent, 92))}</p>
          </div>
        </div>
        <span class="badge">${escapeHtml(item.platform || AUTO_PLATFORM)}</span>
      </div>
      <div class="chips">${[item.type, item.style_bias?.density, item.style_bias?.abstraction].filter(Boolean).map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join("")}</div>
      <p class="meta">${(item.examples || []).length} examples</p>
      <div class="row">
        <button class="soft" data-use-designer="${item.designer_id}">${item.designer_id === state.activeDesignerId ? "Current Designer" : "Use Designer"}</button>
        <button class="tiny danger" data-delete-designer="${item.designer_id}">Delete</button>
      </div>
    </article>
  `;
}

function bindDesignerStudio() {
  $("#designerBrandSelect")?.addEventListener("change", (event) => {
    state.activeBrandId = event.target.value;
    state.activeDesignerId = designerForBrand(event.target.value)?.designer_id || "";
    persistAll();
    render();
  });
  $("#newDesignerBtn")?.addEventListener("click", () => {
    state.activeDesignerId = "";
    render();
  });
  $("#generateDesignerFromBrandBtn")?.addEventListener("click", () => {
    if (!brand()) return toast("Select a Brand first.");
    const generated = createDefaultDesigner(brand());
    state.activeDesignerId = generated.designer_id;
    persistAll();
    render();
    toast("Designer generated from Brand.");
  });
  $("#saveDesignerBtn")?.addEventListener("click", saveDesignerFromForm);
  page.querySelectorAll("[data-use-designer]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.designers.find((entry) => entry.designer_id === button.dataset.useDesigner);
      if (!item) return;
      state.activeBrandId = item.brand_id;
      state.activeDesignerId = item.designer_id;
      persistAll();
      render();
    });
  });
  page.querySelectorAll("[data-delete-designer]").forEach((button) => {
    button.addEventListener("click", () => deleteDesigner(button.dataset.deleteDesigner));
  });
}

function saveDesignerFromForm() {
  const currentBrand = state.brands.find((item) => item.brand_id === $("#designerBrandSelect").value);
  if (!currentBrand) return toast("Select a Brand first.");
  const existing = state.designers.find((item) => item.designer_id === state.activeDesignerId && item.brand_id === currentBrand.brand_id);
  const item = {
    designer_id: existing?.designer_id || uid("designer"),
    brand_id: currentBrand.brand_id,
    name: $("#designerNameInput").value.trim() || `${currentBrand.brand_name} Designer`,
    role: "Brand-bound Visual Designer",
    type: $("#designerTypeInput").value,
    platform: $("#designerPlatformInput").value,
    creative_intent: $("#designerIntentInput").value.trim() || `Translate ${currentBrand.brand_name} into a consistent visual expression.`,
    style_bias: {
      composition: $("#designerCompositionInput").value.trim() || currentBrand.visual_style.composition,
      density: $("#designerDensityInput").value,
      abstraction: $("#designerAbstractionInput").value.trim() || "semi-abstract product metaphor",
      materials: splitList($("#designerMaterialsInput").value),
      typography: currentBrand.typography.english,
      visual_metaphor: $("#designerMetaphorInput").value.trim(),
    },
    allowed_deviation: {
      colors: "brand palette only",
      logo: "fixed overlay only",
      layout: "can vary",
      visual_metaphor: "can vary within Brand rules",
    },
    hard_constraints: {
      cannot_change_logo_rules: true,
      cannot_make_banned_colors_primary: true,
      cannot_generate_logo_or_mascot: true,
      allowed_controls: ["composition", "visual metaphor", "abstraction", "information density", "platform expression", "material mood", "typography hierarchy"],
    },
    examples: existing?.examples || [],
    created_at: existing?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const index = state.designers.findIndex((entry) => entry.designer_id === item.designer_id);
  if (index >= 0) state.designers[index] = item;
  else state.designers.unshift(item);
  state.activeBrandId = item.brand_id;
  state.activeDesignerId = item.designer_id;
  persistAll();
  render();
  toast("Designer saved.");
}

function deleteDesigner(id) {
  const current = state.designers.find((item) => item.designer_id === id);
  if (!current) return;
  const siblings = designersForBrand(current.brand_id);
  if (siblings.length <= 1) return toast("Keep at least one Designer for this Brand.");
  state.designers = state.designers.filter((item) => item.designer_id !== id);
  if (state.activeDesignerId === id) state.activeDesignerId = designerForBrand(state.activeBrandId)?.designer_id || "";
  persistAll();
  render();
}

function splitList(value) {
  return String(value || "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
}

function listify(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (value == null) return [];
  if (typeof value === "object") return Object.values(value).map((item) => String(item || "").trim()).filter(Boolean);
  return splitList(value);
}

function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

async function extractFilesEvidence(files = []) {
  const images = [];
  const pdfs = [];
  for (const file of files) {
    if (file.type.startsWith("image/")) {
      images.push(await extractImageEvidence(file));
    } else if (/pdf/i.test(file.type || file.name)) {
      pdfs.push({ file_name: file.name, file_type: file.type || "application/pdf", size_kb: Math.round(file.size / 1024) });
    }
  }
  const palette = [];
  images.forEach((image) => {
    image.palette.forEach((color) => {
      if (!palette.includes(color.hex)) palette.push(color.hex);
    });
  });
  return {
    files: files.map((file, index) => ({
      file_id: `file_${String(index + 1).padStart(3, "0")}`,
      file_name: file.name,
      file_type: file.type || "unknown",
      size_kb: Math.round((file.size || 0) / 1024),
    })),
    images,
    pdfs,
    palette: palette.slice(0, 6),
    style_summary: images.length ? "image-led brand evidence with extracted palette, composition density, and source-style transfer rules" : "manual brand profile",
    composition_structure: images.map((item) => item.composition_structure).filter(Boolean).join("; ") || "source-led balanced composition",
    materials_lighting: images.map((item) => item.materials_lighting).filter(Boolean).join("; ") || "soft digital surfaces and source-led lighting",
    transferable_rules: [
      "use extracted palette roles",
      "inherit spacing rhythm and focal hierarchy",
      "keep logo and mascot as fixed overlays",
    ],
    do_not_copy: [
      "do not copy exact source layout",
      "do not generate fake logo",
      "do not create unrelated decorative elements",
    ],
    visual_evidence_digest: {
      style_dna: inferStyleDna(images),
      composition_dna: inferCompositionDna(images),
      materials_lighting: Array.from(new Set(images.map((item) => item.materials_lighting).filter(Boolean))).slice(0, 5),
      transfer_rules: [
        "preserve extracted color proportions and color roles",
        "reuse composition rhythm without copying the exact layout",
        "preserve material/light cues that are relevant to the user's request",
      ],
      do_not_copy: [
        "do not copy exact source layout",
        "do not reproduce screenshots, UI chrome, status bars, or watermarks",
        "do not generate fake logo, mascot, or exact brand assets",
      ],
      image_specific_observations: images.map((item) => ({
        file_name: item.file_name,
        screen_content: item.screen_content,
        composition: item.composition_structure,
        main_visual_elements: item.main_visual_elements,
        typography_layout: item.typography_layout,
        brand_assets: item.brand_assets,
        color_proportion: item.color_proportion,
        materials_lighting: item.materials_lighting,
        transferable_rules: item.transferable_rules,
        do_not_copy: item.do_not_copy,
        relevance_to_user_request: item.relevance_to_user_request,
      })),
    },
  };
}

async function extractImageEvidence(file) {
  const dataUrl = await fileToDataUrl(file);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const analysisCanvas = document.createElement("canvas");
      const analysisMax = 768;
      const analysisRatio = Math.min(analysisMax / image.width, analysisMax / image.height, 1);
      analysisCanvas.width = Math.max(1, Math.round(image.width * analysisRatio));
      analysisCanvas.height = Math.max(1, Math.round(image.height * analysisRatio));
      const analysisCtx = analysisCanvas.getContext("2d");
      analysisCtx.drawImage(image, 0, 0, analysisCanvas.width, analysisCanvas.height);
      const analysisImageDataUrl = analysisCanvas.toDataURL("image/jpeg", 0.82);
      const canvas = document.createElement("canvas");
      const max = 96;
      const ratio = Math.min(max / image.width, max / image.height, 1);
      canvas.width = Math.max(1, Math.round(image.width * ratio));
      canvas.height = Math.max(1, Math.round(image.height * ratio));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const sourceThumbDataUrl = canvas.toDataURL("image/jpeg", 0.72);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const buckets = new Map();
      let luminance = 0;
      let saturation = 0;
      const density = Array.from({ length: 9 }, () => ({ value: 0, count: 0 }));
      const saliency = Array.from({ length: 9 }, () => 0);
      for (let i = 0; i < pixels.length; i += 16) {
        const pixelIndex = i / 4;
        const x = pixelIndex % canvas.width;
        const y = Math.floor(pixelIndex / canvas.width);
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const a = pixels[i + 3];
        if (a < 8) continue;
        const key = rgbToHex(Math.round(r / 16) * 16, Math.round(g / 16) * 16, Math.round(b / 16) * 16);
        buckets.set(key, (buckets.get(key) || 0) + 1);
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        luminance += lum;
        saturation += maxC ? (maxC - minC) / maxC : 0;
        const cellX = Math.min(2, Math.floor((x / canvas.width) * 3));
        const cellY = Math.min(2, Math.floor((y / canvas.height) * 3));
        const cell = cellY * 3 + cellX;
        const right = x + 1 < canvas.width ? ((y * canvas.width + x + 1) * 4) : i;
        const down = y + 1 < canvas.height ? (((y + 1) * canvas.width + x) * 4) : i;
        const rightLum = 0.2126 * pixels[right] + 0.7152 * pixels[right + 1] + 0.0722 * pixels[right + 2];
        const downLum = 0.2126 * pixels[down] + 0.7152 * pixels[down + 1] + 0.0722 * pixels[down + 2];
        const edge = Math.abs(lum - rightLum) + Math.abs(lum - downLum);
        density[cell].value += edge + (maxC - minC) * 0.2;
        density[cell].count += 1;
        saliency[cell] += edge + Math.abs(lum - 128) * 0.2 + (maxC - minC) * 0.3;
      }
      const total = Array.from(buckets.values()).reduce((sum, value) => sum + value, 0) || 1;
      const palette = Array.from(buckets.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([hex, count], index) => ({ hex, coverage: `${Math.round((count / total) * 100)}%`, role: index === 0 ? "background/surface" : index < 3 ? "accent/depth" : "support" }));
      const avgLum = luminance / Math.max(1, pixels.length / 16);
      const avgSat = saturation / Math.max(1, pixels.length / 16);
      const densityGrid = density.map((cell) => Math.round(Math.min(100, (cell.value / Math.max(1, cell.count)) / 2.8)));
      const hotCell = saliency.indexOf(Math.max(...saliency));
      const focalRegion = ["top-left", "top-center", "top-right", "middle-left", "center", "middle-right", "bottom-left", "bottom-center", "bottom-right"][hotCell] || "center";
      const colorProportion = palette.map((item) => `${item.hex} ${item.coverage} ${item.role}`).join("; ");
      const aspect = image.width / image.height;
      const isLight = avgLum > 175;
      const isLowSat = avgSat < 0.22;
      resolve({
        file_name: file.name,
        source_thumb_data_url: sourceThumbDataUrl,
        analysis_image_data_url: analysisImageDataUrl,
        analysis_image_mime: "image/jpeg",
        screen_content: inferScreenContent(file, aspect),
        dimensions: { width: image.width, height: image.height },
        aspect_ratio: Number(aspect.toFixed(2)),
        palette,
        advanced_visual_metrics: {
          average_luminance: Math.round(avgLum),
          average_saturation: Number(avgSat.toFixed(2)),
          density_grid_3x3: densityGrid,
          visual_focus_region: focalRegion,
          dominant_palette_count: palette.length,
        },
        composition_structure: inferCompositionStructure(aspect, focalRegion, densityGrid),
        main_visual_elements: inferVisualElements(avgLum, avgSat, densityGrid),
        typography_layout: inferTypographyLayout(densityGrid, aspect),
        brand_assets: inferBrandAssets(file.name),
        color_proportion: colorProportion,
        textures_materials: inferTextures(avgLum, avgSat, densityGrid),
        lighting_depth: isLight ? "high-key or bright ambient lighting with low visual heaviness" : "controlled darker depth with more pronounced contrast",
        materials_lighting: `${isLight ? "high-key surfaces" : "controlled shadow depth"} with ${isLowSat ? "low-saturation restrained palette" : "noticeable accent color energy"}`,
        transferable_rules: [
          `preserve ${focalRegion} focal rhythm`,
          isLight ? "keep the light surface dominance" : "keep contrast depth controlled",
          isLowSat ? "use accents sparingly" : "keep accent colors intentional and role-based",
        ],
        do_not_copy: [
          "do not copy exact source layout",
          "do not reproduce UI chrome or screenshot artifacts",
          "do not hallucinate or redraw logos/mascots",
        ],
        relevance_to_user_request: state.imageRequest ? "Use this as style evidence only; adapt it to the user's current image goal." : "Use this as Brand style evidence for future generation.",
        photo_design_reading: "source image translated into palette, crop rhythm, density, focal region, typography inference, and material/light cues",
        photographic_prompt_rules: ["carry over crop feel", "carry over surface light", "carry over focal rhythm", "avoid exact layout copy"],
        composition_DNA: "source focal hierarchy and balance without copying exact layout",
      });
    };
    image.onerror = () => resolve({ file_name: file.name, palette: [], composition_structure: "image could not be inspected" });
    image.src = dataUrl;
  });
}

function inferScreenContent(file, aspect) {
  if (/logo|mark|icon/i.test(file.name)) return "likely logo or brand mark asset";
  if (/ppt|slide|deck/i.test(file.name)) return "likely presentation or slide reference";
  if (aspect < 0.65) return "likely mobile screenshot or vertical social/reference image";
  if (aspect > 1.7) return "likely wide banner, slide, or web hero reference";
  return "likely brand image, poster, product, or social reference";
}

function inferCompositionStructure(aspect, focalRegion, densityGrid) {
  const centerWeight = densityGrid[4];
  const topWeight = densityGrid[0] + densityGrid[1] + densityGrid[2];
  const bottomWeight = densityGrid[6] + densityGrid[7] + densityGrid[8];
  const orientation = aspect > 1.2 ? "horizontal" : aspect < 0.82 ? "vertical" : "near-square";
  const balance = Math.abs(topWeight - bottomWeight) < 28 ? "balanced" : topWeight > bottomWeight ? "top-weighted" : "bottom-weighted";
  return `${orientation} ${balance} composition; strongest visual activity around ${focalRegion}; ${centerWeight > 45 ? "central focal density is high" : "central focal density is restrained"}`;
}

function inferVisualElements(avgLum, avgSat, densityGrid) {
  const items = ["brand color fields", "surface/background system"];
  if (Math.max(...densityGrid) > 55) items.push("high-detail focal zones");
  else items.push("minimal/quiet focal zones");
  if (avgLum > 175) items.push("bright negative-space surfaces");
  if (avgSat > 0.28) items.push("clear accent-color elements");
  items.push("typographic or layout hierarchy cues");
  return items;
}

function inferTypographyLayout(densityGrid, aspect) {
  const left = densityGrid[0] + densityGrid[3] + densityGrid[6];
  const right = densityGrid[2] + densityGrid[5] + densityGrid[8];
  if (Math.abs(left - right) > 35) return left > right ? "likely left-weighted text or information column" : "likely right-weighted text or information column";
  if (aspect > 1.3) return "likely horizontal title/hero hierarchy with room for overlay typography";
  return "likely stacked title/body hierarchy or centered content";
}

function inferBrandAssets(fileName) {
  const assets = [];
  if (/logo|mark|wordmark/i.test(fileName)) assets.push("logo/wordmark reference");
  if (/mascot|character|ip/i.test(fileName)) assets.push("mascot/IP reference");
  return assets.length ? assets : ["brand visual reference, not a fixed asset unless confirmed"];
}

function inferTextures(avgLum, avgSat, densityGrid) {
  const maxDensity = Math.max(...densityGrid);
  const textures = [];
  if (avgLum > 180) textures.push("clean high-key surface");
  if (avgSat < 0.18) textures.push("restrained matte or neutral finish");
  if (maxDensity > 58) textures.push("visible texture/detail zones");
  else textures.push("smooth minimal surface treatment");
  return textures;
}

function inferStyleDna(images) {
  const dna = new Set();
  images.forEach((item) => {
    if (item.advanced_visual_metrics?.average_luminance > 175) dna.add("high-key clean surface");
    if (item.advanced_visual_metrics?.average_saturation < 0.22) dna.add("low-saturation restraint");
    if (Math.max(...(item.advanced_visual_metrics?.density_grid_3x3 || [0])) > 55) dna.add("detail-led focal contrast");
    else dna.add("minimal focal clarity");
    (item.main_visual_elements || []).slice(0, 2).forEach((part) => dna.add(part));
  });
  return Array.from(dna).slice(0, 8);
}

function inferCompositionDna(images) {
  return Array.from(new Set(images.map((item) => item.composition_structure).filter(Boolean))).slice(0, 6);
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function installDebugBridge() {
  window.__annaVisualBrandMvp = {
    listBrands: () => JSON.parse(JSON.stringify(state.brands)),
    listDesigners: () => JSON.parse(JSON.stringify(state.designers)),
    getLatestPackage: () => JSON.parse(JSON.stringify(state.latestPackage)),
    getLatestGeneratedImage: () => JSON.parse(JSON.stringify(state.latestGeneratedImage)),
    getGeneratedPreviews: () => JSON.parse(JSON.stringify(state.generatedPreviews)),
    getPreviewErrors: () => JSON.parse(JSON.stringify(state.previewErrors)),
    getLatestImageGenerationPayload: () => JSON.parse(JSON.stringify(buildImageGenerationPayload(state.latestPackage))),
    buildImageGenerationPayload: () => JSON.parse(JSON.stringify(buildImageGenerationPayload(state.latestPackage))),
  };
}

function bindShell() {
  $("#imageNav").addEventListener("click", () => {
    state.view = "image";
    render();
  });
  $("#brandNav").addEventListener("click", () => {
    state.view = "brand";
    render();
  });
  $("#designerNav").addEventListener("click", () => {
    state.view = "designer";
    render();
  });
  $("#minimizeBtn").addEventListener("click", () => $("#shell").classList.toggle("min"));
}

async function init() {
  bindShell();
  seedDemoData();
  await loadAllStorage();
  installDebugBridge();
  render();
  connectRuntime();
}

init();
