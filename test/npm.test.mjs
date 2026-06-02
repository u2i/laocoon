import { test } from "node:test";
import assert from "node:assert/strict";

import * as npm from "../src/ecosystems/npm.mjs";
import { diffEntries } from "../src/diff.mjs";

const PACKAGE_LOCK_V3 = JSON.stringify({
  name: "app",
  lockfileVersion: 3,
  packages: {
    "": { name: "app" },
    "node_modules/left-pad": {
      version: "1.3.0",
      resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      integrity: "sha512-AAA==",
    },
    "node_modules/@scope/pkg": {
      version: "2.1.0",
      resolved: "https://registry.npmjs.org/@scope/pkg/-/pkg-2.1.0.tgz",
      integrity: "sha512-BBB==",
    },
    "node_modules/sketchy": {
      version: "0.0.1",
      resolved: "git+https://github.com/attacker/sketchy.git#abc",
    },
    "node_modules/app/node_modules/left-pad": {
      version: "1.3.0",
      resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      integrity: "sha512-AAA==",
    },
  },
});

test("parses package-lock v3 packages map incl. scoped names", () => {
  const e = npm.parse(PACKAGE_LOCK_V3, "package-lock.json");
  assert.equal(e["left-pad"].version, "1.3.0");
  assert.equal(e["left-pad"].source, "npm");
  assert.equal(e["left-pad"].integrity, "sha512-AAA==");
  assert.equal(e["@scope/pkg"].version, "2.1.0");
  assert.equal(e["@scope/pkg"].source, "npm");
});

test("flags non-registry (git) source", () => {
  const e = npm.parse(PACKAGE_LOCK_V3, "package-lock.json");
  assert.equal(e["sketchy"].source, "git");
  assert.equal(npm.isRegistryBacked(e["sketchy"]), false);
  assert.equal(npm.isRegistryBacked(e["left-pad"]), true);
});

test("parses yarn.lock classic", () => {
  const yarn = `# yarn lockfile v1


left-pad@^1.3.0:
  version "1.3.0"
  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#abc"
  integrity sha512-CCC==

"@scope/pkg@^2.0.0":
  version "2.1.0"
  resolved "https://registry.yarnpkg.com/@scope/pkg/-/pkg-2.1.0.tgz#def"
  integrity sha512-DDD==
`;
  const e = npm.parse(yarn, "yarn.lock");
  assert.equal(e["left-pad"].version, "1.3.0");
  assert.equal(e["@scope/pkg"].version, "2.1.0");
  assert.equal(e["left-pad"].source, "npm");
});

test("parses pnpm-lock.yaml packages section", () => {
  const pnpm = `lockfileVersion: '6.0'

packages:

  /left-pad@1.3.0:
    resolution: {integrity: sha512-EEE==}
    dev: false

  '@scope/pkg@2.1.0':
    resolution: {integrity: sha512-FFF==}
`;
  const e = npm.parse(pnpm, "pnpm-lock.yaml");
  assert.equal(e["left-pad"].version, "1.3.0");
  assert.equal(e["@scope/pkg"].version, "2.1.0");
});

test("diff detects an upgraded package", () => {
  const before = npm.parse(PACKAGE_LOCK_V3, "package-lock.json");
  const afterDoc = JSON.parse(PACKAGE_LOCK_V3);
  afterDoc.packages["node_modules/left-pad"].version = "1.3.1";
  afterDoc.packages["node_modules/left-pad"].integrity = "sha512-ZZZ==";
  const after = npm.parse(JSON.stringify(afterDoc), "package-lock.json");
  const diff = diffEntries(before, after);
  assert.deepEqual(diff.changed.map((c) => c.name), ["left-pad"]);
});
