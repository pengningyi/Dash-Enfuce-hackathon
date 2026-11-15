"use client";

import { useRef, useEffect } from "react";
import gsap from "gsap";
import {
  Layers, Brain, Sparkles, Loader2, ArrowRight,
  X,
} from "lucide-react";
import { Decision } from "@/lib/api";
import { decisionMeta, type IndexedResult, type ResolvedItem } from "./constants";

/* ── Phase config ── */
const PHASE_CONFIG = {
  scanning: {
    label: "Layer 1-2: Vector Search + Rules",
    sublabel: "FAISS similarity + Jaro-Winkler + deterministic matching",
    icon: Layers, dotColor: "#2E2E2E",
  },
  llm_phase: {
    label: "Layer 3: AI Analysis",
    sublabel: "Grok xAI reasoning on edge cases",
    icon: Brain, dotColor: "#7c3aed",
  },
};

/* ── Phase Indicator ── */
export function PhaseIndicator({ phase }: { phase: "scanning" | "llm_phase" }) {
  const cfg = PHASE_CONFIG[phase];
  const Icon = cfg.icon;
  const dotRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dotRef.current) return;
    const tl = gsap.timeline({ repeat: -1 });
    tl.to(dotRef.current, { scale: 1.4, boxShadow: `0 0 12px 2px ${cfg.dotColor}40`, duration: 0.6, ease: "power2.out" });
    tl.to(dotRef.current, { scale: 1, boxShadow: `0 0 0px 0px ${cfg.dotColor}00`, duration: 0.8, ease: "power2.in" });
    return () => { tl.kill(); };
  }, [phase, cfg.dotColor]);

  useEffect(() => {
    if (!labelRef.current) return;
    gsap.fromTo(labelRef.current, { opacity: 0, x: -6 }, { opacity: 1, x: 0, duration: 0.3, ease: "power2.out" });
  }, [phase]);

  return (
    <div className="flex items-center gap-2.5">
      <div ref={dotRef} className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: cfg.dotColor }} />
      <div ref={labelRef}>
        <div className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[13px] font-semibold">{cfg.label}</span>
        </div>
        <p className="text-[11px] text-muted-foreground">{cfg.sublabel}</p>
      </div>
    </div>
  );
}

/* ── Progress Bar ── */
export function ProgressBar({ progress, processed, total, isActive }: { progress: number; processed: number; total: number; isActive: boolean }) {
  const barRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!barRef.current) return;
    gsap.to(barRef.current, { width: `${progress}%`, duration: 0.3, ease: "power2.out" });
  }, [progress]);

  useEffect(() => {
    if (!glowRef.current || !isActive) return;
    const tl = gsap.timeline({ repeat: -1 });
    tl.fromTo(glowRef.current, { left: "-20%", opacity: 0 }, { left: "120%", opacity: 0.6, duration: 1.5, ease: "none" });
    return () => { tl.kill(); };
  }, [isActive]);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="font-medium">{isActive ? "Screening…" : "Complete"}</span>
        <span className="font-mono tabular-nums">{processed.toLocaleString()} / {total.toLocaleString()} <span className="ml-1.5 text-foreground font-semibold">{progress}%</span></span>
      </div>
      <div className="h-1.5 rounded-full bg-black/[0.06] overflow-hidden relative">
        <div ref={barRef} className="h-full rounded-full bg-[#2E2E2E] transition-none" style={{ width: 0 }} />
        {isActive && <div ref={glowRef} className="absolute top-0 h-full w-[20%] rounded-full" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)" }} />}
      </div>
    </div>
  );
}

/* ── Live Counter ── */
export function LiveCounter({ label, value, icon, color }: { label: string; value: number; icon: React.ReactNode; color: string }) {
  const numRef = useRef<HTMLSpanElement>(null);
  const prevValue = useRef(value);
  useEffect(() => {
    if (!numRef.current || value === prevValue.current) return;
    gsap.fromTo(numRef.current, { scale: 1.2, color }, { scale: 1, color: "#111827", duration: 0.5, ease: "power2.out" });
    prevValue.current = value;
  }, [value, color]);

  return (
    <div className="p-3 flex items-center gap-3">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: `${color}12`, color }}>{icon}</div>
      <div>
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <span ref={numRef} className="text-xl font-semibold tracking-tight leading-none tabular-nums block mt-0.5">{value.toLocaleString()}</span>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   AI SIDE PANEL — Slide-in panel showing LLM analysis live
   ══════════════════════════════════════════════════════════════ */
