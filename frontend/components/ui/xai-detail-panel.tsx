"use client";

import { useRef, useEffect, useState, useMemo } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import type { SignalBreakdown, SignalScore, Decision } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Fingerprint, Calendar, Globe, Waves, Brain, ShieldAlert,
  ChevronRight, AlertTriangle, CheckCircle2, XCircle, Info, Zap,
} from "lucide-react";

gsap.registerPlugin(useGSAP);

/* ═══════════════════════════════════════════════════════════
   TYPES & CONFIG
   ═══════════════════════════════════════════════════════════ */

interface SignalConfig {
  key: keyof SignalBreakdown;
  label: string;
  shortLabel: string;
  icon: React.ReactNode;
  description: string;
}

const SIGNALS: SignalConfig[] = [
  { key: "name_jw",   label: "Jaro-Winkler",   shortLabel: "JW",   icon: <Fingerprint className="w-3.5 h-3.5" />, description: "Character-level name similarity" },
  { key: "phonetic",  label: "Phonetic",        shortLabel: "PH",   icon: <Waves className="w-3.5 h-3.5" />,       description: "Metaphone sound-alike matching" },
  { key: "embedding", label: "Embedding",       shortLabel: "EMB",  icon: <Brain className="w-3.5 h-3.5" />,        description: "Multilingual semantic similarity" },
  { key: "dob",       label: "Date of Birth",   shortLabel: "DOB",  icon: <Calendar className="w-3.5 h-3.5" />,     description: "Birth date proximity" },
  { key: "country",   label: "Country",         shortLabel: "CTY",  icon: <Globe className="w-3.5 h-3.5" />,        description: "Nationality / country match" },
];

/**
 * The rule engine thresholds — hardcoded to match backend _apply_rules().
 * Each signal shows where the ESCALATE and NEEDS_REVIEW thresholds sit.
 */
const THRESHOLDS: Record<string, { escalate?: number; review?: number }> = {
  name_jw:   { escalate: 0.92, review: 0.75 },
  phonetic:  { escalate: 0.50, review: 0.30 },
  embedding: { escalate: 0.90, review: 0.70 },
  dob:       { escalate: 1.00, review: 0.80 },
  country:   { escalate: 1.00 },
};

const DECISION_CONFIG: Record<string, {
  label: string; color: string; bg: string; border: string; icon: React.ReactNode; description: string;
}> = {
  ESCALATE:     { label: "ESCALATE",     color: "#dc2626", bg: "rgba(220,38,38,0.06)",  border: "rgba(220,38,38,0.15)", icon: <XCircle className="w-4 h-4" />,        description: "Immediate compliance review required" },
  NEEDS_REVIEW: { label: "NEEDS REVIEW", color: "#d97706", bg: "rgba(217,119,6,0.06)",  border: "rgba(217,119,6,0.15)", icon: <AlertTriangle className="w-4 h-4" />,   description: "Manual verification recommended" },
  AUTO_CLEAR:   { label: "AUTO CLEAR",   color: "#059669", bg: "rgba(5,150,105,0.06)",  border: "rgba(5,150,105,0.15)", icon: <CheckCircle2 className="w-4 h-4" />,    description: "No significant match signals" },
};


/* ═══════════════════════════════════════════════════════════
   RADIAL GAUGE — SVG ring for each signal
   ═══════════════════════════════════════════════════════════ */

function RadialGauge({
  score, thresholds, size = 56, strokeWidth = 4, missing, delay = 0,
}: {
  score: number; thresholds?: { escalate?: number; review?: number };
  size?: number; strokeWidth?: number; missing?: boolean; delay?: number;
}) {
  const gaugeRef = useRef<SVGCircleElement>(null);
  const r = (size - strokeWidth) / 2;
  const circ = 2 * Math.PI * r;
  const scoreColor = missing ? "#d1d5db" : score >= 0.7 ? "#dc2626" : score >= 0.3 ? "#d97706" : "#059669";

  useEffect(() => {
    if (!gaugeRef.current || missing) return;
    const target = circ * (1 - score);
    gsap.fromTo(gaugeRef.current,
      { strokeDashoffset: circ },
      { strokeDashoffset: target, duration: 0.8, delay, ease: "power3.out" }
    );
  }, [score, circ, delay, missing]);

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      {/* Track */}
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#f3f4f6" strokeWidth={strokeWidth} />

      {/* Threshold markers */}
      {thresholds?.review && !missing && (
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#d97706" strokeWidth={1}
          strokeDasharray={`${circ * 0.008} ${circ * 0.992}`}
          strokeDashoffset={circ * thresholds.review}
          opacity={0.4} />
      )}
      {thresholds?.escalate && !missing && (
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#dc2626" strokeWidth={1}
          strokeDasharray={`${circ * 0.008} ${circ * 0.992}`}
          strokeDashoffset={circ * thresholds.escalate}
          opacity={0.4} />
      )}

      {/* Score arc */}
      <circle
        ref={gaugeRef}
        cx={size/2} cy={size/2} r={r} fill="none"
        stroke={scoreColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={missing ? circ : circ}
      />
    </svg>
  );
}


