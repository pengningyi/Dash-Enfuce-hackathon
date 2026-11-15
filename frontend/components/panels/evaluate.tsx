"use client";

import { useState, useRef, useCallback, useEffect, useMemo, type ReactNode } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  Play, ChevronRight, Square, CheckCircle2, Loader2,
  Filter, Brain, Search, Users, X, Shield, AlertTriangle,
  Database, Zap, FlaskConical, XCircle, Minus, CircleDollarSign, TrendingUp, Calculator,
} from "lucide-react";
import { DotMatrix } from "@/components/ui/dot-matrix";
import { ShiningText } from "@/components/ui/shining-text";
import { XAIDetailPanel } from "@/components/ui/xai-detail-panel";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  pipelineStart, pipelineRunLayer, getPipelineDatasets, getPairsPreview, getPipelineClients,
  type PipelineStartResponse, type PipelineLayerEvent, type PipelineConfusionMatrix, type PairPreview, type PipelineClient, type PipelineClientsPage,
} from "@/lib/api";

gsap.registerPlugin(useGSAP);

type Phase = "idle" | "starting" | "l1_run" | "l1_done" | "l2_run" | "l2_done" | "l3_run" | "l3_done";
type CmType = 'TP' | 'FP' | 'FN' | 'TN';
type FilterKey = "all" | "escalated" | "review" | "tp" | "fn" | "fp";
type DecisionSnapshot = { AUTO_CLEAR: number; ESCALATE: number; NEEDS_REVIEW: number };

function getCmType(c: PipelineClient): CmType | null {
  if (!c.decision) return null;
  const isFlagged = c.decision !== "AUTO_CLEAR";
  if (c.is_tp && isFlagged) return 'TP';
  if (c.is_tp && !isFlagged) return 'FN';
  if (!c.is_tp && isFlagged) return 'FP';
  return 'TN';
}

/* ═══════════════════════════════════════════
   MAIN
   ═══════════════════════════════════════════ */
