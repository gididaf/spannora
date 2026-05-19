#!/usr/bin/env node
// Build + bundle spannora into a deployable tarball.
//
//   npm run package           (from repo root, via workspace dispatch)
//   npm run package -w packages/server
//   → spannora-<version>.tar.gz in the repo root
//
// The tarball extracts to a flat layout (dist/, public/, deploy/, package.json,
// package-lock.json) so install.sh + deploy/spannora.service don't need to know
// anything about the monorepo restructure.

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverPkgDir = path.resolve(scriptDir, "..");            // packages/server
const repoRoot = path.resolve(serverPkgDir, "..", "..");       // monorepo root

const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const serverPkg = JSON.parse(fs.readFileSync(path.join(serverPkgDir, "package.json"), "utf8"));
const version = rootPkg.version;
const stageName = `spannora-${version}`;
const tarballName = `${stageName}.tar.gz`;

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd: serverPkgDir, stdio: "inherit", ...opts });
}

function copyTree(src, dest) {
  // Note: Node's `dereference: true` on cpSync only follows the source root
  // itself, not nested symlinks. public/shared (symlink → ../../shared/src)
  // needs to be handled explicitly after this — see stageSharedModules().
  fs.cpSync(src, dest, { recursive: true, dereference: true });
}

// Replace the staged `public/shared` symlink with real files from
// packages/shared/src/. The dev-time symlink is great for hot-reload but
// would break on the target machine (it points at the build host's path).
function stageSharedModules(stagedPublicDir) {
  const staged = path.join(stagedPublicDir, "shared");
  const real = path.join(repoRoot, "packages", "shared", "src");
  if (!fs.existsSync(real)) {
    throw new Error(`@spannora/shared missing at ${real}`);
  }
  // Remove whatever cpSync left (symlink or stale dir).
  if (fs.existsSync(staged) || fs.lstatSync(staged, { throwIfNoEntry: false })) {
    fs.rmSync(staged, { recursive: true, force: true });
  }
  fs.mkdirSync(staged);
  for (const entry of fs.readdirSync(real)) {
    fs.copyFileSync(path.join(real, entry), path.join(staged, entry));
  }
  console.log(`  + public/shared (${fs.readdirSync(staged).length} files)`);
}

// 1. Set up staging dirs and clean any previous tarball.
const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "spannora-build-"));
const stageRoot = path.join(stageDir, stageName);
fs.mkdirSync(stageRoot, { recursive: true });
const tarballPath = path.join(repoRoot, tarballName);
if (fs.existsSync(tarballPath)) fs.rmSync(tarballPath);

// 2. Compile TS → JS (relative to packages/server thanks to cwd above).
run("npx tsc");

// 3. Stage tree items from packages/server/ into stageRoot/.
const treeItems = ["dist", "public", "deploy"];
for (const item of treeItems) {
  const src = path.join(serverPkgDir, item);
  if (!fs.existsSync(src)) {
    console.warn(`  (skipping ${item} — not found)`);
    continue;
  }
  copyTree(src, path.join(stageRoot, item));
  console.log(`  + ${item}`);
}

// 3b. Dereference the public/shared symlink into real files.
stageSharedModules(path.join(stageRoot, "public"));

// 4. Stage package.json: server's package.json with the unified version stamped in.
const stagedPkg = { ...serverPkg, version };
fs.writeFileSync(
  path.join(stageRoot, "package.json"),
  JSON.stringify(stagedPkg, null, 2) + "\n",
);
console.log("  + package.json (version stamped)");

// 5. Stage package-lock.json from the repo root (the workspace lockfile).
//    install.sh runs `npm install --omit=dev` (not `npm ci`), which tolerates a
//    workspace-shaped lockfile against a flat package.json — npm updates it in
//    place on the target.
const rootLock = path.join(repoRoot, "package-lock.json");
if (fs.existsSync(rootLock)) {
  fs.copyFileSync(rootLock, path.join(stageRoot, "package-lock.json"));
  console.log("  + package-lock.json");
} else {
  console.warn("  (skipping package-lock.json — not found at repo root)");
}

// 6. Create the tarball at the repo root.
// On macOS, `bsdtar` writes PAX headers for extended attributes
// (`LIBARCHIVE.xattr.com.apple.provenance` etc.) which make GNU tar on Linux
// emit "Ignoring unknown extended header keyword" warnings on extract.
// Suppressing both xattr categories on Mac builds gives us a clean tarball.
const isMac = os.platform() === "darwin";
const tarFlags = isMac ? "--no-xattrs --no-mac-metadata --no-fflags" : "";
run(`tar ${tarFlags} -czf "${tarballPath}" -C "${stageDir}" "${stageName}"`);

// 7. Clean up staging.
fs.rmSync(stageDir, { recursive: true, force: true });

const size = fs.statSync(tarballPath).size;
const mb = (size / 1024 / 1024).toFixed(2);
console.log("");
console.log(`✓ Built ${tarballName} (${mb} MiB)`);
console.log(`  → ${tarballPath}`);
console.log("");
console.log("Next: scp it to a VPS and follow deploy/DEPLOY.md (also bundled).");
