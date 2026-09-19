import { mkdir, writeFile } from 'node:fs/promises';
import { compare, parseRun, loadTraceSet, renderHtml, renderJunit } from '../dist/index.js';
const metric = (value, source = 'synthetic recorder', coverage = 'complete') => ({ value, source, coverage });
function run(case_id, latency = 1420, overrides = {}) {
  return parseRun({ schema_version: 1, case_id, repeat_id: '1', status: 'ok', spans_complete: true,
    production: { latency_ms: metric(latency), input_tokens: metric(2100), output_tokens: metric(340), cost_usd: metric(.0126, 'provided invoice amount') },
    evaluation: { latency_ms: metric(26, 'local rule timer'), cost_usd: metric(0, 'no model evaluation') },
    spans: [
      { id: 'root', name: 'Resolve request', kind: 'agent', start_ms: 0, end_ms: latency, status: 'ok', metrics: { input_tokens: metric(2100, 'aggregate, display only') } },
      { id: 'plan', parent_id: 'root', name: 'Plan response', kind: 'llm', start_ms: latency * .03, end_ms: latency * .3, status: 'ok', metrics: { input_tokens: metric(1200) } },
      { id: 'retrieve', parent_id: 'root', name: 'retrieve', kind: 'tool', start_ms: latency * .33, end_ms: latency * .55, status: 'ok' },
      { id: 'answer', parent_id: 'root', name: 'Write answer', kind: 'llm', start_ms: latency * .6, end_ms: latency * .95, status: 'ok', metrics: { input_tokens: metric(900) } }
    ], ...overrides });
}
const baseline = [run('refund-policy'), run('invoice-lookup', 1200), run('support-routing', 950), run('account-check', 1300), run('duplicate-import', 1000), run('removed-case', 500), run('free-cache-hit', 0), run('partial-recovery', 1400)];
const candidate = [run('refund-policy', 1280), run('invoice-lookup', 3300), run('support-routing', 1080), run('account-check', 1450), run('duplicate-import', 1100), run('duplicate-import', 1200), run('new-case', 900), run('free-cache-hit', 0), run('partial-recovery', 1900)];
candidate[1].production.cost_usd = metric(.045, 'provided invoice amount');
candidate[1].spans.push({ id:'retry-1', parent_id:'root', name:'retrieve', kind:'tool', start_ms:1900, end_ms:2200, status:'error' }, { id:'retry-2', parent_id:'root', name:'retrieve', kind:'tool', start_ms:2300, end_ms:2600, status:'ok' });
delete candidate[2].production.cost_usd;
candidate[3].spans = candidate[3].spans.filter(s=>s.kind!=='tool');
const partial = candidate.find(item => item.case_id === 'partial-recovery');
partial.status = 'error'; partial.production.cost_usd = metric(.004, 'sampled billing span', 'partial'); partial.spans_complete = false;
for (const item of [...baseline, ...candidate].filter(item => item.case_id === 'free-cache-hit')) { item.production = { latency_ms:metric(0),input_tokens:metric(0),output_tokens:metric(0),cost_usd:metric(0) }; }
baseline[0].evidence = { directory: 'evidence/baseline-refund', files: [{ path: 'notes.md', label: 'Recorded policy context' }] };
candidate[0].evidence = { directory: 'evidence/candidate-refund', files: [{ path: 'notes.md', label: 'Recorded policy context' }] };
const rules = { schema_version:1, require_status:'ok', required_tools:['retrieve'], max_tool_calls:{ retrieve:2 }, budgets:{ production:{latency_ms:2500,cost_usd:.03}, evaluation:{} } };
for (const directory of ['examples','docs','examples/evidence/baseline-refund','examples/evidence/candidate-refund']) await mkdir(directory,{recursive:true});
await writeFile('examples/evidence/baseline-refund/notes.md','# Synthetic policy\nRefunds are reviewed using the published policy.\n');
await writeFile('examples/evidence/candidate-refund/notes.md','# Synthetic policy\nSame policy, with the evidence retrieved in one call.\n');
await writeFile('examples/baseline.jsonl',baseline.map(r=>JSON.stringify(r)).join('\n')+'\n');
await writeFile('examples/candidate.jsonl',candidate.map(r=>JSON.stringify(r)).join('\n')+'\n');
await writeFile('examples/rules.json',JSON.stringify(rules,null,2)+'\n');
const report=compare(await loadTraceSet('examples/baseline.jsonl',{evidence:true}),await loadTraceSet('examples/candidate.jsonl',{evidence:true}),rules);
await writeFile('docs/demo.html',renderHtml(report));
console.log('Created docs/demo.html from synthetic recorded traces.');
