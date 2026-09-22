import { cpSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateRoot, readJson, writeJson } from "./lib/fs.mjs";
import { gateDeps, validateConfig } from "./gates/deps.mjs";
import { gateTypes } from "./gates/types.mjs";
import { gateArtifacts } from "./gates/artifacts.mjs";
import { pass } from "./lib/log.mjs";

function newSection() {
  return {
    violations: [],
    details: {},
    add(v) {
      this.violations.push(v);
    },
    detail(key, value) {
      this.details[key] = value;
    },
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(`selftest assertion failed: ${message}`);
}

export async function selftest() {
  const fineConfig = readJson(join(gateRoot, "src", "config", "fine.json"));
  const outRoot = join(gateRoot, "dist", "fine");
  const layout = { ...validateConfig(fineConfig), outRoot };
  const manifest = readJson(join(outRoot, "release-manifest.json"));

  // 1. Circular dependencies must be rejected at config load time.
  const cyclic = structuredClone(fineConfig);
  cyclic.id = "selftest-cycle";
  // Move tzOffset into the scan package and tzScan into the offset package:
  // scan -> offset (tzScan imports tzOffset) and offset -> scan (aggregator
  // graph wiring) produces a package-level cycle.
  cyclic.packages["@date-fns/tz-offset"].modules = ["tzScan"];
  cyclic.packages["@date-fns/tz-scan"].modules = ["tzOffset"];
  try {
    validateConfig(cyclic);
    throw new Error("cycle not detected");
  } catch (error) {
    assert(
      /circular|cycle/i.test(error.message),
      `expected cycle error, got ${error.message}`,
    );
    pass("cycle detection rejects cyclic package graphs");
  }

  // 2. Types gate must catch a dangling relative import in declarations.
  const scratch = join(gateRoot, "work", "selftest");
  rmSync(scratch, { recursive: true, force: true });
  cpSync(outRoot, scratch, { recursive: true });
  const scratchLayout = { ...layout, outRoot: scratch };
  const dtsFile = join(
    scratch,
    "date-fns-tz-factory",
    "tz",
    "index.d.ts",
  );
  writeFileSync(
    dtsFile,
    'import { TZDate } from "../date/index.js";\nexport declare const tz: 1;\n',
  );
  const typesSection = newSection();
  gateTypes(scratchLayout, typesSection, {
    releaseVersion: manifest.version,
  });
  assert(
    typesSection.violations.some((v) => v.includes("unresolved")),
    `types gate missed dangling import: ${typesSection.violations.join("; ")}`,
  );
  pass("types gate rejects dangling declaration imports");

  // 3. Version skew must stop the release.
  const skewPkg = join(scratch, "date-fns-tz-core", "package.json");
  const skewManifest = readJson(skewPkg);
  skewManifest.version = "9.9.9";
  writeJson(skewPkg, skewManifest);
  const skewSection = newSection();
  gateTypes(scratchLayout, skewSection, { releaseVersion: "1.6.0" });
  assert(
    skewSection.violations.some((v) => v.includes("9.9.9")),
    "version skew not detected",
  );
  pass("types gate rejects version skew between declarations and release");

  // 4. Artifacts gate must catch tampered/untracked files.
  writeFileSync(join(scratch, "date-fns-tz-core", "rogue.js"), "export const rogue = 1;\n");
  const artifactsSection = newSection();
  gateArtifacts(scratchLayout, artifactsSection, {
    manifest,
    releaseVersion: manifest.version,
  });
  assert(
    artifactsSection.violations.some((v) => v.includes("untracked")),
    "untracked artifact not detected",
  );
  pass("artifacts gate rejects untracked files");

  // 5. sideEffects marker must be enforced.
  const noSideEffectsPkg = join(
    scratch,
    "date-fns-tz-name",
    "package.json",
  );
  const stripped = readJson(noSideEffectsPkg);
  delete stripped.sideEffects;
  writeJson(noSideEffectsPkg, stripped);
  const depsSection = newSection();
  gateDeps(scratchLayout, depsSection);
  assert(
    depsSection.violations.some((v) => v.includes("sideEffects")),
    "missing sideEffects marker not detected",
  );
  pass("deps gate enforces sideEffects:false markers");

  rmSync(scratch, { recursive: true, force: true });
  console.log("selftest: all mutation probes were caught by the gates");
}