export function AISidePanel({
  isOpen,
  onClose,
  nextToAnalyze,
  resolvedHistory,
  llmProcessed,
  llmTotal,
}: {
  isOpen: boolean;
  onClose: () => void;
  nextToAnalyze: IndexedResult | null;
  resolvedHistory: ResolvedItem[];
  llmProcessed: number;
  llmTotal: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to top when new item arrives
  useEffect(() => {
    if (scrollRef.current && resolvedHistory.length > 0) {
      scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [resolvedHistory.length]);

  const llmProgress = llmTotal > 0 ? Math.round((llmProcessed / llmTotal) * 100) : 0;

  return (
    <div
      ref={panelRef}
      className="h-full bg-white flex flex-col"
    >
      {/* Header */}
      <div className="shrink-0 px-5 py-4 border-b border-border bg-gradient-to-r from-violet-50/80 to-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-600" />
            <span className="text-[14px] font-semibold">AI Analysis</span>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-secondary transition-colors">
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">Grok xAI · grok-4-1-fast-reasoning</span>
          <span className="text-violet-600 font-mono tabular-nums font-medium">
            {llmProcessed}/{llmTotal} · {llmProgress}%
          </span>
        </div>
        {/* Mini progress */}
        <div className="mt-2 h-1 rounded-full bg-violet-100 overflow-hidden">
          <div className="h-full rounded-full bg-violet-500 transition-all duration-300" style={{ width: `${llmProgress}%` }} />
        </div>
      </div>

      {/* Currently analyzing — show next unresolved from review list */}
      {nextToAnalyze && (
        <div className="shrink-0 px-5 py-3 border-b border-violet-100 bg-violet-50/30">
          <div className="text-[10px] text-violet-500 font-medium uppercase tracking-wider mb-1.5">Next in Queue</div>
          <div className="flex items-center gap-2 mb-2">
            <Loader2 className="h-3.5 w-3.5 text-violet-500 animate-spin" />
            <span className="text-[13px] font-semibold">{nextToAnalyze.query_name}</span>
            <span className="text-[11px] text-muted-foreground">
              → {nextToAnalyze.top_match_name} ({((nextToAnalyze.top_match_score ?? 0) * 100).toFixed(1)}%)
            </span>
          </div>
        </div>
      )}

      {/* Resolved history — scrollable, newest at top */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {resolvedHistory.length === 0 && (
          <div className="flex items-center justify-center h-32 text-[12px] text-muted-foreground">
            Waiting for first AI decision…
          </div>
        )}
        {resolvedHistory.map((item, i) => (
          <ResolvedCard key={item.index} item={item} isLatest={i === 0} />
        ))}
      </div>
    </div>
  );
}

/** Single resolved decision card with evidence badges + GSAP entrance */
function ResolvedCard({ item, isLatest }: { item: ResolvedItem; isLatest: boolean }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const m = decisionMeta[item.decision];
  const ev = item.llm_evidence;

  useEffect(() => {
    if (!cardRef.current || !isLatest) return;
    // Smooth slide-in from top with scale pop
    gsap.fromTo(cardRef.current,
      { opacity: 0, y: -20, scale: 0.96 },
      { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: "back.out(1.4)" },
    );
    // Flash the decision color briefly
    const flashColor = item.decision === Decision.ESCALATE ? "#fef2f2" : "#f0fdf4";
    gsap.fromTo(cardRef.current,
      { backgroundColor: flashColor },
      { backgroundColor: "transparent", duration: 1.2, ease: "power2.out", delay: 0.3 },
    );
  }, [isLatest, item.decision]);

  return (
    <div
      ref={cardRef}
      className={`px-5 py-3 border-b border-border/50 ${isLatest ? "bg-white" : "bg-gray-50/30"}`}
    >
      {/* Name + decision badge */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold">{item.query_name}</span>
          <ArrowRight className="h-3 w-3 text-muted-foreground/30" />
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
            style={{ backgroundColor: m.bg, color: m.color }}
          >
            {m.icon} {m.label}
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
          #{item.index + 1}
        </span>
      </div>

      {/* Evidence badges */}
      {ev && (
        <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
          <EvidenceBadge label="Name" value={ev.name_match} />
          <EvidenceBadge label="DOB" value={ev.dob_match} />
          <EvidenceBadge label="Country" value={ev.country_match} />
          {item.top_match_score != null && (
            <span className="text-[10px] font-mono text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">
              {(item.top_match_score * 100).toFixed(1)}%
            </span>
          )}
        </div>
      )}

      {/* Reasoning */}
      {item.llm_reasoning && (
        <p className="text-[11px] text-muted-foreground leading-relaxed mb-1.5">
          {item.llm_reasoning}
        </p>
      )}

      {/* Meta */}
      <div className="flex items-center gap-3 text-[10px] font-mono flex-wrap">
        {item.processing_time_ms != null && <span className="text-violet-500">{item.processing_time_ms.toFixed(0)}ms</span>}
        <span className="text-violet-500">Layer 3</span>
        {item.llm_confidence != null && <span className="text-violet-500">Confidence {item.llm_confidence}%</span>}
        {item.top_match_name && (
          <span className="text-muted-foreground">
            {item.llm_matched_entity
              ? `Matched: ${item.llm_matched_entity}`
              : `Top vector hit: ${item.top_match_name}`}
          </span>
        )}
      </div>
    </div>
  );
}

/** Evidence badge — color-coded by match quality */
function EvidenceBadge({ label, value }: { label: string; value: string }) {
  const isGood = ["exact", "same", "transliteration"].includes(value);
  const isBad = ["none", "different"].includes(value);
  const color = isGood ? "text-red-600 bg-red-50" : isBad ? "text-green-600 bg-green-50" : "text-amber-600 bg-amber-50";
  // For sanctions screening: "exact" DOB is bad (risky), "different" is good (safe)
  const riskColor = label === "Name"
    ? (["exact", "transliteration", "phonetic"].includes(value) ? "text-red-600 bg-red-50" : "text-green-600 bg-green-50")
    : (["exact", "same"].includes(value) ? "text-red-600 bg-red-50" : ["different"].includes(value) ? "text-green-600 bg-green-50" : "text-amber-600 bg-amber-50");

  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${riskColor}`}>
      {label}: {value}
    </span>
  );
}
