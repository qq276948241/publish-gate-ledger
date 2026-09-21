#!/usr/bin/env node

/**
 * Gate 3 — 类型声明发布
 *
 * 每个拆出去的包都必须随包携带声明，且：
 * 1. package.json 的 types/exports.types 指向的 .d.ts 文件真实存在
 * 2. 功能包版本 = 主包 package.json 版本 = 主包产物版本 = manifest 版本
 * 3. 声明 re-export 的每个子路径，在主包产物里都有匹配的 .d.ts
 * 4. 声明导出的符号集合必须与 JS 产物实际导出一致（多一个/少一个都报错）
 *
 * 声明或拆分方式变更后必须重跑本 Gate；对不上即非零退出，阻断发布。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assert,
  listGeneratedPackages,
  mainDistDir,
  readMainVersion,
  splitDistDir,
} from "./lib.ts";

console.log("🚧 Gate 3: 类型声明与版本一致性核对...");

const version = readMainVersion();
const manifest = JSON.parse(
  readFileSync(join(splitDistDir, "manifest.json"), "utf8"),
);
assert(
  manifest.version === version,
  `manifest 版本 ${manifest.version} 与 package.json 版本 ${version} 不一致`,
);
const mainBuiltVersion = JSON.parse(
  readFileSync(join(mainDistDir, "package.json"), "utf8"),
).version;
assert(
  mainBuiltVersion === version,
  `主包产物版本 ${mainBuiltVersion} 与源码版本 ${version} 不一致：请重新构建`,
);

const packages = listGeneratedPackages();
let declarationCount = 0;

for (const pkg of packages) {
  // 1) 版本一致
  assert(
    pkg.version === version,
    `${pkg.name}@${pkg.version} 与主包版本 ${version} 不一致`,
  );

  // 2) 声明文件存在且被 manifest 正确引用
  const manifestJson = JSON.parse(
    readFileSync(join(pkg.dir, "package.json"), "utf8"),
  );
  const typesPath = manifestJson.types;
  assert(typesPath, `${pkg.name} 缺少 types 字段`);
  const normalizedTypes = typesPath.startsWith("./")
    ? typesPath
    : `./${typesPath}`;
  const dtsFile = join(pkg.dir, normalizedTypes);
  assert(existsSync(dtsFile), `${pkg.name} 的声明文件 ${typesPath} 不存在`);
  assert(
    manifestJson.exports?.["."]?.types === normalizedTypes ||
      manifestJson.exports?.["."]?.import?.types === normalizedTypes,
    `${pkg.name} exports["."] 未通过 types 暴露声明文件 ${typesPath}`,
  );

  // 3)+4) 逐条核对声明 re-export：目标声明存在，且符号集合与 JS 一致
  const dts = readFileSync(dtsFile, "utf8");
  // 门面声明只允许 re-export，禁止声明自有符号（否则会出现 JS 里不存在的“幽灵导出”）
  const ownExports = [
    ...dts.matchAll(
      /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/g,
    ),
  ].map((match) => match[1]);
  assert(
    ownExports.length === 0,
    `${pkg.name} 门面声明包含 JS 产物中不存在的自有导出: ${ownExports.join(", ")}`,
  );
  const specs = [
    ...dts.matchAll(/export\s*(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/g),
  ].map((match) => match[1]);
  assert(
    specs.length === pkg.facadeSpecs.length,
    `${pkg.name} 声明 re-export 数（${specs.length}）与 JS 门面（${pkg.facadeSpecs.length}）不一致`,
  );

  for (const spec of specs) {
    const moduleName = spec.slice("date-fns/".length);
    const jsFile = moduleName.startsWith("fp/")
      ? join(mainDistDir, "fp", `${moduleName.slice(3)}.js`)
      : join(mainDistDir, `${moduleName}.js`);
    const dtsTarget = moduleName.startsWith("fp/")
      ? join(mainDistDir, "fp", `${moduleName.slice(3)}.d.ts`)
      : join(mainDistDir, `${moduleName}.d.ts`);

    assert(
      existsSync(jsFile),
      `${pkg.name} 声明引用的 ${spec} 没有对应 JS 产物`,
    );
    assert(
      existsSync(dtsTarget),
      `${pkg.name} 声明引用的 ${spec} 在主包缺少 .d.ts 声明`,
    );

    // 值导出符号集合必须一致；纯类型导出（type/interface）允许只存在于声明
    const dtsExports = collectDtsValueExports(
      readFileSync(dtsTarget, "utf8"),
      dtsTarget,
    );
    const jsExports = collectJsExports(readFileSync(jsFile, "utf8"));
    const onlyInTypes = [...dtsExports].filter((name) => !jsExports.has(name));
    const onlyInJs = [...jsExports].filter((name) => !dtsExports.has(name));
    assert(
      onlyInTypes.length === 0,
      `${spec}: 声明里多导出了 JS 产物没有的值符号: ${onlyInTypes.join(", ")}`,
    );
    assert(
      onlyInJs.length === 0,
      `${spec}: JS 产物导出了声明里缺失的符号: ${onlyInJs.join(", ")}`,
    );
    declarationCount++;
  }
}

console.log(
  `🟢 ${packages.length} 个包声明齐全、版本全部锁定 ${version}、${declarationCount} 条 re-export 的符号集合与 JS 产物逐一相符`,
);

function collectJsExports(code: string): Set<string> {
  const names = new Set<string>();
  for (const match of code.matchAll(
    /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/g,
  ))
    names.add(match[1]);
  for (const match of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()!
        .trim();
      if (name) names.add(name);
    }
  }
  return names;
}

function collectDtsExports(code: string): Set<string> {
  const names = new Set<string>();
  // export * / export { x } / export declare function/const/class/type/interface
  for (const match of code.matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/g,
  ))
    names.add(match[1]);
  for (const match of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const pieces = part.trim().split(/\s+as\s+/);
      const name = pieces
        .pop()!
        .replace(/^type\s+/, "")
        .trim();
      if (name && name !== "default") names.add(name);
    }
  }
  // 跟随 `export * from "./x"`
  for (const match of code.matchAll(
    /export\s*\*\s*from\s*["'](\.[^"']+)["']/g,
  )) {
    const target = join(mainDistDir, match[1].replace(/\.js$/, ".d.ts"));
    if (existsSync(target))
      for (const name of collectDtsExports(readFileSync(target, "utf8")))
        names.add(name);
  }
  return names;
}

/** Collect runtime-value exports from a .d.ts, following `export *`. */
function collectDtsValueExports(code: string, file: string): Set<string> {
  const names = new Set<string>();
  for (const match of code.matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|enum)\s+([A-Za-z0-9_$]+)/g,
  ))
    names.add(match[1]);
  for (const match of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const trimmed = part.trim();
      if (/^type\s+/.test(trimmed)) continue; // 纯类型导出
      const name = trimmed
        .split(/\s+as\s+/)
        .pop()!
        .trim();
      if (name && name !== "default") names.add(name);
    }
  }
  for (const match of code.matchAll(
    /export\s*\*\s*from\s*["'](\.[^"']+)["']/g,
  )) {
    const target = join(file, "..", match[1].replace(/\.(js|ts)$/, ".d.ts"));
    if (existsSync(target))
      for (const name of collectDtsValueExports(
        readFileSync(target, "utf8"),
        target,
      ))
        names.add(name);
  }
  return names;
}
