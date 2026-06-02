// Ecosystem-agnostic diffing of two unpacked package artifacts (file trees).
//
// Each ecosystem returns a file map: { "relative/path": Buffer }. We classify
// each changed file as text or opaque (binary/minified/huge), and for text
// files produce a compact line diff. Opaque files are NEVER sent to the LLM —
// only their metadata, flagged so a changed binary is treated as elevated risk
// rather than silently "clean".

import { createHash } from "node:crypto";

// Files most likely to carry a payload — prioritized when filling the budget.
const HIGH_PRIORITY = [
  /(^|\/)mix\.exs$/i,
  /(^|\/)package\.json$/i,
  /(^|\/)setup\.py$/i,
  /(^|\/)setup\.cfg$/i,
  /(^|\/)pyproject\.toml$/i,
  /(^|\/)Makefile$/i,
  /(^|\/)binding\.gyp$/i,
  /(^|\/)\.?(pre|post)(install|publish|pack)/i,
  /(^|\/)(install|build|configure|hook|gen)[^/]*\.(sh|exs|ex|py|js|cjs|mjs|rb)$/i,
  /\.(sh|bash|ps1)$/i,
];

const BINARY_EXT =
  /\.(beam|so|dll|dylib|a|o|node|wasm|exe|bin|class|jar|png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tgz|bz2|xz|7z|woff2?|ttf|eot|mp[34]|mov|wav)$/i;

const MAX_PER_FILE_BYTES = 12000;

/** Heuristic: is this content opaque to static review? */
export function classifyContent(path, buf) {
  if (BINARY_EXT.test(path)) return { opaque: true, reason: "binary file type" };
  if (!buf || buf.length === 0) return { opaque: false, reason: null };
  // Null byte => binary.
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.includes(0)) return { opaque: true, reason: "binary content (null bytes)" };
  // Non-UTF8 / high non-printable ratio.
  let nonPrintable = 0;
  for (const b of sample) {
    if (b < 9 || (b > 13 && b < 32)) nonPrintable++;
  }
  if (nonPrintable / sample.length > 0.1)
    return { opaque: true, reason: "non-text content" };
  const text = buf.toString("utf8");
  // Minified / bundled: very long lines.
  const longest = text.split("\n").reduce((m, l) => Math.max(m, l.length), 0);
  if (longest > 5000)
    return { opaque: true, reason: "minified/bundled (very long lines)" };
  return { opaque: false, reason: null };
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/**
 * Diff two file maps.
 * @param {Map<string,Buffer>|Record<string,Buffer>} beforeFiles  (may be empty)
 * @param {Map<string,Buffer>|Record<string,Buffer>} afterFiles
 * @param {number} budgetBytes - overall cap on emitted text diff
 * @returns {ArtifactDiff}
 */
export function diffArtifacts(beforeFiles, afterFiles, budgetBytes) {
  const before = toMap(beforeFiles);
  const after = toMap(afterFiles);

  const changedPaths = new Set([...before.keys(), ...after.keys()]);
  const fileChanges = [];
  const opaqueChanges = [];

  for (const path of changedPaths) {
    const b = before.get(path);
    const a = after.get(path);
    const status = !b ? "added" : !a ? "removed" : null;
    if (status === null && b.equals(a)) continue; // unchanged

    const effective = a ?? b;
    const cls = classifyContent(path, effective);
    if (cls.opaque) {
      opaqueChanges.push({
        path,
        status: status ?? "modified",
        reason: cls.reason,
        oldSize: b ? b.length : 0,
        newSize: a ? a.length : 0,
        oldHash: b ? sha256(b) : null,
        newHash: a ? sha256(a) : null,
      });
      continue;
    }
    fileChanges.push({
      path,
      status: status ?? "modified",
      before: b ? b.toString("utf8") : "",
      after: a ? a.toString("utf8") : "",
      priority: HIGH_PRIORITY.some((re) => re.test(path)) ? 0 : 1,
    });
  }

  // Emit high-priority files first, then the rest, until the budget is spent.
  fileChanges.sort((x, y) => x.priority - y.priority || x.path.localeCompare(y.path));

  let spent = 0;
  const emitted = [];
  const dropped = [];
  for (const fc of fileChanges) {
    if (spent >= budgetBytes) {
      dropped.push(fc.path);
      continue;
    }
    const diffText = makeLineDiff(fc.before, fc.after, MAX_PER_FILE_BYTES);
    if (spent + diffText.length > budgetBytes && emitted.length > 0) {
      dropped.push(fc.path);
      continue;
    }
    spent += diffText.length;
    emitted.push({ path: fc.path, status: fc.status, diff: diffText });
  }

  return {
    files: emitted,
    opaqueFiles: opaqueChanges,
    droppedFiles: dropped,
    bytesEmitted: spent,
    totalChangedFiles: fileChanges.length + opaqueChanges.length,
  };
}

function toMap(x) {
  if (x instanceof Map) return x;
  return new Map(Object.entries(x || {}));
}

/**
 * Compact line-level diff. Not a true LCS — a cheap, readable hunk format that
 * is plenty for an LLM to spot injected code. Truncates per-file.
 */
function makeLineDiff(before, after, cap) {
  if (before === after) return "";
  const bl = before.split("\n");
  const al = after.split("\n");
  const beforeSet = new Set(bl);
  const afterSet = new Set(al);

  const out = [];
  // Removed lines.
  for (const l of bl) {
    if (!afterSet.has(l)) out.push(`- ${l}`);
  }
  // Added lines.
  for (const l of al) {
    if (!beforeSet.has(l)) out.push(`+ ${l}`);
  }
  let text = out.join("\n");
  if (text.length > cap) {
    text = text.slice(0, cap) + `\n… [truncated, ${out.length} changed lines total]`;
  }
  return text;
}

/**
 * @typedef {Object} ArtifactDiff
 * @property {Array<{path:string,status:string,diff:string}>} files
 * @property {Array<{path:string,status:string,reason:string,oldSize:number,newSize:number,oldHash:string|null,newHash:string|null}>} opaqueFiles
 * @property {string[]} droppedFiles
 * @property {number} bytesEmitted
 * @property {number} totalChangedFiles
 */
