import { METRICS, type MetricSet, type Rules, type Run, type Span } from "./types.js";

function invalid(field: string): never { throw new Error(`Invalid ${field}`); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.length || value.length > 1024 || value.includes("\0")) invalid(field);
  return value;
}
function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(field);
  return value;
}
function status(value: unknown): Run["status"] {
  if (value !== "ok" && value !== "error" && value !== "incomplete") invalid("status");
  return value;
}
export function relativePath(value: unknown): string {
  const result = text(value, "relative evidence path");
  if (result.includes("\\") || result.includes(":") || result.includes("%") || result.startsWith("/") || result.split("/").some(p => !p || p === "." || p === "..")) invalid("relative evidence path");
  return result;
}
function metrics(value: unknown): MetricSet {
  if (value === undefined) return {};
  const raw = object(value, "metrics"), result: MetricSet = {};
  for (const key of Object.keys(raw)) {
    if (!(METRICS as readonly string[]).includes(key)) invalid("metric name");
    const item = object(raw[key], "metric"), coverage = item.coverage;
    if (coverage !== "complete" && coverage !== "partial" && coverage !== "unknown") invalid("metric coverage");
    const amount = item.value === null ? null : number(item.value, "metric value");
    if (coverage === "complete" && amount === null) invalid("complete metric value");
    result[key as typeof METRICS[number]] = { value: amount, source: text(item.source, "metric source"), coverage };
  }
  return result;
}
export function parseRun(value: unknown): Run {
  const raw = object(value, "run");
  if (raw.schema_version !== 1) invalid("schema_version");
  if (typeof raw.spans_complete !== "boolean") invalid("spans_complete");
  if (!Array.isArray(raw.spans) || raw.spans.length > 10000) invalid("spans (limit 10000 per run)");
  const spans: Span[] = raw.spans.map(value => {
    const s = object(value, "span"), kind = s.kind;
    if (kind !== "agent" && kind !== "tool" && kind !== "llm" && kind !== "step") invalid("span kind");
    const start = number(s.start_ms, "span start"), end = s.end_ms === null ? null : number(s.end_ms, "span end");
    if (end !== null && end < start) invalid("span interval");
    return { id: text(s.id, "span id"), ...(s.parent_id === undefined ? {} : { parent_id: text(s.parent_id, "parent_id") }),
      name: text(s.name, "span name"), kind, start_ms: start, end_ms: end, status: status(s.status), metrics: metrics(s.metrics) };
  });
  const ids = new Map(spans.map(span => [span.id, span]));
  if (ids.size !== spans.length) invalid("duplicate span id");
  const completed = new Set<string>();
  for (const span of spans) {
    const visited = new Set<string>();
    let current: Span | undefined = span;
    while (current && !completed.has(current.id)) {
      if (visited.has(current.id)) invalid("cyclic span parents");
      visited.add(current.id);
      if (current.parent_id && !ids.has(current.parent_id)) invalid("missing span parent");
      current = current.parent_id ? ids.get(current.parent_id) : undefined;
    }
    for (const id of visited) completed.add(id);
  }
  const run: Run = { schema_version: 1, case_id: text(raw.case_id, "case_id"), repeat_id: text(raw.repeat_id, "repeat_id"),
    status: status(raw.status), spans_complete: raw.spans_complete, production: metrics(raw.production), evaluation: metrics(raw.evaluation), spans };
  if (raw.evidence !== undefined) {
    const evidence = object(raw.evidence, "evidence");
    if (!Array.isArray(evidence.files) || evidence.files.length > 20) invalid("evidence files (limit 20)");
    run.evidence = { directory: relativePath(evidence.directory), files: evidence.files.map(value => {
      const item = object(value, "evidence file");
      return { path: relativePath(item.path), ...(item.label === undefined ? {} : { label: text(item.label, "evidence label") }) };
    }) };
    if (new Set(run.evidence.files.map(f => f.path)).size !== run.evidence.files.length) invalid("duplicate evidence path");
  }
  return run;
}
export function parseJsonl(input: string): Run[] {
  const lines = input.replace(/^\uFEFF/, "").split(/\r?\n/), runs: Run[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    let raw: unknown;
    try { raw = JSON.parse(lines[index]); } catch { throw new Error(`Invalid JSON at line ${index + 1}`); }
    try { runs.push(parseRun(raw)); } catch (error) { throw new Error(`Line ${index + 1}: ${(error as Error).message}`); }
    if (runs.length > 10000) invalid("run count (limit 10000)");
  }
  if (!runs.length) invalid("empty trace set");
  return runs;
}
export function parseRules(input: unknown): Rules {
  const raw = object(input, "rules");
  if (raw.schema_version !== 1) invalid("rule schema_version");
  if (raw.require_status !== "ok" && raw.require_status !== null) invalid("require_status");
  if (!Array.isArray(raw.required_tools) || raw.required_tools.length > 1000) invalid("required_tools");
  const max = object(raw.max_tool_calls, "max_tool_calls"), counts: Record<string, number> = Object.create(null);
  for (const [key, value] of Object.entries(max)) {
    text(key, "tool name"); const count = number(value, "max tool count");
    if (!Number.isSafeInteger(count)) invalid("max tool count");
    counts[key] = count;
  }
  const budgets = object(raw.budgets, "budgets");
  const out: Rules["budgets"] = { production: {}, evaluation: {} };
  for (const domain of ["production", "evaluation"] as const) {
    for (const [key, value] of Object.entries(object(budgets[domain], "metric budgets"))) {
      if (!(METRICS as readonly string[]).includes(key)) invalid("budget metric");
      out[domain][key as typeof METRICS[number]] = number(value, "budget");
    }
  }
  return { schema_version: 1, require_status: raw.require_status, required_tools: [...new Set(raw.required_tools.map(t => text(t, "required tool")))], max_tool_calls: counts, budgets: out };
}
