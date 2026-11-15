"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { DotMatrix } from "@/components/ui/dot-matrix";
import { ShiningText } from "@/components/ui/shining-text";
import {
  Upload, Users, CheckCircle2, XCircle, AlertTriangle,
  RotateCcw, Shield, ChevronDown, Sparkles,
} from "lucide-react";
import {
  batchScreenStream,
  getSanctionsSets,
  switchSanctionsSet,
  runBenchmark,
  type BatchCustomerInput,
  type StreamEvent,
  type SanctionsSet,
  Decision,
} from "@/lib/api";
import { BenchmarkInline } from "@/components/panels/benchmark-modal";
import {
  type BatchState, type Filter, type IndexedResult, type ResolvedItem,
  PAGE_SIZE, UI_BATCH_INTERVAL_MS, decisionMeta, parseCSV, formatTime,
} from "@/components/batch/constants";
import {
  PhaseIndicator, ProgressBar, LiveCounter, AISidePanel,
} from "@/components/batch/sub-components";
import { ExpandableRow } from "@/components/batch/expandable-row";

gsap.registerPlugin(useGSAP);

export function BatchPanel() {
  const ref = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const [state, setState] = useState<BatchState>("idle");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [datasets, setDatasets] = useState<SanctionsSet[]>([]);
  const [switching, setSwitching] = useState(false);
  const [switchStart, setSwitchStart] = useState(0);
  const [switchElapsed, setSwitchElapsed] = useState(0);

  const allResultsRef = useRef<IndexedResult[]>([]);
  const countsRef = useRef({ AUTO_CLEAR: 0, ESCALATE: 0, NEEDS_REVIEW: 0 });

  const [resolvedHistory, setResolvedHistory] = useState<ResolvedItem[]>([]);
  const [llmProcessed, setLlmProcessed] = useState(0);
  const [llmTotal, setLlmTotal] = useState(0);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);

  const [total, setTotal] = useState(0);
  const [processed, setProcessed] = useState(0);
  const [liveCounts, setLiveCounts] = useState({ AUTO_CLEAR: 0, ESCALATE: 0, NEEDS_REVIEW: 0 });
  const [visiblePage, setVisiblePage] = useState(1);
  const [resultsTick, setResultsTick] = useState(0);
  const [summary, setSummary] = useState<{
    total: number; auto_cleared: number; escalated: number; needs_review: number; processing_time_ms: number;
  } | null>(null);

  const startTimeRef = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const batchTimerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // Benchmark state
  const [benchmarkActive, setBenchmarkActive] = useState(false);

  useGSAP(() => {
    gsap.from(".batch-area", { y: 10, opacity: 0, duration: 0.35, ease: "power2.out" });
  }, { scope: ref });


  // Load available datasets
  useEffect(() => {
    if (state === "idle") getSanctionsSets().then(setDatasets).catch(() => {});
  }, [state]);

  // Switching elapsed timer
  useEffect(() => {
    if (!switching) { setSwitchElapsed(0); return; }
    const t = setInterval(() => setSwitchElapsed(Date.now() - switchStart), 100);
    return () => clearInterval(t);
  }, [switching, switchStart]);
  useEffect(() => {
    if (state === "scanning" || state === "llm_phase") {
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => setElapsed(Date.now() - startTimeRef.current), 100);
      return () => clearInterval(timerRef.current);
    }
    clearInterval(timerRef.current);
  }, [state]);

  const visibleResults = useMemo(() => {
    void resultsTick;
    const items = allResultsRef.current;
    const filtered = filter === "all"
      ? items
      : filter === Decision.NEEDS_REVIEW
        ? items.filter((r) => r.decision === Decision.NEEDS_REVIEW || r.wasReview)
        : items.filter((r) => r.decision === filter);
    return filtered.slice(0, visiblePage * PAGE_SIZE);
  }, [resultsTick, filter, visiblePage]);

  const totalFilteredCount = useMemo(() => {
    void resultsTick;
    if (filter === "all") return allResultsRef.current.length;
    if (filter === Decision.NEEDS_REVIEW)
      return allResultsRef.current.filter((r) => r.decision === Decision.NEEDS_REVIEW || r.wasReview).length;
    return allResultsRef.current.filter((r) => r.decision === filter).length;
  }, [resultsTick, filter]);

  // Track new row indices for entrance animation
  const prevVisibleCountRef = useRef(0);
  const newRowIndices = useMemo(() => {
    const currentCount = visibleResults.length;
    const prevCount = prevVisibleCountRef.current;
    prevVisibleCountRef.current = currentCount;
    if (currentCount <= prevCount) return new Set<number>();
    const newSet = new Set<number>();
    for (let i = 0; i < currentCount - prevCount; i++) {
      newSet.add(visibleResults[i]?.index ?? -1);
    }
    return newSet;
  }, [visibleResults]);

  const hasMore = visibleResults.length < totalFilteredCount;

  const nextToAnalyze = useMemo(() => {
    void resultsTick;
    if (state !== "llm_phase") return null;
    return allResultsRef.current.find((r) => r.decision === Decision.NEEDS_REVIEW) ?? null;
  }, [resultsTick, state]);

  useEffect(() => {
    if (!sentinelRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting && hasMore) setVisiblePage((p) => p + 1); },
      { rootMargin: "200px" },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, state]);

  const handleEvent = useCallback((event: StreamEvent) => {
    switch (event.type) {
      case "init":
        setTotal(event.data.total);
        break;
      case "result": {
        const r = event.data as IndexedResult;
        allResultsRef.current.push(r);
        countsRef.current[r.decision as keyof typeof countsRef.current] += 1;
        break;
      }
      case "llm_update": {
        const u = event.data;
        setState("llm_phase");
        const idx = allResultsRef.current.findIndex((r) => r.index === u.index);
        if (idx !== -1) {
          const old = allResultsRef.current[idx];
          const oldD = old.decision as keyof typeof countsRef.current;
          const newD = u.decision as keyof typeof countsRef.current;
          if (oldD !== newD) {
            countsRef.current[oldD] = Math.max(0, countsRef.current[oldD] - 1);
            countsRef.current[newD] += 1;
          }
          const resolved: IndexedResult = { ...old, decision: u.decision, llm_reasoning: u.llm_reasoning, llm_confidence: u.llm_confidence, llm_evidence: u.llm_evidence, llm_matched_entity: u.llm_matched_entity, processing_time_ms: u.processing_time_ms, layer_reached: u.layer_reached, wasReview: true };
          allResultsRef.current[idx] = resolved;
          setResolvedHistory((prev) => [{ ...resolved, resolvedAt: Date.now() }, ...prev]);
          setLlmProcessed((p) => p + 1);
          setSidePanelOpen(true); // Auto-open on first LLM result
        }
        setResultsTick((t) => t + 1);
        setLiveCounts({ ...countsRef.current });
        break;
      }
      case "done":
        setSummary(event.data);
        setProcessed(allResultsRef.current.length);
        setLiveCounts({ ...countsRef.current });
        setResultsTick((t) => t + 1);
        setState("results");
        break;
      case "error":
        setError(event.data.message || "Screening failed");
        setState("error");
        break;
    }
  }, []);

  useEffect(() => {
    if (state !== "scanning" && state !== "llm_phase") { clearInterval(batchTimerRef.current); return; }
    batchTimerRef.current = setInterval(() => {
      setProcessed(allResultsRef.current.length);
      setLiveCounts({ ...countsRef.current });
      setResultsTick((t) => t + 1);
    }, UI_BATCH_INTERVAL_MS);
    return () => clearInterval(batchTimerRef.current);
  }, [state]);

  useEffect(() => {
    if (state === "llm_phase" && llmTotal === 0) setLlmTotal(countsRef.current.NEEDS_REVIEW + llmProcessed);
  }, [state, llmTotal, llmProcessed]);

  async function handleSwitchDataset(setId: string) {
    setSwitching(true);
    setSwitchStart(Date.now());
    setError("");
    try {
      await switchSanctionsSet(setId);
      const sets = await getSanctionsSets();
      setDatasets(sets);
    } catch (e: any) {
      setError(e.message || "Failed to switch dataset");
    } finally {
      setSwitching(false);
    }
  }

  function startScreen(customers: BatchCustomerInput[]) {
    setState("scanning"); setError("");
    allResultsRef.current = []; countsRef.current = { AUTO_CLEAR: 0, ESCALATE: 0, NEEDS_REVIEW: 0 };
    setProcessed(0); setTotal(0); setSummary(null);
    setLiveCounts({ AUTO_CLEAR: 0, ESCALATE: 0, NEEDS_REVIEW: 0 });
    setFilter("all"); setVisiblePage(1); setResultsTick(0);
    setResolvedHistory([]); setLlmProcessed(0); setLlmTotal(0); setSidePanelOpen(false);
    abortRef.current = batchScreenStream({ customers }, handleEvent);
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const customers = parseCSV(ev.target?.result as string);
      if (!customers.length) { setError("No valid rows."); setState("error"); return; }
      startScreen(customers);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function reset() {
    if (abortRef.current) abortRef.current.abort();
    clearInterval(batchTimerRef.current);
    setState("idle"); allResultsRef.current = [];
    countsRef.current = { AUTO_CLEAR: 0, ESCALATE: 0, NEEDS_REVIEW: 0 };
    setSummary(null); setError(""); setFilter("all");
    setProcessed(0); setTotal(0); setElapsed(0);
    setLiveCounts({ AUTO_CLEAR: 0, ESCALATE: 0, NEEDS_REVIEW: 0 });
    setVisiblePage(1); setResultsTick(0);
    setResolvedHistory([]); setLlmProcessed(0); setLlmTotal(0); setSidePanelOpen(false);
  }

  const isScanning = state === "scanning" || state === "llm_phase";
  const progress = total > 0 ? Math.round((processed / total) * 100) : 0;
  const counts = summary ?? { total: processed, auto_cleared: liveCounts.AUTO_CLEAR, needs_review: liveCounts.NEEDS_REVIEW, escalated: liveCounts.ESCALATE };

  const filterTabs: { id: Filter; label: string; count: number }[] = [
    { id: "all", label: "All", count: processed },
    { id: Decision.AUTO_CLEAR, label: "Cleared", count: liveCounts.AUTO_CLEAR },
    { id: Decision.NEEDS_REVIEW, label: "Review", count: liveCounts.NEEDS_REVIEW },
    { id: Decision.ESCALATE, label: "Escalated", count: liveCounts.ESCALATE },
  ];

  return (
    <div ref={ref} className="flex h-full">
      {/* Main content — shrinks when side panel open */}
      <div className={`flex flex-col h-full overflow-hidden transition-all duration-300 ${sidePanelOpen ? "flex-1 min-w-0" : "w-full"}`}>
      {/* IDLE */}
      {state === "idle" && (
        <div className="flex-1 flex items-center justify-center px-8 py-6">
          <div className="batch-area text-center space-y-6 max-w-lg">
            <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} className="hidden" />
            <div className="mx-auto w-14 h-14 rounded-2xl bg-[#f4f2f7] flex items-center justify-center">
              <Shield className="h-7 w-7 text-muted-foreground/60" />
            </div>
            <div>
              <p className="text-[15px] font-semibold">Batch Screening</p>
              <p className="text-[13px] text-muted-foreground mt-1.5 leading-relaxed">
                Select a sanctions dataset, then screen customers against it.
              </p>
            </div>

            {/* Dataset selector */}
            {datasets.length > 0 && (
              <div className="grid grid-cols-2 gap-3 text-left">
                {datasets.map((ds) => (
                  <button
                    key={ds.id}
                    onClick={() => !ds.active && handleSwitchDataset(ds.id)}
                    disabled={switching}
                    className={`rounded-xl p-3.5 text-left ring-1 transition-all ${
                      ds.active
                        ? "ring-[#2E2E2E] bg-[#2E2E2E]/[0.03] shadow-sm"
                        : "ring-black/10 hover:ring-black/20 hover:bg-secondary/50"
                    } ${switching ? "opacity-50 cursor-wait" : ""}`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[12px] font-semibold">{ds.label}</span>
                      {ds.active && (
                        <span className="text-[10px] bg-[#2E2E2E] text-white px-1.5 py-0.5 rounded-full">Active</span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">{ds.customers_label}</p>
                  </button>
                ))}
              </div>
            )}

            {switching && (
              <div className="flex items-center gap-3 justify-center">
                <DotMatrix cols={4} rows={4} dotSize={4} gap={3} color="#2E2E2E" offColor="#e5e7eb" pattern="wave" speed={0.6} />
                <ShiningText text={`Loading sanctions dataset… ${formatTime(switchElapsed)}`} className="text-xs font-medium" />
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-center gap-3">
              <button onClick={() => fileRef.current?.click()} className="h-9 px-5 rounded-xl text-xs font-medium shadow-sm ring-1 ring-black/10 hover:bg-secondary/80 transition-all flex items-center gap-1.5">
                <Upload className="h-3.5 w-3.5" /> Upload CSV
              </button>
              <button onClick={() => startScreen([])} className="h-9 px-5 rounded-xl bg-[#2E2E2E] text-white text-xs font-medium shadow-md hover:bg-[#2E2E2E]/90 transition-all flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5" /> Screen All
              </button>
              <button
                onClick={() => setBenchmarkActive(true)}
                disabled={benchmarkActive}
                className="h-9 px-5 rounded-xl text-xs font-medium shadow-sm ring-1 ring-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 transition-all flex items-center gap-1.5 disabled:opacity-50"
              >
                <Shield className="h-3.5 w-3.5" /> Benchmark
              </button>
            </div>

            {/* Benchmark Inline Results */}
            <BenchmarkInline active={benchmarkActive} onClose={() => setBenchmarkActive(false)} />
          </div>
        </div>
      )}

      {/* ERROR */}
      {state === "error" && (
        <div className="px-8 py-6">
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-[13px] text-red-700">
            {error}
            <button onClick={reset} className="ml-3 underline underline-offset-2 font-medium">Try again</button>
          </div>
        </div>
      )}

      {/* SCANNING / LLM / RESULTS */}
      {(isScanning || state === "results") && (
        <div className="flex flex-col h-full overflow-hidden">
          <div className="shrink-0 px-6 pt-4 pb-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {isScanning && <PhaseIndicator phase={state as "scanning" | "llm_phase"} />}
                {state === "results" && (
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center"><CheckCircle2 className="h-3.5 w-3.5 text-green-600" /></div>
                    <span className="text-[14px] font-semibold">Screening Complete</span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                {isScanning && <span className="text-xs text-muted-foreground font-mono tabular-nums">{formatTime(elapsed)}</span>}
                <button onClick={reset} className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors">
                  <RotateCcw className="h-3 w-3" /> {isScanning ? "Cancel" : "New"}
                </button>
              </div>
            </div>

            <ProgressBar progress={progress} processed={processed} total={total} isActive={isScanning} />

            <div className="grid grid-cols-3 divide-x divide-black/5 shadow-md shadow-black/10 ring-1 ring-black/10 rounded-xl">
              <LiveCounter label="Cleared" value={counts.auto_cleared} icon={<CheckCircle2 className="h-3.5 w-3.5" />} color="#16a34a" />
              <LiveCounter label="Review" value={counts.needs_review} icon={<AlertTriangle className="h-3.5 w-3.5" />} color="#ea580c" />
              <LiveCounter label="Escalated" value={counts.escalated} icon={<XCircle className="h-3.5 w-3.5" />} color="#dc2626" />
            </div>

            {state === "llm_phase" && !sidePanelOpen && (
              <button
                onClick={() => setSidePanelOpen(true)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-violet-200 bg-violet-50/50 text-[12px] text-violet-700 font-medium hover:bg-violet-50 transition-colors"
              >
                <Sparkles className="h-3.5 w-3.5" />
                AI Analysis — {llmProcessed}/{llmTotal} reviewed
                <span className="text-violet-400 ml-1">Open panel →</span>
              </button>
            )}

            <div className="flex items-center gap-5 border-b border-border">
              {filterTabs.map((t) => (
                <button key={t.id} onClick={() => { setFilter(t.id); setVisiblePage(1); }}
                  className={`pb-2 text-[12px] font-medium border-b-2 transition-colors flex items-center gap-1.5 ${filter === t.id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
                  {t.label}
                  {t.count > 0 && <span className="text-[11px] bg-secondary rounded-full px-1.5 py-0.5 tabular-nums">{t.count.toLocaleString()}</span>}
                </button>
              ))}
            </div>
          </div>

          {/* Feed */}
          <div ref={feedRef} className="flex-1 overflow-y-auto px-6 pb-4">
            {/* Processing indicator — above table during scanning */}
            {isScanning && state === "scanning" && (
              <div className="flex items-center gap-3 py-3 justify-center border-b border-border/30 mb-2">
                <DotMatrix cols={4} rows={4} dotSize={4} gap={3} color="#2E2E2E" offColor="#e5e7eb" pattern="wave" speed={0.6} />
                <ShiningText text={`Processing ${processed.toLocaleString()} of ${total.toLocaleString()}…`} className="text-xs font-medium" />
              </div>
            )}
            {isScanning && state === "llm_phase" && (
              <div className="flex items-center gap-3 py-3 justify-center border-b border-violet-100 mb-2">
                <DotMatrix cols={4} rows={4} dotSize={4} gap={3} color="#7c3aed" offColor="#e5e7eb" pattern="pulse" speed={0.6} />
                <ShiningText text={`AI reviewing edge cases… ${llmProcessed} analyzed`} className="text-xs font-medium" />
              </div>
            )}

            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-white z-10">
                <tr className="text-muted-foreground">
                  <th className="text-left py-2 font-medium w-8">#</th>
                  <th className="text-left py-2 font-medium">Name</th>
                  <th className="text-left py-2 font-medium">Status</th>
                  <th className="text-left py-2 font-medium">Top match</th>
                  <th className="text-right py-2 font-medium">Score</th>
                  <th className="text-right py-2 font-medium">Layer</th>
                  <th className="text-right py-2 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {visibleResults.map((row) => (
                  <ExpandableRow key={row.index} row={row} isNew={newRowIndices.has(row.index)} />
                ))}
              </tbody>
            </table>

            {hasMore && !isScanning && (
              <div ref={sentinelRef} className="flex items-center justify-center py-4">
                <button onClick={() => setVisiblePage((p) => p + 1)} className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors">
                  <ChevronDown className="h-3.5 w-3.5" /> Load more ({totalFilteredCount - visibleResults.length} remaining)
                </button>
              </div>
            )}

            {state === "results" && summary && (
              <div className="pt-3 pb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Showing {visibleResults.length.toLocaleString()} of {totalFilteredCount.toLocaleString()}{filter !== "all" && " (filtered)"}{hasMore && " — scroll for more"}</span>
                <span className="font-mono tabular-nums">Total: {formatTime(elapsed)}</span>
              </div>
            )}
          </div>
        </div>
      )}
      </div>

      {/* AI Side Panel — inline, pushes content left */}
      {sidePanelOpen && (
        <div className="w-[380px] shrink-0 border-l border-border">
          <AISidePanel
            isOpen={sidePanelOpen}
            onClose={() => setSidePanelOpen(false)}
            nextToAnalyze={nextToAnalyze}
            resolvedHistory={resolvedHistory}
            llmProcessed={llmProcessed}
            llmTotal={llmTotal}
          />
        </div>
      )}
    </div>
  );
}

