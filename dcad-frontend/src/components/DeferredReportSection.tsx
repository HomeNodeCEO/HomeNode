import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ReactNode } from "react";

export default function DeferredReportSection({
  children,
  label,
  className = "",
  minimumHeight = 260,
  onReady,
}: {
  children: ReactNode;
  label: string;
  className?: string;
  minimumHeight?: number;
  onReady?: () => void;
}) {
  const [ready, setReady] = useState(false);
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const reveal = useCallback(() => setReady(true), []);

  useEffect(() => {
    if (ready) onReadyRef.current?.();
  }, [ready]);

  useEffect(() => {
    if (ready) return;
    const element = placeholderRef.current;
    if (!element || !("IntersectionObserver" in window)) {
      reveal();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) reveal();
      },
      { rootMargin: "700px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ready, reveal]);

  useEffect(() => {
    if (ready) return;
    const revealForPrint = () => {
      // Force the mount before a direct browser print captures the page.
      flushSync(reveal);
    };
    window.addEventListener("beforeprint", revealForPrint);
    window.addEventListener("homenode:prepare-report", revealForPrint);
    return () => {
      window.removeEventListener("beforeprint", revealForPrint);
      window.removeEventListener("homenode:prepare-report", revealForPrint);
    };
  }, [ready, reveal]);

  return (
    <div className={className} data-deferred-report-section={ready ? "ready" : "pending"}>
      {ready ? children : (
        <div
          ref={placeholderRef}
          className="hn-custom-section flex items-center justify-between gap-4 rounded-2xl border p-5"
          style={{ minHeight: `${minimumHeight}px` }}
          aria-label={`${label} is ready to load`}
        >
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-slate-800">
              {label}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              This analysis loads as it approaches the visible report area.
            </p>
          </div>
          <button
            type="button"
            className="hn-action-primary btn btn-sm normal-case rounded-lg"
            onClick={reveal}
          >
            Load Section
          </button>
        </div>
      )}
    </div>
  );
}
