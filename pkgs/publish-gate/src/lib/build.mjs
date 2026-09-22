import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { build } from "rolldown";
import {
  copyFile,
  ensureCleanDir,
  gateRoot,
  repoRoot,
  tzRoot,
  tzSrc,
  writeJson,
} from "./fs.mjs";
import { AGGREGATOR_SUBPATHS, MODULES } from "./modules.mjs";

export const RELEASE_VERSION = "1.6.0";

const MODULE_ENTRY_FILE = {
  constants: "constants/index.ts",
  tzName: "tzName/index.ts",
  tzOffset: "tzOffset/index.ts",
  "date/mini": "date/mini.js",
  date: "date/index.js",
  tzScan: "tzScan/index.ts",
  tz: "tz/index.ts",
};

export function resolveModuleSpec(spec, fromMod) {
  if (!spec.startsWith(".")) return null;
  // Module "m" behaves as file "m/index"; "date/mini" is a file module.
  const fromFile =
    fromMod === "date/mini" ? "date/mini" : `${fromMod}/index`;
  const fromDir = fromFile.slice(0, fromFile.lastIndexOf("/"));
  const baseDirParts = fromDir ? fromDir.split("/") : [];
  const parts = [...baseDirParts];
  for (const rawPiece of spec.split("/")) {
    const piece = rawPiece.replace(/\.(ts|js|cjs|mjs)$/, "");
    if (piece === "..") parts.pop();
    else if (piece !== ".") parts.push(piece);
  }
  let target = parts.join("/");
  // Modules map: "<mod>/index" (except date/mini which is a file module).
  if (target === "date/mini") return "date/mini";
  if (target.endsWith("/index"))
    target = target.slice(0, -"/index".length);
  return MODULES.includes(target) ? target : null;
}

function moduleFromPath(path) {
  const marker = `${join("tz", "src")}${join("/")}`;
  const idx = path.lastIndexOf(marker);
  if (idx === -1) return null;
  const rest = path.slice(idx + marker.length);
  let mod = rest
    .replace(/\.(ts|js)$/, "")
    .replace(/\/index$/, "");
  if (mod === "date/mini") mod = "date/mini";
  return MODULES.includes(mod) ? mod : null;
}

function rewriteExternalPlugin(layout, format) {
  return {
    name: "split-external-rewrite",
    async resolveId(source, importer) {
      if (!importer || !source.startsWith(".")) return null;
      const importerMod = moduleFromPath(importer);
      if (!importerMod) return null;
      const targetMod = resolveModuleSpec(source, importerMod);
      if (!targetMod) return null;
      const fromOwner = layout.moduleOwners.get(importerMod);
      const targetOwner = layout.moduleOwners.get(targetMod);
      if (fromOwner === targetOwner) return null;
      return {
        id: `${targetOwner}/${targetMod}`,
        external: true,
      };
    },
  };
}

