import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gateRoot, readJson, writeJson } from "./fs.mjs";
import { RELEASE_VERSION } from "./build.mjs";

export const LEDGER_PATH = join(gateRoot, "work", "release-ledger.json");

export function bumpVersion(current, release) {
  if (release !== "major" && release !== "minor" && release !== "patch")
    throw new Error(`Unknown release kind: ${release}`);
  const [major, minor, patch] = current.split(".").map(Number);
  if ([major, minor, patch].some((n) => Number.isNaN(n)))
    throw new Error(`Invalid semver: ${current}`);
  const next =
    release === "major"
      ? [major + 1, 0, 0]
      : release === "minor"
        ? [major, minor + 1, 0]
        : [major, minor, patch + 1];
  return next.join(".");
}

export function changelogEntry(version, note, date = new Date().toISOString().slice(0, 10)) {
  return { version, note, date };
}

export function loadLedger() {
  if (!existsSync(LEDGER_PATH))
    return { releases: [] };
  return readJson(LEDGER_PATH);
}

export function recordRelease({ layoutId, version, report, dryRun }) {
  const ledger = loadLedger();
  ledger.releases.push({
    layoutId,
    version,
    dryRun: Boolean(dryRun),
    releasedAt: new Date().toISOString(),
    packageCount: report.checks.find((c) =>
      c.check.startsWith("artifacts"),
    )?.details.packageCount,
    checks: report.checks.map((check) => ({
      check: check.check,
      status: check.status,
      violations: check.violations,
      details: check.details,
    })),
  });
  writeJson(LEDGER_PATH, ledger);
  return ledger;
}

export function findRelease(layoutId, version) {
  const ledger = loadLedger();
  return (
    ledger.releases.find(
      (release) =>
        release.layoutId === layoutId &&
        (version ? release.version === version : true),
    ) ?? null
  );
}
