import { test } from "node:test";
import assert from "node:assert/strict";

import { diffArtifacts, classifyContent } from "../src/artifact-diff.mjs";

const buf = (s) => Buffer.from(s, "utf8");

test("classifies binaries and minified content as opaque", () => {
  assert.equal(classifyContent("lib/nif.so", buf("anything")).opaque, true);
  assert.equal(classifyContent("a.txt", Buffer.from([1, 2, 0, 3])).opaque, true);
  const minified = "var x=1;" + "a".repeat(6000);
  assert.equal(classifyContent("bundle.js", buf(minified)).opaque, true);
  assert.equal(classifyContent("lib/app.ex", buf("defmodule App do\nend\n")).opaque, false);
});

test("diffs text files and surfaces added/removed lines", () => {
  const before = { "lib/app.ex": buf("defmodule App do\n  def hi, do: :ok\nend\n") };
  const after = {
    "lib/app.ex": buf("defmodule App do\n  def hi, do: System.cmd(\"curl\", [\"evil\"]) \nend\n"),
  };
  const d = diffArtifacts(before, after, 60000);
  assert.equal(d.files.length, 1);
  assert.match(d.files[0].diff, /System\.cmd/);
  assert.equal(d.opaqueFiles.length, 0);
});

test("reports changed binaries as opaque, never their contents", () => {
  const before = { "priv/native/nif.so": Buffer.from([0, 1, 2, 3]) };
  const after = { "priv/native/nif.so": Buffer.from([0, 9, 9, 9]) };
  const d = diffArtifacts(before, after, 60000);
  assert.equal(d.files.length, 0);
  assert.equal(d.opaqueFiles.length, 1);
  assert.equal(d.opaqueFiles[0].path, "priv/native/nif.so");
  assert.equal(d.opaqueFiles[0].status, "modified");
  assert.ok(d.opaqueFiles[0].oldHash && d.opaqueFiles[0].newHash);
});

test("prioritizes hook files and respects the byte budget", () => {
  const before = {};
  const after = {
    "README.md": buf("x".repeat(2000)),
    "mix.exs": buf("defmodule P.MixProject do\n  def project, do: []\nend\n"),
  };
  // Tiny budget: mix.exs (priority 0) must win over README.
  const d = diffArtifacts(before, after, 120);
  assert.ok(d.files.some((f) => f.path === "mix.exs"));
  assert.ok(d.droppedFiles.includes("README.md") || d.bytesEmitted <= 120 + 200);
});

test("empty-before diff (new package) shows all files as added", () => {
  const after = { "lib/new.ex": buf("defmodule New do\nend\n") };
  const d = diffArtifacts(new Map(), after, 60000);
  assert.equal(d.files[0].status, "added");
});
