import { type BatchCustomerResult, type LLMEvidence, Decision } from "@/lib/api";
import { CheckCircle2, XCircle, AlertTriangle } from "lucide-react";

/* ── Types ── */
export type BatchState = "idle" | "scanning" | "llm_phase" | "results" | "error";
export type Filter = "all" | Decision;
export type IndexedResult = BatchCustomerResult & {
  index: number;
  /** Set when LLM resolves a NEEDS_REVIEW — tracks original decision */
  wasReview?: boolean;
};
export type ResolvedItem = IndexedResult & { resolvedAt: number };

/* ── Constants ── */
export const PAGE_SIZE = 50;
export const UI_BATCH_INTERVAL_MS = 120;

/* ── Design tokens ── */
export const decisionMeta: Record<
  Decision,
  { label: string; color: string; bg: string; flashBg: string; icon: React.ReactNode }
> = {
  [Decision.AUTO_CLEAR]: {
    label: "Cleared", color: "#16a34a", bg: "#f0fdf4", flashBg: "#bbf7d0",
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
  },
  [Decision.ESCALATE]: {
    label: "Blocked", color: "#dc2626", bg: "#fef2f2", flashBg: "#fecaca",
    icon: <XCircle className="h-3.5 w-3.5" />,
  },
  [Decision.NEEDS_REVIEW]: {
    label: "Review", color: "#ea580c", bg: "#fff7ed", flashBg: "#fed7aa",
    icon: <AlertTriangle className="h-3.5 w-3.5" />,
  },
};

/* ── CSV parser ── */
export function parseCSV(text: string): import("@/lib/api").BatchCustomerInput[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/['"]/g, ""));
  const nameIdx = header.findIndex((h) => ["full_name", "fullname", "name", "customer_name"].includes(h));
  const dobIdx = header.findIndex((h) => ["date_of_birth", "dob", "dateofbirth", "birth_date"].includes(h));
  const countryIdx = header.findIndex((h) => ["country", "nationality", "nation"].includes(h));
  if (nameIdx === -1) return [];
  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = line.split(",").map((c) => c.trim().replace(/['"]/g, ""));
    return {
      name: cols[nameIdx] || "",
      date_of_birth: dobIdx >= 0 ? cols[dobIdx] || null : null,
      country: countryIdx >= 0 ? cols[countryIdx] || null : null,
    };
  }).filter((c) => c.name);
}

/* ── Helpers ── */
export function formatTime(ms: number): string {
  const totalSec = ms / 1000;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return `${min}:${sec.toFixed(1).padStart(4, "0")}`;
  return `${sec.toFixed(1)}s`;
}
