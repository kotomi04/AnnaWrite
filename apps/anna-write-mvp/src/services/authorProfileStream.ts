import type { Author, AuthorSample } from "../types";
import { formatStyleManualFromAnalysis } from "./authorProfile";
import { llmService } from "./llmService";

const WAIT_STATUSES = [
  "Reading uploaded samples…",
  "Comparing openings, rhythm, and word choice…",
  "Looking for repeated moves instead of generic labels…",
];

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function streamText(
  text: string,
  onChunk: (partial: string) => void,
  signal?: AbortSignal,
) {
  const normalized = text.trim();
  if (!normalized) {
    onChunk("");
    return;
  }
  const step = /[\u4e00-\u9fff]/.test(normalized) ? 4 : 12;
  for (let index = step; index < normalized.length; index += step) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    onChunk(normalized.slice(0, index));
    await delay(18, signal);
  }
  onChunk(normalized);
}

export async function streamAuthorProfileText({
  author,
  samples,
  signal,
  onStatus,
  onLog,
  onTextChange,
}: {
  author: Author;
  samples: AuthorSample[];
  signal?: AbortSignal;
  onStatus: (message: string) => void;
  onLog: (message: string) => void;
  onTextChange: (partial: string) => void;
}) {
  let waitIndex = 0;
  const waitTimer = window.setInterval(() => {
    onStatus(WAIT_STATUSES[waitIndex % WAIT_STATUSES.length]);
    onLog(WAIT_STATUSES[waitIndex % WAIT_STATUSES.length]);
    waitIndex += 1;
  }, 1400);

  try {
    const result = await llmService.analyzeAuthorSamples(author, samples);
    window.clearInterval(waitTimer);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    onStatus("Writing style summary…");
    onLog("Turning sample patterns into an editable profile…");
    const manual = formatStyleManualFromAnalysis(result) || result.style_summary;
    await streamText(manual, onTextChange, signal);
    onStatus("Profile ready to review");
    onLog("Finished — edit the summary below, then save.");
    return manual;
  } catch (error) {
    window.clearInterval(waitTimer);
    throw error;
  }
}
