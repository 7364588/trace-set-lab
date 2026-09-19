import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { parseJsonl, relativePath } from "./parse.js";
import type { Run } from "./types.js";
const MAX_INPUT = 25 * 1024 * 1024;
export async function readJsonFile(file: string, limit = MAX_INPUT): Promise<unknown> {
  try { return JSON.parse(await readBounded(file, limit)); }
  catch { throw new Error("Unable to read a bounded UTF-8 JSON file"); }
}
async function readBounded(file: string, limit: number): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error("Input must be a bounded regular file");
    const data = Buffer.alloc(limit + 1); let size = 0;
    while (size < data.length) {
      const result = await handle.read(data, size, data.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > limit) throw new Error("Input size limit exceeded");
    return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, size));
  } finally { await handle.close(); }
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !!relative && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
}
async function safeDescendant(root: string, relative: string, directory: boolean): Promise<string> {
  relativePath(relative);
  let current = root;
  const pieces = relative.split("/");
  for (let i = 0; i < pieces.length; i++) {
    current = path.join(current, pieces[i]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("Evidence symlinks are forbidden");
    if ((i < pieces.length - 1 || directory) && !info.isDirectory()) throw new Error("Invalid evidence directory");
  }
  if (!inside(root, await realpath(current))) throw new Error("Evidence path escapes its root");
  return current;
}
export async function loadEvidence(run: Run, root: string): Promise<Run> {
  if (!run.evidence) return run;
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("Invalid evidence root");
  const canonicalRoot = await realpath(root);
  const directory = await safeDescendant(canonicalRoot, run.evidence.directory, true);
  const attachments = [];
  let total = 0;
  for (const file of run.evidence.files) {
    if (!/\.(txt|md|json|jsonl|log|csv)$/i.test(file.path)) throw new Error("Unsupported evidence text extension");
    const target = await safeDescendant(directory, file.path, false);
    const text = await readBounded(target, 64 * 1024);
    total += Buffer.byteLength(text);
    if (total > 1024 * 1024) throw new Error("Evidence size limit exceeded");
    attachments.push({ path: file.path, label: file.label ?? file.path, text });
  }
  return { ...run, attachments };
}
export async function loadTraceSet(file: string, options: { evidence?: boolean } = {}): Promise<Run[]> {
  const runs = parseJsonl(await readBounded(file, MAX_INPUT));
  if (!options.evidence) return runs;
  // One manifest directory belongs to one case/repetition inside this set.
  const owners = new Map<string, string>();
  const root = path.dirname(path.resolve(file));
  for (const run of runs) if (run.evidence) {
    const resolved = await safeDescendant(await realpath(root), run.evidence.directory, true);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    const owner = JSON.stringify([run.case_id, run.repeat_id]);
    for (const [directory, previous] of owners) {
      if ((key === directory || inside(directory, key) || inside(key, directory)) && previous !== owner) throw new Error("Evidence directories overlap between cases");
    }
    owners.set(key, owner);
  }
  const loaded: Run[] = [];
  let bytes = 0;
  for (const run of runs) {
    const resolved = await loadEvidence(run, root);
    bytes += (resolved.attachments ?? []).reduce((sum, file) => sum + Buffer.byteLength(file.text), 0);
    if (bytes > MAX_INPUT) throw new Error("Trace-set evidence exceeds 25 MiB");
    loaded.push(resolved);
  }
  return loaded;
}
