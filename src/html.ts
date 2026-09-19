import { createHash } from "node:crypto";
import { checkPair, toolCounts, metricDelta } from "./core.js";
import { parseRules } from "./parse.js";
import type { Report, Pair, Rules, Run, MetricName, Span } from "./types.js";

function browserApp(initial: Report): void {
  const $ = (id: string) => document.getElementById(id)!;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node;
  };
  const names: MetricName[] = ["latency_ms", "input_tokens", "output_tokens", "cost_usd"];
  let pairs = initial.pairs, rules = initial.rules, selected = 0;
  const fmt = (n: number | null | undefined, key?: string) => n === null || n === undefined ? "Unknown" : key === "cost_usd" ? "$" + n.toFixed(4) : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const badge = (text: string, state = text) => el("span", text, "badge " + state);
  function download(name: string, text: string, type: string): void {
    const url = URL.createObjectURL(new Blob([text], { type })); const link = el("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function renderStats(): void {
    $("stat-pairs").textContent = String(pairs.length);
    for (const state of ["pass", "fail", "unknown"]) $("stat-" + state).textContent = String(pairs.filter(p => state === "unknown" ? p.checks.some(c=>c.status === "unknown") : p.verdict === state).length);
    $("rule-count").textContent = String((rules.require_status ? 1 : 0) + rules.required_tools.length + Object.keys(rules.max_tool_calls).length + Object.keys(rules.budgets.production).length + Object.keys(rules.budgets.evaluation).length);
  }
  function renderMatrix(): void {
    const list = $("matrix-body"); list.replaceChildren();
    const query = ($("search") as HTMLInputElement).value.toLowerCase();
    const filter = ($("filter") as HTMLSelectElement).value;
    let visible = 0;
    pairs.forEach((pair, index) => {
      if (!(pair.case_id + " " + pair.repeat_id).toLowerCase().includes(query) || (filter !== "all" && (filter === "unknown" ? !pair.checks.some(c=>c.status === "unknown") : pair.verdict !== filter))) return;
      visible++;
      const tr = el("tr", undefined, index === selected ? "selected" : "");
      const id = el("td"), button = el("button", pair.case_id, "case-button"); button.addEventListener("click", () => { selected = index; renderMatrix(); renderDetail(); }); id.append(button, el("small", "repeat " + pair.repeat_id));
      const state = el("td"); state.append(badge(pair.verdict === "unknown" ? "unresolved" : pair.verdict, pair.verdict));
      if (pair.verdict === "fail" && pair.checks.some(c=>c.status === "unknown")) state.append(el("small", "also unresolved"));
      tr.append(id, state);
      const base = pair.baseline.length === 1 ? pair.baseline[0] : undefined, next = pair.candidate.length === 1 ? pair.candidate[0] : undefined;
      for (const key of ["latency_ms", "cost_usd"] as MetricName[]) {
        const td = el("td"), metric = next?.production[key]; td.append(el("div", fmt(metric?.value, key), "numeric"));
        const delta = pair.state === "matched" ? metricDelta(base?.production[key], metric) : null;
        td.append(el("small", delta === null ? "Δ unknown" : "Δ " + (delta > 0 ? "+" : "") + fmt(delta, key), delta !== null && delta > 0 ? "worse" : "")); tr.append(td);
      }
      list.append(tr);
    });
    $("shown-count").textContent = `${visible} of ${pairs.length} pairs`;
    if (!visible) { const row = el("tr"), cell = el("td", "No matching cases. Clear the search or change the filter."); cell.colSpan = 4; row.append(cell); list.append(row); }
  }
  function renderTimeline(run: Run | undefined, container: HTMLElement, title: string, extent: number): void {
    container.replaceChildren();
    const header = el("div", undefined, "run-heading"); header.append(el("h3", title), badge(run?.status ?? "missing", run?.status === "ok" ? "pass" : run?.status === "error" ? "fail" : "unknown")); container.append(header);
    if (!run) { container.append(el("p", "No unique run available for this side.", "muted")); return; }
    container.append(el("p", run.spans_complete ? "Complete span list · same time scale on both sides" : "Partial span list · absence is not proof", "caption"));
    const byParent = new Map<string, Span[]>();
    for (const span of run.spans) { const key = span.parent_id ?? ""; byParent.set(key, [...(byParent.get(key) ?? []), span]); }
    for (const list of byParent.values()) list.sort((a,b)=>a.start_ms-b.start_ms);
    const stack = (byParent.get("") ?? []).slice().reverse().map(span=>({ span, depth: 0 }));
    while (stack.length) {
      const { span, depth } = stack.pop()!;
      const row = el("button", undefined, "span-row"); row.type = "button"; row.style.paddingLeft = `${10 + Math.min(depth, 15) * 12}px`;
      const label = el("div", undefined, "span-label"); label.append(el("span", span.kind, "kind " + span.kind), el("span", span.name, "span-name"), el("span", span.end_ms === null ? "open" : fmt(span.end_ms - span.start_ms) + " ms", "span-duration"));
      const track = el("div", undefined, "track"), bar = el("div", undefined, "bar " + span.kind + (span.status === "error" ? " error" : ""));
      bar.style.marginLeft = `${Math.max(0, span.start_ms / extent * 100)}%`; bar.style.width = `${Math.max(.6, ((span.end_ms ?? span.start_ms) - span.start_ms) / extent * 100)}%`; track.append(bar); row.append(label, track);
      row.addEventListener("click", () => { $("span-detail").textContent = JSON.stringify(span, null, 2); ($("span-dialog") as HTMLDialogElement).showModal(); });
      container.append(row);
      for (const child of (byParent.get(span.id) ?? []).slice().reverse()) stack.push({ span: child, depth: depth + 1 });
    }
    if (!run.spans.length) container.append(el("p", "No recorded spans.", "muted"));
  }
  function renderDetail(): void {
    const pair = pairs[selected]; if (!pair) return;
    $("case-title").textContent = pair.case_id; $("case-repeat").textContent = "REPEAT " + pair.repeat_id;
    const alignment = $("alignment"); alignment.replaceChildren();
    alignment.append(badge(pair.state.replaceAll("_", " "), pair.state === "matched" ? "pass" : "unknown"));
    alignment.append(el("span", `${pair.baseline.length} baseline / ${pair.candidate.length} candidate record(s)`, "caption"));
    const base = pair.baseline.length === 1 ? pair.baseline[0] : undefined, next = pair.candidate.length === 1 ? pair.candidate[0] : undefined;
    const findings = $("checks"); findings.replaceChildren();
    for (const check of pair.checks) { const line = el("div", undefined, "check"); line.append(badge(check.status), el("strong", check.rule), el("span", check.message)); findings.append(line); }
    if (!pair.checks.length) findings.append(el("p", "No rules selected. Pairing is still checked.", "muted"));
    const domain = ($("metric-domain") as HTMLSelectElement).value as "production" | "evaluation";
    const metrics = $("metrics"); metrics.replaceChildren();
    for (const key of names) {
      const card = el("div", undefined, "metric-card"); card.append(el("h4", key.replaceAll("_", " ")));
      for (const [label, run] of [["Baseline", base], ["Candidate", next]] as const) {
        const metric = run?.[domain][key]; const line = el("div", undefined, "metric-line"); line.append(el("span", label), el("strong", fmt(metric?.value, key))); card.append(line);
        card.append(el("small", metric ? `${metric.coverage} · ${metric.source}` : "unknown · not supplied", "source"));
      }
      const delta = pair.state === "matched" ? metricDelta(base?.[domain][key], next?.[domain][key]) : null;
      card.append(el("div", delta === null ? "Δ unknown — requires complete data" : "Δ " + (delta > 0 ? "+" : "") + fmt(delta, key), "delta")); metrics.append(card);
    }
    const extent = Math.max(1, ...[...(base?.spans ?? []), ...(next?.spans ?? [])].map(s=>s.end_ms ?? s.start_ms));
    renderTimeline(base, $("baseline-timeline"), "Baseline", extent); renderTimeline(next, $("candidate-timeline"), "Candidate", extent);
    const tools = $("tools"); tools.replaceChildren();
    const a = base ? toolCounts(base) : {}, b = next ? toolCounts(next) : {};
    const toolNames = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const name of toolNames) {
      const line = el("div", undefined, "tool-line"); const before = base ? a[name] ?? 0 : null, after = next ? b[name] ?? 0 : null;
      const label = !base || !next || !base.spans_complete || !next.spans_complete ? "partial / unpaired" : before === 0 ? "added" : after === 0 ? "removed" : before !== after ? "count changed" : "unchanged";
      line.append(el("code", name), el("span", `${before ?? "?"} → ${after ?? "?"}`), badge(label, label === "unchanged" ? "pass" : "unknown")); tools.append(line);
    }
    if (!toolNames.length) tools.append(el("p", "No observed tool calls.", "muted"));
    const evidence = $("evidence"); evidence.replaceChildren();
    for (const [label, run] of [["Baseline", base], ["Candidate", next]] as const) {
      const section = el("div"); section.append(el("h4", label));
      for (const attachment of run?.attachments ?? []) { const details = el("details"), summary = el("summary", attachment.label); details.append(summary, el("small", attachment.path), el("pre", attachment.text)); section.append(details); }
      if (!run?.attachments?.length) section.append(el("p", run?.evidence?.files.length ? "Manifest present; contents were not included. Run CLI with --evidence to include explicit attachments." : "No explicit attachments.", "muted")); evidence.append(section);
    }
  }
  $("search").addEventListener("input", renderMatrix); $("filter").addEventListener("change", renderMatrix); $("metric-domain").addEventListener("change", renderDetail);
  $("rules-toggle").addEventListener("click", () => { ($("rules-json") as HTMLTextAreaElement).value = JSON.stringify(rules, null, 2); $("rules-error").textContent = ""; ($("rules-dialog") as HTMLDialogElement).showModal(); });
  $("rules-apply").addEventListener("click", () => {
    try {
      rules = parseRules(JSON.parse(($("rules-json") as HTMLTextAreaElement).value));
      pairs = initial.pairs.map(pair=>checkPair(pair, rules)); renderStats(); renderMatrix(); renderDetail(); ($("rules-dialog") as HTMLDialogElement).close();
      $("session-note").textContent = "Rules changed in this browser session. Download rules to reproduce these checks in CI.";
    } catch { $("rules-error").textContent = "Invalid rules. Use schema_version 1, explicit status/tools, and nonnegative numeric limits."; }
  });
  $("rules-download").addEventListener("click", ()=>download("trace-set-rules.json", JSON.stringify(rules, null, 2) + "\n", "application/json"));
  $("report-download").addEventListener("click", ()=>{
    const summary = { pairs: pairs.length, passed: pairs.filter(p=>p.verdict === "pass").length, failed: pairs.filter(p=>p.verdict === "fail").length, unresolved: pairs.filter(p=>p.checks.some(c=>c.status === "unknown")).length, unknown_checks: pairs.reduce((sum,p)=>sum+p.checks.filter(c=>c.status === "unknown").length,0) };
    download("trace-comparison.json", JSON.stringify({ schema_version: 1, rules, pairs, summary, exit_code: summary.unresolved ? 2 : summary.failed ? 1 : 0 }, null, 2), "application/json");
  });
  for (const node of document.querySelectorAll<HTMLButtonElement>("[data-close]")) node.addEventListener("click", ()=>(node.closest("dialog") as HTMLDialogElement).close());
  renderStats(); renderMatrix(); renderDetail();
}

