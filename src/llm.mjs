// Google Gemini client + the two-stage triage/deep cascade.
//
// Stage 1 (triage): a cheap model scores every PR over signals + filtered diff.
// Stage 2 (deep):   a stronger model re-examines ONLY when triage flags risk,
//                   or when the diff touches install/build hooks, changes a
//                   binary/opaque file, or has no soaked baseline.

const RISK_ORDER = ["none", "low", "medium", "high", "critical"];

const SYSTEM_PROMPT = `You are a security analyst specializing in software supply chain attacks across package ecosystems (Elixir/Hex, JavaScript/npm, Python/PyPI, and others). You review changes to a project's dependency lockfile and judge whether they show signs of a supply chain compromise. The payload names the ecosystem.

KEY METHODOLOGY — soaked-baseline diffing:
The greatest risk is a freshly published TROJAN release of an otherwise-trusted package (maintainer account takeover, compromised CI). Long-standing versions get vetted by the ecosystem over time; brand-new ones do not. For each dependency we therefore diff against a "soaked baseline": the newest release on the SAME version lineage that is older than the soak window (so the ecosystem has had time to catch problems in it). The diff you are shown is baseline -> adopted version. Everything in that diff is NOVEL, UN-SOAKED surface — exactly where an injected payload would live. Focus your suspicion there.

You are given, per dependency: old/new version, the soaked baseline version chosen (or a note that none exists), integrity hashes, source (registry/git/path/url), registry signals (release age, downloads, owners, publisher, repository link, retirement/yank), a filtered code diff of security-relevant files, and a list of files that are binary/opaque (NOT shown — they cannot be statically reviewed).

Supply chain attack indicators:
- Code in the diff that exfiltrates env vars/secrets, makes unexpected network calls, executes shell commands, downloads/runs remote code, or is obfuscated/encoded (base64, hex, eval). Weigh build/compile hooks, postinstall scripts, setup.py/build hooks, and release hooks heavily.
- A binary, precompiled NIF, .so/.dll, or minified/bundled blob that is NEW or CHANGED vs the soaked baseline — it cannot be reviewed, so treat as elevated risk and say so explicitly. Do NOT call something clean just because its diff was empty if it is in the opaque-files list.
- No soaked baseline exists (every release is newer than the soak window) — elevated risk; the package has no vetted history to diff against.
- Source switched from the canonical registry to git/path/url, or a non-canonical/typosquat URL.
- Package name typosquats a popular package; dependency-confusion-style additions.
- Release published by a non-owner account; brand-new release adopted within hours; implausible version jump; integrity hash changed for a should-be-immutable version.
- Newly added dep with very low downloads / recently created / no repository link, especially transitive.
- Retired/yanked release or known advisory.

Be calibrated. Routine patch/minor upgrades of well-known packages from the canonical registry, diffing cleanly against a soaked baseline with only benign code changes, are NOT suspicious — say so plainly. Do not invent evidence. Note uncertainty rather than guessing. Reserve critical/high for concrete indicators.

Respond with ONLY a JSON object (no markdown fences):
{
  "overallRisk": "none|low|medium|high|critical",
  "summary": "one or two sentence verdict",
  "needsDeepReview": false,
  "findings": [
    { "dependency": "name", "risk": "none|low|medium|high|critical", "change": "what changed", "indicators": ["concrete signal"], "recommendation": "what to do" }
  ]
}
Set needsDeepReview true if you are a fast/triage model and you see anything that warrants a closer look by a stronger model. Only include findings with risk >= low.`;

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

async function callGemini({ apiKey, model, userText }) {
  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini API HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? "";
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason || "unknown";
    throw new Error(`Gemini returned no text (finishReason: ${reason})`);
  }
  return text;
}

/**
 * Run the cascade for one ecosystem's payload.
 * @returns {Promise<{analysis: Analysis, stages: string[]}>}
 */
export async function analyzeCascade({ apiKey, triageModel, deepModel, payload, forceDeepReasons }) {
  const userText = `Analyze the following dependency changes for supply chain attack risk.\n\n${JSON.stringify(
    payload,
    null,
    2
  )}`;

  const stages = [];
  // Stage 1: triage.
  const triageText = await callGemini({ apiKey, model: triageModel, userText });
  let analysis = normalizeAnalysis(extractJson(triageText), triageText, triageModel);
  stages.push(triageModel);

  const escalate =
    analysis.needsDeepReview ||
    riskRank(analysis.overallRisk) >= riskRank("medium") ||
    (forceDeepReasons && forceDeepReasons.length > 0);

  if (escalate && deepModel && deepModel !== triageModel) {
    const reasonNote = [
      forceDeepReasons?.length ? `Escalation reasons: ${forceDeepReasons.join("; ")}.` : "",
      `Triage model assessed risk "${analysis.overallRisk}". Perform a careful, skeptical deep review and return your own assessment.`,
    ]
      .filter(Boolean)
      .join(" ");
    const deepText = await callGemini({
      apiKey,
      model: deepModel,
      userText: `${userText}\n\n${reasonNote}`,
    });
    analysis = normalizeAnalysis(extractJson(deepText), deepText, deepModel);
    stages.push(deepModel);
  }

  return { analysis, stages };
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("LLM response had no JSON object");
  return JSON.parse(candidate.slice(start, end + 1));
}

function normalizeAnalysis(obj, rawText, model) {
  const findings = (Array.isArray(obj.findings) ? obj.findings : []).map((f) => ({
    dependency: String(f.dependency ?? "unknown"),
    risk: normalizeRisk(f.risk),
    change: String(f.change ?? ""),
    indicators: Array.isArray(f.indicators) ? f.indicators.map(String) : [],
    recommendation: String(f.recommendation ?? ""),
  }));
  const worst = findings.reduce(
    (acc, f) => (riskRank(f.risk) > riskRank(acc) ? f.risk : acc),
    "none"
  );
  const stated = normalizeRisk(obj.overallRisk);
  const overallRisk = riskRank(stated) >= riskRank(worst) ? stated : worst;
  return {
    overallRisk,
    summary: String(obj.summary ?? "").trim(),
    needsDeepReview: Boolean(obj.needsDeepReview),
    findings,
    model,
    raw: rawText,
  };
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
 * @property {string} raw
 */
