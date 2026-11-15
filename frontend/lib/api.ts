/**
 * Typed API client for the sanctions screening backend.
 * Mirrors backend/app/models/schemas.py Pydantic models.
 */

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

// --- Auth state (module-level singleton) ---

let _authToken: string | null = null;
let _authRole: "user" | "guest" | null = null;

export function getAuthToken() { return _authToken; }
export function getAuthRole() { return _authRole; }
export function isGuest() { return _authRole === "guest"; }
export function isLoggedIn() { return _authToken !== null; }

export async function login(password: string): Promise<{ token: string; role: "user" | "guest" }> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error("Login failed");
  const data = await res.json();
  _authToken = data.token;
  _authRole = data.role;
  return data;
}

export function logout() {
  _authToken = null;
  _authRole = null;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (_authToken) h["Authorization"] = `Bearer ${_authToken}`;
  return h;
}

// --- Enums ---

export enum Decision {
  AUTO_CLEAR = "AUTO_CLEAR",
  ESCALATE = "ESCALATE",
  NEEDS_REVIEW = "NEEDS_REVIEW",
}

// --- Request types ---

export interface ScreenRequest {
  name: string;
  threshold?: number;
  date_of_birth?: string | null;
  country?: string | null;
}

export interface BatchCustomerInput {
  name: string;
  date_of_birth?: string | null;
  country?: string | null;
}

export interface BatchScreenRequest {
  customers: BatchCustomerInput[];
}

// --- Signal scoring types (multi-signal pipeline) ---

export interface SignalScore {
  signal_name: string;
  score: number;
  detail: string;
  missing: boolean;
}

export interface SignalBreakdown {
  dob: SignalScore;
  name_jw: SignalScore;
  phonetic: SignalScore;
  embedding: SignalScore;
  country: SignalScore;
}

// --- Response types ---

export interface SanctionsMatch {
  sanctions_id: string;
  full_name: string;
  matched_name: string;
  match_type: string;
  similarity_score: number;
  date_of_birth?: string | null;
  nationality?: string | null;
  sanctions_program?: string | null;
  reason_for_listing?: string | null;
}

export interface LLMEvidence {
  name_match: "exact" | "transliteration" | "phonetic" | "partial_first_only" | "none";
  dob_match: "exact" | "close" | "different" | "missing";
  country_match: "same" | "different" | "explainable" | "missing";
}

export interface ScreenResult {
  query_name: string;
  matches: SanctionsMatch[];
  decision: Decision;
  layer_reached: number;
  threshold_used: number;
  llm_reasoning?: string | null;
  llm_confidence?: number | null;
  llm_evidence?: LLMEvidence | null;
  processing_time_ms?: number | null;
  signal_breakdown?: SignalBreakdown | null;
  reasoning?: string | null;
}

export interface StatsResponse {
  sanctions_count: number;
  index_size: number;
  model_loaded: boolean;
  threshold: number;
  total_screenings: number;
  decision_distribution: Record<string, number>;
  avg_processing_time_ms: number;
}

export interface BatchCustomerResult {
  query_name: string;
  query_dob?: string | null;
  query_country?: string | null;
  decision: Decision;
  top_match_score?: number | null;
  top_match_name?: string | null;
  top_match_dob?: string | null;
  top_match_country?: string | null;
  top_match_program?: string | null;
  top_match_reason?: string | null;
  sanctions_id?: string | null;
  llm_reasoning?: string | null;
  llm_confidence?: number | null;
  llm_evidence?: LLMEvidence | null;
  llm_matched_entity?: string | null;
  processing_time_ms?: number | null;
  layer_reached: number;
  signal_breakdown?: SignalBreakdown | null;
  reasoning?: string | null;
}

export interface BatchScreenResponse {
  results: BatchCustomerResult[];
  summary: {
    total: number;
    auto_cleared: number;
    escalated: number;
    needs_review: number;
    processing_time_ms: number;
  };
}

export interface SanctionsEntry {
  sanction_id: string;
  full_name: string;
  alias_1?: string | null;
  alias_2?: string | null;
  date_of_birth?: string | null;
  nationality?: string | null;
  passport_number?: string | null;
  sanctions_program?: string | null;
  reason_for_listing?: string | null;
}

// --- API client ---

class ApiError extends Error {
  constructor(
    public endpoint: string,
    public status: number,
    message: string,
  ) {
    super(`${endpoint} failed (${status}): ${message}`);
    this.name = "ApiError";
  }
}

