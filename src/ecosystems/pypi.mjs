// Python / PyPI ecosystem support: parses poetry.lock, uv.lock, Pipfile.lock,
// and pinned requirements.txt, and fetches signals from the PyPI JSON API.
//
// Python's attack surface is arbitrary code in setup.py / build hooks (run at
// install time for sdists) — caught by the artifact differ's hook detection.
// We prefer diffing the sdist (source) over wheels (often prebuilt/opaque).

import { unpackTarball } from "../untar.mjs";
import { baseContext, computeCadence } from "./registry-context.mjs";

export const id = "pypi";
export const displayName = "Python (PyPI)";
export const lockfiles = ["poetry.lock", "uv.lock", "Pipfile.lock", "requirements.txt"];

export function parse(contents, filename = "") {
  if (!contents) return {};
  const base = filename.split("/").pop();
  if (base === "Pipfile.lock") return parsePipfileLock(contents);
  if (base === "requirements.txt") return parseRequirements(contents);
  // poetry.lock and uv.lock are both TOML with [[package]] arrays.
  return parseTomlPackages(contents);
}

// ---- poetry.lock / uv.lock : TOML [[package]] stanzas ----

function parseTomlPackages(contents) {
  const entries = {};
  // Split into [[package]] blocks without a full TOML parser. The delimiter is
  // a line consisting of "[[package]]"; everything after it up to the next
  // table header is that package's body.
  const blocks = contents.split(/^\s*\[\[package\]\]\s*$/m);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) continue;
    // Stop the block at the next top-level table header ("[" not "[[" handled
    // by the split; also stop at the next "[[").
    const body = block.split(/\n\s*\[/)[0];
    const name = tomlStr(body, "name");
    const version = tomlStr(body, "version");
    if (!name || !version) continue;
    const norm = normalizePy(name, version);
    applySource(norm, body);
    // hashes (poetry: files=[{hash=...}], uv: sdist={hash=...})
    const hashes = [...body.matchAll(/hash\s*=\s*"(sha256:[a-f0-9]+)"/g)].map((m) => m[1]);
    if (hashes.length) norm.integrity = hashes[0];
    entries[name.toLowerCase()] = norm;
  }
  return entries;
}

function applySource(norm, body) {
  // uv: source = { registry = "https://pypi.org/simple" } | { git = "..." } | { url = "..." }
  const git = body.match(/source\s*=\s*\{[^}]*\bgit\s*=\s*"([^"]+)"/);
  const url = body.match(/source\s*=\s*\{[^}]*\burl\s*=\s*"([^"]+)"/);
  const reg = /source\s*=\s*\{[^}]*\bregistry\s*=/.test(body);
  if (git) { norm.source = "git"; norm.gitUrl = git[1]; norm.registry = null; }
  else if (url) { norm.source = "url"; norm.resolvedUrl = url[1]; norm.registry = null; }
  else if (reg) { norm.source = "pypi"; }
  // poetry sets source via [package.source] table; default is pypi.
}

function tomlStr(body, key) {
  const m = body.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*"([^"]+)"`));
  return m ? m[1] : null;
}

// ---- Pipfile.lock : JSON ----

function parsePipfileLock(contents) {
  const entries = {};
  let json;
  try { json = JSON.parse(contents); } catch { return entries; }
  for (const section of ["default", "develop"]) {
    const deps = json[section];
    if (!deps) continue;
    for (const [name, info] of Object.entries(deps)) {
      const version = (info.version || "").replace(/^==/, "") || null;
      const norm = normalizePy(name, version);
      if (Array.isArray(info.hashes) && info.hashes[0]) norm.integrity = info.hashes[0];
      if (info.git) { norm.source = "git"; norm.gitUrl = info.git; norm.registry = null; }
      else if (info.file || info.path) { norm.source = "path"; norm.resolvedUrl = info.file || info.path; norm.registry = null; }
      entries[name.toLowerCase()] = norm;
    }
  }
  return entries;
}

// ---- requirements.txt : only fully-pinned (==) lines are analyzable ----

function parseRequirements(contents) {
  const entries = {};
  for (const raw of contents.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line.startsWith("-")) continue; // skip flags/options
    const m = line.match(/^([A-Za-z0-9._-]+)\s*==\s*([A-Za-z0-9._+!-]+)/);
    if (!m) continue; // unpinned/range — no exact version to soak-diff
    const name = m[1];
    const norm = normalizePy(name, m[2]);
    const hash = line.match(/--hash=(sha256:[a-f0-9]+)/);
    if (hash) norm.integrity = hash[1];
    entries[name.toLowerCase()] = norm;
  }
  return entries;
}

