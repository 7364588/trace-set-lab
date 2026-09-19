import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { compare, defaultRules, parseJsonl, parseRun, parseRules, metricDelta, renderHtml, renderJunit } from '../dist/index.js';
const metric=(value,coverage='complete')=>({value,coverage,source:'synthetic'});
const raw=(extra={})=>({schema_version:1,case_id:'case',repeat_id:'1',status:'ok',spans_complete:true,spans:[],...extra});
const run=(extra={})=>parseRun(raw(extra));
const rules=(extra={})=>parseRules({...structuredClone(defaultRules),...extra});
test('explicit pairs ignore order and preserve repeat identifiers',()=>{
  const report=compare([run({repeat_id:'2'}),run()],[run(),run({repeat_id:'2'})]);
  assert.equal(report.exit_code,0); assert.deepEqual(report.pairs.map(p=>p.repeat_id),['1','2']);
});
test('tuple alignment does not conflate delimiter-containing identifiers',()=>{
  assert.equal(compare([run({case_id:'a|b',repeat_id:'c'})],[run({case_id:'a',repeat_id:'b|c'})]).summary.unresolved,2);
});
test('duplicates remain ambiguous rather than choosing a run',()=>{
  const report=compare([run(),run()],[run()]); assert.equal(report.exit_code,2); assert.equal(report.pairs[0].state,'ambiguous');assert.equal(report.pairs[0].baseline.length,2);
});
test('missing sides remain unresolved',()=>{
  for(const report of [compare([run()],[]),compare([],[run()])]) assert.equal(report.exit_code,2);
});
test('unknown metric differs from zero',()=>{
  const r=rules({budgets:{production:{cost_usd:0},evaluation:{}}});
  assert.equal(compare([run()],[run({production:{cost_usd:metric(0)}})],r).exit_code,0);
  assert.equal(compare([run()],[run()],r).exit_code,2);
});
test('partial budget below bound unresolved, above bound failure',()=>{
  const r=rules({budgets:{production:{cost_usd:1},evaluation:{}}});
  assert.equal(compare([run()],[run({production:{cost_usd:metric(.5,'partial')}})],r).exit_code,2);
  assert.equal(compare([run()],[run({production:{cost_usd:metric(2,'partial')}})],r).exit_code,1);
});
test('unknown coverage is unresolved even with numeric value',()=>{
  assert.equal(compare([run()],[run({production:{cost_usd:metric(50,'unknown')}})],rules({budgets:{production:{cost_usd:1},evaluation:{}}})).exit_code,2);
});
test('known failure remains visible beside unknown check',()=>{
  const report=compare([run()],[run({status:'error'})],rules({budgets:{production:{cost_usd:1},evaluation:{}}}));
  assert.equal(report.exit_code,2);assert.equal(report.summary.failed,1);assert.equal(report.summary.unresolved,1);assert.equal(report.pairs[0].verdict,'fail');
});
test('production and evaluation budgets stay separate',()=>{
  const candidate=run({production:{cost_usd:metric(2)},evaluation:{cost_usd:metric(0)}});
  assert.equal(compare([run()],[candidate],rules({budgets:{production:{},evaluation:{cost_usd:0}}})).exit_code,0);
});
test('span tokens never summed into missing or provided run totals',()=>{
  const spans=[{id:'a',name:'a',kind:'agent',start_ms:0,end_ms:1,status:'ok',metrics:{input_tokens:metric(500)}},{id:'b',parent_id:'a',name:'b',kind:'llm',start_ms:0,end_ms:1,status:'ok',metrics:{input_tokens:metric(500)}}];
  assert.equal(run({spans}).production.input_tokens,undefined);
  assert.equal(run({spans,production:{input_tokens:metric(500)}}).production.input_tokens.value,500);
});
test('required tools and max calls respect trace coverage',()=>{
  const r=rules({required_tools:['lookup'],max_tool_calls:{lookup:1}});
  assert.equal(compare([run()],[run()],r).exit_code,1);
  assert.equal(compare([run()],[run({spans_complete:false})],r).exit_code,2);
  const span={name:'lookup',kind:'tool',start_ms:0,end_ms:1,status:'ok'};
  assert.equal(compare([run()],[run({spans:[{...span,id:'a'},{...span,id:'b'}]})],r).exit_code,1);
});
test('delta uses complete data and handles baseline zero finitely',()=>{
  assert.equal(metricDelta(metric(0),metric(4)),4);assert.equal(metricDelta(undefined,metric(0)),null);assert.equal(metricDelta(metric(1,'partial'),metric(4)),null);
});
test('parser validates JSONL without exposing malformed source',()=>{
  assert.throws(()=>parseJsonl('synthetic-secret!'),/line 1/);assert.throws(()=>parseJsonl(''),/empty/);
  assert.equal(parseJsonl('\ufeff'+JSON.stringify(raw())+'\r\n\r\n').length,1);
});
test('parser rejects incomplete identity and invalid metrics',()=>{
  for(const value of [raw({case_id:''}),raw({repeat_id:undefined}),raw({production:{cost_usd:metric(-1)}}),raw({production:{cost_usd:metric(null)}}),raw({production:{wrong:metric(1)}})]) assert.throws(()=>parseRun(value));
});
test('parser rejects duplicate span ids, cycles, missing parents',()=>{
  const s={id:'a',name:'a',kind:'step',start_ms:0,end_ms:1,status:'ok'};
  for(const spans of [[s,s],[{...s,parent_id:'a'}],[{...s,parent_id:'b'}]])assert.throws(()=>parseRun(raw({spans})));
});
test('invalid rule shape cannot silently disable checks',()=>{
  for(const item of [{},{...defaultRules,require_status:'whatever'},{...defaultRules,max_tool_calls:{tool:1.2}},{...defaultRules,budgets:{production:{cost_usd:-1},evaluation:{}}}])assert.throws(()=>parseRules(item));
});
test('HTML escapes hostile strings and has no external dependencies',()=>{
  const payload='</script><script>alert("synthetic")</script>';
  const html=renderHtml(compare([run({case_id:payload})],[run({case_id:payload})]));
  assert.equal((html.match(/<script>/g)||[]).length,1);assert.equal((html.match(/<\/script>/g)||[]).length,1);
  assert.ok(!html.includes(payload));assert.ok(html.includes("connect-src 'none'"));assert.ok(!/<script[^>]*src=|<link[^>]*href=/.test(html));
});
test('embedded HTML script parses as JavaScript after TypeScript compilation',()=>{
  const html=renderHtml(compare([run()],[run()]));
  const source=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source);assert.doesNotThrow(()=>new Script(source));
});
test('JUnit escapes labels and marks unresolved as errors',()=>{
  const xml=renderJunit(compare([run({case_id:'a<&"'})],[]));assert.ok(xml.includes('a&lt;&amp;&quot;'));assert.ok(xml.includes('<error '));
});
test('JUnit replaces invalid XML scalars while preserving astral text',()=>{
  const xml=renderJunit(compare([run({case_id:'case\ufffe\ud800🙂',repeat_id:'repeat\uffff'})],[]));
  assert.ok(!xml.includes('\ufffe'));assert.ok(!xml.includes('\uffff'));assert.ok(!xml.includes('\ud800'));assert.ok(xml.includes('🙂'));
});
