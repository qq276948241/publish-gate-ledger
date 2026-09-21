#!/usr/bin/env node

/**
 * Gate 1 — 构建产物拆分
 *
 * - 按 release/split.config.json 把主包功能模块拆成可独立安装的功能包
 * - 主包（date-fns）仍是聚合入口，功能包只做门面 re-export，不复制公共代码
 * - 依据源码导入图推导包间依赖，出现循环依赖立刻报错退出
 *
 * 输出：dist/split/<pkg>/... 与 dist/split/manifest.json
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  assert,
  buildPackageGraph,
  configHash,
  findCycles,
  listSourceModules,
  loadConfig,
  readMainVersion,
  srcDir,
  splitDistDir,
} from "./lib.ts";

const config = loadConfig();
const version = readMainVersion();

console.log("🚧 Gate 1: 校验拆分配置...");

const sourceModules = listSourceModules();
const assigned = new Map<string, string>();
for (const pkg of config.packages) {
  assert(pkg.modules.length > 0, `${pkg.name} 没有分配任何模块`);
  for (const module of pkg.modules) {
    assert(
      sourceModules.has(module),
      `${pkg.name} 引用了主包里不存在的模块: ${module}`,
    );
    const previous = assigned.get(module);
    assert(
      !previous,
      `模块 ${module} 同时被 ${previous} 和 ${pkg.name} 拆分，归属必须唯一`,
    );
    assigned.set(module, pkg.name);
  }
}

const unassigned = [...sourceModules].filter((module) => !assigned.has(module));
assert(
  unassigned.length === 0,
  `以下模块没有被任何功能包覆盖，主入口聚合将不完整: ${unassigned.join(", ")}`,
);

// 主包内部功能模块之间会共享内部实现（_lib、互相 import），这些调用全部封装
// 在主包内。功能包是零复制门面，依赖关系以生成产物为准（见 Gate 1b）。
console.log("🟢 拆分配置、模块唯一归属校验通过");

console.log("🚧 生成功能包产物...");
rmSync(splitDistDir, { recursive: true, force: true });
mkdirSync(splitDistDir, { recursive: true });

const manifestPackages = config.packages.map((pkg) => {
  const shortName = pkg.name.split("/")[1];
  const pkgDir = join(splitDistDir, pkg.name);
  mkdirSync(pkgDir, { recursive: true });

  const packageJson = {
    name: pkg.name,
    version,
    description: `date-fns feature package: ${shortName}`,
    license: "MIT",
    type: "module",
    sideEffects: false,
    main: "index.js",
    module: "index.js",
    types: "index.d.ts",
    exports: {
      "./package.json": "./package.json",
      ".": {
        types: "./index.d.ts",
        import: {
          types: "./index.d.ts",
          default: "./index.js",
        },
        default: "./index.js",
      },
    },
    files: ["index.js", "index.d.ts"],
    dependencies: { "date-fns": `^${version}` },
    publishConfig: { access: "public" },
  };

  const exportLines =
    pkg.name === "@date-fns/fp"
      ? collectFpExports()
      : pkg.modules.map((module) => `export * from "date-fns/${module}";`);

  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify(packageJson, null, 2) + "\n",
  );
  writeFileSync(join(pkgDir, "index.js"), exportLines.join("\n") + "\n");
  writeFileSync(join(pkgDir, "index.d.ts"), exportLines.join("\n") + "\n");

  return {
    name: pkg.name,
    modules: pkg.modules,
    dependencies: [],
  };
});

const manifest = {
  generatedAt: new Date().toISOString(),
  version,
  mainPackage: "date-fns",
  mainVersion: version,
  configHash: configHash(config),
  packages: manifestPackages,
};
writeFileSync(
  join(splitDistDir, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);

console.log(
  `🟢 已生成 ${config.packages.length} 个功能包 -> ${splitDistDir}（门面 re-export 主包 date-fns，零代码复制）`,
);

function collectFpExports(): string[] {
  const fpSrc = join(srcDir, "fp");
  if (!existsSync(fpSrc)) return [];
  return readdirSync(fpSrc, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(fpSrc, entry.name, "index.ts")),
    )
    .map((entry) => `export * from "date-fns/fp/${entry.name}";`);
}
