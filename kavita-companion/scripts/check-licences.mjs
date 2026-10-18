#!/usr/bin/env node
// Dependency licence gate. Every package this project resolves must be under a permissive licence —
// no GPL, AGPL, LGPL, SSPL or anything undeclared. It reads package-lock.json rather than
// node_modules, so it is deterministic, needs no install, and can run before `npm ci`; the lockfile is
// what npm will actually install.
//
// Run: npm run licences   (CI runs it on every push and pull request)
//
// To allow a new licence, add it to ALLOWED *and* satisfy yourself it is permissive. To carry a
// package that declares nothing, add it to KNOWN_UNLICENSED with the reason and a pointer to the
// work that resolves it — never silently.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Permissive licences we accept. Copyleft is deliberately absent and must never be added. */
const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-4.0", // data/attribution only, never code
  "Python-2.0",
  "Zlib",
  "OFL-1.1", // fonts
]);

/**
 * Packages that declare no licence upstream. Each entry needs a reason; the gate prints them so they
 * cannot be forgotten. Keep this list as short as the truth allows.
 */
const KNOWN_UNLICENSED = new Map([
  [
    "node_modules/combine-errors",
    "declares no licence upstream; transitive via tus-js-client (browser bundle). Tracked as C3 in " +
      "docs/superpowers/plans/2026-10-18-kavita-companion-lectern-compliance.md",
  ],
]);

/** Copyleft, so a failure is reported as such rather than as "unknown". */
const COPYLEFT = /^(A?GPL|LGPL|SSPL|EUPL|CDDL|MPL|EPL|CPL|OSL|CECILL)/i;

/**
 * Evaluate an SPDX expression. Handles `A OR B`, `A AND B`, parentheses and the `WITH` exception
 * operator. `OR` is satisfied by either side, `AND` needs both. `X WITH Y` is evaluated as `X`, which
 * is safe here: it can only ever *reject* copyleft, never admit it.
 */
function isPermissive(expression) {
  const tokens = expression.replace(/[()]/g, (m) => ` ${m} `).split(/\s+/).filter(Boolean);
  let at = 0;

  const factor = () => {
    if (tokens[at] === "(") {
      at += 1;
      const value = or();
      at += 1; // the ")"
      return value;
    }
    const id = (tokens[at++] ?? "").replace(/\+$/, ""); // LGPL-2.1+ -> LGPL-2.1 (still rejected)
    if (tokens[at] === "WITH") at += 2; // skip the exception; see the note above
    return ALLOWED.has(id);
  };
  const and = () => {
    let value = factor();
    while (tokens[at] === "AND") {
      at += 1;
      value = factor() && value; // no short-circuit: keep consuming the expression
    }
    return value;
  };
  const or = () => {
    let value = and();
    while (tokens[at] === "OR") {
      at += 1;
      value = and() || value;
    }
    return value;
  };

  return or();
}

/** The declared licence of a lockfile entry: a string, or a legacy `licenses` array. */
function declaredLicence(entry) {
  if (typeof entry.license === "string" && entry.license.trim()) return entry.license.trim();
  if (Array.isArray(entry.licenses) && entry.licenses.length) {
    const types = entry.licenses.map((l) => (typeof l === "string" ? l : l?.type)).filter(Boolean);
    if (types.length) return types.join(" OR ");
  }
  return null;
}

const lock = JSON.parse(readFileSync(join(here, "..", "package-lock.json"), "utf8"));
const packages = lock.packages ?? {};

const counts = new Map();
const failures = [];
const tolerated = [];

for (const [path, entry] of Object.entries(packages)) {
  if (!path) continue; // the root project itself
  if (entry.link) continue; // a workspace link, not a package

  const licence = declaredLicence(entry);
  if (licence === null) {
    if (KNOWN_UNLICENSED.has(path)) tolerated.push([path, entry.version, KNOWN_UNLICENSED.get(path)]);
    else failures.push([path, entry.version, "declares no licence"]);
    continue;
  }

  for (const id of licence.match(/[A-Za-z0-9.+-]+/g) ?? []) {
    if (!/^(AND|OR|WITH)$/i.test(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  if (!isPermissive(licence)) {
    const copyleft = COPYLEFT.test(licence);
    failures.push([path, entry.version, `${licence}${copyleft ? " (copyleft)" : ""}`]);
  }
}

console.log(`Checked ${Object.keys(packages).length - 1} packages in package-lock.json\n`);
console.log("Licences in the tree:");
for (const [id, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${id}`);

if (tolerated.length) {
  console.log("\nCarried without a declared licence (documented exceptions):");
  for (const [path, version, why] of tolerated) console.log(`  ${path}@${version} — ${why}`);
}

if (failures.length) {
  console.error("\nFAILED — these are not permissive:");
  for (const [path, version, why] of failures) console.error(`  ${path}@${version} — ${why}`);
  console.error("\nRemove the dependency, or add its licence to ALLOWED in scripts/check-licences.mjs");
  console.error("only after satisfying yourself it is permissive.");
  process.exit(1);
}

console.log("\nOK — every dependency is permissively licensed.");
