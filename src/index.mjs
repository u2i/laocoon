// Entrypoint for the Laocoön composite GitHub Action.
//
// Flow:
//   1. Resolve base/head refs for the PR.
//   2. Detect which known lockfiles changed (across all ecosystems).
//   3. Parse + diff each. Fingerprint the combined net diff; if the existing PR
//      comment already shows that fingerprint, skip (idempotent across pushes).
//   4. For each changed dependency, select a soaked baseline, fetch+diff the
//      published artifacts, gather registry signals.
//   5. Run the Gemini triage→deep cascade per ecosystem.
//   6. Post/update one PR comment + job summary; fail if risk >= fail-on.

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

import { diffEntries, diffIsEmpty, normEntry } from "./diff.mjs";
import {
  ecosystemForLockfile,
  allLockfileNames,
  selectEcosystems,
} from "./ecosystems/index.mjs";
import { buildEcosystemPayload } from "./pipeline.mjs";
import { analyzeCascade, riskRank, normalizeRisk } from "./llm.mjs";
import {
  readEvent,
  resolveRefs,
  gitShow,
  ensureRef,
  listChangedFiles,
  findExistingComment,
  upsertComment,
} from "./github.mjs";
import { renderComment, renderJobSummary, overallRiskOf } from "./report.mjs";

function setOutput(name, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `${name}=${String(value).replace(/\r?\n/g, " ")}\n`);
}
function writeSummary(md) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f && md) appendFileSync(f, md + "\n");
}
function log(msg) {
  process.stdout.write(`[laocoon] ${msg}\n`);
}

