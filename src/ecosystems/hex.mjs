// Elixir / Hex ecosystem support: parses mix.lock and fetches hex.pm signals.
//
// Normalized entry shape (shared across ecosystems):
//   { name, source, version, registry, integrity, innerHash,
//     resolvedUrl, gitUrl, gitRef, packageId, raw }

import { unpackTarball, untar } from "../untar.mjs";
import { baseContext, computeCadence } from "./registry-context.mjs";

export const id = "hex";
export const displayName = "Elixir (Hex)";
export const lockfiles = ["mix.lock"];

/**
 * Parse a mix.lock (an Elixir map literal) into name -> normalized entry.
 * A tolerant brace-balanced tokenizer; not a full Elixir parser.
 */
export function parse(contents) {
  const entries = {};
  if (!contents) return entries;
  const text = contents;
  const len = text.length;
  let i = 0;

  while (i < len) {
    const keyMatch = /"((?:[^"\\]|\\.)*)"\s*:\s*\{/g;
    keyMatch.lastIndex = i;
    const m = keyMatch.exec(text);
    if (!m) break;

    const name = m[1];
    let j = m.index + m[0].length;
    let depth = 1;
    let inString = false;
    let escaped = false;
    const start = j;

    while (j < len && depth > 0) {
      const c = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
      } else {
        if (c === '"') inString = true;
        else if (c === "{") depth++;
        else if (c === "}") depth--;
      }
      j++;
    }

    entries[name] = parseTuple(name, text.slice(start, j - 1));
    i = j;
  }
  return entries;
}

function parseTuple(name, body) {
  const entry = {
    name,
    source: "unknown",
    version: null,
    registry: null,
    integrity: null,
    innerHash: null,
    resolvedUrl: null,
    gitUrl: null,
    gitRef: null,
    packageId: null,
    raw: body.trim(),
  };

  const fields = splitTopLevel(body);
  const unquote = (s) => {
    s = s.trim();
    if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
    if (s.startsWith(":")) return s.slice(1);
    return s;
  };
  if (fields.length === 0) return entry;

  const kind = unquote(fields[0]);
  if (kind === "hex") {
    entry.source = "hex";
    entry.packageId = fields[1] ? unquote(fields[1]) : null;
    entry.version = fields[2] ? unquote(fields[2]) : null;
    entry.innerHash = fields[3] ? unquote(fields[3]) : null;
    const strFields = fields
      .map((f) => f.trim())
      .filter((f) => f.startsWith('"') && f.endsWith('"'))
      .map(unquote);
    if (strFields.length >= 2) {
      entry.integrity = strFields[strFields.length - 1]; // outer sha256
      entry.registry = strFields[strFields.length - 2];
    }
  } else if (kind === "git") {
    entry.source = "git";
    entry.gitUrl = fields[1] ? unquote(fields[1]) : null;
    entry.version = fields[2] ? unquote(fields[2]) : null; // commit sha
    const refMatch = body.match(/\b(?:ref|tag|branch):\s*"([^"]+)"/);
    if (refMatch) entry.gitRef = refMatch[1];
  } else if (kind === "path") {
    entry.source = "path";
    entry.resolvedUrl = fields[1] ? unquote(fields[1]) : null;
  }
  return entry;
}

function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let cur = "";
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (inString) {
      cur += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      cur += c;
    } else if (c === "[" || c === "{" || c === "(") {
      depth++;
      cur += c;
    } else if (c === "]" || c === "}" || c === ")") {
      depth--;
      cur += c;
    } else if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Which entries in a diff are worth registry lookups (hex-sourced only). */
export function isRegistryBacked(entry) {
  return entry.source === "hex";
}

/** Registry id used in the package URL. */
export function packageKey(entry, name) {
  return entry.packageId || name;
}

const HEX_API = "https://hex.pm/api";

/**
 * Fetch hex.pm context for a changed/added package.
 * @returns {Promise<RegistryContext>}
 */