export function EvaluatePanel() {
  const root = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [info, setInfo] = useState<PipelineStartResponse | null>(null);
  const [progress, setProgress] = useState({ processed: 0, total: 0, percent: 0, phase: "" });
  const [layerStats, setLayerStats] = useState<Record<number, Record<string, any>>>({});
  const [cms, setCms] = useState<Record<number, PipelineConfusionMatrix>>({});
  const [elapsed, setElapsed] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [llmResults, setLlmResults] = useState<any[]>([]);
  const [streamCounts, setStreamCounts] = useState<{ decisions: Record<string, number>; cm: PipelineConfusionMatrix } | null>(null);
  const [economicsOpen, setEconomicsOpen] = useState(false);
  const [manualReviewCost, setManualReviewCost] = useState(8.33);
  const [l2DecisionSnapshot, setL2DecisionSnapshot] = useState<DecisionSnapshot | null>(null);
  const [activeReviewIdx, setActiveReviewIdx] = useState<Set<number>>(new Set());
  const [autoExpandIdx, setAutoExpandIdx] = useState<number | null>(null);
  const [clientFilter, setClientFilter] = useState<FilterKey>("all");

  // ── Batch-style ref pattern: all data in ref, render only visible slice ──
  const allClientsRef = useRef<PipelineClient[]>([]);
  const [visiblePage, setVisiblePage] = useState(1);
  const [clientsTick, setClientsTick] = useState(0);
  const CLIENTS_PAGE_SIZE = 50;

  const visibleClients = useMemo(() => {
    void clientsTick;
    const items = allClientsRef.current;
    const filtered = clientFilter === "all" ? items
      : clientFilter === "escalated" ? items.filter(c => c.decision === "ESCALATE")
      : clientFilter === "review" ? items.filter(c => c.decision === "NEEDS_REVIEW")
      : clientFilter === "tp" ? items.filter(c => c.is_tp)
      : clientFilter === "fn" ? items.filter(c => getCmType(c) === 'FN')
      : clientFilter === "fp" ? items.filter(c => getCmType(c) === 'FP')
      : items;
    return filtered.slice(0, visiblePage * CLIENTS_PAGE_SIZE);
  }, [clientsTick, clientFilter, visiblePage]);

  const totalFilteredCount = useMemo(() => {
    void clientsTick;
    const items = allClientsRef.current;
    if (clientFilter === "all") return items.length;
    if (clientFilter === "escalated") return items.filter(c => c.decision === "ESCALATE").length;
    if (clientFilter === "review") return items.filter(c => c.decision === "NEEDS_REVIEW").length;
    if (clientFilter === "tp") return items.filter(c => c.is_tp).length;
    if (clientFilter === "fn") return items.filter(c => getCmType(c) === 'FN').length;
    if (clientFilter === "fp") return items.filter(c => getCmType(c) === 'FP').length;
    return items.length;
  }, [clientsTick, clientFilter]);

  const clientsHasMore = visibleClients.length < totalFilteredCount;

  // Setup
  const [files, setFiles] = useState<{ sanctions: string[]; clients: string[] }>({ sanctions: [], clients: [] });
  const [selS, setSelS] = useState("sanction_list_100.csv");
  const [selC, setSelC] = useState("clients_generated100.csv");
  const [pairCount, setPairCount] = useState(5);
  const [preview, setPreview] = useState<PairPreview[] | null>(null);
  const [poolSize, setPoolSize] = useState(0);
  const [confirmed, setConfirmed] = useState<PairPreview[]>([]);
  const [selIds, setSelIds] = useState<Set<number>>(new Set());
  const [previewLoading, setPreviewLoading] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const batchTimerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const t0Ref = useRef(0);
  const [liveMs, setLiveMs] = useState(0);

  // Refs for batched UI updates — SSE writes here, interval flushes to state
  const streamCountsRef = useRef<{ decisions: Record<string, number>; cm: PipelineConfusionMatrix } | null>(null);
  const progressRef = useRef({ processed: 0, total: 0, percent: 0, phase: "" });

  useEffect(() => { getPipelineDatasets().then(setFiles).catch(() => {}); }, []);

  useGSAP(() => { gsap.from(".ev-title", { y: 12, opacity: 0, duration: 0.4, ease: "power3.out" }); }, { scope: root });

  const startTimer = useCallback(() => {
    t0Ref.current = Date.now();
    timerRef.current = setInterval(() => setLiveMs(Date.now() - t0Ref.current), 100);
  }, []);
  const stopTimer = useCallback(() => { clearInterval(timerRef.current); timerRef.current = undefined; }, []);

  const handlePreview = useCallback(async () => {
    setPreviewLoading(true);
    try { const r = await getPairsPreview(pairCount); setPreview(r.pairs); setPoolSize(r.valid_pool_size); setSelIds(new Set(r.pairs.map(p => p.pair_id))); }
    finally { setPreviewLoading(false); }
  }, [pairCount]);

  // Fetch all clients into ref after layer completes — one call, no pagination needed for ref
  const refreshClients = useCallback(() => {
    getPipelineClients(0, 200000, "all").then((page) => {
      allClientsRef.current = page.items;
      setClientsTick(t => t + 1);
    }).catch(() => {});
  }, []);


  const runLayer = useCallback((n: number) => {
    const rMap: Record<number, Phase> = { 1: "l1_run", 2: "l2_run", 3: "l3_run" };
    const dMap: Record<number, Phase> = { 1: "l1_done", 2: "l2_done", 3: "l3_done" };
    streamCountsRef.current = null; progressRef.current = { processed: 0, total: 0, percent: 0, phase: "" };
    setPhase(rMap[n]); setProgress({ processed: 0, total: 0, percent: 0, phase: "" }); setError(null); setStreamCounts(null); startTimer();

    // Batched UI interval — flush refs to state every 120ms (same as batch tab)
    clearInterval(batchTimerRef.current);
    batchTimerRef.current = setInterval(() => {
      setProgress({ ...progressRef.current });
      if (streamCountsRef.current) setStreamCounts({ ...streamCountsRef.current });
    }, 120);

    const ctrl = pipelineRunLayer(n, (ev: PipelineLayerEvent) => {
      if (ev.type === "progress") {
        // Write to refs only — no re-render. Interval flushes to state.
        const d = ev.data as any;
        progressRef.current = { processed: d.processed ?? 0, total: d.total ?? 0, percent: d.percent ?? 0, phase: d.phase ?? "" };
        if (d.decisions && d.confusion_matrix) {
          streamCountsRef.current = { decisions: d.decisions, cm: d.confusion_matrix };
        }
      }
      else if (ev.type === "layer_complete") {
        clearInterval(batchTimerRef.current);
        // Final flush
        setProgress({ ...progressRef.current });
        if (streamCountsRef.current) setStreamCounts({ ...streamCountsRef.current });
        const e = Date.now() - t0Ref.current; stopTimer();
        setElapsed(p => ({ ...p, [n]: e })); setPhase(dMap[n]);
        if (ev.data.stats) setLayerStats(p => ({ ...p, [n]: ev.data.stats! }));
        if (ev.data.confusion_matrix) setCms(p => ({ ...p, [n]: ev.data.confusion_matrix! }));
        refreshClients();
      } else if (ev.type === "llm_result") {
        const d = ev.data as any;
        setLlmResults(p => [d, ...p]);
        if (d.client_index != null) {
          // Update in ref — no re-render
          const c = allClientsRef.current.find(c => c.index === d.client_index);
          if (c) {
            c.decision = d.decision ?? c.decision;
            c.score = d.match_score ?? c.score;
            c.llm_reasoning = d.reasoning;
            c.llm_confidence = d.confidence;
            c.llm_matched_entity = d.matched_entity;
          }
          setAutoExpandIdx(d.client_index);
          setActiveReviewIdx(prev => { const n = new Set(prev); n.delete(d.client_index); return n; });
          setClientsTick(t => t + 1);
        }
      } else if ((ev.type as string) === "llm_analyzing") {
        const ci = (ev.data as any).client_index;
        if (ci != null) setActiveReviewIdx(prev => new Set(prev).add(ci));
      } else if (ev.type === "error") {
        clearInterval(batchTimerRef.current);
        stopTimer();
        setError(ev.data.message ?? "Error");
        const fallback: Record<number, Phase> = { 1: "idle", 2: "l1_done", 3: "l2_done" };
        setPhase(fallback[n] ?? "idle");
      }
    });
    abortRef.current = ctrl;
  }, [startTimer, stopTimer, refreshClients]);

  const handleStart = useCallback(async (directPairs?: PairPreview[]) => {
    const pairsToUse = directPairs ?? confirmed;
    setError(null); setPhase("starting"); setLayerStats({}); setCms({}); setElapsed({}); setLlmResults([]); allClientsRef.current = []; setClientsTick(0); setVisiblePage(1); setStreamCounts(null); setL2FlaggedIndices(new Set()); setCmSnapshots({}); setL2DecisionSnapshot(null); setEconomicsOpen(false); l2CmTypeRef.current = new Map();
    try { const i = await pipelineStart(selC, selS, pairsToUse); setInfo(i); runLayer(1); }
    catch (e: any) { setError(e?.message || "Failed"); setPhase("idle"); }
  }, [selC, selS, confirmed, runLayer]);

  const handleStop = useCallback(() => { abortRef.current?.abort(); clearInterval(batchTimerRef.current); stopTimer(); setPhase("idle"); }, [stopTimer]);
  const reset = useCallback(() => { clearInterval(batchTimerRef.current); setPhase("idle"); setInfo(null); setLlmResults([]); setCms({}); setLayerStats({}); setElapsed({}); allClientsRef.current = []; setClientsTick(0); setVisiblePage(1); setStreamCounts(null); setL2FlaggedIndices(new Set()); setCmSnapshots({}); setL2DecisionSnapshot(null); setEconomicsOpen(false); l2CmTypeRef.current = new Map(); }, []);

  const isRunning = phase.endsWith("_run") || phase === "starting";
  const curLayer = phase.includes("1") ? 1 : phase.includes("2") ? 2 : phase.includes("3") ? 3 : 0;
  const lStatus = (n: number): "pending" | "running" | "done" => {
    if (phase === "idle" || phase === "starting") return "pending";
    if (phase === `l${n}_run`) return "running";
    if (phase === `l${n}_done`) return "done";
    return curLayer > n ? "done" : "pending";
  };

  // LLM results lookup by client index
  const llmByIndex = useMemo(() => {
    const map: Record<number, any> = {};
    for (const r of llmResults) {
      if (r.client_index != null) map[r.client_index] = r;
    }
    return map;
  }, [llmResults]);

  // Live-computed confusion matrix — prefer streaming counts, fall back to ref-based
  const liveCm = useMemo(() => {
    void clientsTick;
    if (streamCounts?.cm) return streamCounts.cm;
    const items = allClientsRef.current;
    if (items.length === 0) return null;
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const c of items) {
      if (!c.decision) continue;
      const isFlagged = c.decision !== "AUTO_CLEAR";
      if (c.is_tp && isFlagged) tp++;
      else if (c.is_tp && !isFlagged) fn++;
      else if (!c.is_tp && isFlagged) fp++;
      else tn++;
    }
    const total = tp + fp + fn + tn;
    return {
      tp, fp, fn, tn,
      precision: tp / Math.max(tp + fp, 1),
      recall: tp / Math.max(tp + fn, 1),
      accuracy: (tp + tn) / Math.max(total, 1),
      total,
    };
  }, [clientsTick, streamCounts]);

  // Live-computed decision counts — prefer streaming counts during L2
  const liveDecisions = useMemo(() => {
    void clientsTick;
    if (streamCounts?.decisions) {
      return {
        AUTO_CLEAR: streamCounts.decisions.AUTO_CLEAR ?? 0,
        ESCALATE: streamCounts.decisions.ESCALATE ?? 0,
        NEEDS_REVIEW: streamCounts.decisions.NEEDS_REVIEW ?? 0,
      };
    }
    const counts = { AUTO_CLEAR: 0, ESCALATE: 0, NEEDS_REVIEW: 0 };
    for (const c of allClientsRef.current) {
      if (c.decision && c.decision in counts) counts[c.decision as keyof typeof counts]++;
    }
    return counts;
  }, [clientsTick, streamCounts]);

  // Snapshot CM at each layer boundary for delta display
  const [cmSnapshots, setCmSnapshots] = useState<Record<number, { tp: number; fp: number; fn: number; tn: number }>>({});
  useEffect(() => {
    if (!liveCm) return;
    // Snapshot when a layer completes (phase transitions to l*_done)
    if (phase === "l2_done" && !cmSnapshots[2]) {
      setCmSnapshots(prev => ({ ...prev, 2: { tp: liveCm.tp, fp: liveCm.fp, fn: liveCm.fn, tn: liveCm.tn } }));
    }
    if (phase === "l3_done" && !cmSnapshots[3]) {
      setCmSnapshots(prev => ({ ...prev, 3: { tp: liveCm.tp, fp: liveCm.fp, fn: liveCm.fn, tn: liveCm.tn } }));
    }
  }, [phase, liveCm, cmSnapshots]);

  // Compute deltas from previous layer
  const cmDelta = useMemo(() => {
    if (!liveCm) return null;
    const prev = cmSnapshots[curLayer - 1]; // e.g., layer 3 compares to layer 2 snapshot
    if (!prev) return null;
    return {
      tp: liveCm.tp - prev.tp,
      fp: liveCm.fp - prev.fp,
      fn: liveCm.fn - prev.fn,
      tn: liveCm.tn - prev.tn,
    };
  }, [liveCm, cmSnapshots, curLayer]);

  // Track which clients were flagged at L2 (before L3 changes decisions)
  const [l2FlaggedIndices, setL2FlaggedIndices] = useState<Set<number>>(new Set());
  // Track CM type per client at L2 end — shows transitions when L3 changes decisions
  const l2CmTypeRef = useRef<Map<number, CmType>>(new Map());

  // Capture L2 flagged set when L2 completes or L3 starts
  useEffect(() => {
    if ((phase === "l2_done" || phase === "l3_run") && l2FlaggedIndices.size === 0 && allClientsRef.current.length > 0) {
      const flagged = new Set<number>();
      const cmMap = new Map<number, CmType>();
      for (const c of allClientsRef.current) {
        if (c.decision && c.decision !== "AUTO_CLEAR") flagged.add(c.index);
        const ct = getCmType(c);
        if (ct) cmMap.set(c.index, ct);
      }
      setL2FlaggedIndices(flagged);
      l2CmTypeRef.current = cmMap;
    }
  }, [phase, allClientsRef.current.length, l2FlaggedIndices.size]);

  // Client list filter — "flagged" keeps L2 flagged clients even after L3 changes them

  // When filter changes — client-side only, no backend call (batch tab pattern)
  const handleFilterChange = useCallback((f: FilterKey) => {
    setClientFilter(f);
    setVisiblePage(1);
  }, []);

  // Backend handles filtering — clients IS the filtered list
  

  // Flagged count — use L2 set if available
  const flaggedCount = useMemo(() => {
    void clientsTick;
    if (streamCounts?.decisions) {
      return (streamCounts.decisions.ESCALATE ?? 0) + (streamCounts.decisions.NEEDS_REVIEW ?? 0);
    }
    if (l2FlaggedIndices.size > 0) return l2FlaggedIndices.size;
    return allClientsRef.current.filter(c => c.decision && c.decision !== "AUTO_CLEAR").length;
  }, [clientsTick, l2FlaggedIndices, streamCounts]);

  // TP count from streaming CM
  const tpCount = useMemo(() => {
    void clientsTick;
    if (streamCounts?.cm) return streamCounts.cm.tp + streamCounts.cm.fn;
    return allClientsRef.current.filter(c => c.is_tp).length;
  }, [clientsTick, streamCounts]);

  // FN count — sanctions targets we missed
  const fnCount = useMemo(() => {
    void clientsTick;
    if (streamCounts?.cm) return streamCounts.cm.fn;
    return allClientsRef.current.filter(c => getCmType(c) === 'FN').length;
  }, [clientsTick, streamCounts]);

  // FP count — non-targets we flagged
  const fpCount = useMemo(() => {
    void clientsTick;
    if (streamCounts?.cm) return streamCounts.cm.fp;
    return allClientsRef.current.filter(c => getCmType(c) === 'FP').length;
  }, [clientsTick, streamCounts]);

  useEffect(() => {
    if (phase !== "l2_done" || l2DecisionSnapshot) return;
    setL2DecisionSnapshot({
      AUTO_CLEAR: liveDecisions.AUTO_CLEAR,
      ESCALATE: liveDecisions.ESCALATE,
      NEEDS_REVIEW: liveDecisions.NEEDS_REVIEW,
    });
  }, [phase, l2DecisionSnapshot, liveDecisions]);

  const l2Economics = useMemo(() => {
    const cm = cms[2] ?? (phase === "l2_done" ? liveCm : null);
    if (!cm || !l2DecisionSnapshot) return null;

    const total = cm.total;
    const manualQueue = l2DecisionSnapshot.ESCALATE + l2DecisionSnapshot.NEEDS_REVIEW;
    const withSystemCost = manualQueue * manualReviewCost;
    const manualBaselineCost = total * manualReviewCost;
    const savings = manualBaselineCost - withSystemCost;

    return {
      total,
      cleared: l2DecisionSnapshot.AUTO_CLEAR,
      review: l2DecisionSnapshot.NEEDS_REVIEW,
      escalated: l2DecisionSnapshot.ESCALATE,
      manualQueue,
      autoClearRate: l2DecisionSnapshot.AUTO_CLEAR / Math.max(total, 1),
      manualQueueRate: manualQueue / Math.max(total, 1),
      blendedCostPerCustomer: withSystemCost / Math.max(total, 1),
      withSystemCost,
      manualBaselineCost,
      savings,
      falsePositiveSpend: cm.fp * manualReviewCost,
      precision: cm.precision,
      recall: cm.recall,
      tp: cm.tp,
      fp: cm.fp,
      fn: cm.fn,
      tn: cm.tn,
    };
  }, [cms, phase, liveCm, l2DecisionSnapshot, manualReviewCost]);

  return (
    <div ref={root} className="flex flex-col h-full">
      <L2EconomicsDialog
        open={economicsOpen}
        onOpenChange={setEconomicsOpen}
        economics={l2Economics}
        manualReviewCost={manualReviewCost}
        onManualReviewCostChange={setManualReviewCost}
      />
      {/* ── IDLE ── */}
      {phase === "idle" && (
        <div className="flex-1 overflow-auto">
          <div className="min-h-full flex items-center justify-center py-8">
            <IdleSetup files={files} selS={selS} selC={selC} onS={setSelS} onC={setSelC}
              pairCount={pairCount} onPairCount={setPairCount} onPreview={handlePreview} previewLoading={previewLoading}
              preview={preview} selIds={selIds} onSelIds={setSelIds}
              onConfirm={() => { setConfirmed((preview || []).filter(p => selIds.has(p.pair_id))); setPreview(null); }}
              onCancelPreview={() => setPreview(null)} confirmed={confirmed} onClearPairs={() => setConfirmed([])}
              poolSize={poolSize} onStart={handleStart} />
          </div>
        </div>
      )}

      {/* ── STARTING ── */}
      {phase === "starting" && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 min-h-[60vh]">
          <DotMatrix cols={5} rows={5} dotSize={5} gap={4} color="#2E2E2E" offColor="#e5e7eb" pattern="pulse" speed={0.5} />
          <ShiningText text="Loading datasets & building index…" className="text-xs font-semibold" />
          <StartingTimer />
        </div>
      )}

      {/* ── PIPELINE VIEW ── */}
      {phase !== "idle" && phase !== "starting" && (
        <div className="flex flex-col h-full overflow-hidden">
          {/* Top bar — batch style */}
          <div className="shrink-0 px-6 pt-4 pb-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {isRunning && (
                  <div className="flex items-center gap-2.5">
                    <div className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ backgroundColor: curLayer === 3 ? "#8b5cf6" : curLayer === 2 ? "#d97706" : "#6366f1" }} />
                    <div>
                      <span className="text-[14px] font-semibold">Layer {curLayer}: {curLayer === 1 ? "DOB Pre-filter" : curLayer === 2 ? "Embedding + Scoring" : "Grok LLM"}</span>
                      <span className="text-[12px] text-muted-foreground ml-2 font-mono tabular-nums">{fmtMs(liveMs)}</span>
                    </div>
                  </div>
                )}
                {!isRunning && !error && (
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center"><CheckCircle2 className="h-3.5 w-3.5 text-green-600" /></div>
                    <span className="text-[14px] font-semibold">Layer {curLayer} Complete</span>
                  </div>
                )}
                {!isRunning && error && (
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-red-100 flex items-center justify-center"><XCircle className="h-3.5 w-3.5 text-red-600" /></div>
                    <span className="text-[14px] font-semibold text-red-700">Layer failed</span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isRunning && <StopBtn onClick={handleStop} />}
                {!isRunning && error && (
                  <>
                    <button onClick={reset} className="h-9 px-4 rounded-xl text-[12px] font-medium shadow-sm ring-1 ring-black/10 hover:bg-secondary transition-all flex items-center gap-1.5"><Play className="w-3.5 h-3.5" /> Start Over</button>
                  </>
                )}
                {!error && phase === "l1_done" && <NextBtn label="Continue → L2" onClick={() => runLayer(2)} />}
                {!error && phase === "l2_done" && (<>
                  {l2Economics && (
                    <button onClick={() => setEconomicsOpen(true)} className="h-9 px-4 rounded-xl text-[12px] font-medium shadow-sm ring-1 ring-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-all flex items-center gap-1.5">
                      <CircleDollarSign className="w-3.5 h-3.5" /> L2 Cost Table
                    </button>
                  )}
                  <NextBtn label="Continue → L3 (Grok)" onClick={() => runLayer(3)} />
                  <button onClick={reset} className="h-9 px-4 rounded-xl text-[12px] font-medium shadow-sm ring-1 ring-black/10 hover:bg-secondary transition-all">Done</button>
                </>)}
                {!error && phase === "l3_done" && <>
                  {l2Economics && (
                    <button onClick={() => setEconomicsOpen(true)} className="h-9 px-4 rounded-xl text-[12px] font-medium shadow-sm ring-1 ring-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-all flex items-center gap-1.5">
                      <CircleDollarSign className="w-3.5 h-3.5" /> L2 Cost Table
                    </button>
                  )}
                  <button onClick={reset} className="h-9 px-4 rounded-xl text-[12px] font-medium shadow-sm ring-1 ring-black/10 hover:bg-secondary transition-all flex items-center gap-1.5"><Play className="w-3.5 h-3.5" /> Again</button>
                </>}
              </div>
            </div>

            {/* Progress bar */}
            {isRunning && progress.total > 0 && (
              <div>
                <div className="flex items-center justify-between text-[12px] text-muted-foreground mb-1.5">
                  <span className="capitalize font-medium">{progress.phase.replace("_", " ")}</span>
                  <span className="tabular-nums font-mono">{progress.processed.toLocaleString()} / {progress.total.toLocaleString()} ({progress.percent}%)</span>
                </div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden shadow-inner">
                  <div className="h-full rounded-full transition-all duration-200" style={{ width: `${progress.percent}%`, backgroundColor: curLayer === 3 ? "#8b5cf6" : curLayer === 2 ? "#d97706" : "#6366f1" }} />
                </div>
              </div>
            )}

            {/* Batch-style LiveCounter row */}
            <div className="grid grid-cols-3 divide-x divide-black/5 shadow-md shadow-black/10 ring-1 ring-black/10 rounded-xl">
              <div className="p-4">
                <div className="flex items-center gap-2 mb-1">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  <span className="text-[12px] text-muted-foreground">Cleared</span>
                </div>
                <span className="text-2xl font-bold tabular-nums">{liveDecisions.AUTO_CLEAR.toLocaleString()}</span>
              </div>
              <div className="p-4">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  <span className="text-[12px] text-muted-foreground">Review</span>
                </div>
                <span className="text-2xl font-bold tabular-nums text-amber-600">{liveDecisions.NEEDS_REVIEW.toLocaleString()}</span>
              </div>
              <div className="p-4">
                <div className="flex items-center gap-2 mb-1">
                  <Shield className="h-4 w-4 text-red-500" />
                  <span className="text-[12px] text-muted-foreground">Escalated</span>
                </div>
                <span className="text-2xl font-bold tabular-nums text-red-600">{liveDecisions.ESCALATE.toLocaleString()}</span>
              </div>
            </div>

            {/* Confusion matrix — grid card matching the decisions card style */}
            {liveCm && (
              <div className="grid grid-cols-[1fr_1fr_auto_1fr_auto_1fr] items-center gap-0 shadow-md shadow-black/10 ring-1 ring-black/10 rounded-xl overflow-hidden">
                {/* 2×2 confusion matrix */}
                <div className="p-3 bg-emerald-50/60 border-r border-b border-black/5">
                  <div className="text-[10px] text-emerald-600 font-medium mb-0.5">True Positive</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-xl font-bold tabular-nums text-emerald-700">{liveCm.tp}</span>
                    {cmDelta && cmDelta.tp !== 0 && <CmDelta value={cmDelta.tp} good={cmDelta.tp > 0} />}
                  </div>
                </div>
                <div className="p-3 bg-red-50/60 border-b border-black/5">
                  <div className="text-[10px] text-red-500 font-medium mb-0.5">False Negative</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-xl font-bold tabular-nums text-red-600">{liveCm.fn}</span>
                    {cmDelta && cmDelta.fn !== 0 && <CmDelta value={cmDelta.fn} good={cmDelta.fn < 0} />}
                  </div>
                </div>

                {/* Divider */}
                <div className="row-span-2 w-px bg-black/5 self-stretch" />

                {/* Precision */}
                <div className="row-span-2 p-3 flex flex-col items-center justify-center">
                  <div className="text-[10px] text-muted-foreground font-medium mb-1">Precision</div>
                  <span className="text-2xl font-bold tabular-nums">{(liveCm.precision * 100).toFixed(1)}%</span>
                </div>

                {/* Divider */}
                <div className="row-span-2 w-px bg-black/5 self-stretch" />

                {/* Recall */}
                <div className="row-span-2 p-3 flex flex-col items-center justify-center">
                  <div className="text-[10px] text-muted-foreground font-medium mb-1">Recall</div>
                  <span className="text-2xl font-bold tabular-nums">{(liveCm.recall * 100).toFixed(1)}%</span>
                </div>

                <div className="p-3 bg-amber-50/60 border-r border-t border-black/5">
                  <div className="text-[10px] text-amber-600 font-medium mb-0.5">False Positive</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-xl font-bold tabular-nums text-amber-600">{liveCm.fp}</span>
                    {cmDelta && cmDelta.fp !== 0 && <CmDelta value={cmDelta.fp} good={cmDelta.fp < 0} />}
                  </div>
                </div>
                <div className="p-3 bg-gray-50/60 border-t border-black/5">
                  <div className="text-[10px] text-gray-500 font-medium mb-0.5">True Negative</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-xl font-bold tabular-nums text-gray-500">{liveCm.tn}</span>
                    {cmDelta && cmDelta.tn !== 0 && <CmDelta value={cmDelta.tn} good={cmDelta.tn > 0} />}
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-xl shadow-sm bg-red-50 p-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-[13px] text-red-700">
                  <XCircle className="w-4 h-4 shrink-0" />
                  <span>{error}</span>
                </div>
                <button onClick={() => setError(null)} className="p-1 rounded hover:bg-red-100 text-red-400 hover:text-red-600 transition-colors">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Filter tabs — show when we have streaming counts OR loaded clients */}
            {(streamCounts || allClientsRef.current.length > 0) && (
              <div className="flex items-center gap-5 border-b border-border overflow-x-auto">
                {([
                  ["all", "All", streamCounts?.cm?.total ?? allClientsRef.current.length],
                  ["escalated", "Escalated", liveDecisions.ESCALATE],
                  ["review", "Review", liveDecisions.NEEDS_REVIEW],
                  ["tp", "True Positives", tpCount],
                  ["fn", "False Negatives", fnCount],
                  ["fp", "False Positives", fpCount],
                ] as const).map(([key, label, count]) => (
                  <button key={key} onClick={() => handleFilterChange(key)}
                    disabled={isRunning && allClientsRef.current.length === 0}
                    className={`pb-2 text-[13px] font-medium border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed ${clientFilter === key ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
                    {label}
                    <span className={`text-[11px] rounded-full px-1.5 py-0.5 tabular-nums ${
                      key === "fn" && (count as number) > 0 ? "bg-red-100 text-red-700"
                      : key === "fp" && (count as number) > 0 ? "bg-amber-100 text-amber-700"
                      : "bg-secondary"
                    }`}>{typeof count === 'number' ? count.toLocaleString() : count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Feed — scrollable client list */}
          {allClientsRef.current.length > 0 ? (
            <ClientListScroller visibleClients={visibleClients} isRunning={isRunning} curLayer={curLayer} progress={progress} llmByIndex={llmByIndex} activeReviewIdx={activeReviewIdx} autoExpandIdx={autoExpandIdx} hasMore={clientsHasMore} totalFilteredCount={totalFilteredCount} onLoadMore={() => setVisiblePage(p => p + 1)} l2CmTypes={l2CmTypeRef.current} />
          ) : isRunning ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="flex items-center gap-3">
                <DotMatrix cols={4} rows={4} dotSize={4} gap={3} color={curLayer === 3 ? "#7c3aed" : "#2E2E2E"} offColor="#e5e7eb" pattern="wave" speed={0.6} />
                <ShiningText text={`Processing ${progress.processed.toLocaleString()} of ${progress.total.toLocaleString()}… Results available after layer completes.`} className="text-[13px] font-medium" />
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function L2EconomicsDialog({
  open,
  onOpenChange,
  economics,
  manualReviewCost,
  onManualReviewCostChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  economics: {
    total: number;
    cleared: number;
    review: number;
    escalated: number;
    manualQueue: number;
    autoClearRate: number;
    manualQueueRate: number;
    blendedCostPerCustomer: number;
    withSystemCost: number;
    manualBaselineCost: number;
    savings: number;
    falsePositiveSpend: number;
    precision: number;
    recall: number;
    tp: number;
    fp: number;
    fn: number;
    tn: number;
  } | null;
  manualReviewCost: number;
  onManualReviewCostChange: (value: number) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(760px,calc(100vh-2rem))] w-[min(1040px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden p-0 sm:max-w-[1040px]">
        <div className="flex min-h-0 flex-1 flex-col bg-white">
          <DialogHeader className="shrink-0 border-b border-black/8 px-6 py-5">
            <DialogTitle className="flex items-center gap-2 text-[15px]">
              <CircleDollarSign className="h-4 w-4 text-emerald-600" />
              Layer 2 Cost & Savings
            </DialogTitle>
            <DialogDescription className="max-w-2xl text-[12px] leading-5">
              Based on the Layer 2 snapshot only. Savings are shown against a fully manual-review baseline and should be read as an operational upper bound.
            </DialogDescription>
          </DialogHeader>

          {economics ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 space-y-5">
              <div className="rounded-2xl border border-black/10 bg-slate-50/80 p-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="text-[13px] font-medium text-foreground">Manual review assumption</p>
                    <p className="mt-1 text-[12px] text-muted-foreground">Cost per flagged record sent to human review.</p>
                  </div>
                  <label className="flex items-center gap-2 text-[12px] font-medium text-foreground">
                    <span className="text-muted-foreground">EUR</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={manualReviewCost}
                      onChange={(e) => onManualReviewCostChange(Math.max(0, Number(e.target.value) || 0))}
                      className="h-10 w-28 rounded-xl border border-black/10 bg-white px-3 text-right font-mono tabular-nums outline-none focus:ring-2 focus:ring-emerald-300"
                    />
                  </label>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <EconomyCard
                  label="Auto-cleared"
                  value={fmtInt(economics.cleared)}
                  sub={fmtPct(economics.autoClearRate)}
                  tone="default"
                />
                <EconomyCard
                  label="Manual Queue"
                  value={fmtInt(economics.manualQueue)}
                  sub={fmtPct(economics.manualQueueRate)}
                  tone="default"
                />
                <EconomyCard
                  label="Cost With System"
                  value={fmtCurrency(economics.withSystemCost)}
                  sub="for this run"
                  tone="default"
                />
                <EconomyCard
                  label="Estimated Savings"
                  value={fmtCurrency(economics.savings)}
                  sub="vs fully manual"
                  tone="positive"
                />
              </div>

              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_320px]">
                <div className="rounded-2xl border border-black/10 bg-white p-5">
                  <div className="mb-4">
                    <div>
                      <p className="text-[13px] font-medium text-foreground">Economics table</p>
                      <p className="mt-1 text-[12px] text-muted-foreground">Directly derived from Layer 2 decisions and confusion matrix counts.</p>
                    </div>
                  </div>

                  <table className="w-full text-[13px]">
                    <tbody>
                      <EconomyRow label="Total screened" value={fmtInt(economics.total)} />
                      <EconomyRow label="Cleared automatically" value={`${fmtInt(economics.cleared)} (${fmtPct(economics.autoClearRate)})`} />
                      <EconomyRow label="Needs review" value={fmtInt(economics.review)} />
                      <EconomyRow label="Escalated" value={fmtInt(economics.escalated)} />
                      <EconomyRow label="Total manual queue" value={`${fmtInt(economics.manualQueue)} (${fmtPct(economics.manualQueueRate)})`} highlight />
                      <EconomyRow label="Manual baseline cost" value={fmtCurrency(economics.manualBaselineCost)} />
                      <EconomyRow label="Cost with this system" value={fmtCurrency(economics.withSystemCost)} />
                      <EconomyRow label="Estimated savings" value={fmtCurrency(economics.savings)} positive />
                      <EconomyRow label="False-positive review spend" value={fmtCurrency(economics.falsePositiveSpend)} />
                    </tbody>
                  </table>
                </div>

                <div className="space-y-4">
                  <div className="rounded-2xl border border-black/10 bg-white p-5">
                    <p className="text-[13px] font-medium text-foreground">Quality snapshot</p>
                    <div className="mt-4 space-y-3">
                      <QualityRow label="Precision" value={fmtPct(economics.precision)} />
                      <QualityRow label="Recall" value={fmtPct(economics.recall)} />
                      <QualityRow label="True positive" value={fmtInt(economics.tp)} />
                      <QualityRow label="False positive" value={fmtInt(economics.fp)} />
                      <QualityRow label="False negative" value={fmtInt(economics.fn)} />
                      <QualityRow label="True negative" value={fmtInt(economics.tn)} />
                    </div>
                  </div>

                  <div className="rounded-2xl border border-black/10 bg-slate-50/70 p-5 text-[12px] text-foreground">
                    <p className="font-medium">Reading</p>
                    <p className="mt-2 leading-5 text-muted-foreground">
                      In this run, only {fmtInt(economics.manualQueue)} records reached manual review. The blended review cost is {fmtCurrency(economics.blendedCostPerCustomer)} per screened customer.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <div className="rounded-2xl border border-dashed border-black/10 bg-slate-50/70 px-4 py-8 text-[13px] text-muted-foreground">
                Run Layer 2 to generate the cost table.
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EconomyCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "default" | "positive";
}) {
  const tones: Record<typeof tone, string> = {
    default: "border border-black/10 bg-white",
    positive: "border border-emerald-200 bg-emerald-50/60",
  };
  return (
    <div className={`rounded-2xl p-4 ${tones[tone]}`}>
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div className={`mt-2 text-[28px] leading-none font-semibold tabular-nums tracking-tight ${tone === "positive" ? "text-emerald-700" : "text-foreground"}`}>{value}</div>
      <div className="mt-2 text-[12px] text-muted-foreground">{sub}</div>
    </div>
  );
}

function EconomyRow({
  label,
  value,
  highlight = false,
  positive = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  positive?: boolean;
}) {
  return (
    <tr className="border-t border-black/5 first:border-t-0">
      <td className={`py-3.5 pr-4 text-left ${highlight ? "font-medium text-foreground" : "text-muted-foreground"}`}>{label}</td>
      <td className={`py-3.5 text-right font-mono tabular-nums ${positive ? "font-semibold text-emerald-700" : "text-foreground"}`}>{value}</td>
    </tr>
  );
}

function QualityRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-black/5 pb-3 last:border-b-0 last:pb-0">
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className="font-mono text-[14px] font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function fmtCurrency(value: number) {
  return new Intl.NumberFormat("en-FI", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

function fmtPct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtInt(value: number) {
  return value.toLocaleString();
}

/* ═══════════════════════════════════════════
   CLIENT LIST SCROLLER — batch tab pattern: visiblePage + sentinel
   ═══════════════════════════════════════════ */
function ClientListScroller({ visibleClients, isRunning, curLayer, progress, llmByIndex, activeReviewIdx, autoExpandIdx, hasMore, totalFilteredCount, onLoadMore, l2CmTypes }: {
  visibleClients: PipelineClient[]; isRunning: boolean; curLayer: number;
  progress: { processed: number; total: number; percent: number; phase: string };
  llmByIndex: Record<number, any>; activeReviewIdx: Set<number>; autoExpandIdx: number | null;
  hasMore: boolean; totalFilteredCount: number; onLoadMore: () => void;
  l2CmTypes: Map<number, CmType>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Row reveal via IntersectionObserver
  useEffect(() => {
    if (!scrollRef.current) return;
    const rows = scrollRef.current.querySelectorAll<HTMLElement>("tr[data-client-row]:not([data-revealed])");
    if (!rows.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            gsap.to(entry.target, { opacity: 1, y: 0, duration: 0.25, ease: "power2.out" });
            (entry.target as HTMLElement).setAttribute("data-revealed", "1");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, root: scrollRef.current }
    );
    rows.forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, [visibleClients]);

  // Sentinel — load more on scroll (batch tab pattern)
  useEffect(() => {
    if (!sentinelRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting && hasMore) onLoadMore(); },
      { rootMargin: "200px" },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 pb-4">
      {isRunning && (
        <div className="flex items-center gap-3 py-3 justify-center border-b border-border/30 mb-2">
          <DotMatrix cols={4} rows={4} dotSize={4} gap={3} color={curLayer === 3 ? "#7c3aed" : "#2E2E2E"} offColor="#e5e7eb" pattern={curLayer === 3 ? "pulse" : "wave"} speed={0.6} />
          <ShiningText text={curLayer === 3 ? `Grok analyzing case ${progress.processed} of ${progress.total}…` : `Processing ${progress.processed.toLocaleString()} of ${progress.total.toLocaleString()}…`} className="text-[13px] font-medium" />
        </div>
      )}

      <table className="w-full text-[13px]">
        <thead className="sticky top-0 bg-white z-10">
          <tr className="text-muted-foreground">
            <th className="text-left py-2.5 font-medium w-10">#</th>
            <th className="text-left py-2.5 font-medium">Name</th>
            <th className="text-left py-2.5 font-medium w-28">Status</th>
            <th className="text-left py-2.5 font-medium">Top match</th>
            <th className="text-right py-2.5 font-medium w-16">Score</th>
            <th className="text-right py-2.5 font-medium w-14">Type</th>
          </tr>
        </thead>
        <tbody>
          {visibleClients.map((c, i) => (
            <ClientRow key={c.index} client={c} idx={i} curLayer={curLayer} isRunning={isRunning}
              llmInfo={llmByIndex[c.index]}
              isAnalyzing={activeReviewIdx.has(c.index)}
              autoExpand={autoExpandIdx === c.index}
              l2CmType={l2CmTypes.get(c.index) ?? null} />
          ))}
        </tbody>
      </table>

      {/* Sentinel + load more (batch tab pattern) */}
      {hasMore && (
        <div ref={sentinelRef} className="flex items-center justify-center py-4">
          <button onClick={onLoadMore} className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors">
            <ChevronRight className="h-3.5 w-3.5" /> Show more ({totalFilteredCount - visibleClients.length} remaining)
          </button>
        </div>
      )}
      {!hasMore && visibleClients.length > 0 && (
        <div className="pt-3 pb-1 text-center text-[11px] text-muted-foreground">
          Showing {visibleClients.length.toLocaleString()} of {totalFilteredCount.toLocaleString()}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   CLIENT ROW — animated, colored by TP/decision
   ═══════════════════════════════════════════ */
function ClientRow({ client: c, idx, curLayer, isRunning, llmInfo, isAnalyzing, autoExpand, l2CmType }: {
  client: PipelineClient; idx: number; curLayer: number; isRunning: boolean;
  llmInfo?: { reasoning?: string; confidence?: number; evidence?: any; matched_entity?: string; decision?: string };
  isAnalyzing?: boolean; autoExpand?: boolean;
  l2CmType: CmType | null;
}) {
  const ref = useRef<HTMLTableRowElement>(null);
  const [expanded, setExpanded] = useState(false);
  const detailRef = useRef<HTMLDivElement>(null);

  // L3 transition: if layer_reached=3, this client went through LLM review (was NEEDS_REVIEW at L2)
  const wasReview = c.layer_reached === 3;

  // Entrance: start hidden, IntersectionObserver in parent will reveal
  useEffect(() => {
    if (!ref.current) return;
    // Set initial hidden state for observer-based reveal
    ref.current.style.opacity = "0";
    ref.current.style.transform = "translateY(6px)";
  }, []);

  // Flash when decision changes
  const prevDec = useRef(c.decision);
  useEffect(() => {
    if (!ref.current || c.decision === prevDec.current) return;
    const flash = c.decision === "ESCALATE" ? "#fecaca" : c.decision === "AUTO_CLEAR" ? "#bbf7d0" : "#fef3c7";
    gsap.fromTo(ref.current, { backgroundColor: flash }, { backgroundColor: "transparent", duration: 1.5, ease: "power2.out" });
    prevDec.current = c.decision;
  }, [c.decision]);

  // Auto-expand when LLM result arrives
  useEffect(() => {
    if (autoExpand && !expanded) setExpanded(true);
  }, [autoExpand]);

  // Pulse glow when being analyzed
  useEffect(() => {
    if (!ref.current || !isAnalyzing) return;
    const tl = gsap.timeline({ repeat: -1 });
    tl.to(ref.current, { boxShadow: "0 0 12px 2px rgba(139,92,246,0.3)", duration: 0.6, ease: "power2.out" });
    tl.to(ref.current, { boxShadow: "0 0 0px 0px rgba(139,92,246,0)", duration: 0.8, ease: "power2.in" });
    return () => { tl.kill(); gsap.set(ref.current!, { boxShadow: "none" }); };
  }, [isAnalyzing]);

  // Expand/collapse
  function toggle() {
    if (expanded && detailRef.current) {
      gsap.to(detailRef.current, { height: 0, opacity: 0, duration: 0.2, ease: "power2.in", onComplete: () => setExpanded(false) });
    } else { setExpanded(true); }
  }
  useEffect(() => {
    if (!expanded || !detailRef.current) return;
    gsap.fromTo(detailRef.current, { height: 0, opacity: 0 }, { height: "auto", opacity: 1, duration: 0.3, ease: "power3.out" });
  }, [expanded]);

  const isFlagged = c.decision && c.decision !== "AUTO_CLEAR";
  const isProcessing = isRunning && curLayer === 3 && c.decision === "NEEDS_REVIEW" && !llmInfo;

  let rowBg = "";
  if (isAnalyzing) rowBg = "bg-violet-100/60";
  else if (c.is_tp && isFlagged) rowBg = "bg-emerald-50/60";
  else if (c.is_tp && !isFlagged && c.decision) rowBg = "bg-red-50/60";
  else if (!c.is_tp && isFlagged) rowBg = "bg-amber-50/40";
  else if (isProcessing) rowBg = "bg-violet-50/30";

  // Status badge — show transition from REVIEW when LLM decided
  let badge = null;
  if (wasReview && c.decision !== "NEEDS_REVIEW") {
    // L3 resolved this: show strikethrough REVIEW → new decision
    const newDec = c.decision;
    badge = (
      <div className="flex items-center gap-1.5">
        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100/60 text-amber-400 line-through">REVIEW</span>
        <span className="text-[9px] text-muted-foreground">→</span>
        {newDec === "ESCALATE"
          ? <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-red-100 text-red-700">ESCALATE</span>
          : <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-100 text-emerald-700">CLEAR</span>}
      </div>
    );
  } else if (c.decision === "ESCALATE") {
    badge = <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-red-100 text-red-700">ESCALATE</span>;
  } else if (c.decision === "NEEDS_REVIEW") {
    badge = <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-100 text-amber-700">REVIEW</span>;
  } else if (c.decision === "AUTO_CLEAR") {
    badge = <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-100 text-emerald-700">CLEAR</span>;
  } else {
    badge = <span className="text-[9px] text-muted-foreground">—</span>;
  }

  const curCmType = getCmType(c);

  let typeBadge = null;
  if (c.decision) {
    const typeChanged = l2CmType !== null && curCmType !== null && l2CmType !== curCmType;
    if (typeChanged) {
      typeBadge = <CmTypeBadgeTransition from={l2CmType!} to={curCmType!} />;
    } else if (c.is_tp && isFlagged) typeBadge = <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-emerald-200 text-emerald-800">TP</span>;
    else if (c.is_tp && !isFlagged) typeBadge = <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-red-200 text-red-800">FN</span>;
    else if (!c.is_tp && isFlagged) typeBadge = <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-amber-200 text-amber-700">FP</span>;
    else typeBadge = <span className="px-1 py-0.5 rounded text-[10px] font-bold bg-gray-100 text-gray-500">TN</span>;
  }

  return (
    <>
      <tr ref={ref} data-client-row onClick={toggle} className={`border-b border-gray-50 cursor-pointer transition-colors duration-500 ${rowBg} hover:bg-gray-50/80`}>
        <td className="py-2.5 text-muted-foreground tabular-nums">{c.index + 1}</td>
        <td className="py-2.5">
          <div className="flex items-center gap-1.5">
            <ChevronRight className={`w-3 h-3 text-muted-foreground/40 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`} />
            {isAnalyzing && <Loader2 className="w-3 h-3 text-violet-500 animate-spin shrink-0" />}
            {c.is_tp && !isAnalyzing && <div className="w-2 h-2 rounded-full bg-indigo-500 shrink-0" title="Injected TP" />}
            <span className={`font-medium ${c.is_tp ? "text-indigo-700" : ""} ${isAnalyzing ? "text-violet-700" : ""}`}>{c.name}</span>
            {isAnalyzing && <span className="text-[9px] text-violet-500 font-medium ml-1">analyzing…</span>}
          </div>
        </td>
        <td className="py-2.5">{badge}</td>
        <td className="py-2.5 text-muted-foreground truncate max-w-[200px]">{c.match_name || "—"}</td>
        <td className="py-2.5 text-right tabular-nums font-mono">{c.score ? `${(c.score * 100).toFixed(1)}%` : "—"}</td>
        <td className="py-2.5 text-right">{typeBadge}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} className="p-0">
            <div ref={detailRef} className="overflow-hidden">
              <div className="px-8 py-4 bg-[#fafafa] border-b border-border/30 space-y-3">
                {/* Customer vs Match comparison — batch-style */}
                {c.match_name && (
                  <div className="grid grid-cols-2 gap-4">
                    {/* Customer */}
                    <div className="rounded-lg border border-border/50 bg-white p-3 space-y-2">
                      <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Customer</div>
                      <div className="text-[13px] font-semibold">{c.name}</div>
                      <div className="space-y-1 text-[11px]">
                        <EvalField label="Date of Birth" value={c.dob} />
                        <EvalField label="Country" value={c.country} />
                      </div>
                      {c.is_tp && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-indigo-100 text-indigo-700">● Injected True Positive</span>}
                    </div>

                    {/* Sanctions Match */}
                    <div className="rounded-lg border border-red-100 bg-red-50/30 p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-[10px] text-red-500 font-medium uppercase tracking-wider">Sanctions Match</div>
                        <span className="text-[10px] font-mono text-muted-foreground">{c.match_id}</span>
                      </div>
                      <div className="text-[13px] font-semibold">{c.match_name}</div>
                      <div className="space-y-1 text-[11px]">
                        <EvalCompareField label="Date of Birth" customerVal={c.dob} matchVal={c.match_dob} />
                        <EvalCompareField label="Country" customerVal={c.country} matchVal={c.match_country} />
                        <EvalField label="Program" value={c.match_program} />
                        <EvalField label="Reason" value={c.match_reason} />
                      </div>
                    </div>
                  </div>
                )}

                {/* Similarity + Layer info */}
                <div className="flex items-center gap-4 text-[11px] flex-wrap">
                  {c.score != null && (
                    <span className={`font-mono font-bold ${c.score >= 0.8 ? "text-red-600" : c.score >= 0.65 ? "text-amber-600" : "text-muted-foreground"}`}>
                      Similarity: {(c.score * 100).toFixed(1)}%
                    </span>
                  )}
                  <span className="text-muted-foreground">Layer 2 signals</span>
                  {c.layer_reached === 3 && <span className="text-violet-600 font-medium">→ Layer 3 (Grok)</span>}
                </div>

                {/* XAI Signal Breakdown + Decision Logic + Agent Reasoning */}
                <XAIDetailPanel
                  signalBreakdown={c.signal_breakdown}
                  reasoning={c.reasoning}
                  decision={wasReview && c.decision !== "NEEDS_REVIEW" ? "NEEDS_REVIEW" : (c.decision || "AUTO_CLEAR")}
                  finalDecision={wasReview && c.decision !== "NEEDS_REVIEW" ? (c.decision || undefined) : undefined}
                  llmReasoning={c.llm_reasoning || llmInfo?.reasoning}
                  llmConfidence={c.llm_confidence != null ? c.llm_confidence / 100 : llmInfo?.confidence != null ? llmInfo.confidence / 100 : null}
                />

                {/* Live analyzing indicator */}
                {!c.llm_reasoning && !llmInfo && isAnalyzing && (
                  <div className="flex items-center gap-2 text-[10px] text-violet-600 italic">
                    <Loader2 className="w-3 h-3 animate-spin" /> Grok analyzing…
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ═══════════════════════════════════════════
   IDLE SETUP
   ═══════════════════════════════════════════ */
function IdleSetup({ files, selS, selC, onS, onC, pairCount, onPairCount, onPreview, previewLoading,
  preview, selIds, onSelIds, onConfirm, onCancelPreview, confirmed, onClearPairs, poolSize, onStart }: any) {
  const ref = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const [expandedPair, setExpandedPair] = useState<number | null>(null);

  useGSAP(() => {
    const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
    tl.from(".ev-title", { y: 10, opacity: 0, duration: 0.35 });
    tl.from(".ev-sub", { y: 8, opacity: 0, duration: 0.3 }, "-=0.15");
    tl.from(".ev-section", { y: 15, opacity: 0, stagger: 0.08, duration: 0.4 }, "-=0.1");
  }, { scope: ref });

  useEffect(() => {
    if (preview && preview.length > 0 && actionRef.current) {
      setTimeout(() => {
        actionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 350);
    }
  }, [preview]);

  const handleConfirmAndRun = useCallback(() => {
    const pairs = (preview || []).filter((p: PairPreview) => selIds.has(p.pair_id));
    if (titleRef.current) {
      titleRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    onStart(pairs);
  }, [preview, selIds, onStart]);

  const handleRunPipeline = useCallback(() => {
    if (titleRef.current) {
      titleRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    onStart();
  }, [onStart]);

  return (
    <div ref={ref} className="w-full max-w-2xl space-y-5 px-4">
      <div ref={titleRef} className="text-center">
        <p className="ev-title text-[15px] font-semibold">Pipeline Evaluation</p>
        <p className="ev-sub text-[13px] text-muted-foreground mt-1">
          Select datasets, inject known matches, then run each layer to measure precision & recall
        </p>
      </div>

      {/* Sanctions — compact pill buttons */}
      <div className="ev-section">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Sanctions List</p>
        {files.sanctions.length === 0 ? (
          <div className="flex gap-2">{[1,2,3].map(i => <div key={i} className="h-8 w-32 rounded-lg bg-gray-100 animate-pulse" />)}</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {files.sanctions.map((f: string) => {
              const label = f.replace('.csv', '').replace(/_/g, ' ');
              const active = selS === f;
              return (
                <button key={f} onClick={() => onS(f)}
                  className={`rounded-lg px-3 py-1.5 text-[11px] font-medium transition-all ${
                    active
                      ? "bg-[#2E2E2E] text-white shadow-sm"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}>
                  <span className="capitalize">{label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Clients — same compact pills */}
      <div className="ev-section">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Client List</p>
        {files.clients.length === 0 ? (
          <div className="flex gap-2">{[1,2].map(i => <div key={i} className="h-8 w-36 rounded-lg bg-gray-100 animate-pulse" />)}</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {files.clients.map((f: string) => {
              const label = f.replace('.csv', '').replace(/_/g, ' ');
              const active = selC === f;
              return (
                <button key={f} onClick={() => onC(f)}
                  className={`rounded-lg px-3 py-1.5 text-[11px] font-medium transition-all ${
                    active
                      ? "bg-[#2E2E2E] text-white shadow-sm"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}>
                  <span className="capitalize">{label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* True positives injection */}
      <div className="ev-section shadow-sm shadow-black/5 bg-white rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-[13px] font-semibold">Inject True Positives</span>
          </div>
          {poolSize > 0 && <span className="text-[11px] text-muted-foreground">{poolSize.toLocaleString()} available</span>}
        </div>

        <div className="flex items-center justify-center gap-2">
          <input type="number" min={1} max={200} value={pairCount}
            onChange={e => onPairCount(Math.max(1, Math.min(200, parseInt(e.target.value) || 1)))}
            className="w-16 h-9 rounded-xl shadow-md shadow-black/10 px-3 text-sm text-center tabular-nums outline-none focus:ring-2 focus:ring-black/20 bg-white" />
          <span className="text-[12px] text-muted-foreground">pairs</span>
          <button onClick={onPreview} disabled={previewLoading}
            className="h-9 px-4 rounded-xl text-[12px] font-medium shadow-sm shadow-black/5 bg-white hover:shadow-md transition-all flex items-center gap-1.5 disabled:opacity-40">
            {previewLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />} Search Pairs
          </button>
        </div>

        {/* Pair rows — GSAP animated */}
        {preview !== null && (
          <PairList preview={preview} selIds={selIds} onSelIds={onSelIds}
            expandedPair={expandedPair} setExpandedPair={setExpandedPair} />
        )}

        {/* Already confirmed badge */}
        {confirmed.length > 0 && preview === null && (
          <div className="flex items-center justify-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium bg-indigo-100 text-indigo-700">
              <CheckCircle2 className="w-3.5 h-3.5" /> {confirmed.length} pair{confirmed.length !== 1 ? "s" : ""} ready
            </span>
            <button onClick={onClearPairs} className="p-1 rounded text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}
      </div>

      {/* Action buttons — outside card, centered */}
      <div ref={actionRef} className="ev-section flex justify-center gap-3">
        {preview !== null ? (
          <>
            <button onClick={handleConfirmAndRun}
              className="h-10 px-6 rounded-xl bg-[#2E2E2E] text-white text-[13px] font-medium shadow-md hover:bg-[#2E2E2E]/90 transition-all inline-flex items-center gap-2">
              <Play className="w-4 h-4" /> Confirm {selIds.size} Pairs & Run
            </button>
            <button onClick={onCancelPreview}
              className="h-10 px-4 rounded-xl text-[12px] font-medium shadow-sm shadow-black/5 bg-white hover:bg-gray-50 transition-all">
              Cancel
            </button>
          </>
        ) : (
          <button onClick={handleRunPipeline}
            className="h-10 px-6 rounded-xl bg-[#2E2E2E] text-white text-[13px] font-medium shadow-md hover:bg-[#2E2E2E]/90 transition-all inline-flex items-center gap-2">
            <Play className="w-4 h-4" /> Run Pipeline
          </button>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   LAYER CARD
   ═══════════════════════════════════════════ */
const COLORS = ["", "#6366f1", "#d97706", "#8b5cf6"];

function LayerCard({ n, label, icon: Icon, status, stats, cm, elapsed, liveMs }: {
  n: number; label: string; icon: any; status: "pending" | "running" | "done";
  stats?: Record<string, any>; cm?: PipelineConfusionMatrix; elapsed?: number; liveMs?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const color = COLORS[n];

  useGSAP(() => {
    if (status !== "done" || !ref.current) return;
    const tl = gsap.timeline({ defaults: { ease: "back.out(1.3)" } });
    tl.from(ref.current.querySelectorAll(".lc-stat"), { y: 8, opacity: 0, stagger: 0.04, duration: 0.3 });
    if (ref.current.querySelectorAll(".cm-cell").length)
      tl.from(ref.current.querySelectorAll(".cm-cell"), { scale: 0, opacity: 0, stagger: { amount: 0.2, from: "random" }, duration: 0.3 }, "-=0.1");
    ref.current.querySelectorAll<HTMLElement>(".cm-up").forEach(el => {
      const target = parseFloat(el.dataset.target || "0");
      const obj = { val: 0 };
      tl.to(obj, { val: target, duration: 0.8, ease: "power2.out", onUpdate: () => { el.textContent = obj.val.toFixed(1) + "%"; } }, "-=0.8");
    });
  }, { dependencies: [status], scope: ref });

  const cardStyle = status === "running"
    ? "shadow-md shadow-blue-100/50 bg-blue-50/20"
    : status === "done"
    ? "shadow-md shadow-black/5 bg-white"
    : "shadow-sm shadow-black/5 bg-gray-50/50";
  const time = liveMs ?? elapsed;

  return (
    <div ref={ref} className={`rounded-xl p-3 transition-all duration-300 ${cardStyle} flex flex-col min-h-[130px]`}>
      <div className="flex items-center gap-2 mb-2">
        <div className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 ${status === "running" ? "bg-blue-100 text-blue-600" : status === "done" ? "bg-emerald-100 text-emerald-600" : "bg-gray-100 text-gray-400"}`}>
          {status === "running" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : status === "done" ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Icon className="w-3.5 h-3.5" />}
        </div>
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="text-[9px] font-bold px-1 py-[1px] rounded text-white leading-none" style={{ backgroundColor: color }}>L{n}</span>
          <span className="text-[10px] font-semibold truncate">{label}</span>
        </div>
        {time !== undefined && <span className="text-[9px] text-muted-foreground tabular-nums font-mono">{fmtMs(time)}</span>}
      </div>
      {status === "pending" && <div className="flex-1 flex items-center justify-center"><span className="text-[9px] text-muted-foreground">Waiting…</span></div>}
      {status === "running" && <div className="flex-1 flex items-center justify-center"><DotMatrix cols={3} rows={3} dotSize={3} gap={2} color={color} offColor="#e5e7eb" pattern="wave" speed={0.6} /></div>}
      {status === "done" && (
        <div className="flex-1 space-y-1.5">
          {stats?.reduction_percent !== undefined && (
            <div className="lc-stat text-[9px] text-muted-foreground">{stats.total_pairs_before?.toLocaleString()} → {stats.total_pairs_after?.toLocaleString()} <span className="text-emerald-600 font-semibold">−{stats.reduction_percent}%</span></div>
          )}
          {stats?.decisions && (
            <div className="lc-stat flex flex-wrap gap-1">
              {stats.decisions.AUTO_CLEAR > 0 && <Badge color="emerald" label={`✓${stats.decisions.AUTO_CLEAR}`} />}
              {stats.decisions.ESCALATE > 0 && <Badge color="red" label={`⚠${stats.decisions.ESCALATE}`} />}
              {(stats.decisions.NEEDS_REVIEW ?? 0) > 0 && <Badge color="amber" label={`→${stats.decisions.NEEDS_REVIEW}`} />}
            </div>
          )}
          {cm && (
            <div className="space-y-1">
              <div className="grid grid-cols-2 gap-[1px] text-[9px]">
                <div className="cm-cell text-center py-1 rounded-tl bg-emerald-50 ring-1 ring-emerald-200/60"><b className="text-emerald-700">{cm.tp}</b> <span className="text-emerald-400">TP</span></div>
                <div className="cm-cell text-center py-1 rounded-tr bg-red-50 ring-1 ring-red-200/60"><b className="text-red-600">{cm.fn}</b> <span className="text-red-400">FN</span></div>
                <div className="cm-cell text-center py-1 rounded-bl bg-amber-50 ring-1 ring-amber-200/60"><b className="text-amber-600">{cm.fp}</b> <span className="text-amber-400">FP</span></div>
                <div className="cm-cell text-center py-1 rounded-br bg-gray-50 ring-1 ring-gray-200/60"><b className="text-gray-500">{cm.tn}</b> <span className="text-gray-400">TN</span></div>
              </div>
              <div className="flex gap-2 text-[10px] text-muted-foreground">
                <span>P <b className="cm-up text-foreground" data-target={(cm.precision * 100).toFixed(1)}>0%</b></span>
                <span>R <b className="cm-up text-foreground" data-target={(cm.recall * 100).toFixed(1)}>0%</b></span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */
function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return <div className="flex items-center gap-1 text-[11px]"><span className="text-muted-foreground">{label}</span><span className={`font-bold tabular-nums ${accent ? "text-indigo-600" : ""}`}>{value.toLocaleString()}</span></div>;
}
function Badge({ color, label }: { color: string; label: string }) {
  const cls: Record<string, string> = { emerald: "bg-emerald-50 ring-emerald-200 text-emerald-700", red: "bg-red-50 ring-red-200 text-red-700", amber: "bg-amber-50 ring-amber-200 text-amber-700" };
  return <span className={`px-1 py-0.5 rounded ring-1 text-[10px] font-semibold ${cls[color]}`}>{label}</span>;
}
function NextBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return <button onClick={onClick} className="h-8 px-4 rounded-lg bg-[#2E2E2E] text-white text-xs font-medium shadow-md hover:bg-[#2E2E2E]/90 transition-all flex items-center gap-1.5"><ChevronRight className="w-3.5 h-3.5" />{label}</button>;
}
function StopBtn({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick} className="h-8 px-3 rounded-lg text-xs font-medium ring-1 ring-red-200 bg-red-50 text-red-700 hover:bg-red-100 transition-all flex items-center gap-1.5"><Square className="w-3 h-3" />Stop</button>;
}
function CmDelta({ value, good }: { value: number; good: boolean }) {
  const sign = value > 0 ? "+" : "";
  return (
    <span className={`text-[10px] font-semibold tabular-nums ${good ? "text-emerald-600" : "text-red-500"}`}>
      {sign}{value}
    </span>
  );
}

const CM_TYPE_STYLES: Record<CmType, { bg: string; text: string }> = {
  TP: { bg: "bg-emerald-200", text: "text-emerald-800" },
  FN: { bg: "bg-red-200", text: "text-red-800" },
  FP: { bg: "bg-amber-200", text: "text-amber-700" },
  TN: { bg: "bg-gray-100", text: "text-gray-500" },
};

function CmTypeBadgeTransition({ from, to }: { from: CmType; to: CmType }) {
  const fromStyle = CM_TYPE_STYLES[from];
  const toStyle = CM_TYPE_STYLES[to];
  return (
    <div className="flex items-center gap-0.5">
      <span className={`px-1 py-0.5 rounded text-[9px] font-bold ${fromStyle.bg} ${fromStyle.text} opacity-50 line-through`}>{from}</span>
      <span className="text-[8px] text-muted-foreground">→</span>
      <span className={`px-1 py-0.5 rounded text-[10px] font-bold ${toStyle.bg} ${toStyle.text}`}>{to}</span>
    </div>
  );
}
function fmtMs(ms: number) { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`; }
function StartingTimer() {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setMs(Date.now() - t0), 100);
    return () => clearInterval(id);
  }, []);
  return <span className="text-[11px] text-muted-foreground tabular-nums font-mono">{fmtMs(ms)}</span>;
}

/* ═══════════════════════════════════════════
   DETAIL FIELD HELPERS — match batch expandable-row style
   ═══════════════════════════════════════════ */

function EvalField({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={value ? "font-medium" : "text-muted-foreground/40"}>{value ?? "—"}</span>
    </div>
  );
}

function EvalCompareField({ label, customerVal, matchVal }: { label: string; customerVal?: string | null; matchVal?: string | null }) {
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
            ? <CheckCircle2 className="h-3 w-3 text-red-500" />
            : <XCircle className="h-3 w-3 text-green-500" />
        )}
        {isMissing && <Minus className="h-3 w-3 text-amber-400" />}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   PAIR LIST — GSAP animated dropdown rows
   ═══════════════════════════════════════════ */
function PairList({ preview, selIds, onSelIds, expandedPair, setExpandedPair }: {
  preview: PairPreview[]; selIds: Set<number>; onSelIds: any;
  expandedPair: number | null; setExpandedPair: (id: number | null) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Stagger entrance when list first appears
  useGSAP(() => {
    if (!listRef.current) return;
    gsap.from(listRef.current.querySelectorAll(".pair-row"), {
      y: 8, opacity: 0, duration: 0.3, ease: "power2.out",
    });
  }, { scope: listRef });

  return (
    <div ref={listRef} className="space-y-1.5">
      {preview.map((p) => (
        <PairRow key={p.pair_id} pair={p} selected={selIds.has(p.pair_id)}
          expanded={expandedPair === p.pair_id}
          onToggle={() => setExpandedPair(expandedPair === p.pair_id ? null : p.pair_id)}
          onCheck={(checked: boolean) => {
            onSelIds((prev: Set<number>) => {
              const n = new Set(prev);
              checked ? n.add(p.pair_id) : n.delete(p.pair_id);
              return n;
            });
          }}
        />
      ))}
    </div>
  );
}

function PairRow({ pair: p, selected, expanded, onToggle, onCheck }: {
  pair: PairPreview; selected: boolean; expanded: boolean;
  onToggle: () => void; onCheck: (c: boolean) => void;
}) {
  const detailRef = useRef<HTMLDivElement>(null);

  // Animate expand/collapse
  useEffect(() => {
    if (!detailRef.current) return;
    if (expanded) {
      gsap.fromTo(detailRef.current,
        { height: 0, opacity: 0 },
        { height: "auto", opacity: 1, duration: 0.3, ease: "power3.out" }
      );
    }
  }, [expanded]);

  function handleCollapse() {
    if (detailRef.current && expanded) {
      gsap.to(detailRef.current, {
        height: 0, opacity: 0, duration: 0.2, ease: "power2.in",
        onComplete: onToggle,
      });
    } else {
      onToggle();
    }
  }

  return (
    <div className={`pair-row rounded-xl shadow-sm transition-all ${selected ? "shadow-md bg-indigo-50/30" : "bg-gray-50/50"}`}>
      <div className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer" onClick={handleCollapse}>
        <input type="checkbox" checked={selected}
          onClick={e => e.stopPropagation()}
          onChange={e => onCheck(e.target.checked)}
          className="shrink-0 w-4 h-4" />
        <ChevronRight className={`w-3.5 h-3.5 text-muted-foreground/40 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`} />
        <span className="text-[12px] font-medium truncate">{p.client.first_name} {p.client.last_name}</span>
        <span className="text-[11px] text-muted-foreground shrink-0">↔</span>
        <span className="text-[12px] font-medium truncate">{p.sanction.name}</span>
        {p.client.birth_date && <span className="text-[11px] text-muted-foreground ml-auto tabular-nums font-mono shrink-0">{p.client.birth_date}</span>}
      </div>
      {expanded && (
        <div ref={detailRef} className="overflow-hidden">
          <div className="px-10 pb-3 pt-0 border-t border-black/5">
            <div className="grid grid-cols-2 gap-4 mt-2.5">
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Client</p>
                <p className="text-[13px] font-medium">{p.client.first_name} {p.client.last_name}</p>
                <div className="flex gap-3 text-[11px] text-muted-foreground">
                  <span>DOB: <strong className="text-foreground">{p.client.birth_date || "N/A"}</strong></span>
                  <span>Country: <strong className="text-foreground">{p.client.country || "N/A"}</strong></span>
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Sanction</p>
                <p className="text-[13px] font-medium">{p.sanction.name}</p>
                <div className="flex gap-3 text-[11px] text-muted-foreground">
                  <span>DOB: <strong className="text-foreground">{p.sanction.birth_date || "N/A"}</strong></span>
                  <span>Country: <strong className="text-foreground">{p.sanction.country || "N/A"}</strong></span>
                </div>
                <p className="text-[11px] text-muted-foreground">ID: <span className="font-mono text-foreground">{p.sanction.id}</span></p>
                {p.sanction.aliases.length > 0 && (
                  <p className="text-[11px] text-muted-foreground">Aliases: {p.sanction.aliases.slice(0, 3).join(", ")}</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
