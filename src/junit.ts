import type { Report } from "./types.js";
function xml(input: string): string {
  return input.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, "\ufffd").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
export function renderJunit(report: Report): string {
  const rows = report.pairs.map(pair => {
    const issues = pair.checks.filter(c => c.status !== "pass").map(c => `${c.rule}: ${c.message}`).join("\n");
    const result = pair.verdict === "fail" ? `<failure message="Regression">${xml(issues)}</failure>` : pair.verdict === "unknown" ? `<error message="Unresolved evidence">${xml(issues)}</error>` : "";
    return `<testcase classname="${xml(pair.case_id)}" name="${xml(pair.repeat_id)}">${result}</testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="Trace Set Lab" tests="${report.summary.pairs}" failures="${report.summary.failed}" errors="${report.pairs.filter(p=>p.verdict === "unknown").length}">\n${rows.join("\n")}\n</testsuite>\n`;
}
