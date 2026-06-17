import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

export type FileExtractionResult = {
  text: string;
  rawContent?: string;
  status: "saved" | "extracted" | "failed";
  error?: string;
  title?: string;
};

function normalizeExtractedText(value: string) {
  return value
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripRtf(value: string) {
  return normalizeExtractedText(
    value
      .replace(/\\'[0-9a-fA-F]{2}/g, " ")
      .replace(/\\[a-z]+\d* ?/g, " ")
      .replace(/[{}]/g, " ")
  );
}

const articleSelectors = [
  "article",
  "main article",
  "[role='article']",
  "[itemprop='articleBody']",
  ".post-content",
  ".article-content",
  ".entry-content",
  ".markdown-body",
  ".prose",
  ".docs-content",
  ".doc-content",
  ".content",
  "main",
  "[role='main']",
];

const boilerplateSelector = [
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  "canvas",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "[role='navigation']",
  "[aria-label*='navigation' i]",
  "[aria-label*='menu' i]",
  ".nav",
  ".navbar",
  ".sidebar",
  ".toc",
  ".menu",
  ".breadcrumb",
  ".footer",
  ".header",
  ".cookie",
  ".share",
  ".social",
  ".related",
].join(", ");

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function urlHash(url?: string) {
  if (!url) return "";
  try {
    return safeDecode(new URL(url).hash.replace(/^#/, "").trim());
  } catch {
    return "";
  }
}

function cssEscape(value: string) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return value.replace(/["\\#.:,[\]()]/g, "\\$&");
}

function linkDensity(element: Element) {
  const textLength = normalizeExtractedText(element.textContent || "").length || 1;
  const linkLength = Array.from(element.querySelectorAll("a"))
    .reduce((total, link) => total + normalizeExtractedText(link.textContent || "").length, 0);
  return linkLength / textLength;
}

function headingLevel(element: Element) {
  const match = element.tagName.match(/^H([1-6])$/i);
  return match ? Number(match[1]) : 0;
}

function scoreReadableElement(element: Element) {
  const text = normalizeExtractedText(element.textContent || "");
  if (text.length < 160) return 0;
  const paragraphs = element.querySelectorAll("p, li, blockquote").length;
  const headings = element.querySelectorAll("h1, h2, h3").length;
  const densityPenalty = Math.min(1, linkDensity(element)) * 1200;
  const className = String((element as HTMLElement).className || "");
  const semanticBoost = /article|post|content|entry|markdown|prose|doc/i.test(`${element.tagName} ${className}`) ? 900 : 0;
  return text.length + paragraphs * 130 + headings * 70 + semanticBoost - densityPenalty;
}

function findHashTarget(doc: Document, hash: string) {
  if (!hash) return null;
  const escaped = cssEscape(hash);
  return (
    doc.getElementById(hash) ||
    doc.querySelector(`[name="${escaped}"]`) ||
    doc.querySelector(`[href="#${escaped}"]`) ||
    doc.querySelector(`[data-id="${escaped}"], [data-anchor="${escaped}"]`)
  );
}

function extractSectionFromTarget(target: Element) {
  const container = target.closest("section, article, [role='article'], .section, .docs-section");
  if (container) {
    const text = normalizeExtractedText(container.textContent || "");
    if (text.length > 180 && linkDensity(container) < 0.7) return text;
  }

  const heading = headingLevel(target) ? target : target.closest("h1, h2, h3, h4, h5, h6");
  if (!heading) return normalizeExtractedText(target.textContent || "");

  const level = headingLevel(heading);
  const parts: string[] = [heading.textContent || ""];
  let node = heading.nextElementSibling;
  while (node) {
    const nextLevel = headingLevel(node);
    if (nextLevel && nextLevel <= level) break;
    parts.push(node.textContent || "");
    node = node.nextElementSibling;
  }
  return normalizeExtractedText(parts.join("\n\n"));
}

function stripMarkdownDecorations(value: string) {
  return normalizeExtractedText(
    value
      .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      .replace(/^\s*[*+-]\s+/gm, "")
      .replace(/^\s*#{1,6}\s*/gm, "")
      .replace(/^\s*>+\s?/gm, "")
      .replace(/`{1,3}/g, "")
  );
}

function lineLooksLikeBoilerplate(line: string) {
  const cleaned = line.trim();
  if (!cleaned) return true;
  if (/^(download|developers|docs|forum|sign in|product|legal|connect|copyright|©|terms|privacy|contact)$/i.test(cleaned)) return true;
  if (/^(getting started|core capabilities|other features|scenarios|faq)$/i.test(cleaned)) return true;
  if ((cleaned.match(/\[[^\]]+]\([^)]*\)/g) || []).length >= 2 && cleaned.length < 360) return true;
  if (/^\*?\s*\[[^\]]+]\([^)]*\)\s*$/.test(cleaned)) return true;
  if (/^\[.*]\([^)]*\)$/.test(cleaned) && cleaned.length < 120) return true;
  if (/^image\s+\d+/i.test(cleaned)) return true;
  return false;
}

function extractMarkdownSection(markdown: string, hash: string) {
  if (!hash) return "";
  const normalizedHash = hash.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
  const anchorLabelPattern = new RegExp(`\\[([^\\]]+)]\\([^)]*#${hash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`, "i");
  const anchorLabel = markdown.match(anchorLabelPattern)?.[1];
  const normalizedAnchorLabel = anchorLabel
    ? stripMarkdownDecorations(anchorLabel).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "")
    : "";
  const lines = markdown.split(/\n/);
  let start = -1;
  let level = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (!heading) continue;
    const plainHeading = stripMarkdownDecorations(heading[2]).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
    const hashMatch = plainHeading.includes(normalizedHash) || normalizedHash.includes(plainHeading);
    const labelMatch = normalizedAnchorLabel && (plainHeading.includes(normalizedAnchorLabel) || normalizedAnchorLabel.includes(plainHeading));
    if (!hashMatch && !labelMatch) continue;
    start = index;
    level = heading[1].length;
    break;
  }

  if (start < 0) return "";
  const parts: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s+/);
    if (index > start && heading && heading[1].length <= level) break;
    parts.push(lines[index]);
  }
  return stripMarkdownDecorations(parts.join("\n"));
}

function cleanReaderMarkdown(raw: string, url: string): { title?: string; text: string } {
  const title = raw.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
  const hash = urlHash(url);
  const afterMarker = raw.includes("Markdown Content:")
    ? raw.split("Markdown Content:").slice(1).join("Markdown Content:")
    : raw;
  const section = extractMarkdownSection(afterMarker, hash);
  const source = section || afterMarker;
  const cleanedLines = source
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => !lineLooksLikeBoilerplate(line));
  const cleaned = stripMarkdownDecorations(cleanedLines.join("\n"));
  return { title, text: cleaned };
}

function readableWordCount(value: string) {
  return value.split(/\s+/).filter(Boolean).length;
}

function looksLikeNavigationText(value: string) {
  const text = normalizeExtractedText(value);
  if (!text) return true;
  const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const navTerms = [
    "download",
    "developers",
    "docs",
    "forum",
    "sign in",
    "getting started",
    "core capabilities",
    "other features",
    "scenarios",
    "faq",
    "privacy policy",
    "terms of service",
  ];
  const navHits = navTerms.reduce((total, term) => total + (text.toLowerCase().includes(term) ? 1 : 0), 0);
  const shortLineRatio = lines.length ? lines.filter((line) => line.length < 42).length / lines.length : 0;
  return navHits >= 5 && shortLineRatio > 0.48 && readableWordCount(text) < 260;
}

function resolveUrl(baseUrl: string, value: string) {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return "";
  }
}

function extractScriptUrls(rawHtml: string, pageUrl: string) {
  const scripts = Array.from(rawHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi))
    .map((match) => resolveUrl(pageUrl, match[1]))
    .filter(Boolean);
  return Array.from(new Set(scripts)).slice(0, 8);
}

