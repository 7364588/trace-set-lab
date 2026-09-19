export const METRICS = ["latency_ms", "input_tokens", "output_tokens", "cost_usd"] as const;
export type MetricName = typeof METRICS[number];
export interface Metric { value: number | null; source: string; coverage: "complete" | "partial" | "unknown" }
export type MetricSet = Partial<Record<MetricName, Metric>>;
export interface Span {
  id: string; parent_id?: string; name: string; kind: "agent" | "tool" | "llm" | "step";
  start_ms: number; end_ms: number | null; status: "ok" | "error" | "incomplete"; metrics?: MetricSet;
}
export interface Attachment { path: string; label: string; text: string }
export interface Run {
  schema_version: 1; case_id: string; repeat_id: string; status: "ok" | "error" | "incomplete";
  spans_complete: boolean; production: MetricSet; evaluation: MetricSet; spans: Span[];
  evidence?: { directory: string; files: { path: string; label?: string }[] };
  attachments?: Attachment[];
}
export interface Rules {
  schema_version: 1; require_status: "ok" | null; required_tools: string[];
  max_tool_calls: Record<string, number>;
  budgets: { production: Partial<Record<MetricName, number>>; evaluation: Partial<Record<MetricName, number>> };
}
export interface Check { rule: string; status: "pass" | "fail" | "unknown"; message: string }
export interface Pair {
  case_id: string; repeat_id: string;
  state: "matched" | "missing_baseline" | "missing_candidate" | "ambiguous";
  baseline: Run[]; candidate: Run[];
}
export interface CheckedPair extends Pair { checks: Check[]; verdict: "pass" | "fail" | "unknown" }
export interface Report {
  schema_version: 1; rules: Rules; pairs: CheckedPair[]; exit_code: 0 | 1 | 2;
  summary: { pairs: number; passed: number; failed: number; unresolved: number; unknown_checks: number };
}
