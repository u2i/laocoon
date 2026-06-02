import { test } from "node:test";
import assert from "node:assert/strict";

import {
  selectSoakedBaseline,
  compareVersions,
  parseVersion,
  isPrerelease,
} from "../src/soak.mjs";

const NOW = new Date("2026-06-02T00:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

const RELEASES = [
  { version: "1.0.0", insertedAt: daysAgo(400) },
  { version: "1.1.0", insertedAt: daysAgo(200) }, // soaked, same minor
  { version: "1.1.1", insertedAt: daysAgo(120) }, // soaked, same minor
  { version: "1.2.0", insertedAt: daysAgo(90) }, // soaked, different minor
  { version: "1.1.2", insertedAt: daysAgo(3) }, // adopted (fresh)
];

test("version compare and prerelease detection", () => {
  assert.ok(compareVersions("1.1.2", "1.1.0") > 0);
  assert.ok(compareVersions("1.1.0", "1.2.0") < 0);
  assert.equal(parseVersion("v2.3.4").major, 2);
  assert.equal(isPrerelease("1.0.0-rc.1"), true);
  assert.equal(isPrerelease("1.0.0"), false);
});

test("prefers newest soaked release on the SAME minor lineage", () => {
  // Adopting 1.1.2 should baseline against 1.1.1 (soaked, same 1.1.x),
  // NOT 1.2.0 even though 1.2.0 is newer and also soaked.
  const r = selectSoakedBaseline({
    adopted: "1.1.2",
    releases: RELEASES,
    soakDays: 60,
    now: NOW,
  });
  assert.equal(r.baselineVersion, "1.1.1");
  assert.equal(r.lineage, "major.minor");
});

test("falls back to same major when no soaked release on the minor line", () => {
  const releases = [
    { version: "2.0.0", insertedAt: daysAgo(300) },
    { version: "2.4.0", insertedAt: daysAgo(2) }, // adopted, fresh, lonely minor
  ];
  const r = selectSoakedBaseline({
    adopted: "2.4.0",
    releases,
    soakDays: 60,
    now: NOW,
  });
  assert.equal(r.baselineVersion, "2.0.0");
  assert.equal(r.lineage, "major");
});

test("flags when no release is older than the soak window", () => {
  const releases = [
    { version: "0.1.0", insertedAt: daysAgo(10) },
    { version: "0.1.1", insertedAt: daysAgo(2) },
  ];
  const r = selectSoakedBaseline({
    adopted: "0.1.1",
    releases,
    soakDays: 60,
    now: NOW,
  });
  assert.equal(r.baselineVersion, null);
  assert.match(r.reason, /soak window/);
});

test("never selects a baseline newer than the adopted version", () => {
  const r = selectSoakedBaseline({
    adopted: "1.1.0",
    releases: RELEASES,
    soakDays: 60,
    now: NOW,
  });
  // Only 1.0.0 is both soaked and < 1.1.0; same major.
  assert.equal(r.baselineVersion, "1.0.0");
});
