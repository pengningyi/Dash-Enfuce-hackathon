"use client";

import type { SignalBreakdown, SignalScore } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Info } from "lucide-react";

/* ── Signal display config ── */

const SIGNAL_LABELS: Record<keyof SignalBreakdown, string> = {
  dob: "Date of Birth",
  name_jw: "Name (Jaro-Winkler)",
  phonetic: "Phonetic",
  embedding: "Embedding",
  country: "Country",
};

const SIGNAL_ORDER: (keyof SignalBreakdown)[] = [
  "name_jw",
  "phonetic",
  "embedding",
  "dob",
  "country",
];

/**
 * Score color: red ≥0.7 (high risk match), amber 0.3–0.7, green <0.3.
 * In sanctions screening, high scores mean the match is likely real — that's dangerous.
 */
function scoreColor(score: number): { bar: string; text: string; bg: string } {
  if (score >= 0.7)
    return { bar: "bg-red-500", text: "text-red-600", bg: "bg-red-50" };
  if (score >= 0.3)
    return { bar: "bg-amber-500", text: "text-amber-600", bg: "bg-amber-50" };
  return { bar: "bg-green-500", text: "text-green-600", bg: "bg-green-50" };
}

/* ── Signal row ── */

function SignalRow({ label, signal }: { label: string; signal: SignalScore }) {
  if (signal.missing) {
    return (
      <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 py-1.5">
        <div className="w-full sm:w-[140px] text-[11px] text-muted-foreground shrink-0 truncate">
          {label}
        </div>
        <div className="flex-1 flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-muted/50" />
          <span className="text-[11px] text-muted-foreground/50 font-mono tabular-nums w-[42px] text-right">
            N/A
          </span>
        </div>
        <div className="text-[10px] text-muted-foreground/40 truncate sm:max-w-[200px]">
          {signal.detail || "Data not available"}
        </div>
      </div>
    );
  }

  const colors = scoreColor(signal.score);
  const pct = Math.round(signal.score * 100);

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 py-1.5">
      <div className="w-full sm:w-[140px] text-[11px] text-muted-foreground shrink-0 truncate">
        {label}
      </div>
      <div className="flex-1 flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-muted/30 overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all", colors.bar)}
            style={{ width: `${Math.max(pct, 2)}%` }}
          />
        </div>
        <span
          className={cn(
            "text-[11px] font-mono tabular-nums font-semibold w-[42px] text-right",
            colors.text,
          )}
        >
          {pct}%
        </span>
      </div>
      <div className="text-[10px] text-muted-foreground/60 truncate sm:max-w-[200px]">
        {signal.detail}
      </div>
    </div>
  );
}

/* ── Main panel ── */

interface SignalBreakdownPanelProps {
  signalBreakdown?: SignalBreakdown | null;
  reasoning?: string | null;
}

export function SignalBreakdownPanel({
  signalBreakdown,
  reasoning,
}: SignalBreakdownPanelProps) {
  // No data at all → render nothing
  if (!signalBreakdown && !reasoning) return null;

  return (
    <div className="space-y-2">
      {/* Signal bars */}
      {signalBreakdown && (
        <div className="rounded-lg border border-border/50 bg-white p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Info className="h-3 w-3 text-muted-foreground/60" />
            <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
              Signal Breakdown
            </span>
          </div>
          <div className="divide-y divide-border/30">
            {SIGNAL_ORDER.map((key) => (
              <SignalRow
                key={key}
                label={SIGNAL_LABELS[key]}
                signal={signalBreakdown[key]}
              />
            ))}
          </div>
        </div>
      )}

      {/* Reasoning text */}
      {reasoning && (
        <div className="rounded-lg border border-border/50 bg-white px-3 py-2">
          <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider mb-1">
            Reasoning
          </div>
          <p className="text-[11px] text-foreground leading-relaxed">
            {reasoning}
          </p>
        </div>
      )}
    </div>
  );
}