/* ═══════════════════════════════════════════════════════════
   SIGNAL CARD — one per signal
   ═══════════════════════════════════════════════════════════ */

function SignalCard({
  config, signal, delay,
}: {
  config: SignalConfig; signal: SignalScore; delay: number;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const pct = signal.missing ? null : Math.round(signal.score * 100);
  const th = THRESHOLDS[config.key];
  const hitEscalate = th?.escalate != null && !signal.missing && signal.score >= th.escalate;
  const hitReview   = th?.review != null && !signal.missing && signal.score >= th.review;

  useGSAP(() => {
    if (!cardRef.current) return;
    gsap.from(cardRef.current, {
      y: 12, autoAlpha: 0, duration: 0.45,
      delay, ease: "power3.out",
    });
  }, { scope: cardRef });

  return (
    <div
      ref={cardRef}
      className={cn(
        "relative rounded-xl border p-2.5 sm:p-3 transition-colors",
        hitEscalate ? "border-red-200 bg-red-50/40" :
        hitReview   ? "border-amber-200 bg-amber-50/30" :
                      "border-gray-100 bg-white"
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 sm:gap-2 mb-2">
        <span className={cn(
          "flex items-center justify-center w-5 h-5 sm:w-6 sm:h-6 rounded-md",
          hitEscalate ? "bg-red-100 text-red-600" :
          hitReview   ? "bg-amber-100 text-amber-600" :
                        "bg-gray-100 text-gray-500"
        )}>
          {config.icon}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] sm:text-[11px] font-semibold text-gray-800 leading-tight truncate">{config.label}</p>
          <p className="text-[8px] sm:text-[9px] text-gray-400 leading-tight hidden sm:block">{config.description}</p>
        </div>
      </div>

      {/* Gauge + score */}
      <div className="flex items-center gap-2 sm:gap-3">
        <div className="relative shrink-0">
          <RadialGauge score={signal.score} thresholds={th} size={48} strokeWidth={3.5} missing={signal.missing} delay={delay} />
          <div className="absolute inset-0 flex items-center justify-center">
            <span className={cn(
              "text-[10px] sm:text-xs font-bold tabular-nums",
              signal.missing ? "text-gray-300" :
              signal.score >= 0.7 ? "text-red-600" :
              signal.score >= 0.3 ? "text-amber-600" :
                                    "text-emerald-600"
            )}>
              {signal.missing ? "N/A" : `${pct}`}
            </span>
          </div>
        </div>

        {/* Threshold indicators */}
        <div className="flex-1 space-y-0.5 sm:space-y-1 min-w-0">
          {th?.escalate != null && (
            <ThresholdRow
              label="Escalate" threshold={th.escalate} score={signal.score}
              hit={hitEscalate} color="red" missing={signal.missing}
            />
          )}
          {th?.review != null && (
            <ThresholdRow
              label="Review" threshold={th.review} score={signal.score}
              hit={hitReview && !hitEscalate} color="amber" missing={signal.missing}
            />
          )}
          <p className="text-[8px] sm:text-[9px] text-gray-400 truncate mt-0.5 sm:mt-1" title={signal.detail}>{signal.detail}</p>
        </div>
      </div>
    </div>
  );
}

function ThresholdRow({ label, threshold, score, hit, color, missing }: {
  label: string; threshold: number; score: number; hit: boolean; color: "red" | "amber"; missing?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={cn(
        "w-1.5 h-1.5 rounded-full shrink-0",
        missing ? "bg-gray-200" :
        hit ? (color === "red" ? "bg-red-500" : "bg-amber-500") :
              "bg-gray-200"
      )} />
      <span className="text-[9px] text-gray-500 tabular-nums">
        {label} ≥{Math.round(threshold * 100)}%
      </span>
      {!missing && (
        <span className={cn(
          "text-[9px] font-medium tabular-nums ml-auto",
          hit ? (color === "red" ? "text-red-600" : "text-amber-600") : "text-gray-300"
        )}>
          {hit ? "TRIGGERED" : `${Math.round(score * 100)}%`}
        </span>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   DECISION TRACE — shows which rule fired
   ═══════════════════════════════════════════════════════════ */

function DecisionTrace({
  decision, reasoning, delay,
}: {
  decision: string; reasoning: string; delay: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dc = DECISION_CONFIG[decision] ?? DECISION_CONFIG.AUTO_CLEAR;

  useGSAP(() => {
    if (!ref.current) return;
    gsap.from(ref.current, { y: 10, autoAlpha: 0, duration: 0.5, delay, ease: "power3.out" });
  }, { scope: ref });

  return (
    <div ref={ref} className="rounded-xl border p-3 sm:p-4" style={{ borderColor: dc.border, backgroundColor: dc.bg }}>
      <div className="flex items-start gap-2.5 sm:gap-3">
        <div className="flex items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-lg shrink-0" style={{ backgroundColor: `${dc.color}15` }}>
          <span style={{ color: dc.color }}>{dc.icon}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 mb-1">
            <span className="text-xs font-bold tracking-wide" style={{ color: dc.color }}>{dc.label}</span>
            <ChevronRight className="w-3 h-3 text-gray-300 hidden sm:block" />
            <span className="text-[10px] text-gray-500">{dc.description}</span>
          </div>
          <div className="flex items-start gap-1.5 mt-2">
            <Zap className="w-3 h-3 text-gray-400 mt-0.5 shrink-0" />
            <p className="text-[10px] sm:text-[11px] text-gray-600 leading-relaxed font-mono break-words">{reasoning}</p>
          </div>
        </div>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   SIGNAL STRENGTH SUMMARY — horizontal bar
   ═══════════════════════════════════════════════════════════ */

function SignalStrengthBar({
  breakdown, delay,
}: {
  breakdown: SignalBreakdown; delay: number;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);

  // Weighted aggregate (same as backend _aggregate_strength)
  const aggregate = useMemo(() =>
    0.25 * breakdown.name_jw.score
    + 0.25 * breakdown.embedding.score
    + 0.20 * breakdown.dob.score
    + 0.15 * breakdown.phonetic.score
    + 0.15 * breakdown.country.score
  , [breakdown]);

  const pct = Math.round(aggregate * 100);
  const color = aggregate >= 0.6 ? "#dc2626" : aggregate >= 0.3 ? "#d97706" : "#059669";

  useEffect(() => {
    if (!fillRef.current) return;
    gsap.fromTo(fillRef.current,
      { width: "0%" },
      { width: `${Math.max(pct, 2)}%`, duration: 0.7, delay, ease: "power3.out" }
    );
  }, [pct, delay]);

  return (
    <div ref={barRef} className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wider">Aggregate Signal Strength</span>
        <span className="text-xs font-bold tabular-nums" style={{ color }}>{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
        <div ref={fillRef} className="h-full rounded-full transition-colors" style={{ backgroundColor: color, width: 0 }} />
      </div>
      <div className="flex items-center justify-between text-[8px] sm:text-[9px] text-gray-400 tabular-nums">
        <span>0%</span>
        <span className="flex items-center gap-2 sm:gap-3">
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Safe</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Review</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-500" /> Escalate</span>
        </span>
        <span>100%</span>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   LLM REASONING PANEL — streamed typewriter
   ═══════════════════════════════════════════════════════════ */

function LLMReasoningPanel({
  reasoning, confidence, delay,
}: {
  reasoning: string; confidence?: number | null; delay: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);

  useGSAP(() => {
    if (!ref.current) return;
    gsap.from(ref.current, { y: 10, autoAlpha: 0, duration: 0.5, delay, ease: "power3.out" });
  }, { scope: ref });

  // Typewriter
  useEffect(() => {
    setDisplayed(""); setDone(false);
    let i = 0;
    const iv = setInterval(() => {
      i++;
      setDisplayed(reasoning.slice(0, i));
      if (i >= reasoning.length) { clearInterval(iv); setDone(true); }
    }, 14);
    return () => clearInterval(iv);
  }, [reasoning]);

  // Cursor blink via GSAP
  useEffect(() => {
    if (!cursorRef.current || done) return;
    const tl = gsap.timeline({ repeat: -1 });
    tl.to(cursorRef.current, { autoAlpha: 0, duration: 0.4 });
    tl.to(cursorRef.current, { autoAlpha: 1, duration: 0.4 });
    return () => { tl.kill(); };
  }, [done]);

  return (
    <div ref={ref} className="rounded-xl border border-gray-100 bg-gradient-to-b from-gray-50/80 to-white overflow-hidden">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between px-3 sm:px-4 py-2 sm:py-2.5 border-b border-gray-100 gap-1">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-5 h-5 rounded-md bg-violet-100">
            <Brain className="w-3 h-3 text-violet-600" />
          </div>
          <span className="text-[10px] font-semibold text-gray-700 uppercase tracking-wider">AI Agent Analysis</span>
        </div>
        {confidence != null && (
          <span className="text-[10px] font-mono text-gray-400 tabular-nums">confidence: {Math.round(confidence * 100)}%</span>
        )}
      </div>
      {/* Body */}
      <div className="px-3 sm:px-4 py-2.5 sm:py-3">
        <p className="text-[11px] sm:text-[12px] leading-[1.7] text-gray-600 font-mono break-words">
          {displayed}
          {!done && <span ref={cursorRef} className="inline-block w-[2px] h-[13px] bg-violet-500 ml-0.5 align-text-bottom" />}
        </p>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   MAIN EXPORT — XAI Detail Panel
   ═══════════════════════════════════════════════════════════ */

interface XAIDetailPanelProps {
  signalBreakdown?: SignalBreakdown | null;
  reasoning?: string | null;
  decision: string;
  /** If L3 changed the decision, this is the final (post-LLM) decision */
  finalDecision?: string;
  llmReasoning?: string | null;
  llmConfidence?: number | null;
}

export function XAIDetailPanel({
  signalBreakdown, reasoning, decision, finalDecision, llmReasoning, llmConfidence,
}: XAIDetailPanelProps) {
  const root = useRef<HTMLDivElement>(null);

  // No data → nothing
  if (!signalBreakdown && !reasoning && !llmReasoning) return null;

  const baseDelay = 0.05;

  return (
    <div ref={root} className="space-y-4">

      {/* ── Section 1: Signal Breakdown (The "Why" and "How") ── */}
      {signalBreakdown && (
        <>
          <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 mb-1">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Signal Breakdown</span>
            </div>
            <span className="text-[9px] text-gray-400 sm:ml-auto">5 independent signals · higher = stronger match</span>
          </div>

          {/* Signal cards — responsive grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {SIGNALS.map((cfg, i) => (
              <SignalCard
                key={cfg.key}
                config={cfg}
                signal={signalBreakdown[cfg.key]}
                delay={baseDelay + i * 0.08}
              />
            ))}
          </div>

          {/* Aggregate strength bar */}
          <SignalStrengthBar
            breakdown={signalBreakdown}
            delay={baseDelay + SIGNALS.length * 0.08}
          />
        </>
      )}

      {/* ── Section 2: Decision Trace (L2 Rule Engine) ── */}
      {reasoning && (
        <DecisionTrace
          decision={decision}
          reasoning={reasoning}
          delay={baseDelay + SIGNALS.length * 0.08 + 0.15}
        />
      )}

      {/* ── Section 2b: L3 Decision Override ── */}
      {finalDecision && finalDecision !== decision && (
        <div className="rounded-xl border border-violet-200 bg-violet-50/30 p-3 sm:p-4">
          <div className="flex items-start sm:items-center gap-2.5 sm:gap-3">
            <div className="flex items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-violet-100 shrink-0">
              <Brain className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-violet-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[10px] font-bold text-violet-700 uppercase tracking-wider">Layer 3 — Grok Decision</span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100/60 text-amber-400 line-through">{DECISION_CONFIG[decision]?.label ?? decision}</span>
                <span className="text-gray-400">→</span>
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${finalDecision === "ESCALATE" ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}>
                  {DECISION_CONFIG[finalDecision]?.label ?? finalDecision}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Section 3: LLM Reasoning (The "Agent" Output) ── */}
      {llmReasoning && (
        <LLMReasoningPanel
          reasoning={llmReasoning}
          confidence={llmConfidence}
          delay={baseDelay + SIGNALS.length * 0.08 + 0.3}
        />
      )}
    </div>
  );
}