export async function fetchContext({ pkg, fromVersion, toVersion }) {
  const ctx = baseContext({ registry: "hex.pm", pkg, fromVersion, toVersion });
  try {
    const pkgRes = await hexGet(`/packages/${encodeURIComponent(pkg)}`);
    if (!pkgRes) {
      ctx.notes.push("Package not found on hex.pm — verify it is a real Hex package.");
      return ctx;
    }
    ctx.available = true;
    ctx.htmlUrl = pkgRes.html_url ?? null;
    ctx.totalDownloads = pkgRes.downloads?.all ?? null;
    const links = pkgRes.meta?.links ?? {};
    ctx.repository = links.GitHub ?? links.Github ?? links.github ?? links.Repository ?? null;
    if (Array.isArray(pkgRes.owners)) {
      ctx.owners = pkgRes.owners.map((o) => o.username || o.email || "unknown");
    }
    const releases = pkgRes.releases ?? [];
    const find = (v) => releases.find((r) => r.version === v);
    const toRel = find(toVersion);
    const fromRel = fromVersion ? find(fromVersion) : null;
    if (toRel?.inserted_at) ctx.releaseInsertedAt = toRel.inserted_at;
    if (fromRel?.inserted_at) ctx.fromReleaseInsertedAt = fromRel.inserted_at;
    computeCadence(ctx);

    const rel = await hexGet(
      `/packages/${encodeURIComponent(pkg)}/releases/${encodeURIComponent(toVersion)}`
    );
    if (rel) {
      ctx.retired = rel.retirement
        ? `${rel.retirement.reason}: ${rel.retirement.message ?? ""}`.trim()
        : null;
      const publisher = rel.publisher?.username || rel.publisher?.email || null;
      if (publisher && ctx.owners && !ctx.owners.includes(publisher)) {
        ctx.publishedByDifferentOwner = publisher;
        ctx.notes.push(
          `Release ${toVersion} was published by "${publisher}", not in the current owner list (${ctx.owners.join(", ")}).`
        );
      }
    }
  } catch (err) {
    ctx.notes.push(`hex.pm lookup failed: ${err.message}`);
  }
  return ctx;
}

async function hexGet(path) {
  const res = await fetch(`${HEX_API}${path}`, {
    headers: { Accept: "application/json", "User-Agent": "laocoon-supply-chain-guard" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`hex.pm ${path} -> HTTP ${res.status}`);
  return res.json();
}

/**
 * List all releases with publish dates, for soaked-baseline selection.
 * @returns {Promise<Array<{version:string, insertedAt:string|null}>>}
 */
export async function getReleases(pkg) {
  const pkgRes = await hexGet(`/packages/${encodeURIComponent(pkg)}`);
  if (!pkgRes || !Array.isArray(pkgRes.releases)) return [];
  return pkgRes.releases.map((r) => ({
    version: r.version,
    insertedAt: r.inserted_at ?? null,
  }));
}

/**
 * Download and unpack a published Hex artifact into a path -> Buffer map.
 * Hex tarballs are an OUTER tar containing `contents.tar.gz` (the source) plus
 * metadata/checksum members. We return the unpacked contents.tar.gz tree.
 * @returns {Promise<Map<string,Buffer>>}
 */
export async function fetchArtifact(pkg, version) {
  const url = `https://repo.hex.pm/tarballs/${encodeURIComponent(pkg)}-${encodeURIComponent(version)}.tar`;
  const res = await fetch(url, {
    headers: { "User-Agent": "laocoon-supply-chain-guard" },
  });
  if (!res.ok) throw new Error(`hex tarball ${pkg}-${version} -> HTTP ${res.status}`);
  const outer = untar(Buffer.from(await res.arrayBuffer()));
  const contents = outer.get("contents.tar.gz");
  if (!contents) throw new Error(`no contents.tar.gz in ${pkg}-${version} tarball`);
  return unpackTarball(contents);
}
