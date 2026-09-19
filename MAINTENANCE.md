# Maintenance

Changes are driven by reproducible defects, compatibility gaps and concrete workflows.
An unchanged project does not need a commit or release merely because a week has passed.

Before shipping a change:

1. Reproduce the problem with synthetic input; preserve uncertainty instead of guessing missing data.
2. Run `npm ci --ignore-scripts`, `npm run build` and `npm test`.
3. Run `npm run demo` and check the affected report interactions in a browser.
4. Check the archive from `npm pack --ignore-scripts` and install it in a clean directory.
5. Confirm the supported OS/Node CI matrix, update documentation and the changelog.

Scheduled CI tests compatibility; it does not edit files, make commits or publish packages.
Dependency update proposals require review and tests. Releases depend on useful changes.
No response-time guarantee is made.
