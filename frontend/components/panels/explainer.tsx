"use client";

import { useRef, useEffect, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  User, ArrowRight, Database, Fingerprint, Waves, Brain,
  Calendar, Globe, ShieldCheck, ShieldAlert, ShieldX,
  Search, Zap, GitBranch, CheckCircle2, XCircle, AlertTriangle,
  ChevronDown, Play,
} from "lucide-react";

gsap.registerPlugin(useGSAP);

/* ═══════════════════════════════════════════════════════════
   DESIGN TOKENS
   ═══════════════════════════════════════════════════════════ */

const LAYER_COLORS = {
  blocking: { main: "#6366f1", bg: "#eef2ff", border: "#c7d2fe" },
  scoring:  { main: "#d97706", bg: "#fffbeb", border: "#fde68a" },
  decision: { main: "#059669", bg: "#ecfdf5", border: "#a7f3d0" },
  llm:      { main: "#8b5cf6", bg: "#f5f3ff", border: "#ddd6fe" },
};

const SIGNALS = [
  { key: "jw",        label: "Jaro-Winkler",   icon: Fingerprint, color: "#f59e0b", desc: "Character-level string distance" },
  { key: "phonetic",  label: "Phonetic",        icon: Waves,       color: "#3b82f6", desc: "Metaphone sound codes" },
  { key: "embedding", label: "Embedding",       icon: Brain,       color: "#8b5cf6", desc: "Multilingual neural similarity" },
  { key: "dob",       label: "Date of Birth",   icon: Calendar,    color: "#ef4444", desc: "Birth date proximity (0–1)" },
  { key: "country",   label: "Country",         icon: Globe,       color: "#10b981", desc: "Nationality match" },
];

const DECISIONS = [
  { key: "ESCALATE",     icon: ShieldX,      color: "#dc2626", label: "ESCALATE",     desc: "Immediate compliance review" },
  { key: "NEEDS_REVIEW", icon: ShieldAlert,   color: "#d97706", label: "NEEDS REVIEW", desc: "Manual verification needed" },
  { key: "AUTO_CLEAR",   icon: ShieldCheck,   color: "#059669", label: "AUTO CLEAR",   desc: "No significant match" },
];

/* ═══════════════════════════════════════════════════════════
   ANIMATED FLOW NODE
   ═══════════════════════════════════════════════════════════ */

