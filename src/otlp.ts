import { parseRun } from './parse.js';
import type { MetricSet, Run, Span } from './types.js';

type Row = Record<string, unknown>;
const MAX_SPANS = 100_000;
function record(value: unknown, field: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid OTLP ${field}`);
  return value as Row;
}
function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid OTLP ${field}`);
  return value;
}
function id(value: unknown, length: number, field: string): string {
  if (typeof value !== 'string' || value.length !== length || !/^[a-fA-F0-9]+$/.test(value) || /^0+$/.test(value)) {
    throw new Error(`Invalid OTLP ${field}`);
  }
  return value.toLowerCase();
}
function nanos(value: unknown): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) throw new Error('OTLP timestamps must be exact unsigned decimal nanoseconds');
  const result = BigInt(value);
  if (result > 18_446_744_073_709_551_615n) throw new Error('OTLP timestamp exceeds uint64');
  return result;
}
function milliseconds(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('OTLP relative interval exceeds supported precision');
  return Number(value) / 1_000_000;
}
function attributes(raw: unknown): Map<string, Row> {
  const result = new Map<string, Row>();
  for (const item of list(raw ?? [], 'attributes')) {
    const entry = record(item, 'attribute');
    if (typeof entry.key !== 'string' || result.has(entry.key)) throw new Error('Invalid or duplicate OTLP attribute key');
    result.set(entry.key, record(entry.value, 'attribute value'));
  }
  return result;
}
function stringAttribute(attrs: Map<string, Row>, key: string): string | undefined {
  const value = attrs.get(key)?.stringValue;
  return typeof value === 'string' ? value : undefined;
}
function spanKind(attrs: Map<string, Row>): Span['kind'] {
  const openInference = stringAttribute(attrs, 'openinference.span.kind');
  if (openInference === 'TOOL') return 'tool';
  if (openInference === 'LLM') return 'llm';
  if (openInference === 'AGENT') return 'agent';
  const operation = stringAttribute(attrs, 'gen_ai.operation.name');
  if (operation === 'execute_tool') return 'tool';
  if (operation === 'invoke_agent' || operation === 'create_agent') return 'agent';
  if (['chat', 'text_completion', 'generate_content'].includes(operation ?? '')) return 'llm';
  return 'step';
}
function tokens(attrs: Map<string, Row>, spanId: string): MetricSet {
  const result: MetricSet = {};
  const fields = {
    input_tokens: ['gen_ai.usage.input_tokens', 'llm.token_count.prompt'],
    output_tokens: ['gen_ai.usage.output_tokens', 'llm.token_count.completion'],
  } as const;
  for (const metric of ['input_tokens', 'output_tokens'] as const) {
    for (const key of fields[metric]) {
      const attr = attrs.get(key);
      if (!attr) continue;
      const raw = attr.intValue;
      let value: number;
      if (typeof raw === 'string' && /^\d+$/.test(raw)) value = Number(raw);
      else if (typeof raw === 'number') value = raw;
      else throw new Error('Supported OTLP token attributes must use intValue');
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('OTLP token count must be a nonnegative safe integer');
      result[metric] = { value, source: `OTLP span ${spanId}: ${key}`, coverage: 'complete' };
      break;
    }
  }
  return result;
}

/** Import selected OTLP/HTTP JSON traces. This performs no I/O and executes no input code. */
export function importOtlp(payload: unknown, mapping: unknown): Run[] {
  const selection = record(mapping, 'mapping');
  if (selection.schema_version !== 1) throw new Error('Invalid OTLP mapping schema_version');
  const entries = list(selection.traces, 'mapping traces');
  if (!entries.length || entries.length > 10_000) throw new Error('OTLP mapping requires 1–10000 traces');
  const selected = new Map<string, Row>();
  for (const value of entries) {
    const entry = record(value, 'mapping entry'), traceId = id(entry.trace_id, 32, 'mapped trace_id');
    if (selected.has(traceId)) throw new Error('Duplicate trace_id in OTLP mapping');
    selected.set(traceId, entry);
  }
  const groups = new Map<string, Row[]>();
  let count = 0;
  for (const resourceValue of list(record(payload, 'export').resourceSpans, 'resourceSpans')) {
    const resource = record(resourceValue, 'resource span');
    for (const scopeValue of list(resource.scopeSpans ?? [], 'scopeSpans')) {
      const scope = record(scopeValue, 'scope span');
      for (const spanValue of list(scope.spans ?? [], 'spans')) {
        if (++count > MAX_SPANS) throw new Error('OTLP export exceeds 100000 spans');
        const span = record(spanValue, 'span'), traceId = id(span.traceId, 32, 'traceId');
        if (!selected.has(traceId)) continue;
        const group = groups.get(traceId) ?? [];
        group.push(span); groups.set(traceId, group);
      }
    }
  }
  const runs: Run[] = [];
  for (const [traceId, entry] of selected) {
    const group = groups.get(traceId);
    if (!group?.length) throw new Error('A mapped OTLP trace is absent from the export');
    if (group.length > 10_000) throw new Error('OTLP trace exceeds 10000 spans');
    const starts = group.map(span => nanos(span.startTimeUnixNano));
    const origin = starts.reduce((a, b) => a < b ? a : b);
    const spans = group.map((raw, index) => {
      const spanId = id(raw.spanId, 16, 'spanId');
      const parent = raw.parentSpanId === undefined || raw.parentSpanId === '' || raw.parentSpanId === '0000000000000000'
        ? undefined : id(raw.parentSpanId, 16, 'parentSpanId');
      const start = starts[index];
      const end = raw.endTimeUnixNano === undefined || raw.endTimeUnixNano === null || raw.endTimeUnixNano === '0' || raw.endTimeUnixNano === 0
        ? null : nanos(raw.endTimeUnixNano);
      if (end !== null && end < start) throw new Error('OTLP span end precedes start');
      const attrs = attributes(raw.attributes), kind = spanKind(attrs);
      const code = raw.status === undefined ? 0 : record(raw.status, 'status').code ?? 0;
      if (code !== 0 && code !== 1 && code !== 2) throw new Error('Unsupported OTLP status code; use integer enums');
      const status = code === 2 ? 'error' : end === null || code === 0 ? 'incomplete' : 'ok';
      return {
        id: spanId, ...(parent ? { parent_id: parent } : {}),
        name: kind === 'tool' ? stringAttribute(attrs, 'gen_ai.tool.name') ?? stringAttribute(attrs, 'tool.name') ?? raw.name : raw.name,
        kind, start_ms: milliseconds(start - origin), end_ms: end === null ? null : milliseconds(end - origin),
        status, metrics: tokens(attrs, spanId),
      };
    });
    // Run-level metrics and status are deliberately supplied by the mapping, never summed from spans.
    runs.push(parseRun({ schema_version: 1, case_id: entry.case_id, repeat_id: entry.repeat_id,
      status: entry.status, spans_complete: entry.spans_complete, production: entry.production,
      evaluation: entry.evaluation, spans }));
  }
  return runs;
}