async function request<T>(
  endpoint: string,
  options?: RequestInit,
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...authHeaders(), ...(options?.headers || {}) },
  });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch {
      // ignore parse errors
    }
    throw new ApiError(endpoint, res.status, detail);
  }

  return res.json() as Promise<T>;
}

export async function screenCustomer(
  req: ScreenRequest,
): Promise<ScreenResult> {
  return request<ScreenResult>("/api/screen", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

// --- Streaming screen (layer-by-layer SSE) ---

export interface LayerEvent {
  layer: number;
  status: "running" | "done" | "error";
  label: string;
  ms?: number;
  matches?: number;
  decision?: string;
  reasoning?: string;
}

export function screenStream(
  req: ScreenRequest,
  onLayer: (evt: LayerEvent) => void,
  onResult: (result: ScreenResult) => void,
  onError: (err: Error) => void,
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/screen-stream`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`Screen stream failed: ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const lines = buf.split("\n");
        buf = lines.pop() || "";

        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            if (eventType === "layer") onLayer(data as LayerEvent);
            else if (eventType === "result") onResult(data as ScreenResult);
          }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") onError(err);
    }
  })();

  return controller;
}

export async function getStats(): Promise<StatsResponse> {
  return request<StatsResponse>("/api/stats");
}

export async function batchScreen(
  req: BatchScreenRequest,
): Promise<BatchScreenResponse> {
  return request<BatchScreenResponse>("/api/batch-screen", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function getSanctions(): Promise<SanctionsEntry[]> {
  return request<SanctionsEntry[]>("/api/sanctions");
}

// --- Sanctions management ---

export interface SanctionsAddRequest {
  sanction_id: string;
  full_name: string;
  alias_1?: string;
  alias_2?: string;
  date_of_birth?: string;
  nationality?: string;
  passport_number?: string;
  sanctions_program?: string;
  reason_for_listing?: string;
}

export interface SanctionsAddResponse {
  message: string;
  sanction_id: string;
  vectors_added: number;
}

export async function addSanction(
  req: SanctionsAddRequest,
): Promise<SanctionsAddResponse> {
  return request<SanctionsAddResponse>("/api/sanctions/add", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

// --- Sanctions sets ---

export interface SanctionsSet {
  id: string;
  label: string;
  customers_label: string;
  available: boolean;
  customers_available: boolean;
  active: boolean;
}

export async function getSanctionsSets(): Promise<SanctionsSet[]> {
  return request<SanctionsSet[]>("/api/sanctions/sets");
}

export async function switchSanctionsSet(setId: string): Promise<{
  status: string; set_id: string; label: string;
  sanctions_count: number; index_size: number; load_time_s: number;
}> {
  return request("/api/sanctions/switch", {
    method: "POST",
    body: JSON.stringify({ set_id: setId }),
  });
}

// --- Streaming batch screen via SSE ---

export interface StreamEvent {
  type: "init" | "result" | "llm_update" | "done" | "error";
  data: any;
}

/**
 * Stream batch screening results via Server-Sent Events.
 * Calls onEvent for each SSE event as it arrives.
 * Returns an AbortController so the caller can cancel.
 */
export function batchScreenStream(
  req: BatchScreenRequest,
  onEvent: (event: StreamEvent) => void,
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/batch-screen-stream`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(req),
        signal: controller.signal,
      });

      if (!res.ok) {
        onEvent({ type: "error", data: { message: `HTTP ${res.status}` } });
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let currentEvent = "";
        let currentData = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6).trim();
          } else if (line === "" && currentEvent && currentData) {
            try {
              onEvent({
                type: currentEvent as StreamEvent["type"],
                data: JSON.parse(currentData),
              });
            } catch {
              // skip malformed
            }
            currentEvent = "";
            currentData = "";
          }
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        onEvent({
          type: "error",
          data: { message: err?.message || "Stream failed" },
        });
      }
    }
  })();

  return controller;
}

// --- Benchmark ---

export interface BenchmarkResult {
  sample_size: number;
  elapsed_s: number;
  use_embedding: boolean;
  confusion_matrix: { tp: number; fp: number; fn: number; tn: number };
  precision: number;
  recall: number;
  f1: number;
  alert_rate: number;
  tp_rules: Record<string, number>;
  fn_examples: Array<{
    name_a: string; name_b: string;
    jw: number; phonetic: number; embedding: number;
    dob: number; country: number;
  }>;
  fp_examples: Array<{
    name_a: string; name_b: string;
    jw: number; phonetic: number; embedding: number;
    dob: number; country: number;
    rule: string;
  }>;
}

export async function runBenchmark(sampleSize = 5000): Promise<BenchmarkResult> {
  const res = await fetch(`${API_BASE}/api/benchmark`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ sample_size: sampleSize }),
  });
  if (!res.ok) throw new Error(`Benchmark failed: ${res.status}`);
  return res.json();
}

// --- Pipeline types ---

export interface PairPreviewClient {
  first_name: string;
  last_name: string;
  birth_date?: string | null;
  country?: string | null;
}

export interface PairPreviewSanction {
  id: string;
  name: string;
  aliases: string[];
  birth_date?: string | null;
  country?: string | null;
}

export interface PairPreview {
  pair_id: number;
  client: PairPreviewClient;
  sanction: PairPreviewSanction;
}

export interface PipelineStartResponse {
  client_count: number;
  sanction_count: number;
  index_size: number;
  use_hnsw: boolean;
  load_time_s: number;
  injected_pairs?: number;
}

export interface PipelineConfusionMatrix {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  accuracy: number;
  total: number;
}

export interface PipelineLayerEvent {
  type: "progress" | "layer_complete" | "llm_result" | "error";
  data: {
    processed?: number;
    total?: number;
    percent?: number;
    phase?: string;
    layer?: number;
    stats?: Record<string, any>;
    confusion_matrix?: PipelineConfusionMatrix;
    message?: string;
    // llm_result fields
    client_name?: string;
    decision?: string;
    confidence?: number;
    reasoning?: string;
    matched_entity?: string;
    match_score?: number;
    is_true_positive?: boolean;
  };
}

// --- Pipeline API functions ---

export async function getPipelineDatasets(): Promise<{ sanctions: string[]; clients: string[] }> {
  const res = await fetch(`${API_BASE}/api/pipeline/datasets`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to load datasets");
  return res.json();
}

export async function getPairsPreview(count: number): Promise<{ pairs: PairPreview[]; valid_pool_size: number }> {
  const res = await fetch(`${API_BASE}/api/pipeline/pairs-preview?count=${count}`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to load pairs preview");
  return res.json();
}

export async function pipelineStart(
  clientsCsv?: string,
  sanctionsCsv?: string,
  injectedPairs?: PairPreview[],
): Promise<PipelineStartResponse> {
  const res = await fetch(`${API_BASE}/api/pipeline/start`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      clients_csv: clientsCsv,
      sanctions_csv: sanctionsCsv,
      injected_pairs: injectedPairs,
    }),
  });
  if (!res.ok) throw new Error(`Pipeline start failed: ${res.status}`);
  return res.json();
}

export function pipelineRunLayer(
  layerNum: number,
  onEvent: (event: PipelineLayerEvent) => void,
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/pipeline/layer/${layerNum}`, {
        method: "POST",
        headers: authHeaders(),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        let detail = `Layer ${layerNum} failed: ${res.status}`;
        try {
          const body = await res.json();
          if (body.detail) detail = body.detail;
        } catch { /* ignore */ }
        onEvent({ type: "error", data: { message: detail } });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let currentEvent = "";
        let currentData = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6).trim();
          } else if (line === "" && currentEvent && currentData) {
            try {
              const parsed = JSON.parse(currentData);
              onEvent({ type: currentEvent as any, data: parsed });
            } catch { /* skip */ }
            currentEvent = "";
            currentData = "";
          }
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        onEvent({ type: "error", data: { message: err?.message || "Stream failed" } });
      }
    }
  })();

  return controller;
}

export interface PipelineClient {
  index: number;
  name: string;
  dob: string | null;
  country: string | null;
  is_tp: boolean;
  decision: string | null;
  score: number | null;
  match_name: string | null;
  match_id: string | null;
  match_dob?: string | null;
  match_country?: string | null;
  match_program?: string | null;
  match_reason?: string | null;
  layer_reached?: number | null;
  reasoning?: string | null;
  signal_breakdown?: SignalBreakdown | null;
  llm_reasoning?: string | null;
  llm_confidence?: number | null;
  llm_evidence?: Record<string, string> | null;
  llm_matched_entity?: string | null;
}

export interface PipelineClientsPage {
  items: PipelineClient[];
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
}

export async function getPipelineClients(offset = 0, limit = 100, filter = "all"): Promise<PipelineClientsPage> {
  const res = await fetch(`${API_BASE}/api/pipeline/clients?offset=${offset}&limit=${limit}&filter=${filter}`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to load pipeline clients");
  return res.json();
}
