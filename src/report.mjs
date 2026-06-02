// Renders the combined multi-ecosystem analysis into a Markdown PR comment
// (with the fingerprint marker) and a job summary.

import { MARKER } from "./github.mjs";

const RISK_EMOJI = { none: "✅", low: "🟢", medium: "🟡", high: "🟠", critical: "🔴" };
const RISK_LABEL = {
  none: "No risk detected",
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

const RISK_ORDER = ["none", "low", "medium", "high", "critical"];
function maxRisk(risks) {
  return risks.reduce(
    (acc, r) => (RISK_ORDER.indexOf(r) > RISK_ORDER.indexOf(acc) ? r : acc),
    "none"
  );
}

/**
 * @param {object} params
 * @param {Array<{ecosystem:string, ecosystemName:string, lockfile:string, analysis:object, diff:object, stages:string[]}>} params.results
 * @param {string} params.fingerprint
 */
export function renderComment({ results, fingerprint }) {
  const overall = maxRisk(results.map((r) => r.analysis.overallRisk));
  const lines = [];
  lines.push(MARKER);
  lines.push(`<!-- fingerprint:${fingerprint} -->`);
  lines.push("## 🐎 Laocoön — Supply Chain Guard");
  lines.push("");
  lines.push(`**Overall risk: ${RISK_EMOJI[overall]} ${RISK_LABEL[overall]}**`);
  lines.push("");

  for (const r of results) {
    lines.push(`### ${r.ecosystemName} — \`${r.lockfile}\``);
    const a = r.analysis;
    lines.push(`**${RISK_EMOJI[a.overallRisk]} ${RISK_LABEL[a.overallRisk]}** — ${a.summary || "no summary"}`);
    lines.push("");
    lines.push(renderChangeTable(r.diff));
    lines.push("");

    if (a.findings.length > 0) {
      for (const f of a.findings) {
        lines.push(`#### ${RISK_EMOJI[f.risk]} \`${f.dependency}\` — ${RISK_LABEL[f.risk]}`);
        if (f.change) lines.push(`- **Change:** ${f.change}`);
        if (f.indicators.length) {
          lines.push(`- **Indicators:**`);
          for (const ind of f.indicators) lines.push(`  - ${ind}`);
        }
        if (f.recommendation) lines.push(`- **Recommendation:** ${f.recommendation}`);
        lines.push("");
      }
    } else {
      lines.push("_No supply-chain risk indicators in the changed dependencies._");
      lines.push("");
    }
    lines.push(
      `<sub>Models: ${r.stages.join(" → ")}. Diffed each dependency against its newest soaked baseline (≥ soak window old, same version lineage).</sub>`
    );
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "<sub>🐎 Laocoön diffs each dependency against a soaked baseline to surface novel, un-vetted code where freshly injected trojans live. Automated heuristic review — verify findings before acting. Binary/minified files cannot be statically reviewed and are flagged, not read.</sub>"
  );
  return lines.join("\n");
}

function renderChangeTable(diff) {
  const rows = [];
  rows.push("<details><summary>Dependency changes analyzed</summary>");
  rows.push("");
  rows.push("| Change | Package | From | To | Source |");
  rows.push("|---|---|---|---|---|");
  for (const c of diff.changed)
    rows.push(`| ✏️ changed | \`${c.name}\` | ${c.before.version ?? "?"} | ${c.after.version ?? "?"} | ${c.after.source} |`);
  for (const a of diff.added)
    rows.push(`| ➕ added | \`${a.name}\` | — | ${a.after.version ?? "?"} | ${a.after.source} |`);
  for (const r of diff.removed)
    rows.push(`| ➖ removed | \`${r.name}\` | ${r.before.version ?? "?"} | — | ${r.before.source} |`);
  rows.push("");
  rows.push("</details>");
  return rows.join("\n");
}

export function renderJobSummary({ results, fingerprint }) {
  return renderComment({ results, fingerprint })
    .replace(MARKER, "")
    .replace(/<!-- fingerprint:[a-f0-9]+ -->/, "")
    .trim();
}

export function overallRiskOf(results) {
  return maxRisk(results.map((r) => r.analysis.overallRisk));
}
