// Shared registry-context shape + helpers used by every ecosystem module.
// Keeps the RegistryContext consistent so the LLM payload looks identical
// regardless of which registry the signals came from.

/**
 * @param {object} p
 * @param {string} p.registry  - e.g. "hex.pm", "npm", "PyPI"
 * @param {string} p.pkg
 * @param {string|null} p.fromVersion
 * @param {string} p.toVersion
 * @returns {RegistryContext}
 */
export function baseContext({ registry, pkg, fromVersion, toVersion }) {
  return {
    registry,
    package: pkg,
    fromVersion,
    toVersion,
    available: false,
    repository: null,
    htmlUrl: null,
    totalDownloads: null,
    releaseInsertedAt: null,
    fromReleaseInsertedAt: null,
    daysBetweenReleases: null,
    publishedByDifferentOwner: null,
    owners: null,
    retired: null,
    notes: [],
  };
}

/** Fill daysBetweenReleases when both endpoints have dates. */
export function computeCadence(ctx) {
  if (ctx.releaseInsertedAt && ctx.fromReleaseInsertedAt) {
    const d =
      (new Date(ctx.releaseInsertedAt) - new Date(ctx.fromReleaseInsertedAt)) / 86400000;
    ctx.daysBetweenReleases = Math.round(d * 10) / 10;
  }
}

/**
 * @typedef {Object} RegistryContext
 * @property {string} registry
 * @property {string} package
 * @property {string|null} fromVersion
 * @property {string} toVersion
 * @property {boolean} available
 * @property {string|null} repository
 * @property {string|null} htmlUrl
 * @property {number|null} totalDownloads
 * @property {string|null} releaseInsertedAt
 * @property {string|null} fromReleaseInsertedAt
 * @property {number|null} daysBetweenReleases
 * @property {string|null} publishedByDifferentOwner
 * @property {string[]|null} owners
 * @property {string|null} retired
 * @property {string[]} notes
 */
