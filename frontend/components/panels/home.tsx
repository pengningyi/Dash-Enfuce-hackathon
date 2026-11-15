"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  Search, Loader2, CheckCircle2, XCircle, AlertTriangle,
  Brain, Calendar, Globe, ChevronDown, Check,
} from "lucide-react";
import { DotMatrix } from "@/components/ui/dot-matrix";
import { ShiningText } from "@/components/ui/shining-text";
import {
  screenStream, getStats,
  type ScreenRequest, type ScreenResult, type StatsResponse, type LayerEvent,
  Decision,
} from "@/lib/api";
import { XAIDetailPanel } from "@/components/ui/xai-detail-panel";

gsap.registerPlugin(useGSAP);

/* ── Design tokens ── */
const badge: Record<Decision, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  [Decision.AUTO_CLEAR]: { label: "Cleared", color: "#16a34a", bg: "#f0fdf4", icon: <CheckCircle2 className="h-4 w-4" /> },
  [Decision.ESCALATE]:   { label: "Blocked", color: "#dc2626", bg: "#fef2f2", icon: <XCircle className="h-4 w-4" /> },
  [Decision.NEEDS_REVIEW]:{ label: "Review",  color: "#ea580c", bg: "#fff7ed", icon: <AlertTriangle className="h-4 w-4" /> },
};

const DEMOS = [
  { name: "Kasim Suleymani",     dob: "1957-03-11", country: "Iran",   hint: "Phonetic variant" },
  { name: "Aleksandr Bortnikov", dob: "1951-11-15", country: "Russia", hint: "Exact match" },
  { name: "Hassan Nasrollah",    dob: "1960-08-31", country: "Lebanon",hint: "Transliteration" },
  { name: "John Smith",          dob: "1985-06-15", country: "UK",     hint: "No match expected" },
  { name: "Wladimir Puttin",     dob: "1952-10-07", country: "Russia", hint: "Misspelling test" },
  { name: "Hussein Selami",      dob: "1957-04-04", country: "Iran",   hint: "Turkish variant" },
];

const COUNTRIES = [
  "Afghanistan","Albania","Algeria","Argentina","Armenia","Australia","Austria","Azerbaijan",
  "Bahrain","Belarus","Belgium","Bosnia and Herzegovina","Brazil","Bulgaria","Canada","China",
  "Colombia","Croatia","Cuba","Cyprus","Czech Republic","Denmark","Egypt","Estonia","Ethiopia",
  "Finland","France","Georgia","Germany","Greece","Hong Kong","Hungary","India","Indonesia",
  "Iran","Iraq","Ireland","Israel","Italy","Japan","Jordan","Kazakhstan","Kenya","Kosovo",
  "Kuwait","Kyrgyzstan","Latvia","Lebanon","Libya","Lithuania","Luxembourg","Malaysia","Mali",
  "Mexico","Moldova","Montenegro","Morocco","Myanmar","Netherlands","Nigeria","North Korea",
  "North Macedonia","Norway","Oman","Pakistan","Palestine","Philippines","Poland","Portugal",
  "Qatar","Romania","Russia","Saudi Arabia","Serbia","Singapore","Slovakia","Slovenia",
  "Somalia","South Africa","South Korea","Spain","Sudan","Sweden","Switzerland","Syria",
  "Taiwan","Tajikistan","Thailand","Tunisia","Turkey","Turkmenistan","UAE","UK","Ukraine",
  "United Kingdom","United States","Uruguay","Uzbekistan","Venezuela","Vietnam","Yemen",
];

/* ── Counter hook ── */
function useCounter(target: number, dur = 900, ready = true) {
  const [v, setV] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    if (!ready) { setV(0); return; }
    if (!target) { setV(0); return; }
    const t0 = performance.now();
    function tick(now: number) {
      const p = Math.min((now - t0) / dur, 1);
      setV(Math.round((1 - (1 - p) ** 3) * target));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    }
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, dur, ready]);
  return v;
}

/* ── History ── */
interface HistoryItem {
  id: number;
  query: string;
  dob: string;
  country: string;
  result: ScreenResult | null;
  layers: LayerEvent[];
  timestamp: Date;
  streaming: boolean;
}

/* ══════════════════════════════════════════════════════════════
   HOME PANEL
   ══════════════════════════════════════════════════════════════ */
