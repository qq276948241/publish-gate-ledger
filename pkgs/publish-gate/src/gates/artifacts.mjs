import { existsSync } from "node:fs";
import { join } from "node:path";
import { hashPackage } from "../lib/manifest.mjs";
import { listFiles, sha256File } from "../lib/fs.mjs";

const REQUIRED_FILES = ["LICENSE.md", "README.md", "CHANGELOG.md", "package.json"];

export function gateArtifacts(layout, section, { manifest, releaseVersion }) {
  if (manifest.packageCount !== Object.keys(layout.packages).length)
    section.add(
      `manifest packageCount ${manifest.packageCount} != config ${Object.keys(layout.packages).length}`,
    );

  for (const [name, pkg] of Object.entries(layout.packages)) {
    const pkgDir = join(layout.outRoot, pkg.dir);

    for (const required of REQUIRED_FILES)
      if (!existsSync(join(pkgDir, required)))
        section.add(`${name}: missing ${required}`);

    const jsFiles = listFiles(pkgDir).filter((f) => /\.js$/.test(f) && !/\.d\.ts$/.test(f));
    for (const js of jsFiles) {
      const relative = js.slice(pkgDir.length + 1);
      const dts = join(pkgDir, relative.replace(/\.js$/, ".d.ts"));
      const cjs = join(pkgDir, relative.replace(/\.js$/, ".cjs"));
      const dcts = join(pkgDir, relative.replace(/\.js$/, ".d.cts"));
      if (!existsSync(dts))
        section.add(`${name}: ${relative} has no matching .d.ts`);
      if (!existsSync(cjs))
        section.add(`${name}: ${relative} has no matching .cjs`);
      if (!existsSync(dcts))
        section.add(`${name}: ${relative} has no matching .d.cts`);
    }

    const manifestPkg = manifest.packages[name];
    if (!manifestPkg) {
      section.add(`${name}: missing from release manifest`);
      continue;
    }
    if (manifestPkg.version !== releaseVersion)
      section.add(
        `${name}: manifest version ${manifestPkg.version} != ${releaseVersion}`,
      );

    const actualHashes = hashPackage(pkgDir);
    for (const [file, expected] of Object.entries(manifestPkg.files ?? {})) {
      const path = join(pkgDir, file);
      if (!existsSync(path)) {
        section.add(`${name}: manifest lists file that no longer exists: ${file}`);
        continue;
      }
      if (sha256File(path) !== expected)
        section.add(`${name}: content changed after manifest: ${file}`);
    }
    for (const file of Object.keys(actualHashes)) {
      if (!(file in (manifestPkg.files ?? {})))
        section.add(`${name}: untracked file outside manifest: ${file}`);
    }
  }

  for (const name of Object.keys(manifest.packages ?? {}))
    if (!layout.packages[name])
      section.add(`manifest references package not in layout: ${name}`);
}
