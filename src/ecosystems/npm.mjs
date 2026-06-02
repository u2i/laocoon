// JavaScript / npm ecosystem support: parses package-lock.json (v2/v3) and
// yarn/pnpm lockfiles, and fetches signals from the npm registry.
//
// npm's defining supply-chain vector is lifecycle scripts (postinstall, etc.)
// in package.json — so fetchContext surfaces the adopted version's install
// scripts, and the artifact differ's hook detection flags package.json changes.

import { unpackTarball } from "../untar.mjs";
import { baseContext, computeCadence } from "./registry-context.mjs";

export const id = "npm";
export const displayName = "JavaScript (npm)";
export const lockfiles = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"];

/**
 * Parse an npm-family lockfile into name -> normalized entry.
 * Dispatches on the filename hint passed by the registry, falling back to
 * sniffing the content.
 */
export function parse(contents, filename = "") {
  if (!contents) return {};
  if (filename.endsWith("yarn.lock") || /^# yarn lockfile/m.test(contents)) {
    return parseYarn(contents);
  }
  if (filename.endsWith("pnpm-lock.yaml") || /^lockfileVersion:/m.test(contents)) {
    return parsePnpm(contents);
  }
  return parsePackageLock(contents);
}

// ---- package-lock.json / npm-shrinkwrap.json (lockfileVersion 2 & 3) ----