function FlowNode({
  children, className = "", delay = 0, nodeRef,
}: {
  children: React.ReactNode; className?: string; delay?: number;
  nodeRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const ref = nodeRef ?? useRef<HTMLDivElement>(null);

  useGSAP(() => {
    if (!ref.current) return;
    gsap.from(ref.current, {
      y: 20, autoAlpha: 0, duration: 0.6,
      delay, ease: "power3.out",
    });
  }, { scope: ref });

  return <div ref={ref} className={className}>{children}</div>;
}

function FlowArrow({ delay = 0, vertical = false }: { delay?: number; vertical?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    if (!ref.current) return;
    gsap.from(ref.current, { autoAlpha: 0, duration: 0.3, delay, ease: "power2.out" });
  }, { scope: ref });

  useEffect(() => {
    if (!dotRef.current) return;
    const tl = gsap.timeline({ repeat: -1, delay: delay + 0.5 });
    if (vertical) {
      tl.fromTo(dotRef.current,
        { y: -8, autoAlpha: 0 },
        { y: 8, autoAlpha: 1, duration: 0.4, ease: "power2.out" }
      ).to(dotRef.current, { y: 24, autoAlpha: 0, duration: 0.3, ease: "power2.in" });
    } else {
      tl.fromTo(dotRef.current,
        { x: -8, autoAlpha: 0 },
        { x: 8, autoAlpha: 1, duration: 0.4, ease: "power2.out" }
      ).to(dotRef.current, { x: 24, autoAlpha: 0, duration: 0.3, ease: "power2.in" });
    }
    return () => { tl.kill(); };
  }, [delay, vertical]);

  return (
    <div ref={ref} className={`flex items-center justify-center ${vertical ? "py-2" : "px-2"} shrink-0`}>
      <div className="relative">
        {vertical ? (
          <ChevronDown className="w-4 h-4 text-gray-300" />
        ) : (
          <ArrowRight className="w-4 h-4 text-gray-300" />
        )}
        <div ref={dotRef} className="absolute inset-0 flex items-center justify-center">
          <div className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   SECTION: PIPELINE OVERVIEW
   ═══════════════════════════════════════════════════════════ */

function PipelineOverview() {
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div ref={ref} className="space-y-8">
      {/* Title */}
      <FlowNode delay={0}>
        <div className="text-center space-y-2">
          <h2 className="text-xl font-bold text-gray-900 tracking-tight">How the Screening Pipeline Works</h2>
          <p className="text-sm text-gray-500 max-w-xl mx-auto">
            Every name passes through a multi-layer funnel. Each layer is designed to
            eliminate non-matches as cheaply as possible, reserving expensive analysis for genuine candidates.
          </p>
        </div>
      </FlowNode>

      {/* Horizontal pipeline flow */}
      <FlowNode delay={0.15}>
        <div className="flex items-stretch justify-center gap-0 mx-auto max-w-5xl">
          {/* Input */}
          <div className="flex flex-col items-center justify-center gap-2 px-4">
            <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center">
              <User className="w-5 h-5 text-gray-600" />
            </div>
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Customer</span>
            <span className="text-[10px] text-gray-400">Name + DOB + Country</span>
          </div>

          <FlowArrow delay={0.3} />

          {/* Layer 1: Blocking */}
          <LayerCard
            layer={1}
            title="Blocking"
            subtitle="Candidate Selection"
            color={LAYER_COLORS.blocking}
            icon={<Database className="w-4 h-4" />}
            delay={0.4}
            stats={[
              { label: "Input", value: "100K customers" },
              { label: "Output", value: "~133 pairs" },
              { label: "Reduction", value: "99.87%" },
            ]}
          >
            <div className="space-y-1.5 text-[10px] text-gray-500">
              <div className="flex items-center gap-1.5">
                <Calendar className="w-3 h-3 text-indigo-500" />
                <span>DOB Year Inverted Index</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Waves className="w-3 h-3 text-indigo-500" />
                <span>Metaphone Phonetic Index</span>
              </div>
              <div className="flex items-center gap-1.5">
                <GitBranch className="w-3 h-3 text-indigo-500" />
                <span>3-tier candidate strategy</span>
              </div>
            </div>
          </LayerCard>

          <FlowArrow delay={0.6} />

          {/* Layer 2: Scoring + Decision */}
          <LayerCard
            layer={2}
            title="Signal Scoring"
            subtitle="5 Independent Signals"
            color={LAYER_COLORS.scoring}
            icon={<Zap className="w-4 h-4" />}
            delay={0.7}
            stats={[
              { label: "Signals", value: "5 independent" },
              { label: "Rules", value: "4E + 8R" },
              { label: "Output", value: "Decision + Score" },
            ]}
          >
            <div className="flex flex-wrap gap-1">
              {SIGNALS.map((s) => (
                <span key={s.key} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-50 text-amber-700 border border-amber-200">
                  <s.icon className="w-2.5 h-2.5" /> {s.label}
                </span>
              ))}
            </div>
          </LayerCard>

          <FlowArrow delay={0.9} />

          {/* Layer 3: LLM */}
          <LayerCard
            layer={3}
            title="AI Agent"
            subtitle="Grok LLM Reasoning"
            color={LAYER_COLORS.llm}
            icon={<Brain className="w-4 h-4" />}
            delay={1.0}
            stats={[
              { label: "Input", value: "NEEDS_REVIEW only" },
              { label: "Model", value: "Grok 3 Mini" },
              { label: "Output", value: "Decision + Reasoning" },
            ]}
          >
            <div className="space-y-1.5 text-[10px] text-gray-500">
              <div className="flex items-center gap-1.5">
                <Brain className="w-3 h-3 text-violet-500" />
                <span>Structured compliance analysis</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Search className="w-3 h-3 text-violet-500" />
                <span>Name + DOB + Country reasoning</span>
              </div>
            </div>
          </LayerCard>

          <FlowArrow delay={1.15} />

          {/* Output decisions */}
          <div className="flex flex-col items-center justify-center gap-2 px-4">
            {DECISIONS.map((d, i) => (
              <div key={d.key} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold" style={{ backgroundColor: `${d.color}10`, color: d.color }}>
                <d.icon className="w-3 h-3" /> {d.label}
              </div>
            ))}
          </div>
        </div>
      </FlowNode>
    </div>
  );
}

function LayerCard({
  layer, title, subtitle, color, icon, delay, stats, children,
}: {
  layer: number; title: string; subtitle: string;
  color: { main: string; bg: string; border: string };
  icon: React.ReactNode; delay: number;
  stats: { label: string; value: string }[];
  children: React.ReactNode;
}) {
  return (
    <FlowNode delay={delay}>
      <div className="w-[200px] rounded-xl border p-3 space-y-2.5" style={{ borderColor: color.border, backgroundColor: color.bg }}>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ backgroundColor: `${color.main}20` }}>
            <span style={{ color: color.main }}>{icon}</span>
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ backgroundColor: color.main, color: "white" }}>L{layer}</span>
              <span className="text-[11px] font-bold" style={{ color: color.main }}>{title}</span>
            </div>
            <span className="text-[9px] text-gray-400">{subtitle}</span>
          </div>
        </div>
        {children}
        <div className="space-y-1 border-t pt-2" style={{ borderColor: color.border }}>
          {stats.map((s) => (
            <div key={s.label} className="flex justify-between text-[9px]">
              <span className="text-gray-400">{s.label}</span>
              <span className="font-semibold text-gray-700">{s.value}</span>
            </div>
          ))}
        </div>
      </div>
    </FlowNode>
  );
}


/* ═══════════════════════════════════════════════════════════
   SECTION: LIVE WALKTHROUGH ANIMATION
   ═══════════════════════════════════════════════════════════ */

