"use client";

import { useState, useRef, useEffect } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Shield, XCircle, CheckCircle2, AlertTriangle, X } from "lucide-react";
import { DotMatrix } from "@/components/ui/dot-matrix";
import { ShiningText } from "@/components/ui/shining-text";
import { runBenchmark, type BenchmarkResult } from "@/lib/api";

gsap.registerPlugin(useGSAP);

/* ═══════════════════════════════════════════
 * BenchmarkInline — inline panel with
 * animated count-up metrics and staggered reveals
 * ═══════════════════════════════════════════ */

interface Props {
  active: boolean;
  onClose: () => void;
}

export function BenchmarkInline({ active, onClose }: Props) {
  const [phase, setPhase] = useState<"idle" | "loading" | "results">("idle");
  const [result, setResult] = useState<BenchmarkResult | null>(null);
  const [error, setError] = useState("");
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) { setPhase("idle"); return; }
    if (phase !== "idle") return;
    setPhase("loading");
    setResult(null);
    setError("");

    let cancelled = false;
    runBenchmark(5000)
      .then((r) => { if (!cancelled) { setResult(r); setPhase("results"); } })
      .catch((e) => { if (!cancelled) { setError(e.message); setPhase("idle"); } });
    return () => { cancelled = true; };
  }, [active]);

  // Animate wrapper entrance
  useGSAP(() => {
    if (!active || !wrapperRef.current) return;
    gsap.from(wrapperRef.current, { y: 15, opacity: 0, duration: 0.4, ease: "power3.out" });
  }, { dependencies: [active], scope: wrapperRef });

  if (!active) return null;

  return (
    <div ref={wrapperRef}>
      <div className="mt-5 rounded-xl ring-1 ring-black/10 bg-white shadow-sm">
        {phase === "loading" && !error && <LoadingPhase />}
        {error && <ErrorPhase error={error} onRetry={() => { setPhase("idle"); }} onClose={onClose} />}
        {phase === "results" && result && <ResultsPhase result={result} onClose={onClose} />}
      </div>
    </div>
  );
}

/* ── Loading ── */
function LoadingPhase() {
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    gsap.from(".bm-loading-icon", { scale: 0, rotation: -180, duration: 0.6, ease: "back.out(1.7)" });
    gsap.from(".bm-loading-text", { y: 10, opacity: 0, duration: 0.4, delay: 0.2, ease: "power2.out" });
    gsap.from(".bm-loading-sub", { y: 8, opacity: 0, duration: 0.4, delay: 0.35, ease: "power2.out" });
  }, { scope: ref });

  return (
    <div ref={ref} className="flex flex-col items-center justify-center py-10 gap-3">
      <div className="bm-loading-icon">
        <DotMatrix cols={5} rows={5} dotSize={5} gap={4} color="#2E2E2E" offColor="#e5e7eb" pattern="pulse" speed={0.5} />
      </div>
      <ShiningText text="Running L2 Benchmark…" className="bm-loading-text text-xs font-semibold" />
      <p className="bm-loading-sub text-[11px] text-muted-foreground">
        Evaluating 5,000 labeled pairs against rule engine
      </p>
    </div>
  );
}

/* ── Error ── */
function ErrorPhase({ error, onRetry, onClose }: { error: string; onRetry: () => void; onClose: () => void }) {
  return (
    <div className="flex flex-col items-center py-6 gap-2">
      <XCircle className="h-6 w-6 text-red-500" />
      <p className="text-xs text-red-700">{error}</p>
      <div className="flex gap-2">
        <button onClick={onRetry} className="text-[11px] underline text-muted-foreground">Retry</button>
        <button onClick={onClose} className="text-[11px] underline text-muted-foreground">Close</button>
      </div>
    </div>
  );
}

