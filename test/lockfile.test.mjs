// Run with: node --test "test/**/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";

import * as hex from "../src/ecosystems/hex.mjs";
import { diffEntries, diffIsEmpty } from "../src/diff.mjs";

const SAMPLE_BEFORE = `%{
  "phoenix": {:hex, :phoenix, "1.7.12", "aaa111", [:mix], [{:plug, "~> 1.14", [hex: :plug, repo: "hexpm", optional: false]}], "hexpm", "outerAAA"},
  "jason": {:hex, :jason, "1.4.1", "bbb222", [:mix], [], "hexpm", "outerBBB"},
  "telemetry": {:hex, :telemetry, "1.2.1", "ccc333", [:mix], [], "hexpm", "outerCCC"},
  "my_fork": {:git, "https://github.com/me/my_fork.git", "deadbeef", [ref: "v1.0.0"]},
}`;

const SAMPLE_AFTER = `%{
  "phoenix": {:hex, :phoenix, "1.7.14", "aaa999", [:mix], [{:plug, "~> 1.14", [hex: :plug, repo: "hexpm", optional: false]}], "hexpm", "outerZZZ"},
  "jason": {:hex, :jason, "1.4.1", "bbb222", [:mix], [], "hexpm", "outerBBB"},
  "evil_dep": {:hex, :evil_dep, "0.0.1", "ddd444", [:mix], [], "hexpm", "outerDDD"},
  "my_fork": {:git, "https://github.com/attacker/my_fork.git", "cafebabe", [ref: "v1.0.0"]},
}`;

test("parses hex entries into the normalized shape", () => {
  const parsed = hex.parse(SAMPLE_BEFORE);
  assert.equal(parsed.phoenix.source, "hex");
  assert.equal(parsed.phoenix.packageId, "phoenix");
  assert.equal(parsed.phoenix.version, "1.7.12");
  assert.equal(parsed.phoenix.registry, "hexpm");
  assert.equal(parsed.phoenix.integrity, "outerAAA");
  assert.equal(parsed.phoenix.innerHash, "aaa111");
});

test("parses git entries with url and ref", () => {
  const parsed = hex.parse(SAMPLE_BEFORE);
  assert.equal(parsed.my_fork.source, "git");
  assert.equal(parsed.my_fork.gitUrl, "https://github.com/me/my_fork.git");
  assert.equal(parsed.my_fork.version, "deadbeef");
  assert.equal(parsed.my_fork.gitRef, "v1.0.0");
});

test("diff detects version bump, added dep, git url change, and removal", () => {
  const diff = diffEntries(hex.parse(SAMPLE_BEFORE), hex.parse(SAMPLE_AFTER));
  assert.equal(diffIsEmpty(diff), false);
  assert.deepEqual(diff.changed.map((c) => c.name).sort(), ["my_fork", "phoenix"]);
  assert.deepEqual(diff.added.map((a) => a.name), ["evil_dep"]);
  assert.deepEqual(diff.removed.map((r) => r.name), ["telemetry"]);

  const fork = diff.changed.find((c) => c.name === "my_fork");
  assert.equal(fork.before.gitUrl, "https://github.com/me/my_fork.git");
  assert.equal(fork.after.gitUrl, "https://github.com/attacker/my_fork.git");
});

test("identical lockfiles produce an empty diff", () => {
  assert.equal(diffIsEmpty(diffEntries(hex.parse(SAMPLE_BEFORE), hex.parse(SAMPLE_BEFORE))), true);
});

test("handles empty / missing lockfile", () => {
  assert.deepEqual(hex.parse(""), {});
  assert.deepEqual(hex.parse(undefined), {});
});