export function HomePanel() {
  const root = useRef<HTMLDivElement>(null);

  /* state */
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [dob, setDob] = useState("");
  const [country, setCountry] = useState("");
  const [screening, setScreening] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [filter, setFilter] = useState<"all" | Decision>("all");
  const [screenError, setScreenError] = useState("");
  const [countrySearch, setCountrySearch] = useState("");
  const [showCountryDrop, setShowCountryDrop] = useState(false);
  const nextId = useRef(1);
  const newRowRef = useRef<number | null>(null);

  /* fetch */
  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    try { setStats(await getStats()); } catch { /**/ }
    finally { setStatsLoading(false); }
  }, []);
  useEffect(() => { fetchStats(); }, [fetchStats]);

  /* entrance anim (once) */
  const animated = useRef(false);
  useGSAP(() => {
    if (animated.current) return;
    animated.current = true;
    gsap.from(".hero-section", { y: 14, opacity: 0, duration: 0.4, ease: "power2.out" });
  }, { scope: root });

  const statsAnimated = useRef(false);
  const [statsReady, setStatsReady] = useState(false);
  useEffect(() => {
    if (!statsLoading && stats && root.current) {
      if (!statsAnimated.current) {
        statsAnimated.current = true;
        gsap.from(root.current.querySelectorAll(".stat-card"), {
          y: 8, opacity: 0, duration: 0.3, stagger: 0.05, ease: "power2.out",
          onComplete: () => setStatsReady(true),
        });
      } else if (!statsReady) {
        setStatsReady(true);
      }
    }
  }, [statsLoading, stats, statsReady]);

  /* country dropdown */
  const countryList = countrySearch
    ? COUNTRIES.filter((c) => c.toLowerCase().includes(countrySearch.toLowerCase()))
    : COUNTRIES;

  function pickCountry(c: string) {
    setCountry(c);
    setCountrySearch("");
    setShowCountryDrop(false);
  }

  /* screen — streaming */
  function handleScreen(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || screening) return;
    setScreening(true);
    setScreenError("");

    const itemId = nextId.current++;
    newRowRef.current = itemId;
    const item: HistoryItem = {
      id: itemId,
      query: query.trim(),
      dob,
      country,
      result: null,
      layers: [],
      timestamp: new Date(),
      streaming: true,
    };
    setHistory((p) => [item, ...p]);
    setExpandedId(null);

    // fade demo cards
    if (history.length === 0 && root.current) {
      const demos = root.current.querySelector(".demo-cards");
      if (demos) gsap.to(demos, { opacity: 0, y: -6, duration: 0.15, ease: "power2.in" });
    }

    screenStream(
      { name: query.trim(), date_of_birth: dob || null, country: country || null },
      (layerEvt) => {
        setHistory((prev) => prev.map((h) =>
          h.id === itemId ? { ...h, layers: [...h.layers, layerEvt] } : h
        ));
      },
      (result) => {
        setHistory((prev) => prev.map((h) =>
          h.id === itemId ? { ...h, result, streaming: false } : h
        ));
        setScreening(false);
        setQuery("");
        setExpandedId(itemId);
        fetchStats();
      },
      (err) => {
        setScreenError(err?.message || "Screening failed");
        setHistory((prev) => prev.map((h) =>
          h.id === itemId ? { ...h, streaming: false } : h
        ));
        setScreening(false);
      },
    );
  }

  /* derived */
  const completedHistory = history.filter((h) => h.result !== null);
  const filtered = filter === "all" ? history : history.filter((h) => h.result?.decision === filter);
  const cleared  = completedHistory.filter((h) => h.result!.decision === Decision.AUTO_CLEAR).length;
  const escalated = completedHistory.filter((h) => h.result!.decision === Decision.ESCALATE).length;
  const review   = completedHistory.filter((h) => h.result!.decision === Decision.NEEDS_REVIEW).length;

  /* ── RENDER ── */
  return (
    <div ref={root} className="flex-1 overflow-auto px-4 sm:px-6 md:px-12 py-6">
      <div className="mx-auto w-full max-w-[1400px] space-y-6">

        {/* Hero */}
        <div className="hero-section space-y-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Sanctions Screening</h1>
            <p className="text-sm text-muted-foreground">
              Search any name against EU sanctions database with AI-powered analysis
            </p>
          </div>

          {/* Input row: Name + DOB + Country + Screen */}
          <form onSubmit={handleScreen}>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              {/* Name */}
              <div className="flex items-center flex-1 gap-2 shadow-md shadow-black/10 ring-1 ring-black/10 rounded-xl px-4 h-11 focus-within:ring-2 focus-within:ring-black/20 transition-all bg-white">
                <Search className="w-4 h-4 text-muted-foreground shrink-0" />
                <input
                  type="text"
                  placeholder="Full name..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  disabled={screening}
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 min-w-0"
                />
              </div>

              {/* DOB + Country row on mobile */}
              <div className="flex items-center gap-2">
                <CustomDateInput value={dob} onChange={setDob} disabled={screening} />

                <CustomCountrySelect
                  value={country}
                  onChange={pickCountry}
                  onClear={() => { setCountry(""); setCountrySearch(""); }}
                  search={countrySearch}
                  onSearchChange={(v) => { setCountrySearch(v); setCountry(""); }}
                  open={showCountryDrop}
                  onOpenChange={setShowCountryDrop}
                  items={countryList}
                  disabled={screening}
                />
              </div>

              {/* Screen button */}
              <button
                type="submit"
                disabled={!query.trim() || screening}
                className="h-11 px-5 rounded-xl bg-[#2E2E2E] text-white text-sm font-medium shadow-md hover:bg-[#2E2E2E]/90 disabled:opacity-30 transition-all flex items-center justify-center gap-2 shrink-0"
              >
                {screening ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                Screen
              </button>
            </div>
          </form>
        </div>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-black/5 shadow-md shadow-black/10 ring-1 ring-black/10 rounded-xl">
            <StatCard label="Total screened" value={stats.total_screenings} ready={statsReady} />
            <StatCard label="Auto cleared"   value={stats.decision_distribution[Decision.AUTO_CLEAR] ?? 0} ready={statsReady} />
            <StatCard label="Needs review"   value={stats.decision_distribution[Decision.NEEDS_REVIEW] ?? 0} color="#a16207" ready={statsReady} />
            <StatCard label="Escalated"      value={stats.decision_distribution[Decision.ESCALATE] ?? 0} color="#dc2626" ready={statsReady} />
          </div>
        )}
        {statsLoading && (
          <div className="flex items-center gap-3 py-4">
            <DotMatrix cols={3} rows={3} dotSize={3} gap={2} color="#2E2E2E" offColor="#e5e7eb" pattern="pulse" speed={0.6} />
            <ShiningText text="Loading statistics…" className="text-xs font-medium" />
          </div>
        )}

        {/* Error banner */}
        {screenError && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-red-50 ring-1 ring-red-200 text-sm text-red-700">
            <XCircle className="w-4 h-4 shrink-0" />
            {screenError}
          </div>
        )}

        {/* Results section */}
        <div className="space-y-4">
          {/* Tabs */}
          <div className="flex items-center gap-3 sm:gap-5 border-b border-border overflow-x-auto">
            {([
              { id: "all" as const, label: "All results", count: history.length },
              { id: Decision.AUTO_CLEAR as const, label: "Cleared", count: cleared },
              { id: Decision.NEEDS_REVIEW as const, label: "Review", count: review },
              { id: Decision.ESCALATE as const, label: "Escalated", count: escalated },
            ]).map((t) => (
              <button
                key={t.id}
                onClick={() => setFilter(t.id)}
                className={`pb-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                  filter === t.id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t.label}
                {t.count > 0 && <span className="text-xs bg-secondary rounded-full px-1.5 py-0.5 tabular-nums">{t.count}</span>}
              </button>
            ))}
          </div>

          {/* Demo cards (empty state) */}
          {history.length === 0 && !screening && (
            <div className="demo-cards pt-2">
              <p className="text-sm text-muted-foreground mb-3">Try screening one of these names:</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {DEMOS.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => {
                      setQuery(s.name);
                      setDob(s.dob);
                      setCountry(s.country);
                      setCountrySearch("");
                      setTimeout(() => { root.current?.querySelector("form")?.requestSubmit(); }, 50);
                    }}
                    className="flex items-center justify-between rounded-xl shadow-sm shadow-black/5 ring-1 ring-black/10 px-4 py-3 text-left hover:bg-secondary/50 transition-colors group"
                  >
                    <div>
                      <p className="text-sm font-medium">{s.name}</p>
                      <p className="text-xs text-muted-foreground">{s.hint} · {s.country}</p>
                    </div>
                    <Search className="w-3.5 h-3.5 text-muted-foreground/30 group-hover:text-muted-foreground shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Results list — card-based, no table */}
          <div className="space-y-2">
            {filtered.map((item) => (
              <ScreeningCard
                key={item.id}
                item={item}
                isNew={newRowRef.current === item.id}
                isExpanded={expandedId === item.id}
                onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
                onAnimated={() => { if (newRowRef.current === item.id) newRowRef.current = null; }}
              />
            ))}
          </div>

          {filtered.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {filtered.length} result{filtered.length !== 1 ? "s" : ""}
              {filter !== "all" && " · filtered"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ━━ Reusable components ━━ */

function StatCard({ label, value, color, ready = true }: { label: string; value: number; color?: string; ready?: boolean }) {
  const animated = useCounter(value, 900, ready);
  return (
    <div className="stat-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tracking-tight leading-none mt-1 tabular-nums" style={color ? { color } : undefined}>
        {animated.toLocaleString()}
      </p>
    </div>
  );
}

/* ━━ Layer steps ━━ */

const LAYER_STEPS = [
  { n: 1, icon: <Search className="w-3.5 h-3.5" />,        label: "Embedding", color: "#6366f1" },
  { n: 2, icon: <AlertTriangle className="w-3.5 h-3.5" />, label: "Rules",     color: "#f59e0b" },
  { n: 3, icon: <Brain className="w-3.5 h-3.5" />,         label: "LLM",       color: "#8b5cf6" },
];

function LayerSteps({ layers, streaming }: { layers: LayerEvent[]; streaming: boolean }) {
  const doneSet = new Set(layers.filter((l) => l.status === "done").map((l) => l.layer));
  const runningLayer = layers.find((l) => l.status === "running" && !doneSet.has(l.layer))?.layer;

  return (
    <div className="flex items-center gap-1">
      {LAYER_STEPS.map((step, i) => {
        const done = layers.find((l) => l.layer === step.n && l.status === "done");
        const isRunning = runningLayer === step.n;
        const inactive = !done && !isRunning;

        return (
          <div key={step.n} className="flex items-center">
            {/* Connector line */}
            {i > 0 && (
              <div
                className="w-4 h-[2px] mx-0.5 rounded-full transition-colors duration-500"
                style={{ backgroundColor: doneSet.has(step.n) || doneSet.has(LAYER_STEPS[i - 1].n) ? LAYER_STEPS[i - 1].color + "60" : "#e5e7eb" }}
              />
            )}
            {/* Step */}
            <div
              className={`flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-semibold transition-all duration-300 ${
                isRunning ? "ring-2 ring-offset-1 scale-105" : ""
              }`}
              style={
                inactive
                  ? { backgroundColor: "#f3f4f6", color: "#9ca3af" }
                  : {
                      backgroundColor: step.color + "14",
                      color: step.color,
                      ...(isRunning ? { ringColor: step.color + "50" } : {}),
                    }
              }
            >
              {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : step.icon}
              <span>{step.label}</span>
              {done?.ms != null && (
                <span className="text-[10px] font-mono opacity-60">{done.ms > 1000 ? `${(done.ms / 1000).toFixed(1)}s` : `${done.ms}ms`}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ━━ Screening card ━━ */

function ScreeningCard({ item, isNew, isExpanded, onToggle, onAnimated }: {
  item: HistoryItem;
  isNew: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onAnimated: () => void;
}) {
  const result = item.result;
  const ds = result ? badge[result.decision] : null;
  const top = result?.matches[0];
  const cardRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const didAnimate = useRef(false);

  /* New row entrance animation */
  useEffect(() => {
    if (isNew && cardRef.current && !didAnimate.current) {
      didAnimate.current = true;
      const el = cardRef.current;
      gsap.fromTo(el,
        { opacity: 0, y: -20, scale: 0.98 },
        { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: "power3.out", onComplete: onAnimated }
      );
    }
  }, [isNew, onAnimated]);

  /* Result arrival flash */
  useEffect(() => {
    if (result && cardRef.current && ds) {
      gsap.fromTo(cardRef.current,
        { boxShadow: `0 0 0 2px ${ds.color}40` },
        { boxShadow: "0 0 0 2px transparent", duration: 1.2, ease: "power2.out" }
      );
    }
  }, [result, ds]);

  /* Detail expand/collapse */
  useEffect(() => {
    const el = detailRef.current;
    if (!el) return;
    if (isExpanded && result) {
      el.style.display = "block";
      const h = el.scrollHeight;
      gsap.fromTo(el,
        { height: 0, opacity: 0 },
        { height: h, opacity: 1, duration: 0.4, ease: "power3.out", onComplete: () => { el.style.height = "auto"; } }
      );
    } else {
      if (el.style.display !== "none") {
        gsap.to(el, {
          height: 0, opacity: 0, duration: 0.25, ease: "power2.in",
          onComplete: () => { el.style.display = "none"; }
        });
      }
    }
  }, [isExpanded, result]);

  return (
    <div
      ref={cardRef}
      className="rounded-xl ring-1 ring-black/[0.06] bg-white shadow-sm shadow-black/5 overflow-hidden transition-shadow hover:shadow-md hover:ring-black/10"
    >
      {/* Main row */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-4 sm:px-5 py-3.5 group"
      >
        {/* Mobile layout: stacked */}
        <div className="flex items-center gap-3 sm:hidden">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-foreground truncate">{item.query}</p>
              {ds && (
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold shrink-0"
                  style={{ backgroundColor: ds.bg, color: ds.color }}
                >
                  {ds.icon} {ds.label}
                </span>
              )}
              {!ds && (
                <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
                  <Loader2 className="w-3 h-3 animate-spin" /> Processing
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <p className="text-[11px] text-muted-foreground">
                {item.dob && item.dob}{item.dob && item.country && " · "}{item.country}
              </p>
              {top && (
                <span className="text-[10px] text-muted-foreground/70 font-mono tabular-nums">
                  {top.matched_name} · {(top.similarity_score * 100).toFixed(1)}%
                </span>
              )}
            </div>
            <div className="mt-1.5">
              <LayerSteps layers={item.layers} streaming={item.streaming} />
            </div>
          </div>
          <ChevronDown
            className={`w-4 h-4 text-muted-foreground/40 shrink-0 transition-transform duration-300 ${
              isExpanded ? "rotate-180" : ""
            }`}
          />
        </div>

        {/* Desktop layout: horizontal */}
        <div className="hidden sm:flex items-center gap-4">
          <div className="min-w-[200px] flex-shrink-0">
            <p className="text-sm font-semibold text-foreground">{item.query}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {item.dob && item.dob}{item.dob && item.country && " · "}{item.country}
            </p>
          </div>

          <div className="flex-1 flex justify-center">
            <LayerSteps layers={item.layers} streaming={item.streaming} />
          </div>

          <div className="w-[100px] flex justify-center">
            {ds ? (
              <span
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold"
                style={{ backgroundColor: ds.bg, color: ds.color }}
              >
                {ds.icon} {ds.label}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Processing
              </span>
            )}
          </div>

          <div className="w-[140px] text-right shrink-0">
            <p className="text-sm text-muted-foreground truncate">{top?.matched_name ?? "—"}</p>
            <p className="text-[11px] font-mono tabular-nums text-muted-foreground/70">
              {top ? `${(top.similarity_score * 100).toFixed(1)}%` : ""}
            </p>
          </div>

          <div className="w-[60px] text-right shrink-0">
            <p className="text-xs font-mono tabular-nums text-muted-foreground">
              {result?.processing_time_ms != null
                ? result.processing_time_ms > 1000
                  ? `${(result.processing_time_ms / 1000).toFixed(1)}s`
                  : `${result.processing_time_ms.toFixed(0)}ms`
                : "—"}
            </p>
          </div>

          <ChevronDown
            className={`w-4 h-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-transform duration-300 shrink-0 ${
              isExpanded ? "rotate-180" : ""
            }`}
          />
        </div>
      </button>

      {/* Detail panel */}
      <div
        ref={detailRef}
        className="overflow-hidden border-t border-black/[0.04]"
        style={{ height: 0, opacity: 0, display: "none" }}
      >
        {result && (
          <div className="px-4 sm:px-5 py-4 sm:py-5 bg-[#faf9fc]">
            <DetailPanel result={result} ds={ds!} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ━━ Detail panel ━━ */

function DetailPanel({ result, ds }: { result: ScreenResult; ds: typeof badge[Decision] }) {
  const top = result.matches[0];

  return (
    <div className="space-y-4">
      {/* Info grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6 text-sm">
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Query</h4>
          <KV k="Name" v={result.query_name} />
          <KV k="Threshold" v={result.threshold_used.toFixed(2)} />
          <KV k="Matches" v={String(result.matches.length)} />
        </div>
        {top && (
          <div className="space-y-1.5">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Top Match</h4>
            <KV k="Name" v={top.matched_name} />
            <KV k="Score" v={`${(top.similarity_score * 100).toFixed(1)}%`} vc={ds.color} />
            <KV k="Type" v={top.match_type} />
          </div>
        )}
        {top && (
          <div className="space-y-1.5">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Sanctions Entry</h4>
            <KV k="Reason" v={top.reason_for_listing ?? "—"} />
            <KV k="Program" v={top.sanctions_program ?? "—"} />
            <KV k="Nationality" v={top.nationality ?? "—"} />
            <KV k="DOB" v={top.date_of_birth ?? "—"} />
          </div>
        )}
      </div>

      {/* XAI Detail Panel — Signal Breakdown + Decision Logic + Agent Reasoning */}
      <XAIDetailPanel
        signalBreakdown={result.signal_breakdown}
        reasoning={result.reasoning}
        decision={result.decision}
        llmReasoning={result.llm_reasoning}
        llmConfidence={result.llm_confidence}
      />

      {/* All matches */}
      {result.matches.length > 1 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">All Matches ({result.matches.length})</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
            {result.matches.map((m, i) => (
              <div key={i} className="flex items-center justify-between text-xs border border-border/40 rounded-lg px-3 py-2">
                <span className="font-medium truncate mr-2">{m.matched_name}</span>
                <span className="font-mono tabular-nums text-muted-foreground shrink-0">{(m.similarity_score * 100).toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function KV({ k, v, vc }: { k: string; v: string; vc?: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-medium" style={vc ? { color: vc } : undefined}>{v}</span>
    </div>
  );
}

/* ━━ Custom Date Input ━━ */

function CustomDateInput({ value, onChange, disabled }: {
  value: string;      // ISO yyyy-mm-dd
  onChange: (iso: string) => void;
  disabled?: boolean;
}) {
  const [display, setDisplay] = useState(() => isoToDisplay(value));
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function isoToDisplay(iso: string) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  function displayToIso(disp: string): string | null {
    const clean = disp.replace(/\D/g, "");
    if (clean.length !== 8) return null;
    const d = clean.slice(0, 2), m = clean.slice(2, 4), y = clean.slice(4, 8);
    const day = parseInt(d, 10), month = parseInt(m, 10), year = parseInt(y, 10);
    if (day < 1 || day > 31 || month < 1 || month > 12 || year < 1900 || year > 2100) return null;
    return `${y}-${m}-${d}`;
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    let digits = raw.replace(/\D/g, "").slice(0, 8);

    let formatted = "";
    for (let i = 0; i < digits.length; i++) {
      if (i === 2 || i === 4) formatted += ".";
      formatted += digits[i];
    }
    setDisplay(formatted);

    const iso = displayToIso(formatted);
    onChange(iso ?? "");
  }

  function handleBlur() {
    setFocused(false);
    if (display && !displayToIso(display)) {
      setDisplay("");
      onChange("");
    }
  }

  useEffect(() => {
    if (!focused) setDisplay(isoToDisplay(value));
  }, [value, focused]);

  const hasValue = !!display;

  return (
    <div
      className={`flex items-center gap-1.5 shadow-md shadow-black/10 ring-1 ring-black/10 rounded-xl px-3 h-11 transition-all bg-white shrink-0 cursor-text ${
        focused ? "ring-2 ring-black/20" : ""
      }`}
      onClick={() => inputRef.current?.focus()}
    >
      <Calendar className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <div className="relative w-[100px]">
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          value={display}
          onChange={handleChange}
          onFocus={() => setFocused(true)}
          onBlur={handleBlur}
          disabled={disabled}
          className="bg-transparent text-sm outline-none w-full text-foreground tabular-nums relative z-10"
          maxLength={10}
        />
        {!hasValue && !focused && (
          <span className="absolute inset-0 flex items-center text-sm text-muted-foreground/40 pointer-events-none select-none tabular-nums">
            dd.mm.yyyy
          </span>
        )}
      </div>
      {hasValue && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setDisplay(""); onChange(""); }}
          className="text-muted-foreground/50 hover:text-foreground text-xs transition-colors"
        >
          ×
        </button>
      )}
    </div>
  );
}

/* ━━ Custom Country Select ━━ */

function CustomCountrySelect({ value, onChange, onClear, search, onSearchChange, open, onOpenChange, items, disabled }: {
  value: string;
  onChange: (c: string) => void;
  onClear: () => void;
  search: string;
  onSearchChange: (v: string) => void;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  items: string[];
  disabled?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);

  useEffect(() => {
    setHighlightIdx(0);
  }, [search, open]);

  /* GSAP open/close */
  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;

    if (open && items.length > 0) {
      el.style.display = "block";
      gsap.fromTo(el,
        { opacity: 0, y: -6, scaleY: 0.96 },
        { opacity: 1, y: 0, scaleY: 1, duration: 0.22, ease: "power3.out" }
      );
    } else {
      gsap.to(el, {
        opacity: 0, y: -4, duration: 0.14, ease: "power2.in",
        onComplete: () => { el.style.display = "none"; },
      });
    }
  }, [open, items.length]);

  /* click outside */
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onOpenChange(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open, onOpenChange]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") { onOpenChange(true); e.preventDefault(); }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((p) => Math.min(p + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((p) => Math.max(p - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (items[highlightIdx]) onChange(items[highlightIdx]);
    } else if (e.key === "Escape") {
      onOpenChange(false);
    }
  }

  /* scroll highlighted into view */
  useEffect(() => {
    if (!open || !dropRef.current) return;
    const list = dropRef.current.querySelector("[data-list]");
    const item = list?.children[highlightIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [highlightIdx, open]);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <div
        className={`flex items-center gap-1.5 shadow-md shadow-black/10 ring-1 ring-black/10 rounded-xl px-3 h-11 transition-all bg-white cursor-pointer ${
          open ? "ring-2 ring-black/20" : ""
        }`}
        onClick={() => {
          if (disabled) return;
          onOpenChange(!open);
          setTimeout(() => searchRef.current?.focus(), 60);
        }}
      >
        <Globe className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        {value ? (
          <span className="text-sm text-foreground font-medium truncate max-w-[110px]">{value}</span>
        ) : (
          <span className="text-sm text-muted-foreground/40 select-none">Country...</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {value && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onClear(); }}
              className="text-muted-foreground/50 hover:text-foreground text-xs transition-colors"
            >
              ×
            </button>
          )}
          <ChevronDown className={`w-3 h-3 text-muted-foreground/40 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
        </div>
      </div>

      {/* Dropdown */}
      <div
        ref={dropRef}
        style={{ display: "none", transformOrigin: "top center" }}
        className="absolute left-0 top-[calc(100%+6px)] w-[220px] bg-white rounded-xl shadow-xl shadow-black/12 ring-1 ring-black/10 z-40 overflow-hidden"
      >
        {/* Search */}
        <div className="p-2 border-b border-black/5">
          <div className="flex items-center gap-2 rounded-lg bg-secondary/50 px-2.5 h-8">
            <Search className="w-3 h-3 text-muted-foreground shrink-0" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search..."
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={handleKeyDown}
              className="bg-transparent text-xs outline-none flex-1 placeholder:text-muted-foreground/40"
            />
          </div>
        </div>

        {/* List */}
        <div data-list="" className="max-h-[240px] overflow-y-auto py-1 scroll-smooth">
          {items.length === 0 ? (
            <p className="text-xs text-muted-foreground/50 text-center py-4">No results</p>
          ) : (
            items.map((c, i) => (
              <button
                key={c}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); onChange(c); }}
                onMouseEnter={() => setHighlightIdx(i)}
                className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between transition-colors ${
                  i === highlightIdx ? "bg-secondary/70" : ""
                } ${c === value ? "font-semibold text-foreground" : "text-foreground/80"}`}
              >
                <span>{c}</span>
                {c === value && <Check className="w-3 h-3 text-foreground/60" />}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
