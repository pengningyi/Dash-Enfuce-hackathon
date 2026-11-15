"use client";

import { useState, useRef, useEffect } from "react";
import gsap from "gsap";
import { ChevronDown, ChevronUp, CheckCircle2, XCircle, Minus, ArrowRight } from "lucide-react";
import { Decision } from "@/lib/api";
import { XAIDetailPanel } from "@/components/ui/xai-detail-panel";
import { decisionMeta, type IndexedResult } from "./constants";

/**
 * Expandable table row — click to show customer vs match comparison.
 * All data is inline — no API fetch needed.
 */
export function ExpandableRow({ row, isNew }: { row: IndexedResult; isNew?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const detailRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLTableRowElement>(null);
  const m = decisionMeta[row.decision];

  // GSAP entrance animation for new rows
  useEffect(() => {
    if (!isNew || !rowRef.current) return;
    gsap.fromTo(rowRef.current,
      { opacity: 0, y: -16, scale: 0.98 },
      { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: "power3.out" },
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Flash animation when decision changes (LLM resolve)
  const prevDecision = useRef(row.decision);
  useEffect(() => {
    if (!rowRef.current || row.decision === prevDecision.current) return;
    const flashColor = row.decision === Decision.ESCALATE ? "#fecaca" : "#bbf7d0";
    gsap.fromTo(rowRef.current,
      { backgroundColor: flashColor },
      { backgroundColor: "transparent", duration: 1.5, ease: "power2.out" },
    );
    prevDecision.current = row.decision;
  }, [row.decision]);

  function toggle() {
    if (expanded && detailRef.current) {
      gsap.to(detailRef.current, {
        height: 0, opacity: 0, duration: 0.2, ease: "power2.in",
        onComplete: () => setExpanded(false),
      });
    } else {
      setExpanded(true);
    }
  }

  useEffect(() => {
    if (!expanded || !detailRef.current) return;
    gsap.fromTo(detailRef.current,
      { height: 0, opacity: 0 },
      { height: "auto", opacity: 1, duration: 0.3, ease: "power3.out" },
    );
  }, [expanded]);

  const hasMatch = row.top_match_name != null;
  const showTransition = row.wasReview && row.decision !== Decision.NEEDS_REVIEW;

  return (
    <>
      <tr ref={rowRef} className="hover:bg-[#f8f7fa] transition-colors cursor-pointer group" onClick={toggle}>
        <td className="py-2 text-muted-foreground/50 font-mono tabular-nums">{row.index + 1}</td>
        <td className="py-2 font-medium">
          <div className="flex items-center gap-1.5">
            {expanded
              ? <ChevronUp className="h-3 w-3 text-muted-foreground/50" />
              : <ChevronDown className="h-3 w-3 text-muted-foreground/30 group-hover:text-muted-foreground/60" />}
            {row.query_name}
          </div>
        </td>
        <td className="py-2">
          {showTransition ? (
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground/50 line-through">Review</span>
              <ArrowRight className="h-2.5 w-2.5 text-muted-foreground/30" />
              <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold shadow-sm"
                style={{ backgroundColor: m.bg, color: m.color }}>
                {m.icon} {m.label}
              </span>
            </div>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold shadow-sm"
              style={{ backgroundColor: m.bg, color: m.color }}>
              {m.icon} {m.label}
            </span>
          )}
        </td>
        <td className="py-2 text-muted-foreground truncate max-w-[180px]">{row.top_match_name ?? "—"}</td>
        <td className="py-2 text-right font-mono tabular-nums">{row.top_match_score != null ? `${(row.top_match_score * 100).toFixed(1)}%` : "—"}</td>
        <td className={`py-2 text-right font-mono ${row.layer_reached === 3 ? "text-violet-600 font-bold" : ""}`}>{row.layer_reached}</td>
        <td className="py-2 text-right font-mono text-muted-foreground tabular-nums">{row.processing_time_ms != null ? `${row.processing_time_ms.toFixed(0)}ms` : "—"}</td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={7} className="p-0">
            <div ref={detailRef} className="overflow-hidden">
              <div className="px-8 py-4 bg-[#fafafa] border-y border-border/30 space-y-3">
                {/* Customer vs Match comparison */}
                {hasMatch && (
                  <div className="grid grid-cols-2 gap-4">
                    {/* Customer */}
                    <div className="rounded-lg border border-border/50 bg-white p-3 space-y-2">
                      <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Customer</div>
                      <div className="text-[13px] font-semibold">{row.query_name}</div>
                      <div className="space-y-1 text-[11px]">
                        <Field label="Date of Birth" value={row.query_dob} />
                        <Field label="Country" value={row.query_country} />
                      </div>
                    </div>

                    {/* Sanctions Match */}
                    <div className="rounded-lg border border-red-100 bg-red-50/30 p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-[10px] text-red-500 font-medium uppercase tracking-wider">Sanctions Match</div>
                        <span className="text-[10px] font-mono text-muted-foreground">{row.sanctions_id}</span>
                      </div>
                      <div className="text-[13px] font-semibold">{row.top_match_name}</div>
                      <div className="space-y-1 text-[11px]">
                        <CompareField label="Date of Birth" customerVal={row.query_dob} matchVal={row.top_match_dob} />
                        <CompareField label="Country" customerVal={row.query_country} matchVal={row.top_match_country} />
                        <Field label="Program" value={row.top_match_program} />
                        <Field label="Reason" value={row.top_match_reason} />
                      </div>
                    </div>
                  </div>
                )}

                {/* Similarity + Layer info */}
                <div className="flex items-center gap-4 text-[11px] flex-wrap">
                  {row.top_match_score != null && (
                    <span className={`font-mono font-bold ${row.top_match_score >= 0.8 ? "text-red-600" : row.top_match_score >= 0.65 ? "text-amber-600" : "text-muted-foreground"}`}>
                      Similarity: {(row.top_match_score * 100).toFixed(1)}%
                    </span>
                  )}
                  <span className="text-muted-foreground">Layer {row.layer_reached}</span>
                  {row.processing_time_ms != null && (
                    <span className="text-muted-foreground font-mono">{row.processing_time_ms.toFixed(0)}ms</span>
                  )}
                </div>

                {/* XAI Signal Breakdown + Decision Logic + Agent Reasoning */}
                <XAIDetailPanel
                  signalBreakdown={row.signal_breakdown}
                  reasoning={row.reasoning}
                  decision={row.decision}
                  llmReasoning={row.llm_reasoning}
                  llmConfidence={row.llm_confidence != null ? row.llm_confidence / 100 : null}
                />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ── Helpers ── */

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={value ? "font-medium" : "text-muted-foreground/40"}>{value ?? "—"}</span>
    </div>
  );
}

function CompareField({ label, customerVal, matchVal }: { label: string; customerVal?: string | null; matchVal?: string | null }) {
  const bothPresent = customerVal && matchVal;
  const isMatch = bothPresent && customerVal.toLowerCase() === matchVal.toLowerCase();
  const isMissing = !customerVal || !matchVal;

  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className={matchVal ? "font-medium" : "text-muted-foreground/40"}>{matchVal ?? "—"}</span>
        {bothPresent && (
          isMatch
            ? <CheckCircle2 className="h-3 w-3 text-red-500" /> /* Match is risky in sanctions */
            : <XCircle className="h-3 w-3 text-green-500" /> /* Different is safe */
        )}
        {isMissing && <Minus className="h-3 w-3 text-amber-400" />}
      </div>
    </div>
  );
}