const WT_PHASES = ["blocking", "scoring", "rules", "llm", "decision"] as const;
type WTPhase = typeof WT_PHASES[number] | "idle";

const WT_PHASE_META: Record<Exclude<WTPhase, "idle">, { label: string; color: string }> = {
  blocking:  { label: "Blocking",  color: LAYER_COLORS.blocking.main },
  scoring:   { label: "Scoring",   color: LAYER_COLORS.scoring.main },
  rules:     { label: "Rules",     color: LAYER_COLORS.decision.main },
  llm:       { label: "LLM Agent", color: LAYER_COLORS.llm.main },
  decision:  { label: "Decision",  color: "#dc2626" },
};

function LiveWalkthrough() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<WTPhase>("idle");
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const tlRef = useRef<gsap.core.Timeline | null>(null);

  function resetAll() {
    if (tlRef.current) { tlRef.current.kill(); tlRef.current = null; }
    setRunning(false);
    setFinished(false);
    setPhase("idle");
    if (!containerRef.current) return;
    gsap.set(containerRef.current.querySelectorAll(".anim-node"), { autoAlpha: 0, y: 10 });
    gsap.set(containerRef.current.querySelectorAll(".signal-fill"), { width: "0%" });
    gsap.set(containerRef.current.querySelectorAll(".rule-check"), { autoAlpha: 0, x: -10 });
    gsap.set(containerRef.current.querySelectorAll(".decision-badge"), { autoAlpha: 0, scale: 0.8 });
  }

  function runAnimation() {
    if (!containerRef.current || running) return;
    if (finished) resetAll();
    requestAnimationFrame(() => startTimeline());
  }

  function startTimeline() {
    if (!containerRef.current) return;
    setRunning(true);
    setFinished(false);

    const tl = gsap.timeline({
      defaults: { ease: "power3.out" },
      onComplete: () => { setRunning(false); setFinished(true); },
    });
    tlRef.current = tl;

    // -- Phase 1: Input appears --
    tl.call(() => setPhase("blocking"));
    tl.to(".wt-input", { autoAlpha: 1, y: 0, duration: 0.5 });
    tl.to(".wt-input-arrow", { autoAlpha: 1, duration: 0.3 }, "-=0.2");

    // -- Phase 2: Blocking --
    tl.to(".wt-blocking", { autoAlpha: 1, y: 0, duration: 0.5 }, "+=0.2");
    tl.to(".wt-dob-idx", { autoAlpha: 1, x: 0, duration: 0.3 }, "-=0.2");
    tl.to(".wt-ph-idx", { autoAlpha: 1, x: 0, duration: 0.3 }, "-=0.1");
    tl.to(".wt-blocking-detail", { autoAlpha: 1, y: 0, duration: 0.35 }, "-=0.05");
    tl.to(".wt-candidate", { autoAlpha: 1, scale: 1, duration: 0.4 }, "+=0.15");
    tl.to(".wt-blocking-arrow", { autoAlpha: 1, duration: 0.3 });

    // -- Phase 3: Scoring --
    tl.call(() => setPhase("scoring"));
    tl.to(".wt-scoring", { autoAlpha: 1, y: 0, duration: 0.5 }, "+=0.1");

    const signalData = [
      { cls: ".sf-jw",   pct: "78%" },
      { cls: ".sf-ph",   pct: "50%" },
      { cls: ".sf-emb",  pct: "70%" },
      { cls: ".sf-dob",  pct: "100%" },
      { cls: ".sf-cty",  pct: "0%" },
    ];
    signalData.forEach((s, i) => {
      tl.to(s.cls, { autoAlpha: 1, y: 0, duration: 0.25 }, i === 0 ? "+=0.1" : "-=0.1");
      tl.to(`${s.cls} .signal-fill`, { width: s.pct, duration: 0.5, ease: "power2.out" }, "<0.1");
    });

    tl.to(".wt-scoring-detail", { autoAlpha: 1, y: 0, duration: 0.35 }, "-=0.1");
    tl.to(".wt-scoring-arrow", { autoAlpha: 1, duration: 0.3 });

    // -- Phase 4: Rules --
    tl.call(() => setPhase("rules"));
    tl.to(".wt-rules", { autoAlpha: 1, y: 0, duration: 0.5 }, "+=0.1");

    tl.to(".rule-e1", { autoAlpha: 1, x: 0, duration: 0.3 }, "+=0.15");
    tl.to(".rule-e1-result", { autoAlpha: 1, duration: 0.2 });
    tl.to(".rule-e2", { autoAlpha: 1, x: 0, duration: 0.3 }, "+=0.08");
    tl.to(".rule-e2-result", { autoAlpha: 1, duration: 0.2 });
    tl.to(".rule-r1", { autoAlpha: 1, x: 0, duration: 0.3 }, "+=0.08");
    tl.to(".rule-r1-result", { autoAlpha: 1, duration: 0.2 });
    tl.to(".wt-rules-detail", { autoAlpha: 1, y: 0, duration: 0.35 }, "-=0.1");
    tl.to(".wt-rules-arrow", { autoAlpha: 1, duration: 0.3 });

    // -- Phase 5: LLM Agent --
    tl.call(() => setPhase("llm"));
    tl.to(".wt-llm", { autoAlpha: 1, y: 0, duration: 0.5 }, "+=0.1");
    [0, 1, 2, 3].forEach((i) => {
      tl.to(`.wt-llm-line-${i}`, { autoAlpha: 1, y: 0, duration: 0.3 }, i === 0 ? "+=0.1" : "+=0.06");
    });
    tl.to(".wt-llm-verdict", { autoAlpha: 1, scale: 1, duration: 0.4, ease: "back.out(1.7)" }, "+=0.1");
    tl.to(".wt-llm-arrow", { autoAlpha: 1, duration: 0.3 });

    // -- Phase 6: Final Decision --
    tl.call(() => setPhase("decision"));
    tl.to(".decision-badge", { autoAlpha: 1, scale: 1, duration: 0.5, ease: "back.out(1.7)" }, "+=0.2");
    tl.to(".decision-reasoning", { autoAlpha: 1, y: 0, duration: 0.4 }, "-=0.2");
  }

  useEffect(() => {
    return () => { if (tlRef.current) tlRef.current.kill(); };
  }, []);

  useGSAP(() => {
    if (!containerRef.current) return;
    gsap.set(".anim-node", { autoAlpha: 0, y: 10 });
    gsap.set(".rule-check", { autoAlpha: 0, x: -10 });
    gsap.set(".decision-badge", { autoAlpha: 0, scale: 0.8 });
    gsap.set(".signal-fill", { width: "0%" });
  }, { scope: containerRef });

  const phaseIdx = phase === "idle" ? -1 : WT_PHASES.indexOf(phase as typeof WT_PHASES[number]);

  return (
    <div className="space-y-6">
      <FlowNode delay={0.2}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-gray-900">Live Walkthrough</h3>
            <p className="text-sm text-gray-500">Watch a screening decision being made step by step — results stay on screen for review</p>
          </div>
          <div className="flex items-center gap-2">
            {finished && (
              <button
                onClick={resetAll}
                className="flex items-center gap-2 h-9 px-4 rounded-lg bg-white border border-gray-200 text-gray-600 text-sm font-medium hover:bg-gray-50 transition-all shadow-sm"
              >
                <ArrowRight className="w-3.5 h-3.5 rotate-180" />
                Reset
              </button>
            )}
            <button
              onClick={runAnimation}
              disabled={running}
              className="flex items-center gap-2 h-9 px-5 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-gray-800 disabled:opacity-40 transition-all shadow-md"
            >
              <Play className="w-3.5 h-3.5" />
              {running ? "Running..." : finished ? "Replay" : "Run Demo"}
            </button>
          </div>
        </div>
      </FlowNode>

      <div ref={containerRef} className="rounded-2xl border border-gray-200 bg-gradient-to-br from-slate-50/80 via-white to-indigo-50/30 p-8 space-y-6 overflow-hidden shadow-sm" style={{ minHeight: 520 }}>

        {/* Phase progress bar */}
        <div className="flex items-center justify-center gap-0">
          {WT_PHASES.map((p, i) => {
            const meta = WT_PHASE_META[p];
            const isActive = phase === p;
            const isPast = phaseIdx > i;
            return (
              <div key={p} className="flex items-center">
                {i > 0 && <div className="w-10 h-[2px] transition-colors duration-500" style={{ backgroundColor: isPast || isActive ? meta.color : "#e5e7eb" }} />}
                <div className="flex flex-col items-center gap-1">
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold transition-all duration-500 border-2"
                    style={{
                      backgroundColor: isActive ? meta.color : isPast ? `${meta.color}18` : "#f9fafb",
                      borderColor: isActive || isPast ? meta.color : "#e5e7eb",
                      color: isActive ? "white" : isPast ? meta.color : "#9ca3af",
                    }}
                  >
                    {isPast ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
                  </div>
                  <span className="text-[9px] font-semibold transition-colors duration-300" style={{ color: isActive ? meta.color : isPast ? meta.color : "#9ca3af" }}>
                    {meta.label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Row 1: Input → Blocking Engine ── */}
        <div className="flex items-start gap-4">
          {/* Input card */}
          <div className="anim-node wt-input w-[200px] rounded-xl border border-gray-200 bg-white p-4 space-y-3 shadow-sm shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center">
                <User className="w-4 h-4 text-gray-600" />
              </div>
              <div>
                <p className="text-xs font-bold text-gray-800">Customer Input</p>
                <p className="text-[9px] text-gray-400">Transaction screening</p>
              </div>
            </div>
            <div className="space-y-1.5 text-[11px]">
              <div className="flex justify-between"><span className="text-gray-400">Name</span><span className="font-semibold text-gray-800">Kasim Suleymani</span></div>
              <div className="flex justify-between"><span className="text-gray-400">DOB</span><span className="font-semibold text-gray-800">1957-03-11</span></div>
              <div className="flex justify-between"><span className="text-gray-400">Country</span><span className="font-mono text-gray-300 italic">—</span></div>
            </div>
          </div>

          <div className="anim-node wt-input-arrow flex items-center self-center pt-4"><ArrowRight className="w-4 h-4 text-gray-300" /></div>

          {/* Layer 1: Blocking Engine */}
          <div className="anim-node wt-blocking flex-1 rounded-xl border p-4 space-y-3 shadow-sm transition-all"
            style={{ borderColor: LAYER_COLORS.blocking.border, backgroundColor: LAYER_COLORS.blocking.bg }}>
            <div className="flex items-center gap-2.5">
              <span className="text-[9px] font-bold px-2 py-0.5 rounded text-white" style={{ backgroundColor: LAYER_COLORS.blocking.main }}>LAYER 1</span>
              <span className="text-sm font-bold" style={{ color: LAYER_COLORS.blocking.main }}>Blocking Engine</span>
              <span className="ml-auto text-[9px] text-gray-400">Candidate Selection</span>
            </div>

            <p className="anim-node wt-blocking-detail text-[11px] text-gray-500 leading-relaxed">
              100K+ customers are narrowed down via inverted index queries on DOB year and Metaphone phonetic codes.
              Only records sharing the same birth year or sound code pass through as candidates — O(1) lookup.
            </p>

            <div className="space-y-2">
              <div className="anim-node wt-dob-idx rule-check flex items-center gap-3 px-3 py-2 rounded-lg bg-white/70 border border-indigo-100 text-[11px]">
                <Calendar className="w-4 h-4 text-indigo-500 shrink-0" />
                <div>
                  <p className="font-semibold text-gray-700">DOB Year Index <span className="font-normal text-gray-400">→ 1957</span></p>
                  <p className="text-[9px] text-gray-400">Year-based inverted index: 1957 → <span className="font-bold text-indigo-600">{"{"}EU-0009, EU-0142{"}"}</span></p>
                </div>
              </div>
              <div className="anim-node wt-ph-idx rule-check flex items-center gap-3 px-3 py-2 rounded-lg bg-white/70 border border-indigo-100 text-[11px]">
                <Waves className="w-4 h-4 text-indigo-500 shrink-0" />
                <div>
                  <p className="font-semibold text-gray-700">Phonetic Index <span className="font-normal text-gray-400">→ SLMN</span></p>
                  <p className="text-[9px] text-gray-400">Metaphone code: Suleymani → SLMN, Soleimani → SLMN <span className="text-green-600 font-bold">✓ Match</span></p>
                </div>
              </div>
            </div>

            <div className="anim-node wt-candidate flex items-center gap-2.5 px-3 py-2 rounded-lg bg-indigo-100/60 border border-indigo-200 text-[11px]">
              <CheckCircle2 className="w-4 h-4 text-indigo-600 shrink-0" />
              <div>
                <p className="font-bold text-indigo-700">1 candidate found — Primary Block Hit</p>
                <p className="text-[10px] text-indigo-500">DOB year 1957 ✓ + shared phonetic SLMN ✓ → <span className="font-semibold">Ghasem Soleimani (EU-0009)</span></p>
              </div>
            </div>
          </div>
        </div>

        {/* ── Row 2: Scoring ── */}
        <div className="flex items-start gap-4">
          <div className="w-[200px] shrink-0" />
          <div className="anim-node wt-blocking-arrow flex items-center self-center"><ArrowRight className="w-4 h-4 text-gray-300 -rotate-45" /></div>

          <div className="anim-node wt-scoring flex-1 rounded-xl border p-4 space-y-3 shadow-sm transition-all"
            style={{ borderColor: LAYER_COLORS.scoring.border, backgroundColor: LAYER_COLORS.scoring.bg }}>
            <div className="flex items-center gap-2.5">
              <span className="text-[9px] font-bold px-2 py-0.5 rounded text-white" style={{ backgroundColor: LAYER_COLORS.scoring.main }}>LAYER 2</span>
              <span className="text-sm font-bold" style={{ color: LAYER_COLORS.scoring.main }}>5-Signal Scoring</span>
              <span className="ml-auto text-[9px] text-gray-400">Independent Signal Analysis</span>
            </div>

            <div className="grid grid-cols-[1fr_1fr] gap-x-6 gap-y-2">
              {[
                { cls: "sf-jw",  label: "Jaro-Winkler", value: "0.783", color: "#f59e0b", desc: "Token-level string distance" },
                { cls: "sf-ph",  label: "Phonetic",     value: "0.500", color: "#3b82f6", desc: "1/2 Metaphone codes match" },
                { cls: "sf-emb", label: "Embedding",    value: "0.696", color: "#8b5cf6", desc: "Multilingual neural similarity" },
                { cls: "sf-dob", label: "DOB",          value: "1.000", color: "#ef4444", desc: "Exact date match" },
                { cls: "sf-cty", label: "Country",      value: "N/A",   color: "#9ca3af", desc: "Not provided" },
              ].map((s) => (
                <div key={s.cls} className={`anim-node ${s.cls} flex items-center gap-2.5 text-[11px]`}>
                  <span className="w-[82px] text-gray-600 font-medium shrink-0">{s.label}</span>
                  <div className="flex-1 h-[7px] rounded-full bg-white/80 overflow-hidden border border-gray-200/50">
                    <div className="signal-fill h-full rounded-full transition-none" style={{ backgroundColor: s.color, width: "0%" }} />
                  </div>
                  <span className="w-[38px] text-right font-mono font-bold tabular-nums text-[11px]" style={{ color: s.color }}>{s.value}</span>
                </div>
              ))}
            </div>

            <p className="anim-node wt-scoring-detail text-[10px] text-gray-500 leading-relaxed border-t border-amber-200/50 pt-2">
              Each signal is computed independently. Jaro-Winkler measures character similarity, Phonetic compares sound codes,
              Embedding captures multilingual semantic similarity, DOB checks date proximity, and Country verifies nationality.
              No signal is weighted — the rule engine evaluates combinations.
            </p>
          </div>
        </div>

        {/* ── Row 3: Rules Engine ── */}
        <div className="flex items-start gap-4">
          <div className="w-[200px] shrink-0" />
          <div className="anim-node wt-scoring-arrow flex items-center self-center"><ArrowRight className="w-4 h-4 text-gray-300 -rotate-45" /></div>

          <div className="anim-node wt-rules flex-1 rounded-xl border p-4 space-y-3 shadow-sm transition-all"
            style={{ borderColor: LAYER_COLORS.decision.border, backgroundColor: LAYER_COLORS.decision.bg }}>
            <div className="flex items-center gap-2.5">
              <span className="text-[9px] font-bold px-2 py-0.5 rounded text-white" style={{ backgroundColor: LAYER_COLORS.decision.main }}>LAYER 3</span>
              <span className="text-sm font-bold" style={{ color: LAYER_COLORS.decision.main }}>Rule Engine</span>
              <span className="ml-auto text-[9px] text-gray-400">Priority-ordered evaluation</span>
            </div>

            <div className="space-y-2">
              <div className="anim-node rule-check rule-e1 flex items-center gap-3 px-3 py-2 rounded-lg bg-white/60 border border-gray-200 text-[11px]">
                <span className="font-bold text-gray-400 w-[28px] shrink-0">E1</span>
                <span className="text-gray-500 flex-1 font-mono text-[10px]">DOB ≥ 1.0 AND JW ≥ 0.90</span>
                <span className="text-[9px] text-gray-400 shrink-0">JW 0.783 &lt; 0.90</span>
                <span className="anim-node rule-e1-result"><XCircle className="w-3.5 h-3.5 text-gray-300" /></span>
              </div>
              <div className="anim-node rule-check rule-e2 flex items-center gap-3 px-3 py-2 rounded-lg bg-white/60 border border-gray-200 text-[11px]">
                <span className="font-bold text-gray-400 w-[28px] shrink-0">E2</span>
                <span className="text-gray-500 flex-1 font-mono text-[10px]">DOB ≥ 1.0 AND Emb ≥ 0.85 AND JW ≥ 0.65</span>
                <span className="text-[9px] text-gray-400 shrink-0">Emb 0.696 &lt; 0.85</span>
                <span className="anim-node rule-e2-result"><XCircle className="w-3.5 h-3.5 text-gray-300" /></span>
              </div>
              <div className="anim-node rule-check rule-r1 flex items-center gap-3 px-3 py-2 rounded-lg bg-amber-50/80 border border-amber-200 text-[11px]">
                <span className="font-bold text-amber-600 w-[28px] shrink-0">R1</span>
                <span className="text-gray-600 flex-1 font-mono text-[10px]">DOB ≥ 1.0 AND JW ≥ 0.70</span>
                <span className="text-[9px] text-amber-600 font-semibold shrink-0">DOB 1.0 ✓ JW 0.783 ✓</span>
                <span className="anim-node rule-r1-result"><CheckCircle2 className="w-3.5 h-3.5 text-amber-500" /></span>
              </div>
            </div>

            <div className="anim-node wt-rules-detail flex items-center gap-2.5 px-3 py-2 rounded-lg bg-amber-100/50 border border-amber-200 text-[11px]">
              <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
              <div>
                <p className="font-bold text-amber-700">R1 fired → NEEDS_REVIEW</p>
                <p className="text-[10px] text-gray-500">First matching rule wins. E-rules failed, R1 triggered — forwarding to LLM Agent.</p>
              </div>
            </div>
          </div>
        </div>

        {/* ── Row 4: LLM Agent ── */}
        <div className="flex items-start gap-4">
          <div className="w-[200px] shrink-0" />
          <div className="anim-node wt-rules-arrow flex items-center self-center"><ArrowRight className="w-4 h-4 text-gray-300 -rotate-45" /></div>

          <div className="anim-node wt-llm flex-1 rounded-xl border p-4 space-y-3 shadow-sm transition-all"
            style={{ borderColor: LAYER_COLORS.llm.border, backgroundColor: LAYER_COLORS.llm.bg }}>
            <div className="flex items-center gap-2.5">
              <span className="text-[9px] font-bold px-2 py-0.5 rounded text-white" style={{ backgroundColor: LAYER_COLORS.llm.main }}>LAYER 4</span>
              <span className="text-sm font-bold" style={{ color: LAYER_COLORS.llm.main }}>LLM Agent</span>
              <span className="ml-auto text-[9px] text-gray-400">Grok 3 Mini — structured reasoning</span>
            </div>

            <div className="space-y-1.5">
              {[
                "Exact DOB match (1957-03-11) — strong biometric signal",
                "\"Kasim\" ↔ \"Ghasem\" — Arabic/Farsi transliteration (قاسم)",
                "\"Suleymani\" ↔ \"Soleimani\" — systematic vowel shift",
                "Verdict: High-confidence transliteration → ESCALATE",
              ].map((line, i) => {
                const isLast = i === 3;
                return (
                  <div key={i} className={`anim-node wt-llm-line-${i} flex items-start gap-2 px-3 py-1.5 rounded-lg text-[11px] ${
                    isLast ? "bg-red-50 border border-red-200 font-semibold text-red-700" : "bg-white/60 text-gray-600"
                  }`}>
                    <span className="text-gray-300 shrink-0 mt-0.5">{isLast ? "→" : "·"}</span>
                    <span>{line}</span>
                  </div>
                );
              })}
            </div>

            <div className="anim-node wt-llm-verdict flex items-center justify-center">
              <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-50 border border-red-200 text-[11px]">
                <ShieldX className="w-4 h-4 text-red-600" />
                <span className="font-bold text-red-600">LLM upgraded: NEEDS_REVIEW → ESCALATE</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── Row 5: Final Decision ── */}
        <div className="flex items-start gap-4">
          <div className="w-[200px] shrink-0" />
          <div className="anim-node wt-llm-arrow flex items-center self-center"><ArrowRight className="w-4 h-4 text-gray-300 -rotate-45" /></div>

          <div className="flex-1 flex items-center gap-6">
            <div className="decision-badge flex items-center gap-3 px-5 py-3 rounded-xl bg-red-50 border-2 border-red-200 shadow-lg">
              <ShieldX className="w-6 h-6 text-red-600" />
              <div>
                <span className="text-lg font-bold text-red-600">ESCALATE</span>
                <p className="text-[10px] text-gray-500">Immediate compliance review</p>
              </div>
            </div>
            <div className="anim-node decision-reasoning flex-1 rounded-lg bg-white border border-gray-200 p-3 shadow-sm">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Pipeline Summary</p>
              <p className="text-[11px] text-gray-600 leading-relaxed">
                Exact DOB match (1957-03-11) + Arabic/Farsi transliteration pattern (Kasim↔Ghasem, Suleymani↔Soleimani)
                + shared phonetic code (SLMN). Rule R1 → NEEDS_REVIEW, LLM analysis → upgraded to <span className="font-bold text-red-600">ESCALATE</span>.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   SECTION: SIGNAL DEEP DIVE
   ═══════════════════════════════════════════════════════════ */

function SignalDeepDive() {
  return (
    <div className="space-y-5">
      <FlowNode delay={0.1}>
        <h3 className="text-lg font-bold text-gray-900">The 5 Signals</h3>
        <p className="text-sm text-gray-500">Each signal is independently scored 0.0–1.0 and evaluated by the rule engine</p>
      </FlowNode>

      <div className="grid grid-cols-5 gap-3">
        {SIGNALS.map((signal, i) => (
          <FlowNode key={signal.key} delay={0.2 + i * 0.1}>
            <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3 hover:shadow-md transition-shadow h-full">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${signal.color}15` }}>
                  <signal.icon className="w-4 h-4" style={{ color: signal.color }} />
                </div>
                <div>
                  <p className="text-[11px] font-bold text-gray-800">{signal.label}</p>
                  <p className="text-[9px] text-gray-400">{signal.desc}</p>
                </div>
              </div>
              <SignalScaleBar color={signal.color} delay={0.4 + i * 0.15} />
            </div>
          </FlowNode>
        ))}
      </div>
    </div>
  );
}

function SignalScaleBar({ color, delay }: { color: string; delay: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const segments = ref.current.querySelectorAll(".scale-seg");
    gsap.fromTo(segments, { scaleX: 0 }, {
      scaleX: 1, duration: 0.5, stagger: 0.08, delay, ease: "power2.out", transformOrigin: "left",
    });
  }, [delay]);

  return (
    <div ref={ref} className="space-y-1">
      <div className="flex gap-[2px] h-[6px]">
        {[0.2, 0.3, 0.3, 0.2].map((w, i) => (
          <div key={i} className="scale-seg rounded-sm" style={{
            width: `${w * 100}%`, backgroundColor: color,
            opacity: 0.2 + i * 0.25,
          }} />
        ))}
      </div>
      <div className="flex justify-between text-[8px] text-gray-400 tabular-nums">
        <span>0.0</span>
        <span className="text-amber-500">Review</span>
        <span className="text-red-500">Escalate</span>
        <span>1.0</span>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   SECTION: RULE ENGINE
   ═══════════════════════════════════════════════════════════ */

function RuleEngine() {
  const rules = [
    { id: "E1", type: "ESCALATE", condition: "DOB ≥ 1.0  AND  JW ≥ 0.85", desc: "Exact date + strong name" },
    { id: "E2", type: "ESCALATE", condition: "DOB ≥ 1.0  AND  Emb ≥ 0.80  AND  Ph ≥ 0.5", desc: "Exact date + embedding + phonetic" },
    { id: "E3", type: "ESCALATE", condition: "JW ≥ 0.92  AND  DOB ≥ 0.8  AND  Country = 1", desc: "Very strong name + year + country" },
    { id: "E4", type: "ESCALATE", condition: "Emb ≥ 0.90  AND  DOB ≥ 0.8  AND  corroboration", desc: "Strong embedding + date + support" },
    { id: "E5", type: "ESCALATE", condition: "DOB ≥ 1.0  AND  JW ≥ 0.70  AND  Ph ≥ 0.40", desc: "Transliteration pattern" },
    { id: "R1", type: "REVIEW",   condition: "Missing data  AND  (JW ≥ 0.75 OR Emb ≥ 0.70)", desc: "Missing DOB/country + name signal" },
    { id: "R7", type: "REVIEW",   condition: "DOB ≥ 1.0  AND  Emb ≥ 0.50", desc: "Cross-script safety net" },
    { id: "R8", type: "REVIEW",   condition: "DOB ≥ 0.8  AND  Emb ≥ 0.60  AND  Country = 1", desc: "Cross-script + metadata" },
  ];

  const ruleColor = (type: string) => type === "ESCALATE" ? { bg: "#fef2f2", border: "#fecaca", text: "#dc2626" } : { bg: "#fffbeb", border: "#fde68a", text: "#d97706" };

  return (
    <div className="space-y-5">
      <FlowNode delay={0.1}>
        <h3 className="text-lg font-bold text-gray-900">Rule Engine</h3>
        <p className="text-sm text-gray-500">
          Rules are evaluated in priority order. First match wins. No match → AUTO_CLEAR.
        </p>
      </FlowNode>

      <FlowNode delay={0.2}>
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="grid grid-cols-[48px_80px_1fr_1fr] text-[10px] font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-100 px-4 py-2">
            <span>Rule</span><span>Type</span><span>Condition</span><span>Description</span>
          </div>
          {rules.map((rule, i) => {
            const c = ruleColor(rule.type);
            return (
              <FlowNode key={rule.id} delay={0.25 + i * 0.06}>
                <div className="grid grid-cols-[48px_80px_1fr_1fr] items-center px-4 py-2.5 border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                  <span className="text-[11px] font-bold text-gray-700">{rule.id}</span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full w-fit" style={{ backgroundColor: c.bg, color: c.text, borderWidth: 1, borderColor: c.border }}>
                    {rule.type}
                  </span>
                  <span className="text-[11px] font-mono text-gray-600">{rule.condition}</span>
                  <span className="text-[11px] text-gray-500">{rule.desc}</span>
                </div>
              </FlowNode>
            );
          })}
          {/* Auto clear */}
          <div className="grid grid-cols-[48px_80px_1fr_1fr] items-center px-4 py-2.5 bg-emerald-50/30">
            <span className="text-[11px] font-bold text-gray-400">—</span>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full w-fit bg-emerald-50 text-emerald-600 border border-emerald-200">CLEAR</span>
            <span className="text-[11px] font-mono text-gray-400 italic">No rule matched</span>
            <span className="text-[11px] text-gray-400">Default → AUTO_CLEAR</span>
          </div>
        </div>
      </FlowNode>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   MAIN EXPORT
   ═══════════════════════════════════════════════════════════ */

export function ExplainerPanel() {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    gsap.from(".explainer-title", { y: 12, autoAlpha: 0, duration: 0.5, ease: "power3.out" });
  }, { scope: root });

  return (
    <div ref={root} className="overflow-auto px-10 py-8">
      <div className="mx-auto max-w-[1400px] space-y-14">

        {/* Title */}
        <div className="explainer-title text-center space-y-2">
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Screening Pipeline</h1>
          <p className="text-sm text-gray-500 max-w-lg mx-auto">
            How the 4-layer screening pipeline processes each customer —
            from raw input to final compliance decision.
          </p>
        </div>

        {/* Divider */}
        <div className="relative flex items-center justify-center py-2">
          <div className="absolute inset-x-0 top-1/2 h-px bg-gray-200" />
          <span className="relative bg-white px-4 text-[10px] font-bold text-gray-400 uppercase tracking-widest">
            Reference
          </span>
        </div>

        {/* Pipeline overview (static reference) */}
        <PipelineOverview />

        {/* Live walkthrough */}
        <LiveWalkthrough />

        {/* Signal deep dive */}
        <SignalDeepDive />

        {/* Rule engine */}
        <RuleEngine />

      </div>
    </div>
  );
}