function extractApiBasesFromScript(script: string, pageUrl: string) {
  const bases = Array.from(script.matchAll(/\bAPI_BASE\b\s*=\s*["']([^"']+)["']/g))
    .map((match) => resolveUrl(pageUrl, match[1]))
    .filter(Boolean);
  return Array.from(new Set(bases));
}

function commonDocsApiBases(pageUrl: string) {
  try {
    const url = new URL(pageUrl);
    return [
      `${url.origin}/api/v1/docs`,
      `${url.origin}/api/docs`,
      `${url.origin}/docs/api`,
    ];
  } catch {
    return [];
  }
}

function extractJsonPayload(raw: string) {
  const source = raw.includes("Markdown Content:")
    ? raw.split("Markdown Content:").slice(1).join("Markdown Content:")
    : raw;
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(source.slice(first, last + 1));
  } catch {
    return null;
  }
}

function extractTitleFromMarkdown(markdown: string) {
  return stripMarkdownDecorations(markdown.match(/^#\s+(.+)$/m)?.[1] || "");
}

function extractDocApiPayload(raw: string): { title?: string; text: string } | null {
  const payload = extractJsonPayload(raw);
  if (!payload || typeof payload !== "object") return null;
  const content = typeof payload.content === "string" ? payload.content : "";
  if (!content) return null;
  const title = normalizeExtractedText(
    typeof payload.title === "string" ? payload.title : extractTitleFromMarkdown(content)
  );
  const text = stripMarkdownDecorations(content);
  if (text.length < 180) return null;
  return { title: title || extractTitleFromMarkdown(content) || undefined, text };
}

async function fetchText(url: string, ms = 10000) {
  const timeout = withTimeout(ms);
  try {
    const response = await fetch(url, { signal: timeout.signal, headers: { Accept: "text/plain, application/json, text/html" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    timeout.done();
  }
}

async function fetchDocApiContent(apiUrl: string): Promise<{ title?: string; text: string; rawContent: string } | null> {
  try {
    const raw = await fetchText(apiUrl, 10000);
    const extracted = extractDocApiPayload(raw);
    if (extracted) return { ...extracted, rawContent: raw };
  } catch {
    // Cross-origin APIs often block browser fetches; the reader proxy can still expose JSON text.
  }

  try {
    const raw = await fetchText(`https://r.jina.ai/${apiUrl}`, 16000);
    const extracted = extractDocApiPayload(raw);
    if (extracted) return { ...extracted, rawContent: raw };
  } catch {
    return null;
  }
  return null;
}

async function discoverDocsApiBases(rawHtml: string | undefined, pageUrl: string) {
  const bases = commonDocsApiBases(pageUrl);
  if (!rawHtml) return Array.from(new Set(bases));

  const scriptUrls = extractScriptUrls(rawHtml, pageUrl);
  const scriptTexts = await Promise.all(
    scriptUrls.map(async (scriptUrl) => {
      try {
        return await fetchText(scriptUrl, 9000);
      } catch {
        return "";
      }
    })
  );

  scriptTexts.forEach((script) => {
    extractApiBasesFromScript(script, pageUrl).forEach((base) => bases.unshift(base));
  });
  return Array.from(new Set(bases));
}

async function fetchDynamicDocumentText(pageUrl: string, rawHtml?: string): Promise<FileExtractionResult | null> {
  const slug = urlHash(pageUrl);
  if (!slug) return null;
  const apiBases = await discoverDocsApiBases(rawHtml, pageUrl);

  for (const apiBase of apiBases) {
    const apiUrl = `${apiBase.replace(/\/$/, "")}/content/${encodeURIComponent(slug)}`;
    const extracted = await fetchDocApiContent(apiUrl);
    if (extracted) {
      return {
        text: extracted.text,
        rawContent: extracted.rawContent,
        status: "extracted",
        title: extracted.title,
      };
    }
  }
  return null;
}

function extractHtmlText(value: string, url?: string): { title?: string; text: string } {
  const doc = new DOMParser().parseFromString(value, "text/html");
  doc.querySelectorAll(boilerplateSelector).forEach((node) => node.remove());
  const title = normalizeExtractedText(
    doc.querySelector("meta[property='og:title']")?.getAttribute("content") ||
    doc.querySelector("meta[name='twitter:title']")?.getAttribute("content") ||
    doc.querySelector("h1")?.textContent ||
    doc.querySelector("title")?.textContent ||
    ""
  );
  const targetText = extractSectionFromTarget(findHashTarget(doc, urlHash(url)) || doc.createElement("span"));
  if (targetText.length > 180) return { title: title || undefined, text: targetText };

  const candidates = articleSelectors
    .flatMap((selector) => Array.from(doc.querySelectorAll(selector)))
    .filter((element, index, list) => list.indexOf(element) === index);
  const article = candidates.sort((a, b) => scoreReadableElement(b) - scoreReadableElement(a))[0];
  const bodyText = normalizeExtractedText((article || doc.body || doc.documentElement).textContent || "");
  return { title: title || undefined, text: bodyText };
}

function withTimeout(ms = 14000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => window.clearTimeout(timer) };
}

async function fetchReadableText(url: string): Promise<FileExtractionResult> {
  const timeout = withTimeout();
  try {
    const response = await fetch(url, { signal: timeout.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = await response.text();
    const contentType = response.headers.get("content-type") || "";
    const extracted = contentType.includes("text/html") ? extractHtmlText(raw, url) : { text: normalizeExtractedText(raw), title: undefined };
    if (contentType.includes("text/html") && looksLikeNavigationText(extracted.text)) {
      const dynamic = await fetchDynamicDocumentText(url, raw);
      if (dynamic) return dynamic;
    }
    if (!extracted.text) throw new Error("No readable text found.");
    return { text: extracted.text, rawContent: raw, status: "extracted", title: extracted.title };
  } finally {
    timeout.done();
  }
}

async function fetchViaReader(url: string): Promise<FileExtractionResult> {
  const timeout = withTimeout(22000);
  try {
    const response = await fetch(`https://r.jina.ai/${url}`, {
      signal: timeout.signal,
      headers: { Accept: "text/plain" },
    });
    if (!response.ok) throw new Error(`Reader HTTP ${response.status}`);
    const raw = await response.text();
    const extracted = cleanReaderMarkdown(raw, url);
    const text = extracted.text;
    if (looksLikeNavigationText(text)) {
      const dynamic = await fetchDynamicDocumentText(url);
      if (dynamic) return dynamic;
    }
    if (!text) throw new Error("Reader returned no text.");
    return { text, rawContent: raw, status: "extracted", title: extracted.title };
  } finally {
    timeout.done();
  }
}

function readAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read this file in the browser."));
    reader.readAsText(file);
  });
}

function readAsArrayBuffer(file: File) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error("Could not read this file in the browser."));
    reader.readAsArrayBuffer(file);
  });
}