// These parser helpers are deliberately embedded with parseRules: the report
// uses the exact same validation and evaluation code as the library and CLI.
function ruleParserSource(): string {
  return `const METRICS=["latency_ms","input_tokens","output_tokens","cost_usd"];
function invalid(field){throw new Error("Invalid "+field)}
function object(value,field){if(!value||typeof value!=="object"||Array.isArray(value))invalid(field);return value}
function text(value,field){if(typeof value!=="string"||!value.length||value.length>1024||value.includes("\\0"))invalid(field);return value}
function number(value,field){if(typeof value!=="number"||!Number.isFinite(value)||value<0)invalid(field);return value}
const parseRules=${parseRules.toString()};`;
}
export function renderHtml(report: Report): string {
  const data = JSON.stringify(report).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  const script = `${ruleParserSource()}\nconst toolCounts=${toolCounts.toString()};\nconst metricDelta=${metricDelta.toString()};\nconst checkPair=${checkPair.toString()};\n(${browserApp.toString()})(${data});`.replace(/\r\n?/g, "\n");
  const digest = createHash("sha256").update(script).digest("base64");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${digest}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>Trace Set Lab · Run comparison</title><style>${css}</style></head><body>
<header><a class="brand" href="#"><span class="mark">≋</span> Trace Set Lab</a><div class="header-right"><span class="offline">● OFFLINE REPORT</span><button id="report-download">Export JSON ↓</button><button id="rules-toggle" class="primary">Edit rules <span id="rule-count"></span></button></div></header>
<main><div class="intro"><div><div class="eyebrow">RECORDED RUNS / REGRESSION WORKBENCH</div><h1>What changed between runs?</h1><p>Compare the evidence. Keep the original measurements.</p></div><div class="intro-note">No model calls. No uploads.<br>Explicit cases, explicit uncertainty.</div></div>
<section class="stats"><article><span>CASE / REPEAT PAIRS</span><strong id="stat-pairs">0</strong><small>Matched by explicit identifiers</small></article><article><span>PASSING</span><strong id="stat-pass" class="green">0</strong><small>All selected checks pass</small></article><article><span>REGRESSIONS</span><strong id="stat-fail" class="red">0</strong><small>Confirmed rule failures</small></article><article><span>UNRESOLVED</span><strong id="stat-unknown" class="amber">0</strong><small>Missing, partial, or ambiguous</small></article></section>
<p id="session-note" class="session-note">Metrics are supplied per run. Parent and child span tokens are never added together.</p>
<div class="workspace"><aside class="panel matrix"><div class="panel-title"><h2>Case matrix</h2><small id="shown-count"></small></div><div class="filters"><input id="search" type="search" placeholder="Search cases or repeats…" aria-label="Search cases"><select id="filter" aria-label="Filter cases"><option value="all">All results</option><option value="fail">Regressions</option><option value="unknown">Unresolved</option><option value="pass">Passing</option></select></div><div class="table-scroll"><table><thead><tr><th>CASE</th><th>RESULT</th><th>LATENCY ms</th><th>COST USD</th></tr></thead><tbody id="matrix-body"></tbody></table></div><p class="matrix-note">Candidate production metrics; deltas use complete paired measurements only. Select a case to inspect.</p></aside>
<section class="detail"><div class="panel case-header"><div class="eyebrow" id="case-repeat"></div><h2 id="case-title"></h2><div id="alignment"></div><div id="checks"></div></div>
<section class="panel"><div class="panel-title"><h2>Measurements & provenance</h2><select id="metric-domain" aria-label="Metric domain"><option value="production">Production metrics</option><option value="evaluation">Evaluation metrics</option></select></div><div id="metrics" class="metrics"></div></section>
<section class="panel"><div class="panel-title"><h2>Run timelines</h2><small>Click a span to inspect</small></div><div class="timeline-legend"><span>● Agent</span><span>● Model</span><span>● Tool</span><span>● Step</span></div><div class="timelines"><div id="baseline-timeline"></div><div id="candidate-timeline"></div></div></section>
<section class="panel"><div class="panel-title"><h2>Tool-call changes</h2><small>Observed counts, not inferred actions</small></div><div id="tools"></div></section>
<section class="panel"><div class="panel-title"><h2>Case evidence</h2><small>Explicit manifest only</small></div><div id="evidence" class="evidence"></div></section></section></div>
<footer>TRACE SET LAB <span>Artifact comparison · no replay · no model credentials required</span></footer></main>
<dialog id="rules-dialog"><div class="dialog-heading"><h2>Reusable regression rules</h2><button data-close aria-label="Close rules">×</button></div><p>Candidate budgets are absolute maxima. Partial data below a limit stays unresolved.</p><textarea id="rules-json" spellcheck="false" aria-label="Rules JSON"></textarea><p id="rules-error" class="red" role="alert"></p><div class="dialog-actions"><button id="rules-download">Download current rules ↓</button><button id="rules-apply" class="primary">Apply & recompute</button></div></dialog>
<dialog id="span-dialog"><div class="dialog-heading"><h2>Recorded span</h2><button data-close aria-label="Close span">×</button></div><pre id="span-detail"></pre></dialog>
<script>${script}</script></body></html>`;
}
const css = `:root{--bg:#f4f5f7;--card:#fff;--ink:#182431;--muted:#748092;--border:#e3e7ed;--teal:#0c877b;--red:#c74756;--amber:#956914;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}*{box-sizing:border-box}body{margin:0}button,input,select,textarea{font:inherit}button,select{cursor:pointer}button{border:1px solid var(--border);background:white;border-radius:8px;padding:9px 13px;color:var(--ink)}button:hover{border-color:#76aaa5;background:#f4faf9}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #72b5ff;outline-offset:2px}.primary{background:var(--teal);color:white;border-color:var(--teal)}.primary:hover{background:#096e65;color:white}header{height:76px;background:#fff;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 4vw;gap:15px}.brand{text-decoration:none;color:var(--ink);font-size:19px;font-weight:750;letter-spacing:-.6px;display:flex;align-items:center;gap:10px}.mark{background:#103d3b;color:#a7e5d5;width:34px;height:34px;display:grid;place-items:center;border-radius:10px;font-size:30px}.header-right{display:flex;align-items:center;gap:10px;font-size:12px}.offline{color:var(--teal);font-size:10px;letter-spacing:1px;margin-right:10px}main{max-width:1720px;margin:auto;padding:40px 4vw 0}.intro{display:flex;justify-content:space-between;align-items:end;margin-bottom:28px;gap:20px}.eyebrow{font-size:10px;letter-spacing:1.7px;font-weight:700;color:var(--teal)}h1{font-size:clamp(28px,3vw,40px);letter-spacing:-1.5px;margin:10px 0}p{line-height:1.5}.intro p{color:var(--muted);margin:0;font-size:14px}.intro-note{color:var(--muted);font-size:12px;line-height:1.8;text-align:right}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.stats article{background:white;border:1px solid var(--border);border-radius:12px;padding:20px 24px}.stats article>span{font-size:10px;letter-spacing:1px;color:var(--muted);font-weight:650}.stats strong{display:block;font-size:32px;font-weight:600;margin:8px 0}.stats small{font-size:11px;color:var(--muted)}.green{color:var(--teal)}.red,.worse{color:var(--red)!important}.amber{color:var(--amber)}.session-note{font-size:11px;color:var(--muted);margin:18px 2px 23px}.workspace{display:grid;grid-template-columns:minmax(340px,36%) minmax(0,1fr);align-items:start;gap:22px}.panel{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}.panel-title{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;gap:10px;border-bottom:1px solid #edf0f3}.panel-title h2{font-size:13px;margin:0;font-weight:650}.panel-title small{font-size:10px;color:var(--muted)}.matrix{position:sticky;top:18px}.filters{padding:15px;display:flex;gap:8px}input,select{min-width:0;border:1px solid var(--border);border-radius:7px;padding:9px 10px;font-size:11px;background:white;color:var(--ink)}input{width:100%;flex:1}select{max-width:190px}.table-scroll{overflow:auto;max-height:590px}table{width:100%;border-collapse:collapse;text-align:left;font-size:11px}th{background:#f8f9fb;padding:12px 11px;font-size:9px;letter-spacing:.6px;color:var(--muted);white-space:nowrap}td{padding:14px 11px;border-top:1px solid #eef0f4}td small{display:block;font-size:9px;color:var(--muted);margin-top:5px}.numeric{font-variant-numeric:tabular-nums}tr.selected{background:#eef8f5}tr.selected td:first-child{box-shadow:inset 3px 0 var(--teal)}.case-button{border:0;padding:0;text-align:left;font-size:11px;font-weight:650;background:transparent;max-width:150px;overflow-wrap:anywhere}.matrix-note{font-size:10px;color:var(--muted);padding:12px 18px;margin:0;border-top:1px solid var(--border)}.badge{display:inline-block;font-size:9px;white-space:nowrap;padding:4px 7px;border-radius:5px;background:#f0f2f5;color:var(--muted);font-weight:600}.badge.pass{background:#e4f4ed;color:#13745c}.badge.fail{background:#fbe9eb;color:#b64150}.badge.unknown{background:#fbf2dc;color:#92701b}.detail{display:flex;flex-direction:column;gap:18px;min-width:0}.case-header{padding:22px}.case-header h2{font-size:23px;letter-spacing:-.6px;margin:7px 0 12px;overflow-wrap:anywhere}#alignment{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.caption{font-size:10px;color:var(--muted)}#checks{margin-top:18px;display:grid;gap:8px}.check{display:flex;align-items:center;gap:8px;font-size:10px;flex-wrap:wrap}.check>span:last-child{color:var(--muted)}.metrics{display:grid;grid-template-columns:repeat(4,1fr)}.metric-card{padding:16px 14px;border-right:1px solid var(--border);min-width:0}.metric-card:last-child{border:0}h4{font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin:0 0 14px;color:var(--muted)}.metric-line{display:flex;justify-content:space-between;align-items:baseline;gap:6px;font-size:9px;margin-bottom:4px}.metric-line strong{font-size:12px;font-weight:600}.source{display:block;font-size:9px;color:var(--muted);margin:0 0 12px;overflow-wrap:anywhere}.delta{font-size:9px;border-top:1px dashed var(--border);padding-top:10px;color:var(--teal)}.timelines{display:grid;grid-template-columns:1fr 1fr;min-width:0}.timelines>div{padding:0 10px 16px;min-width:0}.timelines>div:first-child{border-right:1px solid var(--border)}.run-heading{display:flex;justify-content:space-between;align-items:center;gap:5px;margin:12px 0}.run-heading h3{font-size:11px;margin:0}.timeline-legend{display:flex;gap:18px;font-size:9px;padding:14px 20px 0;color:var(--muted)}.timeline-legend span:nth-child(1){color:#9184c5}.timeline-legend span:nth-child(2){color:#4c91ba}.timeline-legend span:nth-child(3){color:#48a58e}.span-row{display:block;width:100%;border:0;border-radius:5px;padding:8px;margin:2px 0;background:#fafbfc;text-align:left}.span-row:hover{background:#eff5f6}.span-label{display:flex;gap:5px;align-items:center;font-size:9px}.span-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.span-duration{font-variant-numeric:tabular-nums;font-size:8px;white-space:nowrap;color:var(--muted)}.kind{font-size:7px;text-transform:uppercase;color:var(--muted);width:30px;flex:none}.track{height:5px;background:#edf0f4;border-radius:3px;margin-top:6px;overflow:hidden}.bar{height:100%;background:#b2bec9;border-radius:3px}.bar.agent{background:#a49acb}.bar.llm{background:#75a9cc}.bar.tool{background:#6cb6a2}.bar.error{background:#d97984}.tool-line{display:flex;gap:14px;align-items:center;padding:11px 20px;border-top:1px solid #f0f2f5;font-size:10px}.tool-line code{flex:1;overflow-wrap:anywhere}.tool-line>span{font-variant-numeric:tabular-nums}.muted{color:var(--muted);font-size:11px;padding:0 12px}.evidence{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:18px;min-width:0}.evidence>div{min-width:0}details{border:1px solid var(--border);border-radius:7px;margin-bottom:8px;padding:10px;font-size:11px}summary{cursor:pointer}pre{font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:500px;overflow:auto;background:#f6f7f9;padding:15px;border-radius:7px}footer{display:flex;justify-content:space-between;padding:30px 0;color:#98a2af;font-size:9px;letter-spacing:1px}footer span{letter-spacing:0}dialog{border:1px solid var(--border);border-radius:14px;padding:24px;max-width:700px;width:calc(100% - 32px);color:var(--ink);box-shadow:0 25px 90px #162c3d33}dialog::backdrop{background:#152a4055;backdrop-filter:blur(3px)}.dialog-heading{display:flex;justify-content:space-between;align-items:center;gap:20px}.dialog-heading h2{font-size:18px;margin:0}.dialog-heading button{font-size:22px;padding:2px 10px}dialog p{font-size:12px;color:var(--muted)}textarea{width:100%;height:330px;resize:vertical;border:1px solid var(--border);border-radius:8px;padding:14px;font:12px/1.6 ui-monospace,Consolas,monospace;background:#f8fafb}.dialog-actions{display:flex;justify-content:space-between;gap:10px;margin-top:16px}@media(max-width:1100px){.workspace{grid-template-columns:1fr}.matrix{position:static}.table-scroll{max-height:310px}.case-button{max-width:400px}}@media(max-width:680px){header{height:auto;padding:16px;flex-wrap:wrap}.offline{display:none}main{padding:25px 15px 0}.intro-note{display:none}.stats{grid-template-columns:repeat(2,1fr);gap:8px}.stats article{padding:15px}.stats small{font-size:9px}.metrics{grid-template-columns:repeat(2,1fr)}.metric-card{border-bottom:1px solid var(--border)}.timelines,.evidence{grid-template-columns:1fr}.timelines>div:first-child{border-right:0;border-bottom:1px solid var(--border)}footer{gap:20px;font-size:8px}.panel-title{flex-wrap:wrap}}`;