function normalizePy(name, version) {
  return {
    name,
    source: "pypi",
    version,
    registry: "pypi.org",
    integrity: null,
    innerHash: null,
    resolvedUrl: null,
    gitUrl: null,
    gitRef: null,
    packageId: normalizeName(name),
    raw: `${name}==${version}`,
  };
}

// PEP 503 normalization for the registry URL.
function normalizeName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

// ---- ecosystem hooks ----

export function isRegistryBacked(entry) {
  return entry.source === "pypi";
}
export function packageKey(entry, name) {
  return entry.packageId || normalizeName(name);
}

const PYPI = "https://pypi.org/pypi";
let _cache = new Map();

async function getProject(pkg) {
  if (_cache.has(pkg)) return _cache.get(pkg);
  const res = await fetch(`${PYPI}/${encodeURIComponent(pkg)}/json`, {
    headers: { Accept: "application/json", "User-Agent": "laocoon-supply-chain-guard" },
  });
  if (res.status === 404) { _cache.set(pkg, null); return null; }
  if (!res.ok) throw new Error(`PyPI ${pkg} -> HTTP ${res.status}`);
  const json = await res.json();
  _cache.set(pkg, json);
  return json;
}

export async function getReleases(pkg) {
  const doc = await getProject(pkg);
  if (!doc) return [];
  const out = [];
  for (const [version, files] of Object.entries(doc.releases || {})) {
    if (!Array.isArray(files) || files.length === 0) continue;
    // Earliest upload across the version's files.
    const dates = files.map((f) => f.upload_time_iso_8601).filter(Boolean).sort();
    out.push({ version, insertedAt: dates[0] || null });
  }
  return out;
}

export async function fetchContext({ pkg, fromVersion, toVersion }) {
  const ctx = baseContext({ registry: "PyPI", pkg, fromVersion, toVersion });
  try {
    const doc = await getProject(pkg);
    if (!doc) {
      ctx.notes.push("Package not found on PyPI — verify it is real and not a typosquat.");
      return ctx;
    }
    ctx.available = true;
    ctx.htmlUrl = `https://pypi.org/project/${pkg}/`;
    const urls = doc.info?.project_urls || {};
    ctx.repository =
      urls.Source || urls.Homepage || urls.Repository || doc.info?.home_page || null;
    // PyPI does not expose maintainer accounts via JSON API; author is a weak proxy.
    if (doc.info?.author) ctx.owners = [doc.info.author];

    const relDates = (v) => {
      const files = doc.releases?.[v] || [];
      const d = files.map((f) => f.upload_time_iso_8601).filter(Boolean).sort();
      return d[0] || null;
    };
    ctx.releaseInsertedAt = relDates(toVersion);
    ctx.fromReleaseInsertedAt = fromVersion ? relDates(fromVersion) : null;
    computeCadence(ctx);

    const toFiles = doc.releases?.[toVersion] || [];
    if (toFiles.some((f) => f.yanked)) {
      const reason = toFiles.find((f) => f.yanked)?.yanked_reason || "";
      ctx.retired = `yanked${reason ? `: ${reason}` : ""}`;
      ctx.notes.push(`Release ${toVersion} is yanked on PyPI${reason ? `: ${reason}` : ""}.`);
    }
    if (!toFiles.some((f) => f.packagetype === "sdist")) {
      ctx.notes.push("No sdist published for this version — only wheels (often prebuilt/opaque); source cannot be fully diffed.");
    }
  } catch (err) {
    ctx.notes.push(`PyPI lookup failed: ${err.message}`);
  }
  return ctx;
}

/**
 * Download and unpack the sdist for a version into a path -> Buffer map.
 * sdists are gzipped tar with a "<name>-<version>/" top-level prefix, stripped
 * so paths line up across versions. Falls back to a pure-python wheel (a zip)
 * only if no sdist exists — but wheels aren't supported by our tar unpacker, so
 * we surface that as "no diffable source" rather than guessing.
 */
export async function fetchArtifact(pkg, version) {
  const doc = await getProject(pkg);
  const files = doc?.releases?.[version] || [];
  const sdist = files.find((f) => f.packagetype === "sdist" && /\.tar\.gz$/.test(f.filename));
  if (!sdist) {
    throw new Error(`no sdist (.tar.gz) for ${pkg}==${version}; only wheels — source not diffable`);
  }
  const res = await fetch(sdist.url, { headers: { "User-Agent": "laocoon-supply-chain-guard" } });
  if (!res.ok) throw new Error(`PyPI sdist ${pkg}==${version} -> HTTP ${res.status}`);
  const all = unpackTarball(Buffer.from(await res.arrayBuffer()));
  const stripped = new Map();
  const prefix = new RegExp(`^[^/]+/`); // strip the single top-level dir
  for (const [p, buf] of all) {
    stripped.set(p.replace(prefix, ""), buf);
  }
  return stripped;
}
