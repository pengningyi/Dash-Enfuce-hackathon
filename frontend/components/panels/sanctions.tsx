"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { DotMatrix } from "@/components/ui/dot-matrix";
import { ShiningText } from "@/components/ui/shining-text";
import { Search, Plus, Loader2, RefreshCw, CheckCircle2, X, MoreVertical } from "lucide-react";
import { getSanctions, addSanction, type SanctionsEntry, type SanctionsAddRequest } from "@/lib/api";

gsap.registerPlugin(useGSAP);

export function SanctionsPanel() {
  const [entries, setEntries] = useState<SanctionsEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 100;
  const ref = useRef<HTMLDivElement>(null);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    try { setEntries(await getSanctions()); } catch { /**/ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const animated = useRef(false);
  useGSAP(() => {
    if (animated.current) return;
    animated.current = true;
    gsap.from(".s-header", { y: 10, opacity: 0, duration: 0.35, ease: "power2.out" });
  }, { scope: ref });

  // Scroll-based row reveal — animate rows as they enter viewport
  useEffect(() => {
    if (loading || !ref.current) return;

    const rows = ref.current.querySelectorAll<HTMLElement>(".s-row");
    if (!rows.length) return;

    // Set initial state
    rows.forEach((row) => {
      gsap.set(row, { opacity: 0, y: 6 });
    });

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            gsap.to(entry.target, {
              opacity: 1,
              y: 0,
              duration: 0.3,
              ease: "power2.out",
            });
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, root: ref.current.closest(".content-panel") }
    );

    rows.forEach((row) => observer.observe(row));

    return () => observer.disconnect();
  }, [loading, searchQuery, page]);

  const filtered = entries.filter((e) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return e.sanction_id.toLowerCase().includes(q) || e.full_name.toLowerCase().includes(q) ||
      (e.alias_1 && e.alias_1.toLowerCase().includes(q)) || (e.alias_2 && e.alias_2.toLowerCase().includes(q)) ||
      (e.sanctions_program && e.sanctions_program.toLowerCase().includes(q));
  });

  // Reset page when search changes
  useEffect(() => { setPage(0); }, [searchQuery]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div ref={ref} className="flex min-h-full">
      {/* Main content */}
      <div className="flex-1 px-8 py-6">
        <div className="mx-auto w-full max-w-[1400px]">
          {/* Header */}
          <div className="s-header flex items-center justify-between">
            <p className="text-sm">
              <span className="font-semibold">{entries.length} sanctions entries</span>
              <span className="text-muted-foreground ml-2">EU sanctions database</span>
            </p>
            <button
              onClick={() => setShowAdd(!showAdd)}
              className={`h-8 px-4 rounded-md text-sm font-medium transition-all flex items-center gap-1.5 ${
                showAdd
                  ? "bg-secondary text-foreground"
                  : "bg-[#2E2E2E] text-white hover:bg-[#2E2E2E]/90 shadow-md"
              }`}
            >
              {showAdd ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
              {showAdd ? "Close" : "Add entry"}
            </button>
          </div>

          {/* Search */}
          <div className="mt-5">
            <div className="flex items-center gap-2 shadow-md shadow-black/10 ring-1 ring-black/10 rounded-xl px-3 h-10 focus-within:ring-2 focus-within:ring-black/20 transition-all">
              <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder="Search by name, ID, or program…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
              />
              {searchQuery && (
                <span className="text-xs text-muted-foreground tabular-nums">{filtered.length} results</span>
              )}
            </div>
          </div>

          {/* Table */}
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <DotMatrix cols={4} rows={4} dotSize={4} gap={3} color="#2E2E2E" offColor="#e5e7eb" pattern="pulse" speed={0.7} />
              <ShiningText text="Loading sanctions…" className="text-xs font-medium" />
            </div>
          ) : (
            <div className="mt-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground text-xs">
                    <th className="text-left py-2 font-medium w-20">ID</th>
                    <th className="text-left py-2 font-medium">Full Name</th>
                    <th className="text-left py-2 font-medium">Aliases</th>
                    <th className="text-left py-2 font-medium">Nationality</th>
                    <th className="text-left py-2 font-medium">Program</th>
                    <th className="text-left py-2 font-medium w-24">DOB</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {paged.map((entry) => {
                    const aliases = [entry.alias_1, entry.alias_2].filter(Boolean).join(", ");
                    return (
                      <tr key={entry.sanction_id} className="s-row hover:bg-[#f8f7fa] transition-all">
                        <td className="py-3 font-mono text-muted-foreground text-xs">{entry.sanction_id}</td>
                        <td className="py-3 font-medium">{entry.full_name}</td>
                        <td className="py-3 text-muted-foreground">{aliases || "—"}</td>
                        <td className="py-3 text-muted-foreground">{entry.nationality || "—"}</td>
                        <td className="py-3 text-xs text-muted-foreground">{entry.sanctions_program || "—"}</td>
                        <td className="py-3 text-muted-foreground font-mono tabular-nums text-xs">{entry.date_of_birth || "—"}</td>
                        <td className="py-3"><MoreVertical className="h-4 w-4 text-muted-foreground/30" /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {/* Pagination */}
              <div className="flex items-center justify-between mt-3">
                <p className="text-xs text-muted-foreground">
                  Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length} entries
                  {searchQuery && " · filtered"}
                </p>
                {totalPages > 1 && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      disabled={page === 0}
                      className="h-7 px-2.5 rounded-md text-xs font-medium hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                    >
                      ← Prev
                    </button>
                    <span className="text-xs text-muted-foreground tabular-nums px-2">
                      {page + 1} / {totalPages}
                    </span>
                    <button
                      onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                      disabled={page >= totalPages - 1}
                      className="h-7 px-2.5 rounded-md text-xs font-medium hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                    >
                      Next →
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Add entry side panel */}
      <AddPanel
        open={showAdd}
        onSuccess={() => { setShowAdd(false); fetchEntries(); }}
        onClose={() => setShowAdd(false)}
      />
    </div>
  );
}

/* ── Add Entry Side Panel ── */
function AddPanel({ open, onSuccess, onClose }: { open: boolean; onSuccess: () => void; onClose: () => void }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!wrapperRef.current) return;
    if (open) {
      gsap.fromTo(wrapperRef.current,
        { width: 0, opacity: 0 },
        { width: 340, opacity: 1, duration: 0.3, ease: "power3.out" }
      );
    } else {
      gsap.to(wrapperRef.current,
        { width: 0, opacity: 0, duration: 0.2, ease: "power2.in" }
      );
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formRef.current) return;
    const fd = new FormData(formRef.current);
    const req: SanctionsAddRequest = {
      sanction_id: fd.get("sanction_id") as string,
      full_name: fd.get("full_name") as string,
      alias_1: (fd.get("alias_1") as string) || undefined,
      alias_2: (fd.get("alias_2") as string) || undefined,
      nationality: (fd.get("nationality") as string) || undefined,
      date_of_birth: (fd.get("date_of_birth") as string) || undefined,
      sanctions_program: (fd.get("sanctions_program") as string) || undefined,
    };
    setSubmitting(true);
    try {
      const res = await addSanction(req);
      setSuccess(`Added ${res.sanction_id} · ${res.vectors_added} vectors indexed`);
      setTimeout(() => { setSuccess(null); onSuccess(); }, 1200);
    } catch {
      setSubmitting(false);
    }
  }

  function reset() {
    setSubmitting(false);
    setSuccess(null);
    formRef.current?.reset();
  }

  return (
    <div
      ref={wrapperRef}
      className="shrink-0 border-l border-border bg-white overflow-hidden"
      style={{ width: 0, opacity: 0 }}
    >
      <div className="w-[340px] p-5 space-y-5 overflow-y-auto h-full">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Add Sanctions Entry</h3>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Success */}
        {success && (
          <div className="flex items-center gap-2 text-xs text-green-700 bg-green-50 rounded-lg p-3">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> {success}
          </div>
        )}

        {/* Form */}
        <AddEntryForm formRef={formRef} onSubmit={handleSubmit} submitting={submitting} onCancel={() => { reset(); onClose(); }} />
      </div>
    </div>
  );
}

