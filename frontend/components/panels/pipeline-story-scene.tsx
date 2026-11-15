"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  User, ArrowRight, Database, Fingerprint, Waves, Brain,
  Calendar, Globe, ShieldCheck, ShieldAlert, ShieldX,
  Search, Zap, ChevronRight, ChevronLeft,
  CheckCircle2, XCircle, Cpu, Sparkles,
  ArrowDown, GitBranch,
} from "lucide-react";

gsap.registerPlugin(useGSAP);

/* ═══════════════════════════════════════════════════════════
   DESIGN TOKENS
   ═══════════════════════════════════════════════════════════ */

const C = {
  blocking: { main: "#6366f1", bg: "#eef2ff", border: "#c7d2fe", light: "#e0e7ff" },
  scoring:  { main: "#d97706", bg: "#fffbeb", border: "#fde68a", light: "#fef3c7" },
  rules:    { main: "#059669", bg: "#ecfdf5", border: "#a7f3d0", light: "#d1fae5" },
  llm:      { main: "#8b5cf6", bg: "#f5f3ff", border: "#ddd6fe", light: "#ede9fe" },
  escalate: "#dc2626",
  review:   "#d97706",
  clear:    "#059669",
};

const TOTAL_SCENES = 7;
const SCENE_LABELS = [
  "Overview",
  "Blocking Engine",
  "Inside Blocking",
  "Signal Scoring",
  "Rule Engine",
  "LLM Agent",
  "Decision",
];

/* ═══════════════════════════════════════════════════════════
   EXAMPLE CASE DATA (actual algorithm values)
   ═══════════════════════════════════════════════════════════ */

const EX = {
  customer: { name: "Kasim Suleymani", dob: "1957-03-11", country: "—" },
  match:    { id: "EU-0009", name: "Ghasem Soleimani", dob: "1957-03-11", country: "IR", program: "EU Sanctions" },
  phonetic: { customer: ["KSM", "SLMN"], sanction: ["XSM", "SLMN"] },
  signals:  [
    { key: "jw",   label: "Jaro-Winkler",  value: 0.783, color: "#f59e0b", icon: Fingerprint, desc: "Token-level string distance" },
    { key: "ph",   label: "Phonetic",       value: 0.500, color: "#3b82f6", icon: Waves,       desc: "1/2 Metaphone codes match" },
    { key: "emb",  label: "Embedding",      value: 0.696, color: "#8b5cf6", icon: Brain,       desc: "Multilingual neural similarity" },
    { key: "dob",  label: "Date of Birth",  value: 1.000, color: "#ef4444", icon: Calendar,    desc: "Exact date match" },
    { key: "cty",  label: "Country",        value: null,  color: "#9ca3af", icon: Globe,       desc: "Not provided" },
  ],
  rules: [
    { id: "E1", cond: "DOB ≥ 1.0  AND  JW ≥ 0.90",                     result: false, reason: "JW 0.783 < 0.90" },
    { id: "E2", cond: "DOB ≥ 1.0  AND  Emb ≥ 0.85  AND  JW ≥ 0.65",   result: false, reason: "Emb 0.696 < 0.85" },
    { id: "E3", cond: "DOB ≥ 1.0  AND  JW ≥ 0.75  AND  Country = 1",   result: false, reason: "Country missing" },
    { id: "R1", cond: "DOB ≥ 1.0  AND  JW ≥ 0.70",                     result: true,  reason: "DOB 1.0 ✓  JW 0.783 ✓" },
  ],
  llmReasoning: [
    "Analyzing: Kasim Suleymani ↔ Ghasem Soleimani",
    "Exact DOB match (1957-03-11) — strong biometric signal",
    "\"Kasim\" ↔ \"Ghasem\" — Arabic/Farsi transliteration variant (قاسم)",
    "\"Suleymani\" ↔ \"Soleimani\" — systematic vowel shift pattern",
    "Phonetic codes corroborate: shared SLMN Metaphone",
    "Verdict: High-confidence transliteration match → ESCALATE",
  ],
};


/* ═══════════════════════════════════════════════════════════
   SMALL REUSABLE PIECES
   ═══════════════════════════════════════════════════════════ */

function Pill({ children, bg, color, border }: { children: React.ReactNode; bg: string; color: string; border: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold"
      style={{ backgroundColor: bg, color, border: `1px solid ${border}` }}>
      {children}
    </span>
  );
}

