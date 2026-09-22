#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildLayout, RELEASE_VERSION } from "./lib/build.mjs";
import { gateRoot, readJson, writeJson } from "./lib/fs.mjs";
import {
  changelogEntry,
  findRelease,
  loadLedger,
  recordRelease,
} from "./lib/release.mjs";
import {
  linkPackages,
  writeChangelogs,
  writeReleaseManifest,
} from "./lib/manifest.mjs";
import { gateDeps, validateConfig } from "./gates/deps.mjs";
import { gateTypes } from "./gates/types.mjs";
import { gateArtifacts } from "./gates/artifacts.mjs";
import { gateTreeshake } from "./gates/treeshake.mjs";
import { gateConsumer } from "./lib/consumer.mjs";
import { CheckFailure, Report, dim, fail, info, pass } from "./lib/log.mjs";

const args = process.argv.slice(2);

function flag(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return args[index + 1] ?? true;
}

function loadLayoutById(id) {
  const config = readJson(join(gateRoot, "src", "config", `${id}.json`));
  const layout = validateConfig(config);
  const outRoot = join(gateRoot, "dist", id);
  return { ...layout, outRoot };
}

async function buildCommand(id) {
  const version = flag("version", RELEASE_VERSION);
  const note =
    flag("note", `Fine-grained split release (${id} layout).`) ??
    `Fine-grained split release (${id} layout).`;
  const config = readJson(join(gateRoot, "src", "config", `${id}.json`));
  let layout = validateConfig(config);

  info(`building split layout "${id}" (${Object.keys(config.packages).length} packages)`);
  const { outRoot, pkgRecords } = await buildLayout(layout, { version });
  layout = { ...layout, outRoot };

  const entry = changelogEntry(version, note);
  writeChangelogs(layout, outRoot, entry);
  linkPackages(outRoot, layout.packages);

  // Manifest hashes must cover the final content (incl. changelogs).
  const manifest = writeReleaseManifest({
    outRoot,
    id,
    version,
    pkgRecords,
    source: "@date-fns/tz",
  });
  pass(`wrote ${manifest.packageCount} packages to ${dim(outRoot)}`);
  return { layout, manifest };
}

async function runGates(layout, manifest, { selection = "all" } = {}) {
  const report = new Report(layout.config.id);
  const gates = [];
  if (selection === "all" || selection === "deps")
    gates.push({
      name: "deps: split, shared ownership, no cycles, sideEffects",
      run: (s) => gateDeps(layout, s),
    });
  if (selection === "all" || selection === "treeshake")
    gates.push({
      name: "treeshake: dead code removed, behavior parity, no shells",
      run: async (s) => gateTreeshake(layout, s),
    });
  if (selection === "all" || selection === "types")
    gates.push({
      name: "types: declarations shipped, versioned, surface-complete",
      run: (s) =>
        gateTypes(layout, s, { releaseVersion: manifest.version }),
    });
  if (selection === "all" || selection === "artifacts")
    gates.push({
      name: "artifacts: package count, file completeness, manifest hashes",
      run: (s) =>
        gateArtifacts(layout, s, {
          manifest,
          releaseVersion: manifest.version,
        }),
    });
  if (selection === "all" || selection === "consumer")
    gates.push({
      name: "consumer: downstream runtime + typecheck smoke",
      run: async (s) => gateConsumer(layout, s),
    });

  for (const gate of gates) {
    info(gate.name);
    const section = report.section(gate.name);
    await gate.run(section);
    report.finish(
      report.checks[report.checks.length - 1],
      section.violations.length === 0 ? "pass" : "fail",
    );
  }
  return report;
}

function readBuilt(id) {
  const layout = loadLayoutById(id);
  const manifestPath = join(layout.outRoot, "release-manifest.json");
  if (!existsSafe(manifestPath))
    throw new Error(`No build found for "${id}". Run build ${id} first.`);
  const manifest = readJson(manifestPath);
  return { layout, manifest };
}

function existsSafe(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const command = args[0];

  if (command === "build") {
    const ids = args[1] && !args[1].startsWith("--") ? [args[1]] : ["coarse", "fine"];
    for (const id of ids) await buildCommand(id);
    return;
  }

  if (command === "gate") {
    const selection = args[1] ?? "all";
    const id = flag("layout");
    const ids = id ? [id] : ["coarse", "fine"];
    let failed = false;
    for (const layoutId of ids) {
      info(`gating layout ${layoutId}`);
      const { layout, manifest } = readBuilt(layoutId);
      const report = await runGates(layout, manifest, {
        selection: selection === "all" ? "all" : selection,
      });
      report.print();
      persistReport(layoutId, report);
      if (!report.ok) failed = true;
    }
    if (failed) process.exit(1);
    return;
  }

  if (command === "release") {
    const id = args[1] ?? "fine";
    const dryRun = args.includes("--dry-run");
    const skipBuild = args.includes("--check-existing");
    const { layout, manifest } = skipBuild
      ? readBuilt(id)
      : await buildCommand(id);
    const report = await runGates(layout, manifest);
    report.print();
    persistReport(id, report);
    if (!report.ok) {
      fail("release halted: gates failed, nothing published");
      process.exit(1);
    }
    recordRelease({
      layoutId: id,
      version: manifest.version,
      report,
      dryRun,
    });
    pass(
      dryRun
        ? `dry-run release ${id}@${manifest.version} recorded`
        : `release ${id}@${manifest.version} recorded in ledger`,
    );
    return;
  }

  if (command === "verify") {
    const id = args[1] ?? "fine";
    const { layout, manifest } = await buildCommand(id);
    const report = await runGates(layout, manifest);
    report.print();
    persistReport(id, report);
    if (!report.ok) process.exit(1);
    pass(`full pipeline verified for ${id}@${manifest.version}`);
    return;
  }

  if (command === "report") {
    const id = args[1];
    const version = flag("version");
    if (id) {
      const release = findRelease(id, version);
      if (!release) {
        fail(`no recorded release for ${id}${version ? `@${version}` : ""}`);
        process.exit(1);
      }
      console.log(JSON.stringify(release, null, 2));
    } else {
      console.log(JSON.stringify(loadLedger(), null, 2));
    }
    return;
  }

  if (command === "selftest") {
    const { selftest } = await import("./selftest.mjs");
    await selftest();
    return;
  }

  console.error(
    "usage: publish-gate <build|gate|release|verify|report|selftest> ...",
  );
  process.exit(2);
}

function persistReport(id, report) {
  writeJson(
    join(gateRoot, "work", id, "gate-report.json"),
    report.toJSON(),
  );
}

main().catch((error) => {
  if (error instanceof CheckFailure) {
    fail(error.message);
    process.exit(1);
  }
  fail(error.stack ?? error.message);
  process.exit(1);
});
