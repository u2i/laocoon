// Minimal, dependency-free tar (ustar) reader + gzip helper.
// Handles the subset of tar we encounter from package registries: regular
// files, directories, and GNU/PAX long-name extensions. Good enough to unpack
// Hex/npm/PyPI artifacts without pulling in a tar library.

import { gunzipSync } from "node:zlib";

const BLOCK = 512;

/**
 * Parse a tar buffer into a Map of path -> Buffer (regular files only).
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>}
 */
export function untar(buf) {
  const files = new Map();
  let offset = 0;
  let longName = null;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    // Two consecutive zero blocks => end of archive.
    if (isZeroBlock(header)) {
      offset += BLOCK;
      continue;
    }

    const name = longName ?? readString(header, 0, 100);
    const sizeStr = readString(header, 124, 12).trim();
    const size = parseInt(sizeStr.replace(/[^0-7]/g, ""), 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    const prefix = readString(header, 345, 155);

    offset += BLOCK;
    const dataStart = offset;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    offset += padded;

    if (typeflag === "L") {
      // GNU long name: the data block holds the next entry's name.
      longName = buf.subarray(dataStart, dataStart + size).toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      // PAX extended header: parse a path=... record if present.
      const rec = buf.subarray(dataStart, dataStart + size).toString("utf8");
      const m = rec.match(/\d+ path=([^\n]+)\n/);
      longName = m ? m[1] : longName;
      continue;
    }
    longName = null;

    // 0 / "\0" => regular file. Skip dirs (5), symlinks (1,2), etc.
    if (typeflag === "0" || typeflag === "\0" || header[156] === 0) {
      const full = (prefix ? prefix + "/" : "") + name;
      if (full && !full.endsWith("/")) {
        files.set(full, buf.subarray(dataStart, dataStart + size));
      }
    }
  }
  return files;
}

function readString(block, start, len) {
  const slice = block.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString("utf8");
}

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

export function gunzip(buf) {
  return gunzipSync(buf);
}

/** Unpack a (possibly gzipped) tar buffer into a path -> Buffer map. */
export function unpackTarball(buf) {
  let data = buf;
  // gzip magic 0x1f 0x8b
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    data = gunzipSync(buf);
  }
  return untar(data);
}
