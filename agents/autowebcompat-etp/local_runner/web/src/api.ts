// Types and client for the FastAPI endpoints in ../server.py.

export type RunStatus =
  | "queued"
  | "running"
  | "ok"
  | "error"
  | "cancelled"
  | "interrupted";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface RunOptions {
  model: string | null;
  effort: Effort | null;
  max_turns: number | null;
  headless: boolean;
  build: boolean;
}

export interface RunParams extends Partial<RunOptions> {
  bug_id?: number | null;
  bug_data?: string | null;
}

export interface RunInfo {
  run_id: string;
  params: RunParams;
  status: RunStatus;
  queued?: number | null;
  started: number | null;
  finished: number | null;
  turns: number | null;
  cost: number | null;
  active: boolean;
  applied?: boolean;
}

export interface Config {
  artifacts_root: string;
  bugzilla: string;
  env_file: string | null;
  has_anthropic_key: boolean;
  has_bugzilla_key: boolean;
  max_parallel: number;
  untriaged_url: string;
}

export interface ProposedException {
  category: "baseline" | "convenience";
  urlPattern: string;
  topLevelUrlPattern: string | null;
  classifierFeatures: string[];
  rationale: string;
}

export interface ProposedShim {
  kind: "opt_in_placeholder" | "stub";
  name: string;
  matches: string[];
  unblocksOnOptIn: string[];
  behavior: string;
  existing_shim_id: string | null;
  rationale: string;
}

export interface EtpResult {
  summary: string;
  failure_reason: string | null;
  broken_in_standard: boolean | null;
  broken_in_strict: boolean | null;
  broken_with_easyprivacy?: boolean | null;
  broken_with_easylist?: boolean | null;
  culprit_prefs: string[];
  blocked_resources: string[];
  proposed_exceptions: ProposedException[];
  proposed_shim: ProposedShim | null;
  exception_verified: boolean;
  severity: "S1" | "S2" | "S3" | "S4" | null;
  priority: "P1" | "P2" | "P3" | null;
  steps: string;
  exception_records: Record<string, unknown>[];
  whiteboard_tags: string[];
  user_story_lines: string[];
  existing_exceptions: Record<string, unknown>[] | null;
  existing_shims: Record<string, unknown>[] | null;
  screenshot_urls: Record<string, string>;
}

export interface Summary {
  status: "ok" | "error";
  error: string | null;
  findings: {
    result?: EtpResult;
    num_turns?: number;
    total_cost_usd?: number;
    traceback?: string;
  };
}

export interface AppliedAction {
  action: string;
  stage?: string;
  stages?: string[];
  fields?: string[];
  ids?: number[];
  with_comment?: boolean;
}

export interface Applied {
  applied_at: string;
  bug_id: number;
  url: string;
  actions: AppliedAction[];
  error: string | null;
}

export interface Draft {
  bug_id: number | null;
  comment: string;
  changes: Record<string, unknown>;
  attachments: string[];
}

export interface Review {
  summary: Summary;
  result: EtpResult | null;
  screenshots: Record<string, string>;
  screenshot_labels: Record<string, string>;
  has_agent_log: boolean;
  applied: Applied | null;
  draft: Draft;
}

export interface UntriagedBug {
  id: number;
  summary: string;
  creation_time: string;
  url: string;
  status: string;
  whiteboard: string;
  runs: { run_id: string; status: RunStatus }[];
}

export interface ApplyRequest {
  bug_id: number;
  comment: string;
  changes: Record<string, unknown>;
  attachments: string[];
  force: boolean;
}

export interface WhoAmI {
  name: string;
  real_name?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.detail ?? body;
    throw new Error(
      typeof detail === "string" ? detail : JSON.stringify(detail)
    );
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const runPath = (runId: string) => `/api/runs/${encodeURIComponent(runId)}`;

export const api = {
  config: () => request<Config>("/api/config"),
  whoami: () => request<WhoAmI>("/api/whoami"),
  runs: () => request<RunInfo[]>("/api/runs"),
  startRun: (params: RunParams) => post<RunInfo>("/api/runs", params),
  startBatch: (body: RunOptions & { bug_ids: number[] }) =>
    post<RunInfo[]>("/api/runs/batch", body),
  cancel: (runId: string) => post<RunInfo>(`${runPath(runId)}/cancel`),
  review: (runId: string) => request<Review>(`${runPath(runId)}/review`),
  apply: (runId: string, body: ApplyRequest) =>
    post<Applied>(`${runPath(runId)}/apply`, body),
  untriaged: () => request<UntriagedBug[]>("/api/untriaged"),
  streamUrl: (runId: string) => `${runPath(runId)}/stream`,
  fileUrl: (runId: string, key: string) => `${runPath(runId)}/files/${key}`,
};
