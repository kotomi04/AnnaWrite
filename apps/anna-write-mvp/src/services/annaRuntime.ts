export interface AnnaCompleteResult {
  role?: string;
  content?: Array<{ type?: string; text?: string }> | { type?: string; text?: string } | string;
  text?: string;
  model?: string;
  stopReason?: string;
  usage?: Record<string, number>;
}

export interface AnnaRuntime {
  llm?: {
    complete: (request: {
      messages: Array<{ role: "system" | "user" | "assistant"; content: { type: "text"; text: string } }>;
      maxTokens?: number;
      max_tokens?: number;
      temperature?: number;
      metadata?: Record<string, unknown>;
    }) => Promise<AnnaCompleteResult>;
  };
  storage?: Record<string, (request?: unknown) => Promise<unknown>>;
  chat?: Record<string, (request?: unknown) => Promise<unknown>>;
  window?: Record<string, (request?: unknown) => Promise<unknown>>;
}

declare global {
  interface Window {
    AnnaAppRuntime?: {
      connect: (options?: { windowUuid?: string; token?: string }) => Promise<AnnaRuntime>;
    };
    anna?: AnnaRuntime;
  }
}

let sdkLoadAttempted = false;
let runtimePromise: Promise<AnnaRuntime | null> | null = null;
let lastError = "";

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
};

type RuntimeConnectOptions = {
  windowUuid?: string;
  token?: string;
};

function uuid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildNamespace(runtime: BundledAnnaRuntime, namespace: string) {
  return new Proxy(
    {},
    {
      get(_, method) {
        if (typeof method !== "string") return undefined;
        return (args?: unknown) => runtime.call(namespace, method, args ?? {});
      },
    },
  ) as Record<string, (request?: unknown) => Promise<unknown>>;
}

class BundledAnnaRuntime implements AnnaRuntime {
  llm = buildNamespace(this, "llm") as AnnaRuntime["llm"];
  storage = buildNamespace(this, "storage");
  chat = buildNamespace(this, "chat");
  window = buildNamespace(this, "window");

  private readonly pending = new Map<string, PendingCall>();
  private readonly parentWindow: Window;
  private readonly windowUuid: string;
  private token: string;
  private heartbeat: number | null = null;

  constructor(options: { windowUuid: string; token: string; parent?: Window }) {
    this.windowUuid = options.windowUuid;
    this.token = options.token;
    this.parentWindow = options.parent ?? window.parent;
    window.addEventListener("message", (event) => this.onMessage(event));
  }

  static async connect(options: RuntimeConnectOptions = {}) {
    const params = new URLSearchParams(window.location.search);
    const windowUuid = options.windowUuid || params.get("wid");
    const token = options.token || params.get("t");
    if (!windowUuid || !token) {
      throw new Error("[anna-sdk] missing wid/t URL parameters");
    }

    const runtime = new BundledAnnaRuntime({ windowUuid, token });
    await runtime.call("window", "hello", {});
    runtime.startHeartbeat();
    runtime.call("window", "ready", {}).catch(() => {});
    return runtime;
  }

  call(namespace: string, method: string, args: unknown, { timeoutMs = 30000 } = {}) {
    const id = uuid();
    return new Promise<unknown>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${namespace}.${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.parentWindow.postMessage({ wid: this.windowUuid, t: this.token, kind: "req", id, ns: namespace, method, args: args ?? {} }, "*");
    });
  }

  private startHeartbeat() {
    this.heartbeat = window.setInterval(() => {
      this.call("window", "ready", {}).catch(() => {});
    }, 10000);
  }

  private onMessage(event: MessageEvent) {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.wid && message.wid !== this.windowUuid) return;

    if (message.kind === "event" && message.event === "auth.refresh" && message.token) {
      this.token = String(message.token);
      return;
    }

    if (message.kind !== "res") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    window.clearTimeout(pending.timer);

    if (message.error) {
      const error = new Error(message.error.message || "Anna RPC error");
      pending.reject(error);
      return;
    }
    pending.resolve(message.result);
  }
}

function installBundledRuntime() {
  if (window.AnnaAppRuntime) return;
  window.AnnaAppRuntime = BundledAnnaRuntime;
}

type AnnaCredentials = {
  wid: string;
  token: string;
  source: string;
};

function credentialsFromValue(value: string | undefined, source: string): AnnaCredentials | null {
  if (!value) return null;

  const raw = value.startsWith("?") || value.startsWith("#") ? value.slice(1) : value;
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
  const params = new URLSearchParams(query);
  const wid = params.get("wid");
  const token = params.get("t");
  return wid && token ? { wid, token, source } : null;
}

