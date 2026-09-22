import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { listFiles } from "../lib/fs.mjs";

const IMPORT_RE =
  /(?:from|import|require)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

const EXPORT_DECL_RE =
  /export\s+(?:declare\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;

const EXPORT_LIST_RE = /export\s*\{([^}]*)\}/g;

export function declaredNames(dtsContent) {
  const names = new Set();
  for (const match of dtsContent.matchAll(EXPORT_DECL_RE))
    names.add(match[1]);
  for (const match of dtsContent.matchAll(EXPORT_LIST_RE)) {
    for (const part of match[1].split(",")) {
      const cleaned = part
        .replace(/^type\s+/, "")
        .replace(/\s+as\s+.*$/, "")
        .trim();
      if (cleaned && !cleaned.startsWith("*")) names.add(cleaned);
    }
  }
  return names;
}

function runtimeNames(cjsPath) {
  const localRequire = createRequire(join(cjsPath, "..", "noop.js"));
  const exports = localRequire(cjsPath);
  return new Set(Object.keys(exports));
}

function iterExportTargets(exportsField) {
  const out = [];
  const walk = (value) => {
    if (typeof value === "string") out.push(value);
    else if (value && typeof value === "object")
      for (const v of Object.values(value)) walk(v);
  };
  walk(exportsField);
  return out;
}

export function gateTypes(layout, section, { releaseVersion }) {
  for (const [name, pkg] of Object.entries(layout.packages)) {
    const pkgDir = join(layout.outRoot, pkg.dir);
    const manifest = JSON.parse(
      readFileSync(join(pkgDir, "package.json"), "utf8"),
    );

    if (manifest.version !== releaseVersion)
      section.add(
        `${name}: package version ${manifest.version} != release version ${releaseVersion}`,
      );

    for (const target of iterExportTargets(manifest.exports)) {
      if (target === "./package.json") continue;
      const path = join(pkgDir, target);
      if (!existsSync(path))
        section.add(`${name}: export target missing on disk: ${target}`);
    }

    for (const file of listFiles(pkgDir)) {
      if (!/\.(d\.ts|d\.cts)$/.test(file)) continue;
      const content = readFileSync(file, "utf8");

      // Relative imports inside declarations must resolve inside the package.
      for (const match of content.matchAll(IMPORT_RE)) {
        const spec = match[1];
        const candidate = resolve(dirname(file), spec);
        const resolved =
          [candidate, `${candidate}.ts`, `${candidate}.d.ts`].find((p) =>
            existsSync(p),
          ) ??
          (existsSync(join(candidate, "index.d.ts"))
            ? join(candidate, "index.d.ts")
            : null);
        if (!resolved)
          section.add(
            `${name}: ${file.slice(pkgDir.length + 1)} imports unresolved "${spec}"`,
          );
      }
    }

    // Runtime vs declaration surface parity for each owned module.
    if (!pkg.aggregator) {
      for (const mod of pkg.modules ?? []) {
        const dtsPath =
          mod === "date/mini"
            ? join(pkgDir, "date", "mini.d.ts")
            : join(pkgDir, mod, "index.d.ts");
        const cjsPath =
          mod === "date/mini"
            ? join(pkgDir, "date", "mini.cjs")
            : join(pkgDir, mod, "index.cjs");
        if (!existsSync(dtsPath)) {
          section.add(`${name}: missing declaration for module ${mod}`);
          continue;
        }
        const declared = declaredNames(readFileSync(dtsPath, "utf8"));
        let actual;
        try {
          actual = runtimeNames(cjsPath);
        } catch (error) {
          section.add(`${name}/${mod}: cannot load CJS: ${error.message}`);
          continue;
        }
        // Interfaces/types have no runtime export.
        const runtimeDeclared = new Set(declared);
        for (const runtimeName of actual) {
          if (!runtimeDeclared.has(runtimeName))
            section.add(
              `${name}/${mod}: runtime exports "${runtimeName}" missing from declaration`,
            );
        }
        for (const declaredName of declared) {
          if (!actual.has(declaredName)) {
            // Allow type-only exports: verify the name appears with a
            // type-only declaration keyword context.
            const dts = readFileSync(dtsPath, "utf8");
            const typeOnly = new RegExp(
              `export\\s+(declare\\s+)?(interface|type)\\s+${declaredName}\\b`,
            );
            if (!typeOnly.test(dts))
              section.add(
                `${name}/${mod}: declaration exports "${declaredName}" missing from runtime`,
              );
          }
        }
      }
    }
  }
}
