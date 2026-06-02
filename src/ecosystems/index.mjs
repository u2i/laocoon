// Ecosystem registry. Each ecosystem module conforms to the same interface:
//
//   id            string
//   displayName   string
//   lockfiles     string[]                       // filenames it owns
//   parse(text)   -> { name -> normalizedEntry }
//   isRegistryBacked(entry) -> boolean           // worth a registry lookup
//   packageKey(entry, name) -> string            // id for the registry URL
//   fetchContext({ pkg, fromVersion, toVersion }) -> Promise<RegistryContext>
//
// To add Node or Python support: drop a new module in this folder and add it
// to ECOSYSTEMS below. The core (diff, fingerprint, LLM, GitHub, report) is
// entirely ecosystem-agnostic.

import * as hex from "./hex.mjs";
import * as npm from "./npm.mjs";
import * as pypi from "./pypi.mjs";

export const ECOSYSTEMS = [hex, npm, pypi];

/** Map a lockfile basename to its ecosystem module, or null. */
export function ecosystemForLockfile(filename) {
  const base = filename.split("/").pop();
  return ECOSYSTEMS.find((e) => e.lockfiles.includes(base)) ?? null;
}

/** All lockfile basenames across every registered ecosystem. */
export function allLockfileNames() {
  return ECOSYSTEMS.flatMap((e) => e.lockfiles);
}

/** Restrict to a comma-separated allowlist of ecosystem ids (or all if empty). */
export function selectEcosystems(idsCsv) {
  if (!idsCsv || !idsCsv.trim()) return ECOSYSTEMS;
  const wanted = new Set(idsCsv.split(",").map((s) => s.trim().toLowerCase()));
  return ECOSYSTEMS.filter((e) => wanted.has(e.id));
}
