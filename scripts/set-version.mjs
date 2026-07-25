#!/usr/bin/env node
// Single point of truth for bumping the app version.
//
// The version is duplicated across five files (npm, Cargo and Tauri each keep
// their own copy). A release tag `vX.Y.Z` is only valid if all five agree with
// it, which `--check` verifies in CI before anything is built.
//
//   node scripts/set-version.mjs 0.2.0          # write
//   node scripts/set-version.mjs --check 0.2.0  # verify only, non-zero on mismatch
//
// Run from the repo root. After bumping, commit the result on `develop`.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Each target is (file, locate the version, replace it). Everything is done by
// targeted replacement rather than JSON round-tripping so that formatting of
// large generated files (package-lock.json) survives untouched.
const TARGETS = [
  {
    file: "package.json",
    // The top-level "version" is the first one in the file.
    find: (s) => firstVersionField(s, 0),
  },
  {
    file: "package-lock.json",
    // Two copies: the top-level one and packages[""].version. Both live before
    // the first "node_modules/" key, so bound the search there and take both.
    find: (s) => {
      const limit = s.indexOf('"node_modules/');
      const head = limit === -1 ? s : s.slice(0, limit);
      const hits = [firstVersionField(head, 0)];
      hits.push(firstVersionField(head, hits[0].end));
      return hits;
    },
  },
  {
    file: "src-tauri/tauri.conf.json",
    find: (s) => firstVersionField(s, 0),
  },
  {
    file: "src-tauri/Cargo.toml",
    // The [package] section's version, not a dependency's.
    find: (s) => tomlVersionAfter(s, s.indexOf("[package]")),
  },
  {
    file: "src-tauri/Cargo.lock",
    // The joybug-tauri entry's version.
    find: (s) => tomlVersionAfter(s, s.indexOf('name = "joybug-tauri"')),
  },
];

function firstVersionField(source, from) {
  const re = /"version"\s*:\s*"([^"]*)"/g;
  re.lastIndex = from;
  const m = re.exec(source);
  if (!m) throw new Error('no "version" field found');
  return { start: m.index, end: m.index + m[0].length, value: m[1], text: m[0] };
}

function tomlVersionAfter(source, anchor) {
  if (anchor === -1) throw new Error("anchor not found");
  const re = /^version\s*=\s*"([^"]*)"/gm;
  re.lastIndex = anchor;
  const m = re.exec(source);
  if (!m) throw new Error("no version key found after anchor");
  return { start: m.index, end: m.index + m[0].length, value: m[1], text: m[0] };
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const version = args.find((a) => !a.startsWith("--"));

if (!version) {
  console.error("usage: node scripts/set-version.mjs [--check] <version>");
  process.exit(2);
}
// Tags carry a leading `v`; the manifests must not.
const wanted = version.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(wanted)) {
  console.error(`error: "${wanted}" is not a semver version`);
  process.exit(2);
}

let failed = false;
for (const target of TARGETS) {
  const path = join(ROOT, target.file);
  const source = readFileSync(path, "utf8");
  const hits = [target.find(source)].flat();

  if (checkOnly) {
    for (const hit of hits) {
      if (hit.value === wanted) continue;
      console.error(`${target.file}: is ${hit.value}, expected ${wanted}`);
      failed = true;
    }
    continue;
  }

  // Replace back-to-front so earlier offsets stay valid.
  let out = source;
  for (const hit of [...hits].sort((a, b) => b.start - a.start)) {
    out =
      out.slice(0, hit.start) +
      hit.text.replace(`"${hit.value}"`, `"${wanted}"`) +
      out.slice(hit.end);
  }
  if (out !== source) writeFileSync(path, out);
  console.log(`${target.file}: ${hits[0].value} -> ${wanted}`);
}

if (failed) {
  console.error(
    `\nversion mismatch: run \`node scripts/set-version.mjs ${wanted}\` and commit the result`,
  );
  process.exit(1);
}
if (checkOnly) console.log(`all version fields are ${wanted}`);