function readWindowCredentials(target: Window, label: string): AnnaCredentials | null {
  try {
    return (
      credentialsFromValue(target.location.search, `${label}.search`) ||
      credentialsFromValue(target.location.hash, `${label}.hash`) ||
      credentialsFromValue(target.location.href, `${label}.href`)
    );
  } catch {
    return null;
  }
}

export function getAnnaSessionCredentials(): AnnaCredentials | null {
  return (
    readWindowCredentials(window, "window") ||
    readWindowCredentials(window.parent, "parent") ||
    readWindowCredentials(window.top ?? window, "top") ||
    credentialsFromValue(document.referrer, "document.referrer")
  );
}

export function hasAnnaSessionCredentials() {
  return Boolean(getAnnaSessionCredentials());
}

export function isAnnaEntryPreview() {
  return window.location.pathname.includes("/anna-apps/") && !hasAnnaSessionCredentials() && !window.anna?.llm?.complete;
}

function waitForScript(src: string, timeoutMs = 1600) {
  return new Promise<void>((resolve) => {
    const script = document.createElement("script");
    const timer = window.setTimeout(() => resolve(), timeoutMs);
    script.src = src;
    script.defer = true;
    script.onload = () => {
      window.clearTimeout(timer);
      resolve();
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      resolve();
    };
    document.head.appendChild(script);
  });
}

async function loadRuntimeSdk() {
  if (sdkLoadAttempted) return;
  sdkLoadAttempted = true;
  installBundledRuntime();
  if (window.AnnaAppRuntime) return;
  await waitForScript("/static/anna-apps/_sdk/latest/index.js");
  if (!window.AnnaAppRuntime) {
    await waitForScript("/static/anna-apps/_sdk/0.1.0/index.js");
  }
}

export function getLastAnnaRuntimeError() {
  return lastError;
}

export function getAnnaRuntimeHint() {
  if (window.anna?.llm?.complete) return "";
  if (isAnnaEntryPreview()) {
    return "Entry preview has no Anna session token. Anna LLM needs wid/t from the host runtime.";
  }
  return lastError;
}

export function hasAnnaRuntimeGlobal() {
  return Boolean(window.anna?.llm?.complete || window.AnnaAppRuntime);
}

export async function getAnnaRuntime() {
  if (window.anna?.llm?.complete) return window.anna;

  if (!window.AnnaAppRuntime) {
    await loadRuntimeSdk();
  }

  if (!window.AnnaAppRuntime) {
    lastError = "AnnaAppRuntime global is not available on this page.";
    return null;
  }

  const credentials = getAnnaSessionCredentials();
  if (!credentials) {
    lastError = "Entry preview has no Anna session token. Anna LLM needs wid/t from the host runtime.";
    return null;
  }

  runtimePromise ??= window.AnnaAppRuntime.connect({ windowUuid: credentials.wid, token: credentials.token })
    .then((runtime) => {
      window.anna = runtime;
      lastError = "";
      return runtime;
    })
    .catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      return null;
    });

  return runtimePromise;
}

export function extractAnnaText(result: AnnaCompleteResult) {
  if (typeof result?.content === "string") return result.content;
  if (Array.isArray(result?.content)) {
    return result.content.map((item) => item.text ?? "").join("").trim();
  }
  if (typeof result?.content?.text === "string") return result.content.text;
  if (typeof result?.text === "string") return result.text;
  return "";
}

export async function annaCompleteText(args: {
  name: string;
  system: string;
  user: unknown;
  maxTokens?: number;
  temperature?: number;
}) {
  const runtime = await getAnnaRuntime();
  if (!runtime?.llm?.complete) return null;

  try {
    const result = await Promise.race([
      runtime.llm.complete({
        messages: [
          { role: "system", content: { type: "text", text: args.system } },
          { role: "user", content: { type: "text", text: JSON.stringify(args.user, null, 2) } },
        ],
        maxTokens: args.maxTokens ?? 2400,
        temperature: args.temperature ?? 0.25,
        metadata: { app: "annawrite", action: args.name },
      }),
      new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("anna.llm.complete timed out")), 45000)),
    ]);

    lastError = "";
    return extractAnnaText(result);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

export function parseJsonFromText<T>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const jsonText = start >= 0 && end >= start ? cleaned.slice(start, end + 1) : cleaned;
  return JSON.parse(jsonText) as T;
}
