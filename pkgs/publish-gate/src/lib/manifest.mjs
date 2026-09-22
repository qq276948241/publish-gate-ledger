import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles, sha256File, writeJson } from "./fs.mjs";

export function hashPackage(outPkg) {
  const files = {};
  for (const file of listFiles(outPkg)) {
    const relative = file.slice(outPkg.length + 1);
    files[relative] = sha256File(file);
  }
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function writeReleaseManifest({ outRoot, id, version, pkgRecords, source }) {
  const packages = {};
  for (const [name, record] of Object.entries(pkgRecords)) {
    packages[name] = {
      ...record,
      files: hashPackage(join(outRoot, record.dir)),
    };
  }
  const manifest = {
    id,
    source,
    version,
    builtAt: new Date().toISOString(),
    packageCount: Object.keys(packages).length,
    packages,
  };
  writeJson(join(outRoot, "release-manifest.json"), manifest);
  return manifest;
}

export function linkPackages(outRoot, packages) {
  const scopeDir = join(outRoot, "node_modules", "@date-fns");
  rmSync(join(outRoot, "node_modules"), { recursive: true, force: true });
  mkdirSync(scopeDir, { recursive: true });
  for (const [name, pkg] of Object.entries(packages)) {
    const shortName = name.replace("@date-fns/", "");
    symlinkSync(join(outRoot, pkg.dir), join(scopeDir, shortName), "dir");
  }
}

export function writeChangelogs(layout, outRoot, entry) {
  for (const pkg of Object.values(layout.packages)) {
    mkdirSync(join(outRoot, pkg.dir), { recursive: true });
    const path = join(outRoot, pkg.dir, "CHANGELOG.md");
    const content = `## ${entry.version} — ${entry.date}\n\n- ${entry.note}\n`;
    writeFileSync(path, content);
  }
}
