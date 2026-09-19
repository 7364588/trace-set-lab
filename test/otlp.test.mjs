import test from 'node:test';
import assert from 'node:assert/strict';
import { importOtlp } from '../dist/otlp.js';

const traceId = 'abcdef0123456789abcdef0123456789';
const parentId = 'abcdef0123456789';
const childId = '0000000000000001';
const metric = value => ({ value, source: 'exported production ledger', coverage: 'complete' });
const attr = (key, value) => ({ key, value });
function fixture() {
  const spans = [{ traceId, spanId: parentId, name: 'agent', startTimeUnixNano: '1789800000000000001', endTimeUnixNano: '1789800001000000001', status: { code: 1 },
    attributes: [attr('gen_ai.operation.name', { stringValue: 'invoke_agent' }), attr('gen_ai.usage.input_tokens', { intValue: '100' })] },
  { traceId: traceId.toUpperCase(), spanId: childId, parentSpanId: parentId.toUpperCase(), name: 'tool span', startTimeUnixNano: '1789800000000123457', endTimeUnixNano: '1789800000001123457', status: { code: 1 },
    attributes: [attr('gen_ai.operation.name', { stringValue: 'execute_tool' }), attr('gen_ai.tool.name', { stringValue: 'search' }), attr('gen_ai.usage.input_tokens', { intValue: 30 }), attr('input.value', { stringValue: 'PRIVATE_PROMPT_NOT_FOR_EXPORT' })] }];
  return { payload: { resourceSpans: [{ scopeSpans: [{ spans }] }] }, spans,
    mapping: { schema_version: 1, traces: [{ trace_id: traceId, case_id: 'search-case', repeat_id: 'trial-1', status: 'ok', spans_complete: true, production: { input_tokens: metric(100) } }] } };
}
test('imports real-shaped OTLP JSON with exact submillisecond timing and explicit pairing', () => {
  const { payload, mapping } = fixture();
  const [run] = importOtlp(payload, mapping);
  assert.equal(run.case_id, 'search-case'); assert.equal(run.repeat_id, 'trial-1');
  assert.equal(run.spans[0].end_ms, 1000);
  assert.equal(run.spans[1].start_ms, 0.123456);
  assert.equal(run.spans[1].name, 'search'); assert.equal(run.spans[1].parent_id, parentId);
});
test('does not aggregate nested metrics or invent run-level latency, cost or evaluation metrics', () => {
  const { payload, mapping } = fixture(); const [run] = importOtlp(payload, mapping);
  assert.equal(run.production.input_tokens.value, 100);
  assert.equal(run.spans[1].metrics.input_tokens.value, 30);
  assert.equal(run.production.cost_usd, undefined); assert.equal(run.production.latency_ms, undefined);
  assert.deepEqual(run.evaluation, {}); assert.equal(JSON.stringify(run).includes('PRIVATE_PROMPT_NOT_FOR_EXPORT'), false);
});
test('unknown status remains incomplete; zero tokens stay known zero', () => {
  const { payload, mapping, spans } = fixture(); delete spans[1].status;
  spans[1].attributes.push(attr('gen_ai.usage.output_tokens', { intValue: '0' }));
  const [run] = importOtlp(payload, mapping);
  assert.equal(run.spans[1].status, 'incomplete'); assert.equal(run.spans[1].metrics.output_tokens.value, 0);
});
test('supports OpenInference token and kind attributes without exporting arbitrary attributes', () => {
  const { payload, mapping, spans } = fixture();
  spans[1].attributes = [attr('openinference.span.kind', { stringValue: 'LLM' }), attr('llm.token_count.completion', { intValue: '12' })];
  const [run] = importOtlp(payload, mapping);
  assert.equal(run.spans[1].kind, 'llm'); assert.equal(run.spans[1].metrics.output_tokens.value, 12);
});
test('rejects lossy numeric timestamps instead of silently rounding them', () => {
  const { payload, mapping, spans } = fixture(); spans[0].startTimeUnixNano = 1789800000000000001;
  assert.throws(() => importOtlp(payload, mapping), /exact unsigned decimal/);
});
test('validates case mapping and rejects missing, duplicated and invalid trace IDs', () => {
  const { payload, mapping } = fixture();
  assert.throws(() => importOtlp(payload, { schema_version: 1, traces: [] }), /requires/);
  assert.throws(() => importOtlp(payload, { ...mapping, traces: [...mapping.traces, ...mapping.traces] }), /Duplicate trace/);
  mapping.traces[0].trace_id = '1'.repeat(32);
  assert.throws(() => importOtlp(payload, mapping), /absent/);
  mapping.traces[0].trace_id = '0'.repeat(32);
  assert.throws(() => importOtlp(payload, mapping), /mapped trace_id/);
});
test('rejects duplicate spans and missing parent trees instead of fabricating topology', () => {
  const { payload, mapping, spans } = fixture(); spans.push({ ...spans[1] });
  assert.throws(() => importOtlp(payload, mapping), /duplicate span/);
  spans.pop(); spans[1].parentSpanId = '2'.repeat(16);
  assert.throws(() => importOtlp(payload, mapping), /missing span parent/);
});
test('rejects reversed and overly wide intervals', () => {
  const { payload, mapping, spans } = fixture(); spans[1].endTimeUnixNano = '1';
  assert.throws(() => importOtlp(payload, mapping), /precedes/);
  spans[1].endTimeUnixNano = '18446744073709551615';
  assert.throws(() => importOtlp(payload, mapping), /precision/);
});
test('does not import traces absent from the explicit selection', () => {
  const { payload, mapping, spans } = fixture(); spans.push({ ...spans[0], traceId: '3'.repeat(32), name: 'UNSELECTED' });
  const runs = importOtlp(payload, mapping);
  assert.equal(runs.length, 1); assert.equal(runs[0].spans.length, 2);
});
test('validates token integers, enum codes and duplicate attributes', () => {
  const { payload, mapping, spans } = fixture(); spans[1].attributes[2].value.intValue = '9007199254740993';
  assert.throws(() => importOtlp(payload, mapping), /safe integer/);
  spans[1].attributes[2].value.intValue = '30'; spans[1].status.code = 'STATUS_CODE_OK';
  assert.throws(() => importOtlp(payload, mapping), /integer enums/);
  spans[1].status.code = 1; spans[1].attributes.push(spans[1].attributes[0]);
  assert.throws(() => importOtlp(payload, mapping), /duplicate OTLP attribute/);
});
