import type { Check, CheckedPair, Metric, Pair, Report, Rules, Run } from "./types.js";
export const defaultRules: Rules = { schema_version: 1, require_status: "ok", required_tools: [], max_tool_calls: {}, budgets: { production: {}, evaluation: {} } };
export function pairRuns(baseline: Run[], candidate: Run[]): Pair[] {
  const pairs = new Map<string, Pair>();
  for (const [side, runs] of [["baseline", baseline], ["candidate", candidate]] as const) for (const run of runs) {
    const key = JSON.stringify([run.case_id, run.repeat_id]);
    const pair = pairs.get(key) ?? { case_id: run.case_id, repeat_id: run.repeat_id, state: "matched", baseline: [], candidate: [] };
    pair[side].push(run); pairs.set(key, pair);
  }
  for (const pair of pairs.values()) pair.state = pair.baseline.length > 1 || pair.candidate.length > 1 ? "ambiguous" : !pair.baseline.length ? "missing_baseline" : !pair.candidate.length ? "missing_candidate" : "matched";
  return [...pairs.values()].sort((a,b) => a.case_id < b.case_id ? -1 : a.case_id > b.case_id ? 1 : a.repeat_id < b.repeat_id ? -1 : a.repeat_id > b.repeat_id ? 1 : 0);
}
export function toolCounts(run: Run): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  for (const span of run.spans) if (span.kind === "tool") counts[span.name] = (counts[span.name] ?? 0) + 1;
  return counts;
}
export function metricDelta(baseline?: Metric, candidate?: Metric): number | null {
  return baseline?.coverage === "complete" && candidate?.coverage === "complete" && baseline.value !== null && candidate.value !== null ? candidate.value - baseline.value : null;
}
export function checkPair(pair: Pair, rules: Rules): CheckedPair {
  const checks: Check[] = [];
  if (pair.state !== "matched") checks.push({ rule: "pairing", status: "unknown", message: pair.state.replaceAll("_", " ") + "; no automatic match" });
  else {
    const run = pair.candidate[0], counts = toolCounts(run);
    if (rules.require_status) checks.push({ rule: "status", status: run.status === "incomplete" ? "unknown" : run.status === "ok" ? "pass" : "fail", message: `Candidate status: ${run.status}` });
    for (const name of rules.required_tools) checks.push({ rule: `required tool: ${name}`, status: counts[name] ? "pass" : run.spans_complete ? "fail" : "unknown", message: counts[name] ? `${counts[name]} observed call(s)` : run.spans_complete ? "Tool absent" : "Trace incomplete; absence cannot be confirmed" });
    for (const [name, limit] of Object.entries(rules.max_tool_calls)) {
      const count = counts[name] ?? 0;
      checks.push({ rule: `max calls: ${name}`, status: count > limit ? "fail" : run.spans_complete ? "pass" : "unknown", message: `${count} observed, limit ${limit}${run.spans_complete ? "" : "; trace incomplete"}` });
    }
    for (const domain of ["production", "evaluation"] as const) for (const [key, limit] of Object.entries(rules.budgets[domain])) {
      const metric = run[domain][key as keyof typeof run.production];
      const known = metric?.value !== null && metric?.value !== undefined;
      const status = known && metric!.coverage !== "unknown" && metric!.value! > limit ? "fail" : known && metric!.coverage === "complete" ? "pass" : "unknown";
      checks.push({ rule: `${domain}.${key}`, status, message: `${known ? metric!.value : "Unknown"}, limit ${limit}; ${metric?.coverage ?? "unknown"} coverage` });
    }
  }
  return { ...pair, checks, verdict: checks.some(c => c.status === "fail") ? "fail" : checks.some(c => c.status === "unknown") ? "unknown" : "pass" };
}
export function compare(baseline: Run[], candidate: Run[], rules: Rules = defaultRules): Report {
  const pairs = pairRuns(baseline, candidate).map(p => checkPair(p, rules));
  const summary = { pairs: pairs.length, passed: pairs.filter(p=>p.verdict === "pass").length, failed: pairs.filter(p=>p.verdict === "fail").length, unresolved: pairs.filter(p=>p.checks.some(c=>c.status === "unknown")).length, unknown_checks: pairs.reduce((sum,p)=>sum+p.checks.filter(c=>c.status === "unknown").length,0) };
  return { schema_version: 1, rules, pairs, summary, exit_code: summary.unresolved ? 2 : summary.failed ? 1 : 0 };
}
