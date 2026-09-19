# Contributing

Start with a concrete problem and a small synthetic example. Check existing issues first.
Keep changes focused and explain the observable behavior they improve.

Use Node.js 22 or 24 and Git. Run `npm ci --ignore-scripts`, `npm run build`, `npm test`
and `npm run demo`. For report changes, check keyboard access, narrow screens and the offline
demo. Do not add external scripts, fonts, analytics or network calls to generated reports.

Document unsupported input instead of silently guessing. Add regression coverage for meaningful
behavior changes. Do not include private repositories, real traces, credentials or personal data
in fixtures. Contributions use the repository's MIT license.