function SceneArrow() {
  return (
    <div className="flex items-center justify-center px-1 shrink-0">
      <ArrowRight className="w-4 h-4 text-gray-300" />
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   SCENE 0 — OVERVIEW
   ═══════════════════════════════════════════════════════════ */

function OverviewCard({ color, layer, title, icon: Icon, children }: {
  color: typeof C.blocking; layer: number; title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="w-[150px] rounded-xl border p-2.5 space-y-1.5 shrink-0"
      style={{ borderColor: color.border, backgroundColor: color.bg }}>
      <div className="flex items-center gap-1.5">
        <span className="text-[8px] font-bold px-1.5 py-0.5 rounded text-white" style={{ backgroundColor: color.main }}>L{layer}</span>
        <span className="text-[10px] font-bold" style={{ color: color.main }}>{title}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div style={{ color: color.main }}><Icon className="w-3 h-3" /></div>
        <span className="text-[9px] text-gray-500">{children}</span>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════════════ */

export function PipelineStoryScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const sceneIdx = useRef(0);
  const [display, setDisplay] = useState(0);
  const animating = useRef(false);
  const tls = useRef<gsap.core.Timeline[]>([]);

  /* ── Scene panel refs ── */
  const s0 = useRef<HTMLDivElement>(null);
  const s1 = useRef<HTMLDivElement>(null);
  const s2 = useRef<HTMLDivElement>(null);
  const s3 = useRef<HTMLDivElement>(null);
  const s4 = useRef<HTMLDivElement>(null);
  const s5 = useRef<HTMLDivElement>(null);
  const s6 = useRef<HTMLDivElement>(null);
  const sceneRefs = [s0, s1, s2, s3, s4, s5, s6];

  /* ── Build timelines ── */
  useGSAP(() => {
    const panels = [s1, s2, s3, s4, s5, s6];
    panels.forEach((r) => { if (r.current) gsap.set(r.current, { autoAlpha: 0 }); });

    const DUR = 0.55;
    const EASE = "power3.inOut";

    // ── T1: Overview → Blocking Focus ──
    const t1 = gsap.timeline({ paused: true, defaults: { duration: DUR, ease: EASE } });
    t1.to(s0.current, { autoAlpha: 0, scale: 0.96, duration: 0.35 })
      .fromTo(s1.current!, { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0 }, "-=0.15")
      // internal entrance stagger
      .from(".s1-card", { y: 16, autoAlpha: 0, stagger: 0.08, duration: 0.4 }, "-=0.3")
      .from(".s1-idx-row", { x: -12, autoAlpha: 0, stagger: 0.1, duration: 0.35 }, "-=0.2");
    tls.current[1] = t1;

    // ── T2: Blocking Focus → Inside Blocking ──
    const t2 = gsap.timeline({ paused: true, defaults: { duration: DUR, ease: EASE } });
    t2.to(s1.current, { autoAlpha: 0, x: -24, duration: 0.3 })
      .fromTo(s2.current!, { autoAlpha: 0, x: 24 }, { autoAlpha: 1, x: 0 }, "-=0.15")
      .from(".s2-step", { y: 16, autoAlpha: 0, stagger: 0.12, duration: 0.4 }, "-=0.2")
      // DOB lookup highlight
      .from(".s2-dob-hit", { scale: 0.8, autoAlpha: 0, duration: 0.35, ease: "back.out(1.7)" }, "-=0.1")
      // Phonetic match highlight
      .from(".s2-ph-hit", { scale: 0.8, autoAlpha: 0, duration: 0.35, ease: "back.out(1.7)" }, "-=0.15")
      // Candidate result
      .from(".s2-result", { y: 12, autoAlpha: 0, duration: 0.4 }, "+=0.05");
    tls.current[2] = t2;

    // ── T3: Inside Blocking → Signal Scoring ──
    const t3 = gsap.timeline({ paused: true, defaults: { duration: DUR, ease: EASE } });
    t3.to(s2.current, { autoAlpha: 0, x: -24, duration: 0.3 })
      .fromTo(s3.current!, { autoAlpha: 0, x: 24 }, { autoAlpha: 1, x: 0 }, "-=0.15")
      .from(".s3-pair", { y: 12, autoAlpha: 0, duration: 0.35 }, "-=0.2");
    // Animate each signal bar
    EX.signals.forEach((sig, i) => {
      const pct = sig.value !== null ? `${sig.value * 100}%` : "0%";
      t3.from(`.s3-sig-${sig.key}`, { x: -10, autoAlpha: 0, duration: 0.25 }, i === 0 ? "-=0.1" : "-=0.12")
        .fromTo(`.s3-bar-${sig.key}`, { width: "0%" }, { width: pct, duration: 0.5, ease: "power2.out" }, "<0.05");
    });
    tls.current[3] = t3;

    // ── T4: Signal Scoring → Rule Engine ──
    const t4 = gsap.timeline({ paused: true, defaults: { duration: DUR, ease: EASE } });
    t4.to(s3.current, { autoAlpha: 0, x: -24, duration: 0.3 })
      .fromTo(s4.current!, { autoAlpha: 0, x: 24 }, { autoAlpha: 1, x: 0 }, "-=0.15")
      .from(".s4-header", { y: 12, autoAlpha: 0, duration: 0.35 }, "-=0.2");
    // Evaluate rules one by one
    EX.rules.forEach((rule, i) => {
      t4.from(`.s4-rule-${rule.id}`, { x: -10, autoAlpha: 0, duration: 0.3 }, i === 0 ? "+=0.05" : "+=0.08")
        .from(`.s4-result-${rule.id}`, { scale: 0.7, autoAlpha: 0, duration: 0.25, ease: "back.out(1.7)" }, "-=0.1");
    });
    // Decision badge
    t4.from(".s4-decision", { scale: 0.8, autoAlpha: 0, duration: 0.4, ease: "back.out(1.7)" }, "+=0.1");
    tls.current[4] = t4;

    // ── T5: Rule Engine → LLM Agent ──
    const t5 = gsap.timeline({ paused: true, defaults: { duration: DUR, ease: EASE } });
    t5.to(s4.current, { autoAlpha: 0, x: -24, duration: 0.3 })
      .fromTo(s5.current!, { autoAlpha: 0, x: 24 }, { autoAlpha: 1, x: 0 }, "-=0.15")
      .from(".s5-header", { y: 12, autoAlpha: 0, duration: 0.35 }, "-=0.2")
      .from(".s5-input-badge", { scale: 0.85, autoAlpha: 0, duration: 0.3, ease: "back.out(1.4)" }, "-=0.1");
    // Reasoning lines appear one by one (typewriter feel)
    EX.llmReasoning.forEach((_, i) => {
      t5.from(`.s5-line-${i}`, { y: 8, autoAlpha: 0, duration: 0.3 }, i === 0 ? "+=0.15" : "+=0.06");
    });
    t5.from(".s5-verdict", { scale: 0.8, autoAlpha: 0, duration: 0.45, ease: "back.out(1.7)" }, "+=0.1");
    tls.current[5] = t5;

    // ── T6: LLM Agent → Final Decision ──
    const t6 = gsap.timeline({ paused: true, defaults: { duration: DUR, ease: EASE } });
    t6.to(s5.current, { autoAlpha: 0, scale: 0.96, duration: 0.35 })
      .fromTo(s6.current!, { autoAlpha: 0, scale: 1.04 }, { autoAlpha: 1, scale: 1 }, "-=0.15")
      .from(".s6-badge", { scale: 0.6, autoAlpha: 0, duration: 0.5, ease: "back.out(2)" }, "-=0.2")
      .from(".s6-trace-row", { y: 10, autoAlpha: 0, stagger: 0.06, duration: 0.3 }, "-=0.2")
      .from(".s6-reasoning", { y: 8, autoAlpha: 0, duration: 0.35 }, "-=0.1");
    tls.current[6] = t6;

  }, { scope: rootRef });

  /* ── Navigation ── */
  const go = useCallback((dir: 1 | -1) => {
    const cur = sceneIdx.current;
    const target = cur + dir;
    if (target < 0 || target >= TOTAL_SCENES || animating.current) return;
    animating.current = true;

    if (dir === 1) {
      const tl = tls.current[target];
      tl.eventCallback("onComplete", () => { sceneIdx.current = target; setDisplay(target); animating.current = false; });
      tl.restart();
    } else {
      const tl = tls.current[cur];
      tl.eventCallback("onReverseComplete", () => { sceneIdx.current = target; setDisplay(target); animating.current = false; });
      tl.reverse();
    }
  }, []);

  const next = useCallback(() => go(1), [go]);
  const prev = useCallback(() => go(-1), [go]);

  /* ── Keyboard ── */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [next, prev]);

  /* ── Render ── */
  return (
    <div ref={rootRef} className="space-y-5">
      {/* Header */}
      <div className="text-center space-y-1.5">
        <h2 className="text-xl font-bold text-gray-900 tracking-tight">How the Screening Pipeline Works</h2>
        <p className="text-sm text-gray-500 max-w-xl mx-auto">
          Every name passes through a multi-layer funnel. Step through the animation to see
          each layer in action — from raw input to final compliance decision.
        </p>
      </div>

      {/* Scene label */}
      <div className="flex items-center justify-center gap-2">
        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Scene {display + 1}/{TOTAL_SCENES}</span>
        <span className="text-[10px] text-gray-300">·</span>
        <span className="text-[11px] font-semibold text-gray-600">{SCENE_LABELS[display]}</span>
      </div>

      {/* ══════════════════ STAGE ══════════════════ */}
      <div className="relative overflow-hidden rounded-2xl border border-gray-200 bg-gradient-to-b from-gray-50/30 to-white shadow-sm" style={{ minHeight: 480 }}>

        {/* ── SCENE 0: OVERVIEW ── */}
        <div ref={s0} className="absolute inset-0 flex items-center justify-center p-6">
          <div className="flex items-center gap-2.5 flex-wrap justify-center">
            {/* Customer */}
            <div className="w-[130px] rounded-xl border border-gray-200 bg-white p-2.5 space-y-1 shadow-sm shrink-0">
              <div className="flex items-center gap-1.5">
                <div className="w-6 h-6 rounded-lg bg-gray-100 flex items-center justify-center">
                  <User className="w-3 h-3 text-gray-500" />
                </div>
                <span className="text-[10px] font-bold text-gray-700">Customer</span>
              </div>
              <div className="text-[9px] text-gray-400 space-y-0.5">
                <div>Name + DOB</div>
                <div>+ Country</div>
              </div>
            </div>

            <SceneArrow />

            <OverviewCard color={C.blocking} layer={1} title="Blocking" icon={Database}>
              DOB + Phonetic Indexes
            </OverviewCard>

            <SceneArrow />

            <OverviewCard color={C.scoring} layer={2} title="Scoring" icon={Zap}>
              5 Independent Signals
            </OverviewCard>

            <SceneArrow />

            <OverviewCard color={C.rules} layer={3} title="Rules" icon={GitBranch}>
              E1-E5, R1-R10 Engine
            </OverviewCard>

            <SceneArrow />

            <OverviewCard color={C.llm} layer={4} title="LLM Agent" icon={Brain}>
              Grok 3 Mini Reasoning
            </OverviewCard>

            <SceneArrow />

            {/* Decisions */}
            <div className="flex flex-col gap-1.5 shrink-0">
              <Pill bg="#fef2f2" color={C.escalate} border="#fecaca"><ShieldX className="w-2.5 h-2.5" /> ESCALATE</Pill>
              <Pill bg="#fffbeb" color={C.review} border="#fde68a"><ShieldAlert className="w-2.5 h-2.5" /> REVIEW</Pill>
              <Pill bg="#ecfdf5" color={C.clear} border="#a7f3d0"><ShieldCheck className="w-2.5 h-2.5" /> CLEAR</Pill>
            </div>
          </div>
        </div>

        {/* ── SCENE 1: BLOCKING FOCUS ── */}
        <div ref={s1} className="absolute inset-0 p-6 flex items-center justify-center">
          <div className="flex items-start gap-8 max-w-3xl mx-auto">
            {/* Customer card */}
            <div className="s1-card w-[220px] rounded-xl border border-gray-200 bg-white p-4 space-y-3 shadow-md shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center">
                  <User className="w-4 h-4 text-gray-600" />
                </div>
                <div>
                  <p className="text-xs font-bold text-gray-800">Customer Input</p>
                  <p className="text-[10px] text-gray-400">Transaction screening</p>
                </div>
              </div>
              <div className="space-y-1.5 text-[11px]">
                <div className="flex justify-between"><span className="text-gray-400">Name</span><span className="font-semibold text-gray-800">{EX.customer.name}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">DOB</span><span className="font-semibold text-gray-800">{EX.customer.dob}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Country</span><span className="font-mono text-gray-300 italic">{EX.customer.country}</span></div>
              </div>
            </div>

            <div className="s1-card flex items-center self-center pt-8"><ArrowRight className="w-5 h-5 text-gray-300" /></div>

            {/* Blocking engine */}
            <div className="s1-card flex-1 rounded-xl border p-4 space-y-3 shadow-md" style={{ borderColor: C.blocking.border, backgroundColor: C.blocking.bg }}>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-bold px-2 py-0.5 rounded text-white" style={{ backgroundColor: C.blocking.main }}>LAYER 1</span>
                <span className="text-sm font-bold" style={{ color: C.blocking.main }}>Blocking Engine</span>
              </div>
              <p className="text-[11px] text-gray-500 leading-relaxed">
                Reduces 100K+ customers to a tiny candidate set using two inverted indexes.
                Only candidates that share a DOB year or phonetic code are passed forward.
              </p>
              {/* Index visualization */}
              <div className="space-y-2">
                <div className="s1-idx-row flex items-center gap-2 px-3 py-2 rounded-lg bg-white/60 border" style={{ borderColor: C.blocking.light }}>
                  <Calendar className="w-4 h-4 shrink-0" style={{ color: C.blocking.main }} />
                  <div>
                    <p className="text-[11px] font-semibold text-gray-700">DOB Year Inverted Index</p>
                    <p className="text-[9px] text-gray-400">Year → Set of Sanction IDs with that birth year</p>
                  </div>
                </div>
                <div className="s1-idx-row flex items-center gap-2 px-3 py-2 rounded-lg bg-white/60 border" style={{ borderColor: C.blocking.light }}>
                  <Waves className="w-4 h-4 shrink-0" style={{ color: C.blocking.main }} />
                  <div>
                    <p className="text-[11px] font-semibold text-gray-700">Metaphone Phonetic Index</p>
                    <p className="text-[9px] text-gray-400">Sound code → Set of Sanction IDs with that phonetic</p>
                  </div>
                </div>
                <div className="s1-idx-row flex items-center gap-2 px-3 py-2 rounded-lg bg-white/60 border" style={{ borderColor: C.blocking.light }}>
                  <GitBranch className="w-4 h-4 shrink-0" style={{ color: C.blocking.main }} />
                  <div>
                    <p className="text-[11px] font-semibold text-gray-700">3-Tier Candidate Strategy</p>
                    <p className="text-[9px] text-gray-400">Primary: DOB+Phonetic · Secondary: ≥2 Phonetic · Fallback: ≥1 (no DOB)</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── SCENE 2: INSIDE BLOCKING ── */}
        <div ref={s2} className="absolute inset-0 p-6 overflow-y-auto">
          <div className="max-w-2xl mx-auto space-y-4">
            {/* Title */}
            <div className="s2-step text-center">
              <Pill bg={C.blocking.bg} color={C.blocking.main} border={C.blocking.border}><Database className="w-3 h-3" /> LAYER 1 — LIVE LOOKUP</Pill>
            </div>

            {/* Customer enters */}
            <div className="s2-step flex items-center justify-center gap-3">
              <div className="px-3 py-2 rounded-lg bg-white border border-gray-200 shadow-sm text-[11px]">
                <span className="text-gray-400">Input: </span>
                <span className="font-bold text-gray-800">{EX.customer.name}</span>
                <span className="text-gray-300 mx-1">·</span>
                <span className="font-mono text-gray-500">{EX.customer.dob}</span>
              </div>
              <ArrowRight className="w-4 h-4 text-gray-300" />
              <div className="px-3 py-2 rounded-lg text-[11px] font-semibold" style={{ backgroundColor: C.blocking.bg, color: C.blocking.main, border: `1px solid ${C.blocking.border}` }}>
                Blocking Engine
              </div>
            </div>

            {/* Step 1: DOB lookup */}
            <div className="s2-step rounded-xl border bg-white p-4 space-y-2 shadow-sm" style={{ borderColor: C.blocking.light }}>
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4" style={{ color: C.blocking.main }} />
                <span className="text-xs font-bold text-gray-700">Step 1 — DOB Year Lookup</span>
              </div>
              <div className="flex items-center gap-3 text-[11px]">
                <div className="px-2.5 py-1.5 rounded-lg bg-gray-50 border border-gray-200">
                  <span className="text-gray-400">Extract year: </span>
                  <span className="font-bold text-gray-800">1957-03-11 → <span className="text-indigo-600 font-mono">1957</span></span>
                </div>
                <ArrowRight className="w-3 h-3 text-gray-300" />
                <div className="px-2.5 py-1.5 rounded-lg border" style={{ backgroundColor: C.blocking.bg, borderColor: C.blocking.border }}>
                  <span className="text-gray-500">Index[<span className="font-mono font-bold" style={{ color: C.blocking.main }}>1957</span>] → </span>
                  <span className="s2-dob-hit inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-bold text-white text-[10px]" style={{ backgroundColor: C.blocking.main }}>
                    EU-0009
                  </span>
                </div>
              </div>
            </div>

            {/* Step 2: Phonetic lookup */}
            <div className="s2-step rounded-xl border bg-white p-4 space-y-2 shadow-sm" style={{ borderColor: C.blocking.light }}>
              <div className="flex items-center gap-2">
                <Waves className="w-4 h-4" style={{ color: C.blocking.main }} />
                <span className="text-xs font-bold text-gray-700">Step 2 — Metaphone Phonetic Codes</span>
              </div>
              <div className="space-y-1.5 text-[11px]">
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 w-[80px] shrink-0">Customer:</span>
                  <span className="font-mono text-gray-600">Kasim → <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-bold">KSM</span></span>
                  <span className="font-mono text-gray-600">Suleymani → <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-bold">SLMN</span></span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 w-[80px] shrink-0">Sanction:</span>
                  <span className="font-mono text-gray-600">Ghasem → <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 font-bold">XSM</span></span>
                  <span className="font-mono text-gray-600">Soleimani → <span className="s2-ph-hit px-1.5 py-0.5 rounded bg-green-50 text-green-700 font-bold border border-green-300">SLMN ✓</span></span>
                </div>
              </div>
            </div>

            {/* Result */}
            <div className="s2-result flex items-center justify-center gap-3">
              <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-md border" style={{ backgroundColor: C.blocking.bg, borderColor: C.blocking.main + "40" }}>
                <CheckCircle2 className="w-4 h-4" style={{ color: C.blocking.main }} />
                <div className="text-[11px]">
                  <span className="font-bold" style={{ color: C.blocking.main }}>Primary Block Hit: </span>
                  <span className="text-gray-600">DOB year 1957 ✓ + shared code SLMN ✓</span>
                </div>
              </div>
            </div>
            <div className="s2-result text-center">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white border border-gray-200 shadow-sm text-[11px]">
                <span className="text-gray-400">Candidate pair:</span>
                <span className="font-bold text-gray-800">{EX.customer.name}</span>
                <span className="text-gray-300">↔</span>
                <span className="font-bold" style={{ color: C.blocking.main }}>{EX.match.name} ({EX.match.id})</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── SCENE 3: SIGNAL SCORING ── */}
        <div ref={s3} className="absolute inset-0 p-6 overflow-y-auto">
          <div className="max-w-2xl mx-auto space-y-4">
            <div className="text-center">
              <Pill bg={C.scoring.bg} color={C.scoring.main} border={C.scoring.border}><Zap className="w-3 h-3" /> LAYER 2 — 5-SIGNAL SCORING</Pill>
            </div>

            {/* Candidate pair */}
            <div className="s3-pair flex items-center justify-center gap-4 text-[11px]">
              <div className="px-3 py-2 rounded-lg bg-white border border-gray-200 shadow-sm">
                <User className="w-3 h-3 inline mr-1 text-gray-400" />
                <span className="font-bold">{EX.customer.name}</span>
              </div>
              <span className="text-gray-300 text-xs">vs</span>
              <div className="px-3 py-2 rounded-lg border shadow-sm" style={{ backgroundColor: C.blocking.bg, borderColor: C.blocking.border }}>
                <Database className="w-3 h-3 inline mr-1" style={{ color: C.blocking.main }} />
                <span className="font-bold" style={{ color: C.blocking.main }}>{EX.match.name}</span>
                <span className="text-gray-400 ml-1 text-[10px]">({EX.match.id})</span>
              </div>
            </div>

            {/* Signal bars */}
            <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-3 shadow-sm">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Independent Signal Scores (0.0 – 1.0)</p>
              {EX.signals.map((sig) => (
                <div key={sig.key} className={`s3-sig-${sig.key} flex items-center gap-3`}>
                  <div className="flex items-center gap-2 w-[120px] shrink-0">
                    <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ backgroundColor: `${sig.color}15` }}>
                      <sig.icon className="w-3 h-3" style={{ color: sig.color }} />
                    </div>
                    <span className="text-[11px] font-semibold text-gray-700">{sig.label}</span>
                  </div>
                  <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div className={`s3-bar-${sig.key} h-full rounded-full`}
                      style={{ backgroundColor: sig.color, width: "0%" }} />
                  </div>
                  <span className="w-[44px] text-right text-[11px] font-mono font-bold tabular-nums"
                    style={{ color: sig.value !== null ? sig.color : "#9ca3af" }}>
                    {sig.value !== null ? sig.value.toFixed(3) : "N/A"}
                  </span>
                  <span className="w-[140px] text-[9px] text-gray-400 shrink-0">{sig.desc}</span>
                </div>
              ))}
            </div>

            <p className="text-center text-[10px] text-gray-400">
              Each signal is scored independently. No signal is weighted — the rule engine evaluates combinations.
            </p>
          </div>
        </div>

        {/* ── SCENE 4: RULE ENGINE ── */}
        <div ref={s4} className="absolute inset-0 p-6 overflow-y-auto">
          <div className="max-w-2xl mx-auto space-y-4">
            <div className="text-center">
              <Pill bg={C.rules.bg} color={C.rules.main} border={C.rules.border}><GitBranch className="w-3 h-3" /> LAYER 3 — RULE ENGINE</Pill>
            </div>

            <p className="s4-header text-center text-[11px] text-gray-500">
              Rules evaluate in priority order. <span className="font-semibold text-gray-700">First match wins.</span> No match → AUTO_CLEAR.
            </p>

            {/* Signal summary chips */}
            <div className="s4-header flex items-center justify-center gap-2 flex-wrap">
              {EX.signals.map((sig) => (
                <span key={sig.key} className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[9px] font-semibold bg-gray-50 border border-gray-200 text-gray-600">
                  <sig.icon className="w-2.5 h-2.5" style={{ color: sig.color }} />
                  {sig.label}={sig.value !== null ? sig.value.toFixed(2) : "N/A"}
                </span>
              ))}
            </div>

            {/* Rules evaluation */}
            <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-2 shadow-sm">
              {EX.rules.map((rule) => {
                const isMatch = rule.result;
                const bg = isMatch ? C.rules.bg : "white";
                const border = isMatch ? C.rules.border : "#e5e7eb";
                return (
                  <div key={rule.id} className={`s4-rule-${rule.id} flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors`}
                    style={{ backgroundColor: bg, borderColor: border }}>
                    <span className={`text-[11px] font-bold w-[28px] shrink-0 ${isMatch ? "text-emerald-700" : "text-gray-400"}`}>{rule.id}</span>
                    <span className="flex-1 text-[11px] font-mono text-gray-600">{rule.cond}</span>
                    <span className={`s4-result-${rule.id} text-[10px] font-semibold shrink-0`}>
                      {isMatch ? (
                        <span className="flex items-center gap-1 text-emerald-600"><CheckCircle2 className="w-3.5 h-3.5" /> MATCH</span>
                      ) : (
                        <span className="flex items-center gap-1 text-gray-300"><XCircle className="w-3.5 h-3.5" /> {rule.reason}</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Decision */}
            <div className="s4-decision flex items-center justify-center">
              <div className="flex items-center gap-2 px-5 py-2.5 rounded-xl border-2 shadow-md" style={{ backgroundColor: "#fffbeb", borderColor: "#fde68a" }}>
                <ShieldAlert className="w-5 h-5" style={{ color: C.review }} />
                <div>
                  <span className="text-sm font-bold" style={{ color: C.review }}>NEEDS_REVIEW</span>
                  <p className="text-[10px] text-gray-500">R1: exact DOB + name match (JW ≥ 0.70)</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── SCENE 5: LLM AGENT ── */}
        <div ref={s5} className="absolute inset-0 p-6 overflow-y-auto">
          <div className="max-w-2xl mx-auto space-y-4">
            <div className="text-center">
              <Pill bg={C.llm.bg} color={C.llm.main} border={C.llm.border}><Brain className="w-3 h-3" /> LAYER 4 — LLM AGENT</Pill>
            </div>

            <p className="s5-header text-center text-[11px] text-gray-500">
              Only <span className="font-semibold text-amber-600">NEEDS_REVIEW</span> cases are sent to the LLM.
              The AI agent performs structured compliance analysis using <span className="font-semibold text-gray-700">Grok 3 Mini</span>.
            </p>

            {/* Input badge */}
            <div className="flex justify-center">
              <div className="s5-input-badge flex items-center gap-3 px-4 py-2 rounded-lg border" style={{ backgroundColor: "#fffbeb", borderColor: "#fde68a" }}>
                <ShieldAlert className="w-4 h-4" style={{ color: C.review }} />
                <div className="text-[11px]">
                  <span className="font-bold text-amber-700">NEEDS_REVIEW</span>
                  <span className="text-gray-400 ml-2">{EX.customer.name} ↔ {EX.match.name}</span>
                </div>
                <ArrowRight className="w-3 h-3 text-gray-300" />
                <div className="flex items-center gap-1.5 px-2 py-1 rounded-md" style={{ backgroundColor: C.llm.bg, border: `1px solid ${C.llm.border}` }}>
                  <Cpu className="w-3 h-3" style={{ color: C.llm.main }} />
                  <span className="text-[10px] font-bold" style={{ color: C.llm.main }}>Grok 3 Mini</span>
                </div>
              </div>
            </div>

            {/* LLM reasoning */}
            <div className="rounded-xl border bg-white p-4 space-y-2 shadow-sm" style={{ borderColor: C.llm.border }}>
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="w-4 h-4" style={{ color: C.llm.main }} />
                <span className="text-[11px] font-bold text-gray-700">LLM Reasoning Chain</span>
              </div>
              {EX.llmReasoning.map((line, i) => {
                const isLast = i === EX.llmReasoning.length - 1;
                return (
                  <div key={i} className={`s5-line-${i} flex items-start gap-2 px-3 py-1.5 rounded-lg text-[11px] ${
                    isLast ? "bg-red-50 border border-red-200 font-semibold text-red-700"
                    : "bg-gray-50 text-gray-600"
                  }`}>
                    <span className="text-gray-300 shrink-0 mt-0.5">{isLast ? "→" : "·"}</span>
                    <span>{line}</span>
                  </div>
                );
              })}
            </div>

            {/* Verdict */}
            <div className="s5-verdict flex items-center justify-center">
              <div className="flex items-center gap-3 px-5 py-2.5 rounded-xl border-2 shadow-md" style={{ backgroundColor: "#fef2f2", borderColor: "#fecaca" }}>
                <ShieldX className="w-5 h-5 text-red-600" />
                <div>
                  <span className="text-sm font-bold text-red-600">ESCALATE</span>
                  <p className="text-[10px] text-gray-500">LLM upgraded: transliteration variant detected</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── SCENE 6: FINAL DECISION ── */}
        <div ref={s6} className="absolute inset-0 p-6 overflow-y-auto">
          <div className="max-w-2xl mx-auto space-y-5 flex flex-col items-center justify-center min-h-full">
            {/* Big decision badge */}
            <div className="s6-badge flex flex-col items-center gap-2">
              <div className="w-16 h-16 rounded-2xl bg-red-50 border-2 border-red-200 flex items-center justify-center shadow-lg">
                <ShieldX className="w-8 h-8 text-red-600" />
              </div>
              <span className="text-2xl font-bold text-red-600 tracking-tight">ESCALATE</span>
              <span className="text-[11px] text-gray-400">Immediate compliance review required</span>
            </div>

            {/* Pipeline trace */}
            <div className="w-full rounded-xl border border-gray-200 bg-white p-4 shadow-sm space-y-0">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-3">Pipeline Trace</p>

              <div className="s6-trace-row flex items-center gap-3 px-3 py-2 rounded-lg border-l-2 text-[11px]" style={{ borderColor: C.blocking.main, backgroundColor: C.blocking.bg }}>
                <span className="font-bold w-[50px] shrink-0" style={{ color: C.blocking.main }}>Layer 1</span>
                <span className="text-gray-600">Blocking → <span className="font-semibold">1 candidate via DOB+Phonetic</span></span>
                <span className="ml-auto"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /></span>
              </div>
              <div className="s6-trace-row flex items-center gap-3 px-3 py-2 rounded-lg border-l-2 text-[11px] mt-1" style={{ borderColor: C.scoring.main, backgroundColor: C.scoring.bg }}>
                <span className="font-bold w-[50px] shrink-0" style={{ color: C.scoring.main }}>Layer 2</span>
                <span className="text-gray-600">Scoring → JW=0.783 Ph=0.50 Emb=0.696 DOB=1.0</span>
                <span className="ml-auto"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /></span>
              </div>
              <div className="s6-trace-row flex items-center gap-3 px-3 py-2 rounded-lg border-l-2 text-[11px] mt-1" style={{ borderColor: C.rules.main, backgroundColor: C.rules.bg }}>
                <span className="font-bold w-[50px] shrink-0" style={{ color: C.rules.main }}>Layer 3</span>
                <span className="text-gray-600">Rules → <span className="font-semibold text-amber-600">R1 fired: NEEDS_REVIEW</span></span>
                <span className="ml-auto"><ShieldAlert className="w-3.5 h-3.5 text-amber-500" /></span>
              </div>
              <div className="s6-trace-row flex items-center gap-3 px-3 py-2 rounded-lg border-l-2 text-[11px] mt-1" style={{ borderColor: C.llm.main, backgroundColor: C.llm.bg }}>
                <span className="font-bold w-[50px] shrink-0" style={{ color: C.llm.main }}>Layer 4</span>
                <span className="text-gray-600">LLM → <span className="font-semibold text-red-600">Upgraded to ESCALATE</span></span>
                <span className="ml-auto"><ShieldX className="w-3.5 h-3.5 text-red-500" /></span>
              </div>
            </div>

            {/* Reasoning summary */}
            <div className="s6-reasoning w-full rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Reasoning</p>
              <p className="text-[11px] text-gray-600 leading-relaxed">
                Exact DOB match (1957-03-11) combined with Arabic/Farsi transliteration pattern
                (Kasim↔Ghasem, Suleymani↔Soleimani) and corroborating phonetic codes (shared SLMN).
                Rule R1 triggered NEEDS_REVIEW; LLM analysis confirmed high-confidence transliteration variant
                and upgraded to ESCALATE for immediate compliance review.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ══════════════════ NAVIGATION ══════════════════ */}
      <div className="flex items-center justify-center gap-4">
        <button onClick={prev} disabled={display === 0}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed shadow-sm">
          <ChevronLeft className="w-4 h-4" /> Back
        </button>

        {/* Dots */}
        <div className="flex items-center gap-1.5">
          {Array.from({ length: TOTAL_SCENES }).map((_, i) => (
            <div key={i}
              className="rounded-full transition-all duration-300"
              style={{
                width: i === display ? 20 : 6,
                height: 6,
                backgroundColor: i === display ? "#111827" : "#d1d5db",
              }}
            />
          ))}
        </div>

        <button onClick={next} disabled={display === TOTAL_SCENES - 1}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed shadow-sm">
          Next <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Keyboard hint */}
      <p className="text-center text-[10px] text-gray-300">
        Use <kbd className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-400 font-mono text-[9px]">←</kbd> <kbd className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-400 font-mono text-[9px]">→</kbd> arrow keys to navigate
      </p>
    </div>
  );
}
