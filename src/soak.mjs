// Soaked-baseline selection.
//
// The greatest supply-chain risk is a freshly published trojan release. A
// version that has been public long enough ("soaked") has had time for the
// ecosystem to catch a compromise, so we treat the newest soaked release on the
// SAME version lineage as a presumed-clean baseline and diff the adopted
// version against it. The diff is then the novel, un-soaked surface.

/** Parse a semver-ish string into comparable parts. Tolerant of pre-release. */
export function parseVersion(v) {
  if (!v) return null;
  const m = String(v).match(
    /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+.]?(.*))?$/
  );
  if (!m) return { major: 0, minor: 0, patch: 0, pre: String(v), raw: v };
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    pre: m[4] || "",
    raw: v,
  };
}

export function isPrerelease(v) {
  const p = parseVersion(v);
  return Boolean(p && p.pre);
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  // A release (no pre) outranks a prerelease of the same x.y.z.
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre);
}

/**
 * Choose the soaked baseline version for an adopted version.
 *
 * @param {object} params
 * @param {string} params.adopted               - version being adopted
 * @param {Array<{version:string, insertedAt:string|null}>} params.releases
 * @param {number} params.soakDays              - soak window in days
 * @param {Date} params.now
 * @returns {SoakResult}
 *
 * Selection ladder (each filtered to releases older than soakDays, not the
 * adopted version itself, and version < adopted):
 *   1. same major.minor lineage  (1.1.2 -> newest soaked 1.1.x, e.g. 1.1.0)
 *   2. same major lineage        (-> newest soaked 1.x)
 *   3. any release               (-> newest soaked overall)
 *   4. none -> flagged, no baseline.
 */
export function selectSoakedBaseline({ adopted, releases, soakDays, now }) {
  const cutoff = now.getTime() - soakDays * 86400000;
  const adoptedV = parseVersion(adopted);

  const soaked = releases
    .filter((r) => r.version !== adopted)
    .filter((r) => r.insertedAt && new Date(r.insertedAt).getTime() <= cutoff)
    .filter((r) => compareVersions(r.version, adopted) < 0)
    .filter((r) => !isPrerelease(r.version)) // prefer stable baselines
    .sort((a, b) => compareVersions(b.version, a.version)); // newest first

  const pick = (predicate) => soaked.find(predicate);

  let chosen = null;
  let lineage = null;
  if (adoptedV) {
    chosen = pick(
      (r) => {
        const v = parseVersion(r.version);
        return v && v.major === adoptedV.major && v.minor === adoptedV.minor;
      }
    );
    if (chosen) lineage = "major.minor";
    if (!chosen) {
      chosen = pick((r) => {
        const v = parseVersion(r.version);
        return v && v.major === adoptedV.major;
      });
      if (chosen) lineage = "major";
    }
  }
  if (!chosen) {
    chosen = soaked[0] ?? null;
    if (chosen) lineage = "any";
  }

  if (!chosen) {
    return {
      baselineVersion: null,
      lineage: null,
      reason: `No release of this package is older than the ${soakDays}-day soak window; cannot establish a presumed-clean baseline.`,
    };
  }
  return {
    baselineVersion: chosen.version,
    baselineInsertedAt: chosen.insertedAt,
    lineage,
    reason: null,
  };
}

/**
 * @typedef {Object} SoakResult
 * @property {string|null} baselineVersion
 * @property {string|null} [baselineInsertedAt]
 * @property {"major.minor"|"major"|"any"|null} lineage
 * @property {string|null} reason  - non-null when no baseline could be chosen
 */
