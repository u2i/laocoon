// Provider-agnostic triage→deep cascade, built on the Vercel AI SDK.
//
// Stage 1 (triage): a cheap model scores every PR over signals + filtered diff.
// Stage 2 (deep):   a stronger model re-examines ONLY when triage flags risk,
//                   or when the diff touches install/build hooks, changes a
//                   binary/opaque file, or has no soaked baseline.
//
// The provider for each stage is chosen by a "provider:model" spec (see
// provider.mjs), so triage and deep can even live on different providers.

import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel } from "./provider.mjs";

const RISK_ORDER = ["none", "low", "medium", "high", "critical"];
const RISK_ENUM = z.enum(RISK_ORDER);

const ANALYSIS_SCHEMA = z.object({
  overallRisk: RISK_ENUM,
  summary: z.string().describe("one or two sentence plain-language verdict"),
  needsDeepReview: z
    .boolean()
    .describe("true if a fast/triage model wants a stronger model to take a closer look"),
  findings: z
    .array(
      z.object({
        dependency: z.string(),
        risk: RISK_ENUM,
        change: z.string().describe("short description of what changed"),
        indicators: z.array(z.string()).describe("concrete signals supporting the risk"),
        recommendation: z.string(),
      })
    )
    .describe("only include findings with risk >= low; empty if nothing noteworthy"),
});

const SYSTEM_PROMPT = `You are a security analyst specializing in software supply chain attacks across package ecosystems (Elixir/Hex, JavaScript/npm, Python/PyPI, and others). You review changes to a project's dependency lockfile and judge whether they show signs of a supply chain compromise. The payload names the ecosystem.

KEY METHODOLOGY — soaked-baseline diffing:
The greatest risk is a freshly published TROJAN release of an otherwise-trusted package (maintainer account takeover, compromised CI). Long-standing versions get vetted by the ecosystem over time; brand-new ones do not. For each dependency we therefore diff against a "soaked baseline": the newest release on the SAME version lineage that is older than the soak window. The diff you are shown is baseline -> adopted version. Everything in that diff is NOVEL, UN-SOAKED surface — exactly where an injected payload would live. Focus your suspicion there.

You are given, per dependency: old/new version, the soaked baseline chosen (or a note that none exists), integrity hashes, source (registry/git/path/url), registry signals (release age, downloads, owners, publisher, repository link, retirement/yank), a filtered code diff of security-relevant files, and a list of files that are binary/opaque (NOT shown — they cannot be statically reviewed).

Supply chain attack indicators:
- Code in the diff that exfiltrates env vars/secrets, makes unexpected network calls, executes shell commands, downloads/runs remote code, or is obfuscated/encoded (base64, hex, eval). Weigh build/compile hooks, postinstall scripts, setup.py/build hooks, and release hooks heavily.
- A binary, precompiled NIF, .so/.dll, or minified/bundled blob that is NEW or CHANGED vs the soaked baseline — it cannot be reviewed, so treat as elevated risk and say so explicitly. Do NOT call something clean just because its diff was empty if it is in the opaque-files list.
- No soaked baseline exists (every release is newer than the soak window) — elevated risk; no vetted history to diff against.
- Source switched from the canonical registry to git/path/url, or a non-canonical/typosquat URL.
- Package name typosquats a popular package; dependency-confusion-style additions.
- Release published by a non-owner account; brand-new release adopted within hours; implausible version jump; integrity hash changed for a should-be-immutable version.
- Newly added dep with very low downloads / recently created / no repository link, especially transitive.
- Retired/yanked release or known advisory.

Be calibrated. Routine patch/minor upgrades of well-known packages from the canonical registry, diffing cleanly against a soaked baseline with only benign code changes, are NOT suspicious — say so plainly. Do not invent evidence. Note uncertainty rather than guessing. Reserve critical/high for concrete indicators. Set needsDeepReview true if you are a fast/triage model and see anything warranting a closer look.`;

/**
 * Run the triage→deep cascade for one ecosystem's payload.
 *
 * @param {object} params
 * @param {string} params.triageSpec - "provider:model" for the triage stage
 * @param {string} params.deepSpec   - "provider:model" for the deep stage
 * @param {object} params.payload
 * @param {string[]} params.forceDeepReasons
 * @param {object} [params.env]
 * @returns {Promise<{analysis: Analysis, stages: string[]}>}
 */
export async function analyzeCascade({ triageSpec, deepSpec, payload, forceDeepReasons, env }) {
  const userText = `Analyze the following dependency changes for supply chain attack risk.\n\n${JSON.stringify(
    payload,
    null,
    2
  )}`;

  const stages = [];

  // Stage 1: triage.
  const triage = resolveModel(triageSpec, env);
  let analysis = await runModel(triage, userText);
  stages.push(label(triage));

  const escalate =
    analysis.needsDeepReview ||
    riskRank(analysis.overallRisk) >= riskRank("medium") ||
    (forceDeepReasons && forceDeepReasons.length > 0);

  if (escalate && deepSpec && deepSpec !== triageSpec) {
    const deep = resolveModel(deepSpec, env);
    const reasonNote = [
      forceDeepReasons?.length ? `Escalation reasons: ${forceDeepReasons.join("; ")}.` : "",
      `Triage assessed risk "${analysis.overallRisk}". Perform a careful, skeptical deep review and return your own assessment.`,
    ]
      .filter(Boolean)
      .join(" ");
    analysis = await runModel(deep, `${userText}\n\n${reasonNote}`);
    stages.push(label(deep));
  } else if (escalate && deepSpec === triageSpec) {
    // Same model for both stages: don't pay twice, keep the triage result.
    stages.push(`${label(triage)} (deep=same)`);
  }

  return { analysis, stages };
}

async function runModel({ model, provider, modelId }, prompt) {
  try {
    const { object } = await generateObject({
      model,
      schema: ANALYSIS_SCHEMA,
      system: SYSTEM_PROMPT,
      prompt,
      temperature: 0,
      maxRetries: 2,
    });
    return finalizeAnalysis(object, `${provider}:${modelId}`);
  } catch (err) {
    throw new Error(`LLM call to ${provider}:${modelId} failed: ${err.message}`);
  }
}

/** Never let overallRisk sit below the worst individual finding. */
function finalizeAnalysis(obj, modelLabel) {
  const worst = obj.findings.reduce(
    (acc, f) => (riskRank(f.risk) > riskRank(acc) ? f.risk : acc),
    "none"
  );
  const overallRisk =
    riskRank(obj.overallRisk) >= riskRank(worst) ? obj.overallRisk : worst;
  return { ...obj, overallRisk, model: modelLabel };
}

function label({ provider, modelId }) {
  return `${provider}:${modelId}`;
}

export function normalizeRisk(r) {
  const v = String(r ?? "none").toLowerCase().trim();
  return RISK_ORDER.includes(v) ? v : "none";
}
export function riskRank(r) {
  return RISK_ORDER.indexOf(normalizeRisk(r));
}

/**
 * @typedef {Object} Analysis
 * @property {string} overallRisk
 * @property {string} summary
 * @property {boolean} needsDeepReview
 * @property {Array<{dependency:string,risk:string,change:string,indicators:string[],recommendation:string}>} findings
 * @property {string} model
 */
