#!/usr/bin/env node
// Build + bundle spannora into a deployable tarball.
//
//   npm run package
//   → spannora-<version>.tar.gz in the repo root

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const version = pkg.version;
const stageName = `spannora-${version}`;
const tarballName = `${stageName}.tar.gz`;

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd: repoRoot, stdio: "inherit", ...opts });
}

function copyTree(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

// 1. Clean previous artifacts.
const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "spannora-build-"));
const stageRoot = path.join(stageDir, stageName);
fs.mkdirSync(stageRoot, { recursive: true });
const tarballPath = path.join(repoRoot, tarballName);
if (fs.existsSync(tarballPath)) fs.rmSync(tarballPath);

// 2. Compile TS → JS.
run("npx tsc");

// 3. Stage files into stageRoot.
const items = [
  "dist",
  "public",
  "deploy",
  "package.json",
  "package-lock.json",
];
for (const item of items) {
  const src = path.join(repoRoot, item);
  if (!fs.existsSync(src)) {
    console.warn(`  (skipping ${item} — not found)`);
    continue;
  }
  const dest = path.join(stageRoot, item);
  copyTree(src, dest);
  console.log(`  + ${item}`);
}

// 4. Create the tarball at the repo root.
// On macOS, `bsdtar` writes PAX headers for extended attributes
// (`LIBARCHIVE.xattr.com.apple.provenance` etc.) which make GNU tar on Linux
// emit "Ignoring unknown extended header keyword" warnings on extract.
// Suppressing both xattr categories on Mac builds gives us a clean tarball.
const isMac = os.platform() === "darwin";
const tarFlags = isMac ? "--no-xattrs --no-mac-metadata --no-fflags" : "";
run(`tar ${tarFlags} -czf "${tarballPath}" -C "${stageDir}" "${stageName}"`);

// 5. Clean up staging.
fs.rmSync(stageDir, { recursive: true, force: true });

const size = fs.statSync(tarballPath).size;
const mb = (size / 1024 / 1024).toFixed(2);
console.log("");
console.log(`✓ Built ${tarballName} (${mb} MiB)`);
console.log(`  → ${tarballPath}`);
console.log("");
console.log("Next: scp it to a VPS and follow deploy/DEPLOY.md (also bundled).");
