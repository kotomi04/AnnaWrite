import type { ToastMessage } from "../types";

interface ToastProps {
  messages: ToastMessage[];
}

export function ToastStack({ messages }: ToastProps) {
  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-30 grid gap-2">
      {messages.map((toast) => (
        <div
          key={toast.id}
          className={`rounded-2xl border px-3 py-2 text-xs font-bold shadow-soft backdrop-blur ${
            toast.tone === "warning"
              ? "border-amber-200 bg-amber-50/90 text-amber-800"
              : toast.tone === "success"
                ? "border-emerald-200 bg-emerald-50/90 text-emerald-800"
                : "border-white/70 bg-white/85 text-graphite"
          }`}
        >
          {toast.text}
        </div>
      ))}
    </div>
  );
}
