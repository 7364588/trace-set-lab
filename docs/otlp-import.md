# Import recorded OTLP traces

Use an **OTLP/HTTP JSON `ExportTraceServiceRequest`** with `resourceSpans[].scopeSpans[].spans[]`.
The importer is a file conversion step, not a live collector. It does not contact an observability
service, call a model, or execute code from the export.

Provide a mapping so two runs of the same case can be compared without guessing from span names:

```json
{
  "schema_version": 1,
  "traces": [{
    "trace_id": "abcdef0123456789abcdef0123456789",
    "case_id": "search-case",
    "repeat_id": "trial-1",
    "status": "ok",
    "spans_complete": true,
    "production": {
      "latency_ms": { "value": 1800, "source": "production run ledger", "coverage": "complete" },
      "input_tokens": { "value": 920, "source": "production run ledger", "coverage": "complete" }
    },
    "evaluation": {}
  }]
}
```

```sh
trace-set-lab import-otlp export.json --mapping mapping.json --out recorded.jsonl
```

Try the included synthetic export from a source checkout:

```sh
node dist/cli.js import-otlp examples/otlp-export.json --mapping examples/otlp-mapping.json --out imported.jsonl
```

Use the same `(case_id, repeat_id)` in the baseline and candidate mappings. Their actual trace IDs
can differ. Only listed traces are imported; a missing listed trace is an error. Repeating a trace
ID in the mapping is an error. Multiple different traces mapped to one case/repetition will remain
ambiguous during comparison.

Run-level status, trace completeness, production metrics and evaluation metrics come from the
mapping. They are operator-provided statements: the importer does not verify the source ledger or
infer that an export contains every span. Omitted metrics stay unknown. The importer **does not
sum parent and child metrics**, infer whole-run latency from a partial export, or calculate costs
from a model price list. Supply production totals from the system that recorded them.

Supported span annotations:

- `gen_ai.operation.name`: `execute_tool`, `invoke_agent`, `create_agent`, `chat`, `text_completion`, `generate_content`.
- `gen_ai.tool.name` or `tool.name` for tool-call names.
- `openinference.span.kind`: `TOOL`, `LLM`, `AGENT`; other kinds appear as generic steps.
- `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`, with fallback to
  `llm.token_count.prompt` / `llm.token_count.completion`. These remain span-level measurements;
  explicit zero is preserved. Values must be nonnegative safe integers in OTLP `intValue`.

All other attributes, events, links, resource metadata, prompts and responses are omitted. Span
names themselves may contain sensitive data, so review the resulting report before sharing it.

Timestamps use decimal strings or safe numeric integers. Nanoseconds are subtracted with `BigInt`
before converting to relative milliseconds. Epoch timestamps passed as unsafe JSON numbers are
rejected. IDs are hexadecimal and case-insensitive; all-zero trace/span IDs are rejected. A missing
or zero end time remains unknown. OTLP `UNSET` span status stays incomplete rather than being
reported as verified success; the mapped run-level status is independent.

Current limits: at most 100,000 spans in an export, 10,000 per selected trace, and relative intervals
of at most `Number.MAX_SAFE_INTEGER` nanoseconds (about 104 days). Export every parent of a selected
span: missing parents, duplicate span IDs and cyclic parent links are rejected. Binary Protobuf,
snake_case field aliases, vendor-specific REST exports, log streams and live endpoints are not
supported. Convert them to this documented input format first.

Primary format references: [OTLP JSON specification](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding),
[official JSON example](https://github.com/open-telemetry/opentelemetry-proto/blob/main/examples/trace.json),
[GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai),
[OpenInference conventions](https://github.com/Arize-ai/openinference/tree/main/spec).
