// Conformance runner: the language-neutral rule corpus (`tests/conformance/*.json`) against the real
// rule modules.
//
// The corpus is the contract this repository shares with the Python reimplementation, so it names
// rules only by the spec's rule IDs (`docs/companion-rules-v1.md`) and never by a function name of
// ours. RULES below is the single place the two are tied together — if you rename a rule function,
// update it here and the corpus does not move.
//
// A case whose expectation is the spec's *intended* behaviour but which this implementation does not
// meet yet carries a `current` field. Those are asserted against `current` and reported as tracked
// divergences, so a divergence can neither hide nor outlive its fix: when the code is corrected the
// case fails and tells you to drop the field.
//
//   npm --prefix kavita-companion run build
//   node --test tests/conformance/*.test.mjs
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "..", "..", "kavita-companion", "dist");

/** rule ID -> [module under dist/, exported name]. A non-function export is called with no args. */
const RULES = {
  N2: ["naming.js", "isNoiseGroup"],
  N3: ["naming.js", "dropOrphanBrackets"],
  N4: ["naming.js", "cleanName"],
  N5: ["naming.js", "volumeInSeries"],
  N6: ["naming.js", "dedupeSeriesVolume"],
  N7: ["naming.js", "cleanBookTitle"],
  I1: ["identify.js", "baseOf"],
  I2: ["identify.js", "normaliseNumber"],
  I3: ["identify.js", "stripSeriesMarker"],
  I4: ["identify.js", "guessFromFilename"],
  I5: ["identify.js", "bookMediaDefaults"],
  I6: ["identify.js", "canonicalBookName"],
  P1: ["rules.js", "safeSegment"],
  P2: ["rules.js", "splitName"],
  P3: ["rules.js", "targetExtension"],
  M1: ["metadata.js", "COMICINFO_FIELDS"],
  M2: ["metadata.js", "AGE_RATINGS"],
  M3: ["metadata.js", "readComicInfo"],
  M4: ["metadata.js", "writeComicInfo"],
  M5: ["metadata.js", "readEpubMetadata"],
  M6: ["metadata.js", "writeEpubMetadata"],
  G1: ["providers/merge.js", "mergeRecords"],
  T1: ["media.js", "mediaClass"],
};

/** Searched only when a rule ID is not in RULES: the spec's `signature` names the function. */
const SEARCH = ["naming.js", "identify.js", "rules.js", "media.js", "metadata.js", "providers/merge.js"];

const loaded = new Map();
async function moduleOf(file) {
  if (!loaded.has(file)) loaded.set(file, await import(pathToFileURL(join(DIST, file)).href));
  return loaded.get(file);
}

/**
 * An absent key and a null value mean the same thing to these rules ("no value"), so compare them
 * as such. Scalars are compared strictly — a rule that returns null where the corpus says "" is a
 * real difference.
 */
function normalise(value) {
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== null && entry !== undefined) out[key] = normalise(entry);
    }
    return out;
  }
  return value;
}

const files = readdirSync(here).filter((name) => name.endsWith(".json")).sort();
if (files.length === 0) throw new Error(`No corpus files found in ${here}`);

const skipped = [];
const seenIds = new Map();
let caseCount = 0;
let divergenceCount = 0;

for (const file of files) {
  const corpus = JSON.parse(readFileSync(join(here, file), "utf8"));
  if (!corpus.family || !corpus.rules) throw new Error(`${file}: needs "family" and "rules"`);

  describe(`${file} — family ${corpus.family}`, () => {
    for (const [ruleId, rule] of Object.entries(corpus.rules)) {
      if (!Array.isArray(rule.cases) || rule.cases.length === 0) {
        throw new Error(`${file}: rule ${ruleId} has no cases`);
      }
      for (const one of rule.cases) {
        if (!one.id || !Array.isArray(one.in) || !("out" in one) || !one.provenance) {
          throw new Error(`${file}: case in ${ruleId} needs id, in[], out and provenance`);
        }
        if (seenIds.has(one.id)) throw new Error(`duplicate case id ${one.id} (${file} and ${seenIds.get(one.id)})`);
        seenIds.set(one.id, file);
      }

      const target = RULES[ruleId];
      if (rule.runnable === false || !target) {
        skipped.push(`${ruleId}${rule.reason ? ` — ${rule.reason}` : " — no pure function to call"}`);
        it(`${ruleId} is specified but not run here`, () => {
          assert.ok(rule.cases.length, `${ruleId} carries no cases`);
        });
        continue;
      }

      const [moduleFile, exportName] = target;
      for (const one of rule.cases) {
        caseCount += 1;
        it(`${one.id} — ${one.provenance}`, async () => {
          const mod = await moduleOf(moduleFile);
          const raw = mod[exportName];
          assert.ok(raw !== undefined, `${moduleFile} does not export ${exportName} (rule ${ruleId})`);
          const fn = typeof raw === "function" ? raw : () => raw;
          const actual = normalise(await fn(...one.in));
          const label = `${one.id}: ${rule.signature ?? ruleId}`;

          if ("current" in one) {
            assert.deepStrictEqual(actual, normalise(one.current),
              `${label}\nThe tracked divergence changed. The code now returns something other than the value recorded in "current".`);
            assert.notDeepStrictEqual(actual, normalise(one.out),
              `${label}\nThis divergence is FIXED — delete the "current" field so the case asserts the spec.`);
            divergenceCount += 1;
            return;
          }
          assert.deepStrictEqual(actual, normalise(one.out), label);
        });
      }
    }
  });
}

test("corpus coverage", () => {
  console.log(`\n  ${caseCount} cases run against ${Object.keys(RULES).length} mapped rules`);
  if (divergenceCount) {
    console.log(`  ${divergenceCount} tracked divergence(s) — the spec is intended, the code is not there yet`);
  }
  if (skipped.length) {
    console.log(`  specified but not unit-reachable here (covered by tests/run.sh):\n    - ${skipped.join("\n    - ")}`);
  }
});