async function extractDocx(file: File): Promise<FileExtractionResult> {
  const arrayBuffer = await readAsArrayBuffer(file);
  const mammoth = await import("mammoth/mammoth.browser");
  const result = await mammoth.extractRawText({ arrayBuffer });
  const text = normalizeExtractedText(result.value || "");
  if (!text) {
    return {
      text: "",
      rawContent: "",
      status: "failed",
      error: "No readable text was found in this Word document.",
    };
  }
  return { text, rawContent: text, status: "extracted" };
}

async function extractPdf(file: File): Promise<FileExtractionResult> {
  const arrayBuffer = await readAsArrayBuffer(file);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const pageTexts: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
    if (text.trim()) pageTexts.push(text);
  }

  const extracted = normalizeExtractedText(pageTexts.join("\n\n"));
  if (!extracted) {
    return {
      text: "",
      rawContent: "",
      status: "failed",
      error: "No selectable text was found in this PDF. If it is a scanned PDF, paste OCR text instead.",
    };
  }
  return { text: extracted, rawContent: extracted, status: "extracted" };
}

export async function extractTextFromFile(file: File): Promise<FileExtractionResult> {
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith(".docx")) return extractDocx(file);
    if (name.endsWith(".pdf")) return extractPdf(file);

    const raw = await readAsText(file);
    const text = name.endsWith(".rtf") ? stripRtf(raw) : normalizeExtractedText(raw);
    if (!text) {
      return {
        text: "",
        rawContent: raw,
        status: "failed",
        error: "This file was readable, but it did not contain useful text.",
      };
    }
    return { text, rawContent: raw, status: "saved" };
  } catch (error) {
    return {
      text: "",
      status: "failed",
      error: error instanceof Error ? error.message : "Could not extract text from this file.",
    };
  }
}

export async function extractTextFromUrl(url: string): Promise<FileExtractionResult> {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return { text: "", status: "failed", error: "Enter a valid http(s) URL." };
  }

  try {
    return await fetchReadableText(trimmed);
  } catch (directError) {
    try {
      const dynamic = await fetchDynamicDocumentText(trimmed);
      if (dynamic) return dynamic;
      return await fetchViaReader(trimmed);
    } catch (readerError) {
      const error = readerError instanceof Error ? readerError.message : directError instanceof Error ? directError.message : "Could not fetch this page.";
      return { text: "", status: "failed", error };
    }
  }
}
