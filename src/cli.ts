#!/usr/bin/env node
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { compare, defaultRules } from "./core.js";
import { parseRules } from "./parse.js";
import { loadTraceSet, readJsonFile } from "./io.js";
import { importOtlp } from "./otlp.js";
import { renderHtml } from "./html.js";
import { renderJunit } from "./junit.js";

const help = `Trace Set Lab — compare recorded agent runs without API keys

trace-set-lab compare --baseline base.jsonl --candidate next.jsonl
  [--rules rules.json] [--json report.json] [--html report.html]
  [--junit report.xml] [--evidence]
trace-set-lab rules --out rules.json
trace-set-lab import-otlp export.json --mapping mapping.json --out runs.jsonl

Outputs are created exclusively; existing files are never overwritten.
--evidence reads only text attachments in each explicit case manifest.
Exit 0: checks pass. Exit 1: regression. Exit 2: invalid input or unresolved checks.
`;
async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ options: {
    baseline: { type: "string" }, candidate: { type: "string" }, rules: { type: "string" },
    json: { type: "string" }, html: { type: "string" }, junit: { type: "string" }, out: { type: "string" }, mapping: { type: "string" },
    evidence: { type: "boolean" }, help: { type: "boolean" }, version: { type: "boolean" }
  }, allowPositionals: true });
  if (values.help) { process.stdout.write(help); return 0; }
  if (values.version) { process.stdout.write("trace-set-lab 0.1.0\n"); return 0; }
  if (positionals[0] === "import-otlp") {
    if (positionals.length !== 2 || !values.mapping || !values.out) throw new Error("Missing OTLP import inputs");
    const payload = await readJsonFile(positionals[1]);
    const mapping = await readJsonFile(values.mapping, 1024 * 1024);
    const runs = importOtlp(payload, mapping);
    await writeFile(values.out, runs.map(run=>JSON.stringify(run)).join("\n") + "\n", { flag: "wx" });
    process.stdout.write(`Imported ${runs.length} explicitly mapped trace(s).\n`); return 0;
  }
  if (positionals.length !== 1) throw new Error("Expected one command");
  if (positionals[0] === "rules") {
    if (!values.out) throw new Error("Missing rules output");
    await writeFile(values.out, JSON.stringify(defaultRules, null, 2) + "\n", { flag: "wx" });
    process.stdout.write("Created reusable rules.\n"); return 0;
  }
  if (positionals[0] !== "compare" || !values.baseline || !values.candidate) throw new Error("Missing comparison inputs");
  const rules = values.rules ? parseRules(await readJsonFile(values.rules, 1024 * 1024)) : defaultRules;
  const [baseline, candidate] = await Promise.all([
    loadTraceSet(values.baseline, { evidence: values.evidence }), loadTraceSet(values.candidate, { evidence: values.evidence })
  ]);
  const report = compare(baseline, candidate, rules);
  if (values.json) await writeFile(values.json, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  if (values.html) await writeFile(values.html, renderHtml(report), { flag: "wx" });
  if (values.junit) await writeFile(values.junit, renderJunit(report), { flag: "wx" });
  process.stdout.write(`${report.summary.pairs} pairs · ${report.summary.passed} passed · ${report.summary.failed} failed · ${report.summary.unresolved} unresolved\n`);
  return report.exit_code;
}
let outputFailed = false;
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => { outputFailed = true; process.exitCode = 2; });
main().then(code => { process.exitCode = outputFailed ? 2 : code; }).catch(() => {
  process.exitCode = 2;
  process.stderr.write("trace-set-lab: unable to complete comparison; check command, input schema, evidence boundaries, and output permissions. Existing outputs are not overwritten.\n");
});
