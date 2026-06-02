// Builds the per-dependency analysis payload for one ecosystem: selects the
// soaked baseline, fetches + diffs artifacts, gathers registry signals, and
// flags escalation reasons for the LLM cascade.

import { selectSoakedBaseline } from "./soak.mjs";
import { diffArtifacts } from "./artifact-diff.mjs";

/**
 * @param {object} eco - ecosystem module
 * @param {LockDiff} diff
 * @param {object} opts - { soakDays, now, diffBudgetBytes, log }
 * @returns {Promise<{payload: object, escalate: string[]}>}
 */
export async function buildEcosystemPayload(eco, diff, opts) {
  const { soakDays, now, diffBudgetBytes, log } = opts;
  const escalate = new Set();

  // Targets needing analysis: changed + added entries that are registry-backed.
  const targets = [
    ...diff.changed.map((c) => ({ name: c.name, before: c.before, after: c.after, kind: "changed" })),
    ...diff.added.map((a) => ({ name: a.name, before: null, after: a.after, kind: "added" })),
  ];

  const analyzed = [];
  for (const t of targets) {
    const entry = t.after;
    if (!eco.isRegistryBacked(entry)) {
      // git/path/url source — can't soak-diff against a registry; flag it.
      escalate.add(`${t.name}: non-registry source (${entry.source})`);
      analyzed.push({
        name: t.name,
        kind: t.kind,
        source: entry.source,
        adoptedVersion: entry.version,
        before: t.before ? summarizeEntry(t.before) : null,
        after: summarizeEntry(entry),
        soakedBaseline: null,
        baselineNote: `Source is "${entry.source}", not the canonical registry — no soaked baseline available; review the source/URL directly.`,
        registrySignals: null,
        codeDiff: null,
      });
      continue;
    }

    const pkg = eco.packageKey(entry, t.name);
    const adopted = entry.version;
    const item = {
      name: t.name,
      kind: t.kind,
      source: entry.source,
      adoptedVersion: adopted,
      before: t.before ? summarizeEntry(t.before) : null,
      after: summarizeEntry(entry),
      soakedBaseline: null,
      baselineNote: null,
      registrySignals: null,
      codeDiff: null,
    };

    // 1. Registry signals (release dates, downloads, owners, publisher).
    try {
      item.registrySignals = await eco.fetchContext({
        pkg,
        fromVersion: t.before?.version ?? null,
        toVersion: adopted,
      });
    } catch (e) {
      log(`  signals failed for ${pkg}: ${e.message}`);
    }

    // 2. Pick the soaked baseline from the release history.
    let releases = [];
    try {
      releases = await eco.getReleases(pkg);
    } catch (e) {
      log(`  releases failed for ${pkg}: ${e.message}`);
    }

    const soak = selectSoakedBaseline({ adopted, releases, soakDays, now });
    if (!soak.baselineVersion) {
      item.baselineNote = soak.reason;
      escalate.add(`${t.name}: no soaked baseline (all releases < ${soakDays}d old)`);
    } else {
      item.soakedBaseline = {
        version: soak.baselineVersion,
        insertedAt: soak.baselineInsertedAt ?? null,
        lineage: soak.lineage,
      };
    }

    // 3. Fetch + diff artifacts (soaked baseline -> adopted). If no baseline,
    //    diff against empty so the new surface is still shown.
    try {
      const afterFiles = await eco.fetchArtifact(pkg, adopted);
      const beforeFiles = soak.baselineVersion
        ? await eco.fetchArtifact(pkg, soak.baselineVersion)
        : new Map();
      const ad = diffArtifacts(beforeFiles, afterFiles, diffBudgetBytes);
      item.codeDiff = ad;

      if (ad.opaqueFiles.length > 0) {
        escalate.add(
          `${t.name}: ${ad.opaqueFiles.length} binary/opaque file(s) changed vs baseline`
        );
      }
      if (touchesHooks(ad)) {
        escalate.add(`${t.name}: install/build hook changed`);
      }
      if (ad.droppedFiles.length > 0) {
        log(`  ${t.name}: ${ad.droppedFiles.length} files dropped from diff (budget)`);
      }
    } catch (e) {
      log(`  artifact diff failed for ${pkg}@${adopted}: ${e.message}`);
      item.baselineNote = (item.baselineNote ? item.baselineNote + " " : "") +
        `Could not fetch/unpack artifact: ${e.message}`;
    }

    analyzed.push(item);
  }

  const payload = {
    ecosystem: eco.id,
    ecosystemName: eco.displayName,
    soakDays,
    note: "codeDiff is baseline->adopted. Lines prefixed +/- are added/removed. opaqueFiles are NOT shown (binary/minified) — treat changes to them as elevated risk. Registry signals come from the package registry and may be incomplete.",
    dependencies: analyzed,
    removed: diff.removed.map((r) => ({ name: r.name, before: summarizeEntry(r.before) })),
  };

  return { payload, escalate: [...escalate] };
}

function summarizeEntry(e) {
  return {
    source: e.source,
    version: e.version,
    registry: e.registry,
    integrity: e.integrity,
    gitUrl: e.gitUrl,
    gitRef: e.gitRef,
    resolvedUrl: e.resolvedUrl,
  };
}

const HOOK_RE = /(^|\/)(mix\.exs|package\.json|setup\.py|setup\.cfg|pyproject\.toml|binding\.gyp|Makefile)$|(pre|post)(install|publish|pack)|\.(sh|bash|ps1)$/i;
function touchesHooks(ad) {
  return ad.files.some((f) => HOOK_RE.test(f.path));
}
