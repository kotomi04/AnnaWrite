import { Bot, CheckCircle2, ChevronDown, Loader2 } from "lucide-react";
import { useState } from "react";
import type { LlmTraceEvent } from "../types";

interface LlmTracePanelProps {
  traces: LlmTraceEvent[];
  activeTrace?: LlmTraceEvent;
}

export function LlmTracePanel({ traces, activeTrace }: LlmTracePanelProps) {
  const [open, setOpen] = useState(false);
  const latest = activeTrace ?? traces[0];

  if (!latest) return null;

  return (
    <aside className={`llm-trace ${open ? "open" : ""}`}>
      <button className="llm-trace-button" onClick={() => setOpen((value) => !value)}>
        <div className="flex min-w-0 items-center gap-2">
          <div className="llm-trace-icon">
            {latest?.status === "running" ? <Loader2 className="animate-spin" size={16} /> : <Bot size={16} />}
          </div>
          <div className="llm-trace-copy">
            <div>AI log</div>
            <span>
              {latest ? `${latest.name} · ${latest.status}${latest.output ? ` · ${latest.output}` : ""}` : "Ready. No calls yet."}
            </span>
          </div>
        </div>
        <ChevronDown className={`shrink-0 text-muted transition ${open ? "rotate-180" : ""}`} size={16} />
      </button>

      {open ? (
        <div className="llm-trace-list">
          {traces.length === 0 ? (
            <p className="text-xs leading-5 text-muted">Generate requirements, analyze an author, or create a draft to see Anna or mock prompt usage here.</p>
          ) : (
            <div className="grid gap-3">
              {traces.slice(0, 6).map((trace) => (
                <article className="rounded-2xl border border-white/70 bg-white/55 p-3" key={trace.id}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-extrabold text-ink">
                      {trace.status === "running" ? <Loader2 className="animate-spin text-violet" size={14} /> : <CheckCircle2 className="text-emerald-600" size={14} />}
                      {trace.name}
                    </div>
                    <span className="text-[10px] font-bold uppercase text-muted">{trace.status}</span>
                  </div>
                  <div className="grid gap-2 text-[11px] leading-5 text-graphite">
                    <p>
                      <strong>Input:</strong> {trace.input}
                    </p>
                    {trace.output ? (
                      <p>
                        <strong>Output:</strong> {trace.output}
                      </p>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </aside>
  );
}