/* ── Add Entry Form with validation ── */
function AddEntryForm({ formRef, onSubmit, submitting, onCancel }: {
  formRef: React.RefObject<HTMLFormElement | null>; onSubmit: (e: React.FormEvent) => void; submitting: boolean; onCancel: () => void;
}) {
  const [dob, setDob] = useState("");
  const [nationality, setNationality] = useState("");

  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-3">
      <Field name="sanction_id" label="Sanction ID" required placeholder="e.g. EU-0031" />
      <Field name="full_name" label="Full Name" required placeholder="e.g. John Doe" />
      <Field name="alias_1" label="Alias 1" placeholder="Optional" />
      <Field name="alias_2" label="Alias 2" placeholder="Optional" />

      <Field name="nationality" label="Nationality" placeholder="e.g. Russia">
        <NationalityInput name="nationality" value={nationality} onChange={setNationality} />
      </Field>

      <Field name="date_of_birth" label="Date of Birth">
        <DobInput name="date_of_birth" value={dob} onChange={setDob} />
      </Field>

      <Field name="sanctions_program" label="Program" placeholder="e.g. EU Council Decision 2024/..." />

      <div className="flex items-center gap-2 pt-2">
        <button
          type="submit"
          disabled={submitting}
          className="flex-1 h-8 rounded-md bg-[#2E2E2E] text-white text-xs font-medium shadow-md hover:bg-[#2E2E2E]/90 disabled:opacity-40 transition-all flex items-center justify-center gap-1.5"
        >
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          {submitting ? "Adding…" : "Add entry"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-8 px-3 rounded-md text-xs font-medium shadow-sm hover:bg-secondary/80 transition-all"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ── Countries list (shared) ── */
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

/* ── Input styles ── */
const inputBase = "w-full h-8 rounded-lg shadow-md shadow-black/10 ring-1 ring-black/10 px-3 text-sm outline-none focus:ring-2 focus:ring-black/20 bg-white transition-all";
const inputError = "w-full h-8 rounded-lg shadow-md shadow-red-100 ring-1 ring-red-300 px-3 text-sm outline-none focus:ring-2 focus:ring-red-200 bg-white transition-all";

/* ── Validated field ── */
function Field({ name, label, required, placeholder, error, children }: {
  name: string; label: string; required?: boolean; placeholder?: string; error?: string; children?: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={`add-${name}`} className="text-xs font-medium text-muted-foreground">
        {label} {required && <span className="text-destructive">*</span>}
      </label>
      {children ?? (
        <input
          id={`add-${name}`}
          name={name}
          required={required}
          placeholder={placeholder}
          className={error ? inputError : inputBase}
        />
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

/* ── DOB Input with auto-format ── */
function DobInput({ name, value, onChange, error }: { name: string; value: string; onChange: (v: string) => void; error?: string }) {
  function handleChange(raw: string) {
    // Strip non-digits
    const digits = raw.replace(/\D/g, "").slice(0, 8);
    // Auto-format: YYYY-MM-DD
    let formatted = digits;
    if (digits.length > 4) formatted = digits.slice(0, 4) + "-" + digits.slice(4);
    if (digits.length > 6) formatted = digits.slice(0, 4) + "-" + digits.slice(4, 6) + "-" + digits.slice(6);
    onChange(formatted);
  }

  function validate(): string | undefined {
    if (!value) return undefined;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return "Format: YYYY-MM-DD";
    const [, y, m, d] = match;
    const year = parseInt(y); const month = parseInt(m); const day = parseInt(d);
    if (year < 1900 || year > 2010) return "Year must be 1900-2010";
    if (month < 1 || month > 12) return "Month must be 01-12";
    if (day < 1 || day > 31) return "Day must be 01-31";
    return undefined;
  }

  const validationError = error || validate();

  return (
    <div className="space-y-1">
      <input
        id={`add-${name}`}
        name={name}
        placeholder="YYYY-MM-DD"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        className={validationError ? inputError : inputBase}
        style={{ fontVariantNumeric: "tabular-nums" }}
        maxLength={10}
      />
      {validationError && <p className="text-[11px] text-destructive">{validationError}</p>}
    </div>
  );
}

/* ── Nationality Autocomplete ── */
function NationalityInput({ name, value, onChange }: { name: string; value: string; onChange: (v: string) => void }) {
  const [showDrop, setShowDrop] = useState(false);
  const [hlIdx, setHlIdx] = useState(0);

  const list = value
    ? COUNTRIES.filter((c) => c.toLowerCase().includes(value.toLowerCase())).slice(0, 6)
    : COUNTRIES.slice(0, 6);

  useEffect(() => { setHlIdx(0); }, [value]);

  function pick(c: string) { onChange(c); setShowDrop(false); setHlIdx(0); }

  function onKey(e: React.KeyboardEvent) {
    if (!showDrop) { if (e.key === "ArrowDown") { setShowDrop(true); e.preventDefault(); } return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setHlIdx((i) => Math.min(i + 1, list.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHlIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (list[hlIdx]) pick(list[hlIdx]); }
    else if (e.key === "Escape") setShowDrop(false);
  }

  return (
    <div className="relative">
      <input
        id={`add-${name}`}
        name={name}
        placeholder="Type to search countries..."
        value={value}
        onChange={(e) => { onChange(e.target.value); setShowDrop(true); }}
        onFocus={() => setShowDrop(true)}
        onBlur={() => setTimeout(() => setShowDrop(false), 150)}
        onKeyDown={onKey}
        className={inputBase}
      />
      {showDrop && list.length > 0 && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] bg-white shadow-lg shadow-black/10 ring-1 ring-black/10 rounded-lg z-30 max-h-[180px] overflow-y-auto">
          {list.map((c, i) => (
            <button key={c} type="button"
              onMouseDown={(e) => { e.preventDefault(); pick(c); }}
              className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                i === hlIdx ? "bg-secondary text-foreground" : "hover:bg-secondary/60"
              } ${c === value ? "font-medium" : ""}`}
            >
              {c}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