/* ── Results with GSAP animations ── */
function ResultsPhase({ result, onClose }: { result: BenchmarkResult; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cm = result.confusion_matrix;

  useGSAP(() => {
    const tl = gsap.timeline({ defaults: { ease: "power2.out" } });

    // 1. Header entrance
    tl.from(".bm-header", { y: -12, opacity: 0, duration: 0.3 });

    // 2. Metric cards stagger with bounce
    tl.from(".bm-metric", {
      y: 20, opacity: 0, scale: 0.9,
      stagger: 0.1, duration: 0.4, ease: "back.out(1.4)",
    }, "-=0.1");

    // 3. Count-up animations for metric values
    const counters = ref.current?.querySelectorAll<HTMLElement>(".bm-counter");
    counters?.forEach((el) => {
      const target = parseFloat(el.dataset.target || "0");
      const suffix = el.dataset.suffix || "";
      const obj = { val: 0 };
      tl.to(obj, {
        val: target,
        duration: 1.2,
        ease: "power2.out",
        onUpdate: () => { el.textContent = obj.val.toFixed(1) + suffix; },
      }, "-=1.1");
    });

    // 4. Confusion matrix cells pop in
    tl.from(".bm-cm-cell", {
      scale: 0, opacity: 0,
      stagger: { amount: 0.3, from: "random" },
      duration: 0.35, ease: "back.out(1.6)",
    }, "-=0.6");

    // 5. Rules list slide in
    tl.from(".bm-rule", {
      x: -15, opacity: 0,
      stagger: 0.06, duration: 0.3,
    }, "-=0.3");

    // 6. Examples section fade up
    tl.from(".bm-examples", { y: 12, opacity: 0, duration: 0.3 }, "-=0.1");

  }, { scope: ref });

  return (
    <div ref={ref} className="p-5 space-y-4">
      {/* Header */}
      <div className="bm-header flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-lg bg-[#2E2E2E] flex items-center justify-center">
            <Shield className="h-3.5 w-3.5 text-white" />
          </div>
          <div>
            <h3 className="text-[13px] font-semibold">L2 Benchmark Results</h3>
            <p className="text-[10px] text-muted-foreground">
              {result.sample_size.toLocaleString()} labeled pairs · {result.elapsed_s}s
            </p>
          </div>
        </div>
        <button onClick={onClose} className="p-1 rounded-lg hover:bg-secondary transition-colors">
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-4 gap-2">
        <MetricCard label="Precision" target={result.precision * 100} sub={`${cm.tp}/${cm.tp + cm.fp}`} color="emerald" icon={<CheckCircle2 className="h-3 w-3" />} />
        <MetricCard label="Recall" target={result.recall * 100} sub={`${cm.tp}/${cm.tp + cm.fn}`} color="amber" icon={<Shield className="h-3 w-3" />} />
        <MetricCard label="F1 Score" target={result.f1 * 100} sub="harmonic mean" color="blue" icon={<Shield className="h-3 w-3" />} />
        <MetricCard label="Alert Rate" target={result.alert_rate * 100} sub={`${cm.tp + cm.fp}/${result.sample_size}`} color="gray" icon={<AlertTriangle className="h-3 w-3" />} />
      </div>

      {/* Confusion Matrix + Rules */}
      <div className="grid grid-cols-2 gap-4">
        {/* Confusion Matrix */}
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-wider">Confusion Matrix</p>
          <div className="rounded-lg ring-1 ring-black/5 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#fafafa]">
                  <th className="py-1.5 px-2 text-left text-muted-foreground font-medium"></th>
                  <th className="py-1.5 px-2 text-center text-muted-foreground font-medium">Flagged</th>
                  <th className="py-1.5 px-2 text-center text-muted-foreground font-medium">Cleared</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-black/5">
                  <td className="py-2 px-2 font-medium text-muted-foreground text-[11px]">Match</td>
                  <td className="py-2 px-2 text-center">
                    <span className="bm-cm-cell inline-block px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 font-bold tabular-nums text-[11px]">{cm.tp.toLocaleString()}</span>
                  </td>
                  <td className="py-2 px-2 text-center">
                    <span className="bm-cm-cell inline-block px-2 py-0.5 rounded-md bg-red-100 text-red-700 font-bold tabular-nums text-[11px]">{cm.fn.toLocaleString()}</span>
                  </td>
                </tr>
                <tr className="border-t border-black/5">
                  <td className="py-2 px-2 font-medium text-muted-foreground text-[11px]">No Match</td>
                  <td className="py-2 px-2 text-center">
                    <span className="bm-cm-cell inline-block px-2 py-0.5 rounded-md bg-amber-100 text-amber-700 font-bold tabular-nums text-[11px]">{cm.fp.toLocaleString()}</span>
                  </td>
                  <td className="py-2 px-2 text-center">
                    <span className="bm-cm-cell inline-block px-2 py-0.5 rounded-md bg-gray-100 text-gray-600 font-bold tabular-nums text-[11px]">{cm.tn.toLocaleString()}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Detection Rules */}
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-wider">Top Detection Rules</p>
          <div className="space-y-1">
            {Object.entries(result.tp_rules).slice(0, 5).map(([rule, count], i) => {
              const maxCount = Math.max(...Object.values(result.tp_rules));
              const pct = (count / maxCount) * 100;
              return (
                <div key={i} className="bm-rule flex items-center gap-2">
                  <span className="tabular-nums font-bold text-[10px] w-7 text-right text-emerald-700">{count}</span>
                  <div className="flex-1 relative h-[18px] rounded-md overflow-hidden bg-emerald-50">
                    <div className="absolute inset-y-0 left-0 bg-emerald-200/60 rounded-md" style={{ width: `${pct}%` }} />
                    <span className="relative z-10 px-1.5 text-[9px] text-emerald-800 leading-[18px] truncate block">{rule}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Examples */}
      <div className="bm-examples space-y-3">
        {result.fn_examples.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wider">
              Missed Matches <span className="normal-case font-normal">({cm.fn} total — mostly cross-script)</span>
            </p>
            <div className="space-y-0.5 max-h-24 overflow-y-auto rounded-lg ring-1 ring-red-100 p-1.5">
              {result.fn_examples.slice(0, 6).map((ex, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[10px] py-0.5">
                  <span className="text-red-500 font-semibold shrink-0 w-7">MISS</span>
                  <span className="truncate font-medium max-w-[130px]">{ex.name_a}</span>
                  <span className="text-muted-foreground shrink-0">↔</span>
                  <span className="truncate font-medium max-w-[130px]">{ex.name_b}</span>
                  <span className="text-muted-foreground tabular-nums ml-auto shrink-0">Emb={ex.embedding} DOB={ex.dob}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {result.fp_examples.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wider">
              False Alarms <span className="normal-case font-normal">({cm.fp} total)</span>
            </p>
            <div className="space-y-0.5 max-h-16 overflow-y-auto rounded-lg ring-1 ring-amber-100 p-1.5">
              {result.fp_examples.slice(0, 4).map((ex, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[10px] py-0.5">
                  <span className="text-amber-500 font-semibold shrink-0 w-7">FP</span>
                  <span className="truncate max-w-[180px]">{ex.name_a} ↔ {ex.name_b}</span>
                  <span className="text-muted-foreground tabular-nums ml-auto shrink-0">JW={ex.jw}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Animated Metric Card ── */
function MetricCard({ label, target, sub, color, icon }: {
  label: string; target: number; sub: string; color: string; icon: React.ReactNode;
}) {
  const colors: Record<string, { bg: string; ring: string; text: string; icon: string }> = {
    emerald: { bg: "bg-emerald-50", ring: "ring-emerald-200", text: "text-emerald-800", icon: "text-emerald-500" },
    amber:   { bg: "bg-amber-50",   ring: "ring-amber-200",   text: "text-amber-800",   icon: "text-amber-500" },
    blue:    { bg: "bg-blue-50",     ring: "ring-blue-200",     text: "text-blue-800",     icon: "text-blue-500" },
    gray:    { bg: "bg-gray-50",     ring: "ring-gray-200",     text: "text-gray-700",     icon: "text-gray-400" },
  };
  const c = colors[color] || colors.gray;

  return (
    <div className={`bm-metric rounded-xl ring-1 p-2.5 ${c.bg} ${c.ring}`}>
      <div className="flex items-center gap-1 mb-0.5">
        <span className={c.icon}>{icon}</span>
        <p className={`text-[9px] font-semibold ${c.text} opacity-70 uppercase tracking-wider`}>{label}</p>
      </div>
      <p className={`bm-counter text-lg font-bold tabular-nums ${c.text}`} data-target={target.toFixed(1)} data-suffix="%">0.0%</p>
      <p className={`text-[9px] ${c.text} opacity-50 tabular-nums`}>{sub}</p>
    </div>
  );
}