function parsePackageLock(contents) {
  const entries = {};
  let json;
  try {
    json = JSON.parse(contents);
  } catch {
    return entries;
  }

  // v2/v3: the "packages" map keyed by install path ("node_modules/<name>").
  if (json.packages && typeof json.packages === "object") {
    for (const [path, info] of Object.entries(json.packages)) {
      if (!path || path === "") continue; // root project
      const name = pkgNameFromPath(path);
      if (!name) continue;
      // Skip workspace/link entries (no version + link:true).
      if (info.link) continue;
      // Prefer the shallowest occurrence: a top-level node_modules/<name> entry
      // beats a nested node_modules/.../node_modules/<name> duplicate.
      const depth = (path.match(/node_modules\//g) || []).length;
      const existing = entries[name];
      if (existing && existing._depth <= depth) continue;
      entries[name] = { ...normalize(name, info), _depth: depth };
    }
    for (const e of Object.values(entries)) delete e._depth;
    if (Object.keys(entries).length) return entries;
  }

  // v1 fallback: nested "dependencies".
  if (json.dependencies && typeof json.dependencies === "object") {
    walkV1(json.dependencies, entries);
  }
  return entries;
}

function walkV1(deps, out) {
  for (const [name, info] of Object.entries(deps)) {
    out[name] = normalize(name, info);
    if (info.dependencies) walkV1(info.dependencies, out);
  }
}

function pkgNameFromPath(path) {
  // "node_modules/a/node_modules/@scope/b" -> "@scope/b"
  const idx = path.lastIndexOf("node_modules/");
  const tail = idx === -1 ? path : path.slice(idx + "node_modules/".length);
  return tail || null;
}

function normalize(name, info) {
  const resolved = info.resolved || null;
  let source = "npm";
  if (resolved && /^git\+|\.git(#|$)|^github:/.test(resolved)) source = "git";
  else if (resolved && /^file:|^link:/.test(resolved)) source = "path";
  else if (resolved && !/registry\.npmjs\.org|registry\.yarnpkg\.com/.test(resolved) && /^https?:/.test(resolved))
    source = "url"; // non-canonical registry / tarball URL
  return {
    name,
    source,
    version: info.version || null,
    registry: source === "npm" ? "npmjs.org" : null,
    integrity: info.integrity || null,
    innerHash: info.shasum || null,
    resolvedUrl: resolved,
    gitUrl: source === "git" ? resolved : null,
    gitRef: null,
    packageId: name,
    raw: JSON.stringify({ version: info.version, resolved, integrity: info.integrity }),
  };
}

// ---- yarn.lock (classic v1) ----

function parseYarn(contents) {
  const entries = {};
  const blocks = contents.split(/\n(?=\S)/); // top-level entries start at col 0
  for (const block of blocks) {
    const header = block.split("\n")[0];
    if (!header || header.startsWith("#") || !header.includes(":")) continue;
    // header is one or more comma-separated specs: `"@scope/n@^1.0.0", n@~2:`
    const firstSpec = header.replace(/:$/, "").split(",")[0].trim().replace(/^"|"$/g, "");
    const name = specName(firstSpec);
    if (!name) continue;
    const version = (block.match(/\n\s+version\s+"?([^"\n]+)"?/) || [])[1] || null;
    const resolved = (block.match(/\n\s+resolved\s+"?([^"\n]+)"?/) || [])[1] || null;
    const integrity = (block.match(/\n\s+integrity\s+([^\n]+)/) || [])[1]?.trim() || null;
    let source = "npm";
    if (resolved && /^git\+|\.git#|codeload\.github/.test(resolved)) source = "git";
    else if (resolved && !/registry\.(npmjs\.org|yarnpkg\.com)/.test(resolved) && /^https?:/.test(resolved))
      source = "url";
    entries[name] = {
      name, source, version,
      registry: source === "npm" ? "npmjs.org" : null,
      integrity, innerHash: null,
      resolvedUrl: resolved, gitUrl: source === "git" ? resolved : null, gitRef: null,
      packageId: name, raw: header,
    };
  }
  return entries;
}

function specName(spec) {
  // "@scope/name@^1.2.3" -> "@scope/name"; "name@1.2.3" -> "name"
  if (spec.startsWith("@")) {
    const at = spec.indexOf("@", 1);
    return at === -1 ? spec : spec.slice(0, at);
  }
  const at = spec.indexOf("@");
  return at === -1 ? spec : spec.slice(0, at);
}

// ---- pnpm-lock.yaml (tolerant; the packages: section) ----

function parsePnpm(contents) {
  const entries = {};
  const lines = contents.split("\n");
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (inPackages && /^\S/.test(line) && !/^packages:/.test(line)) break; // left the section
    if (!inPackages) continue;
    // keys look like:  /name@1.2.3:  or  '@scope/name@1.2.3':  or  name@1.2.3:
    const m = line.match(/^\s{2}'?\/?((?:@[^@/]+\/)?[^@'/][^@']*)@([^():'\s]+)'?\s*:/);
    if (!m) continue;
    const name = m[1];
    const version = m[2];
    entries[name] = {
      name, source: "npm", version, registry: "npmjs.org",
      integrity: null, innerHash: null, resolvedUrl: null,
      gitUrl: null, gitRef: null, packageId: name, raw: line.trim(),
    };
  }
  return entries;
}

// ---- ecosystem hooks ----

export function isRegistryBacked(entry) {
  return entry.source === "npm";
}
export function packageKey(entry, name) {
  return entry.packageId || name;
}

const NPM_REGISTRY = "https://registry.npmjs.org";

let _metaCache = new Map();
async function getPackument(pkg) {
  if (_metaCache.has(pkg)) return _metaCache.get(pkg);
  const res = await fetch(`${NPM_REGISTRY}/${encodePkg(pkg)}`, {
    headers: { Accept: "application/json", "User-Agent": "laocoon-supply-chain-guard" },
  });
  if (res.status === 404) { _metaCache.set(pkg, null); return null; }
  if (!res.ok) throw new Error(`npm ${pkg} -> HTTP ${res.status}`);
  const json = await res.json();
  _metaCache.set(pkg, json);
  return json;
}

function encodePkg(pkg) {
  // Scoped names keep the slash but encode the @: @scope/name -> @scope%2fname? No —
  // npm wants @scope/name unescaped except the path; encodeURIComponent breaks the slash.
  return pkg.startsWith("@") ? pkg.replace("/", "%2f") : encodeURIComponent(pkg);
}

export async function getReleases(pkg) {
  const doc = await getPackument(pkg);
  if (!doc) return [];
  const time = doc.time || {};
  return Object.keys(doc.versions || {}).map((v) => ({
    version: v,
    insertedAt: time[v] || null,
  }));
}

export async function fetchContext({ pkg, fromVersion, toVersion }) {
  const ctx = baseContext({ registry: "npm", pkg, fromVersion, toVersion });
  try {
    const doc = await getPackument(pkg);
    if (!doc) {
      ctx.notes.push("Package not found on npm — verify it is real and not a typosquat.");
      return ctx;
    }
    ctx.available = true;
    ctx.htmlUrl = `https://www.npmjs.com/package/${pkg}`;
    const repo = doc.repository?.url || doc.repository || null;
    ctx.repository = typeof repo === "string" ? repo.replace(/^git\+/, "").replace(/\.git$/, "") : null;
    if (Array.isArray(doc.maintainers)) {
      ctx.owners = doc.maintainers.map((m) => m.name || m.email || "unknown");
    }
    const time = doc.time || {};
    ctx.releaseInsertedAt = time[toVersion] || null;
    ctx.fromReleaseInsertedAt = fromVersion ? time[fromVersion] || null : null;
    computeCadence(ctx);

    const verInfo = doc.versions?.[toVersion];
    if (verInfo) {
      // Lifecycle scripts are the prime npm attack surface — surface them.
      const scripts = verInfo.scripts || {};
      const lifecycle = ["preinstall", "install", "postinstall", "prepare", "prepublish"].filter(
        (k) => scripts[k]
      );
      if (lifecycle.length) {
        ctx.notes.push(
          `Defines install/lifecycle scripts: ${lifecycle
            .map((k) => `${k}="${String(scripts[k]).slice(0, 120)}"`)
            .join("; ")}`
        );
      }
      const publisher = verInfo._npmUser?.name || null;
      if (publisher && ctx.owners && !ctx.owners.includes(publisher)) {
        ctx.publishedByDifferentOwner = publisher;
        ctx.notes.push(
          `Version ${toVersion} published by "${publisher}", not in the maintainer list (${ctx.owners.join(", ")}).`
        );
      }
    }
    // Download counts (last week) — popularity signal.
    try {
      const dl = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encodePkg(pkg)}`);
      if (dl.ok) ctx.totalDownloads = (await dl.json()).downloads ?? null;
    } catch { /* best effort */ }
  } catch (err) {
    ctx.notes.push(`npm lookup failed: ${err.message}`);
  }
  return ctx;
}

/**
 * Download and unpack the published npm tarball into a path -> Buffer map.
 * npm tarballs are gzipped tar with everything under a "package/" prefix,
 * which we strip so paths match across versions.
 */
export async function fetchArtifact(pkg, version) {
  const doc = await getPackument(pkg);
  const tarball = doc?.versions?.[version]?.dist?.tarball;
  if (!tarball) throw new Error(`no tarball URL for ${pkg}@${version}`);
  const res = await fetch(tarball, { headers: { "User-Agent": "laocoon-supply-chain-guard" } });
  if (!res.ok) throw new Error(`npm tarball ${pkg}@${version} -> HTTP ${res.status}`);
  const files = unpackTarball(Buffer.from(await res.arrayBuffer()));
  const stripped = new Map();
  for (const [p, buf] of files) {
    stripped.set(p.replace(/^package\//, ""), buf);
  }
  return stripped;
}
