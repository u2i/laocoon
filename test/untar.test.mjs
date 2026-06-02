import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import { untar, unpackTarball } from "../src/untar.mjs";

// Build a minimal ustar archive in-process so the test has no fixtures.
function tarFile(name, content) {
  const data = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, "utf8"); // name
  header.write("0000644", 100, "utf8"); // mode
  header.write("0000000", 108, "utf8"); // uid
  header.write("0000000", 116, "utf8"); // gid
  header.write(data.length.toString(8).padStart(11, "0"), 124, "utf8"); // size
  header.write("00000000000", 136, "utf8"); // mtime
  header[156] = "0".charCodeAt(0); // typeflag = regular file
  header.write("ustar\0", 257, "utf8");
  header.write("00", 263, "utf8");
  // checksum: spaces during computation
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");

  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

function makeTar(files) {
  const parts = Object.entries(files).map(([n, c]) => tarFile(n, c));
  parts.push(Buffer.alloc(1024, 0)); // two zero blocks = end
  return Buffer.concat(parts);
}

test("untar reads regular files", () => {
  const tar = makeTar({ "lib/a.ex": "hello", "mix.exs": "world" });
  const files = untar(tar);
  assert.equal(files.get("lib/a.ex").toString(), "hello");
  assert.equal(files.get("mix.exs").toString(), "world");
});

test("unpackTarball transparently gunzips", () => {
  const tar = makeTar({ "x.txt": "gzipped" });
  const gz = gzipSync(tar);
  const files = unpackTarball(gz);
  assert.equal(files.get("x.txt").toString(), "gzipped");
});

test("unpackTarball handles plain (non-gzipped) tar too", () => {
  const tar = makeTar({ "y.txt": "plain" });
  const files = unpackTarball(tar);
  assert.equal(files.get("y.txt").toString(), "plain");
});