function rewriteLocalExtensionsPlugin(format) {
  const ext = format === "esm" ? ".js" : ".cjs";
  return {
    name: "rewrite-local-extensions",
    renderChunk(code, chunk) {
      const next = code.replace(
        /(from\s*["']|import\(\s*["']|require\(\s*["'])(\.{1,2}\/[^"']+?)(\.[jt]s)(["'])/g,
        (_m, prefix, path, _old, suffix) =>
          `${prefix}${path}${ext}${suffix}`,
      );
      return next === code ? null : { code: next, map: chunk.map ?? null };
    },
  };
}

export function orderedModules(modules) {
  return MODULES.filter((mod) => modules.includes(mod));
}

export function esmBarrel(modules) {
  return (
    orderedModules(modules)
      .map((mod) =>
        mod === "date/mini"
          ? 'export * from "./date/mini.js";'
          : `export * from "./${mod}/index.js";`,
      )
      .join("\n") + "\n"
  );
}

export function cjsBarrel(modules) {
  const ordered = orderedModules(modules);
  const lines = ["'use strict'"];
  ordered.forEach((mod, i) => {
    lines.push(
      mod === "date/mini"
        ? `const __ns${i} = require("./date/mini.cjs");`
        : `const __ns${i} = require("./${mod}/index.cjs");`,
    );
  });
  ordered.forEach((_mod, i) => {
    lines.push(`Object.assign(module.exports, __ns${i});`);
  });
  return lines.join("\n") + "\n";
}

export function dtsBarrel(modules) {
  return (
    orderedModules(modules)
      .map((mod) =>
        mod === "date/mini"
          ? 'export * from "./date/mini.js";'
          : `export * from "./${mod}/index.js";`,
      )
      .join("\n") + "\n"
  );
}

export function subpathExports(subpaths) {
  const exportsMap = { "./package.json": "./package.json" };
  const make = (stem) => ({
    import: { types: `./${stem}.d.ts`, default: `./${stem}.js` },
    require: { types: `./${stem}.d.cts`, default: `./${stem}.cjs` },
  });
  exportsMap["."] = make("index");
  for (const sub of subpaths) exportsMap[`./${sub}`] = make(sub);
  return exportsMap;
}

function splitPackageExports(modules) {
  const exportsMap = {
    "./package.json": "./package.json",
    ".": {
      import: { types: "./index.d.ts", default: "./index.js" },
      require: { types: "./index.d.cts", default: "./index.cjs" },
    },
  };
  for (const mod of orderedModules(modules)) {
    const stem = mod === "date/mini" ? "date/mini" : `${mod}/index`;
    exportsMap[`./${mod}`] = {
      import: {
        types: `./${stem}.d.ts`,
        default: `./${stem}.js`,
      },
      require: {
        types: `./${stem}.d.cts`,
        default: `./${stem}.cjs`,
      },
    };
  }
  return exportsMap;
}

export function packageJsonFor({ name, modules, aggregator, deps, version }) {
  const pkg = {
    name,
    version,
    description: aggregator
      ? "Aggregator entry re-exporting the split layout of @date-fns/tz"
      : "Split build of @date-fns/tz",
    license: "MIT",
    type: "module",
    sideEffects: false,
    exports: aggregator
      ? subpathExports(AGGREGATOR_SUBPATHS)
      : splitPackageExports(modules),
  };
  if (deps.length)
    pkg.dependencies = Object.fromEntries(
      deps.map((dep) => [dep, version]),
    );
  return pkg;
}

const PRESERVE_ROOT = join(repoRoot, "pkgs");

async function bundleModules({ layout, modules, outPkg, format }) {
  const input = modules.map((mod) => join(tzSrc, MODULE_ENTRY_FILE[mod]));
  const extension = format === "esm" ? "js" : "cjs";
  await build({
    input,
    plugins: [rewriteExternalPlugin(layout, format)],
    optimization: { inlineConst: false },
    output: {
      dir: outPkg,
      format: format === "esm" ? "esm" : "cjs",
      entryFileNames: "[name].js",
      chunkFileNames: "[name].js",
      preserveModules: true,
      preserveModulesRoot: PRESERVE_ROOT,
      plugins: [rewriteLocalExtensionsPlugin(format)],
    },
  });

  // Flatten "tz/src/<mod>/index.js" -> "<mod>/index.<ext>".
  const nestedRoot = join(outPkg, "tz", "src");
  for (const mod of modules) {
    const entry = MODULE_ENTRY_FILE[mod].replace(/\.(ts|js)$/, "");
    // entryFileNames is fixed to "[name].js"; the on-disk source is always
    // .js even when emitting CJS.
    const from = join(nestedRoot, `${entry}.js`);
    const to =
      mod === "date/mini"
        ? join(outPkg, "date", `mini.${extension}`)
        : join(outPkg, mod, `index.${extension}`);
    if (!existsSync(from))
      throw new Error(`Bundle output missing for ${mod}: ${from}`);
    copyFile(from, to);
  }
  // Only remove the nested intermediate tree, never the flattened module
  // directories (a module named "tz" lives at "<pkg>/tz/" and would be
  // deleted together with the nested "<pkg>/tz/src" parent).
  rmSync(nestedRoot, { recursive: true, force: true });
}

function samePackageSpec(fromMod, targetMod) {
  const targetIsFile = targetMod === "date/mini";
  const targetFile = targetIsFile
    ? targetMod
    : `${targetMod}/index`;
  const fromFile =
    fromMod === "date/mini" ? fromMod : `${fromMod}/index`;
  let relativePath = relative(dirname(`/root/${fromFile}`), `/root/${targetFile}`);
  if (!relativePath.startsWith(".")) relativePath = `./${relativePath}`;
  return relativePath;
}

export function rewriteDtsImports(content, layout, pkgName, mod) {
  return content.replace(
    /(from\s*["'])(\.{1,2}\/[^"']+?)(\.(?:ts|js))?(["'])/g,
    (match, prefix, spec, _ext, suffix) => {
      const target = resolveModuleSpec(spec, mod);
      if (!target) {
        if (mod === "date/mini" && spec === "./index.js") {
          return `${prefix}./index.js${suffix}`;
        }
        const normalized = spec.replace(/\.ts$/, ".js");
        return `${prefix}${normalized}${suffix}`;
      }
      const targetOwner = layout.moduleOwners.get(target);
      if (targetOwner === pkgName)
        return `${prefix}${samePackageSpec(mod, target)}.js${suffix}`;
      return `${prefix}${targetOwner}/${target}${suffix}`;
    },
  );
}

export function dtsToCts(content) {
  // Only relative imports carry explicit extensions; package subpaths are
  // resolved through "exports" and must stay extension-free.
  return content
    .replace(
      /(from\s*["'])(\.{1,2}\/[^"']+?)\.js(["'])/g,
      "$1$2.cjs$3",
    )
    .replace(
      /(from\s*["'])(\.{1,2}\/[^"']+?)\.ts(["'])/g,
      "$1$2.cts$3",
    );
}

const STAGED_DTS = {
  constants: "constants/index.d.ts",
  tzName: "tzName/index.d.ts",
  tzOffset: "tzOffset/index.d.ts",
  tzScan: "tzScan/index.d.ts",
  tz: "tz/index.d.ts",
  date: "date/index.d.ts",
  "date/mini": "date/mini.d.ts",
};

function runTsgo(staging) {
  const bin = join(repoRoot, "node_modules", ".bin", "tsgo");
  const args = [
    bin,
    "--ignoreConfig",
    "--declaration",
    "--emitDeclarationOnly",
    "--target",
    "esnext",
    "--module",
    "nodenext",
    "--moduleResolution",
    "nodenext",
    "--allowImportingTsExtensions",
    "--skipLibCheck",
    "--rootDir",
    tzSrc,
    "--outDir",
    staging,
    join(tzSrc, "constants", "index.ts"),
    join(tzSrc, "tzName", "index.ts"),
    join(tzSrc, "tzOffset", "index.ts"),
    join(tzSrc, "tzScan", "index.ts"),
    join(tzSrc, "tz", "index.ts"),
    join(tzSrc, "date", "index.d.ts"),
    join(tzSrc, "date", "mini.d.ts"),
  ];
  execFileSync("/bin/sh", args, { cwd: repoRoot, stdio: "pipe" });

  // tsgo only emits declarations for .ts inputs; hand-written .d.ts files
  // (date/index.d.ts, date/mini.d.ts) are copied into staging as-is.
  cpSync(join(tzSrc, "date", "index.d.ts"), join(staging, "date", "index.d.ts"));
  cpSync(
    join(tzSrc, "date", "mini.d.ts"),
    join(staging, "date", "mini.d.ts"),
  );
}

export function runOxFmt(paths) {
  const bin = join(repoRoot, "node_modules", ".bin", "oxfmt");
  execFileSync("/bin/sh", [bin, ...paths], {
    cwd: repoRoot,
    stdio: "ignore",
  });
}

function writeAggregator(outPkg, layout, name) {
  const deps = layout.dependsOn[name];
  mkdirSync(outPkg, { recursive: true });
  const esm =
    deps.map((dep) => `export * from "${dep}";`).join("\n") + "\n";
  const cjs =
    "'use strict';\n" +
    deps
      .map((dep, i) => `const __ns${i} = require("${dep}");`)
      .join("\n") +
    "\n" +
    deps.map((_dep, i) => `Object.assign(module.exports, __ns${i});`).join("\n") +
    "\n";
  writeFileSync(join(outPkg, "index.js"), esm);
  writeFileSync(join(outPkg, "index.cjs"), cjs);
  writeFileSync(join(outPkg, "index.d.ts"), esm);
  writeFileSync(join(outPkg, "index.d.cts"), dtsToCts(esm));

  for (const sub of AGGREGATOR_SUBPATHS) {
    const owner = layout.moduleOwners.get(sub);
    const js = `export * from "${owner}/${sub}";\n`;
    const subBase = sub === "date/mini" ? "date/mini" : sub;
    mkdirSync(join(outPkg, dirname(subBase)), { recursive: true });
    writeFileSync(join(outPkg, `${subBase}.js`), js);
    writeFileSync(join(outPkg, `${subBase}.d.ts`), js);
    const cjsSub =
      `'use strict';\nconst __ns = require("${owner}/${sub}");\n` +
      "Object.assign(module.exports, __ns);\n";
    writeFileSync(join(outPkg, `${subBase}.cjs`), cjsSub);
    writeFileSync(join(outPkg, `${subBase}.d.cts`), dtsToCts(js));
  }
}

export async function buildLayout(layout, { version = RELEASE_VERSION } = {}) {
  const id = layout.config.id;
  const outRoot = join(gateRoot, "dist", id);
  ensureCleanDir(outRoot);

  const staging = join(gateRoot, "work", id, "dts-staging");
  ensureCleanDir(staging);
  runTsgo(staging);

  const pkgRecords = {};

  for (const [name, pkg] of Object.entries(layout.packages)) {
    const modules = pkg.modules ?? [];
    const outPkg = join(outRoot, pkg.dir);
    const deps = layout.dependsOn[name] ?? [];

    if (!pkg.aggregator) {
      await bundleModules({
        layout,
        modules,
        outPkg,
        format: "esm",
      });
      await bundleModules({
        layout,
        modules,
        outPkg,
        format: "cjs",
      });

      rmSync(join(outPkg, "tz", "src"), {
        recursive: true,
        force: true,
      });
      // Empty "tz" parent may remain when no module flattens into it.
      if (
        existsSync(join(outPkg, "tz")) &&
        !modules.includes("tz")
      )
        rmSync(join(outPkg, "tz"), { recursive: true, force: true });

      const ordered = orderedModules(modules);
      writeFileSync(join(outPkg, "index.js"), esmBarrel(ordered));
      writeFileSync(join(outPkg, "index.cjs"), cjsBarrel(ordered));
      writeFileSync(join(outPkg, "index.d.ts"), dtsBarrel(ordered));
      writeFileSync(
        join(outPkg, "index.d.cts"),
        dtsBarrel(ordered).replace(/\.js"/g, '.cjs"'),
      );

      for (const mod of modules) {
        const staged = join(staging, STAGED_DTS[mod]);
        if (!existsSync(staged))
          throw new Error(`Missing staged declaration for ${mod}`);
        const dts = rewriteDtsImports(
          readFileSync(staged, "utf8"),
          layout,
          name,
          mod,
        );
        const dtsBase =
          mod === "date/mini" ? "date/mini.d.ts" : `${mod}/index.d.ts`;
        mkdirSync(join(outPkg, dtsBase, ".."), { recursive: true });
        writeFileSync(join(outPkg, dtsBase), dts);
        writeFileSync(
          join(outPkg, dtsBase.replace(/\.d\.ts$/, ".d.cts")),
          dtsToCts(dts),
        );
      }
    } else {
      writeAggregator(outPkg, layout, name);
    }

    writeJson(
      join(outPkg, "package.json"),
      packageJsonFor({
        name,
        modules,
        aggregator: Boolean(pkg.aggregator),
        deps,
        version,
      }),
    );
    copyFile(join(tzRoot, "LICENSE.md"), join(outPkg, "LICENSE.md"));
    copyFile(join(tzRoot, "README.md"), join(outPkg, "README.md"));

    pkgRecords[name] = {
      dir: pkg.dir,
      version,
      ...(pkg.aggregator
        ? { aggregator: true, modules: [] }
        : { modules: orderedModules(modules) }),
      dependsOn: deps,
    };
  }

  const fmtPaths = Object.values(layout.packages).flatMap((pkg) => [
    join(outRoot, pkg.dir),
  ]);
  runOxFmt(fmtPaths);

  return { outRoot, pkgRecords };
}
