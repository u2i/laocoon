// Shared, ecosystem-agnostic diffing over normalized dependency entries.
//
// Every ecosystem parser produces entries with at least these fields; extra
// fields are allowed and compared generically. The canonical comparison set is
// what matters for supply-chain integrity: source, version, registry, hashes,
// and any VCS coordinates.

const COMPARED_FIELDS = [
  "source",
  "version",
  "registry",
  "integrity",
  "innerHash",
  "resolvedUrl",
  "gitUrl",
  "gitRef",
];

/**
 * @param {Record<string, object>} before
 * @param {Record<string, object>} after
 * @returns {LockDiff}
 */
export function diffEntries(before, after) {
  const added = [];
  const removed = [];
  const changed = [];

  for (const [name, a] of Object.entries(after)) {
    const b = before[name];
    if (!b) added.push({ name, after: a });
    else if (!entriesEqual(a, b)) changed.push({ name, before: b, after: a });
  }
  for (const [name, b] of Object.entries(before)) {
    if (!after[name]) removed.push({ name, before: b });
  }
  return { added, removed, changed };
}

function entriesEqual(a, b) {
  return COMPARED_FIELDS.every((f) => (a[f] ?? null) === (b[f] ?? null));
}

export function diffIsEmpty(diff) {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0
  );
}

/** Canonical, order-independent fingerprint of a net diff (per ecosystem). */
export function normEntry(e) {
  return COMPARED_FIELDS.map((f) => e[f] ?? "").join("|");
}

/**
 * @typedef {Object} LockDiff
 * @property {Array<{name:string, after:object}>} added
 * @property {Array<{name:string, before:object}>} removed
 * @property {Array<{name:string, before:object, after:object}>} changed
 */