function nowDate() {
  // SOURCE_DATE / CI clock; Date is available at runtime in the action (this is
  // not a Workflow script). Allow override for deterministic testing.
  const override = process.env.LAOCOON_NOW;
  return override ? new Date(override) : new Date();
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  const triageModel = process.env.INPUT_TRIAGE_MODEL || "gemini-3.1-flash-lite";
  const deepModel = process.env.INPUT_DEEP_MODEL || "gemini-3.5-flash";
  const failOnRaw = (process.env.INPUT_FAIL_ON || "high").toLowerCase();
  const failOn = normalizeRisk(failOnRaw);
  const failNever = failOnRaw === "none";
  const doComment = (process.env.INPUT_COMMENT || "true").toLowerCase() !== "false";
  const overrideBase = process.env.INPUT_BASE_REF || "";
  const soakDays = parseInt(process.env.INPUT_SOAK_DAYS || "60", 10);
  const diffBudgetBytes = parseInt(process.env.INPUT_MAX_DIFF_BYTES || "60000", 10);
  const ecoFilter = process.env.INPUT_ECOSYSTEMS || "";
  const lockfileOverride = process.env.INPUT_LOCKFILE || "";

  if (!apiKey) {
    log("ERROR: gemini-api-key input is required.");
    process.exit(1);
  }

  const event = readEvent();
  const { base, head, prNumber } = resolveRefs(event, overrideBase);
  if (base) ensureRef(base);

  const ecosystems = selectEcosystems(ecoFilter);
  const knownLockfiles = lockfileOverride
    ? [lockfileOverride]
    : allLockfileNames();

  // Which lockfiles actually changed in this PR?
  const changedFiles = base ? listChangedFiles(base, head) : [];
  const targets = knownLockfiles
    .map((basename) => {
      // Find a changed path whose basename matches (supports monorepo subdirs).
      const path =
        changedFiles.find((p) => p.split("/").pop() === basename) ||
        (changedFiles.length === 0 ? basename : null);
      return path ? { path, basename } : null;
    })
    .filter(Boolean)
    .filter((t) => {
      const eco = ecosystemForLockfile(t.basename);
      return eco && ecosystems.includes(eco);
    });

  if (targets.length === 0) {
    log("No tracked lockfiles changed in this PR. Nothing to analyze.");
    setOutput("risk-level", "none");
    setOutput("findings-json", "[]");
    return;
  }
  log(`Lockfiles to analyze: ${targets.map((t) => t.path).join(", ")}`);

  // Parse + diff each lockfile.
  const ecoDiffs = [];
  for (const t of targets) {
    const eco = ecosystemForLockfile(t.basename);
    const beforeText = base ? gitShow(base, t.path) : "";
    let afterText = "";
    try {
      afterText = readFileSync(t.path, "utf8");
    } catch {
      afterText = head ? gitShow(head, t.path) : "";
    }
    if (!afterText) continue;
    const diff = diffEntries(
      eco.parse(beforeText, t.path),
      eco.parse(afterText, t.path)
    );
    if (diffIsEmpty(diff)) continue;
    ecoDiffs.push({ eco, lockfile: t.path, diff });
  }

  if (ecoDiffs.length === 0) {
    log("Lockfiles changed but no dependency entries differ. Skipping.");
    setOutput("risk-level", "none");
    setOutput("findings-json", "[]");
    return;
  }

  const fingerprint = fingerprintAll(ecoDiffs);

  // Fingerprint-skip: identical net diff already analyzed.
  if (doComment && prNumber) {
    const existing = await findExistingComment(prNumber);
    if (existing && existing.fingerprint === fingerprint) {
      log("Net lockfile diff unchanged since last analyzed run — skipping LLM cascade.");
      setOutput("risk-level", "skipped");
      setOutput("findings-json", "[]");
      return;
    }
  }

  const now = nowDate();
  const results = [];
  for (const { eco, lockfile, diff } of ecoDiffs) {
    log(`Analyzing ${eco.displayName} (${lockfile}): ${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed.`);
    const { payload, escalate } = await buildEcosystemPayload(eco, diff, {
      soakDays,
      now,
      diffBudgetBytes,
      log,
    });
    log(`  cascade: triage=${triageModel}${escalate.length ? ` (force-deep: ${escalate.join("; ")})` : ""}`);
    let analysis, stages;
    try {
      ({ analysis, stages } = await analyzeCascade({
        apiKey,
        triageModel,
        deepModel,
        payload,
        forceDeepReasons: escalate,
      }));
    } catch (e) {
      log(`ERROR in LLM cascade for ${eco.id}: ${e.message}`);
      process.exit(1);
    }
    log(`  ${eco.id} risk: ${analysis.overallRisk} (stages: ${stages.join(" → ")})`);
    results.push({
      ecosystem: eco.id,
      ecosystemName: eco.displayName,
      lockfile,
      analysis,
      diff,
      stages,
    });
  }

  const overall = overallRiskOf(results);
  const commentBody = renderComment({ results, fingerprint });

  if (doComment && prNumber) {
    try {
      await upsertComment(prNumber, commentBody);
      log("PR comment posted/updated.");
    } catch (e) {
      log(`WARNING: failed to post PR comment: ${e.message}`);
    }
  }
  writeSummary(renderJobSummary({ results, fingerprint }));

  const allFindings = results.flatMap((r) =>
    r.analysis.findings.map((f) => ({ ecosystem: r.ecosystem, ...f }))
  );
  setOutput("risk-level", overall);
  setOutput("findings-json", JSON.stringify(allFindings));

  if (!failNever && riskRank(overall) >= riskRank(failOn)) {
    log(`Overall risk ${overall} >= fail-on ${failOn}. Failing the check.`);
    process.exit(1);
  }
}

function fingerprintAll(ecoDiffs) {
  const parts = [];
  for (const { eco, diff } of ecoDiffs) {
    for (const c of diff.changed)
      parts.push(`${eco.id}:C:${c.name}:${normEntry(c.before)}=>${normEntry(c.after)}`);
    for (const a of diff.added) parts.push(`${eco.id}:A:${a.name}:${normEntry(a.after)}`);
    for (const r of diff.removed) parts.push(`${eco.id}:R:${r.name}:${normEntry(r.before)}`);
  }
  parts.sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

main().catch((e) => {
  log(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
