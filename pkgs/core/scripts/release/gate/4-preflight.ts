#!/usr/bin/env node

/**
 * Gate 4a — 发布前总核对（不带任何副作用，只读产物）
 *
 * 顺序重跑各 Gate 的核对口径，并补发布维度检查：
 * - 包数：dist/split 中的功能包数量必须等于拆分配置
 * - 声明齐：每个包 index.d.ts 存在且被 exports 暴露
 * - 版本一致：源码 / 主包产物 / manifest / 每个功能包
 * - 依赖正确：只依赖主包、版本范围匹配、无循环、门面无空壳
 *
 * 任何一项不过立即非零退出，禁止带病发布。
 * 通过后产出 release/audit/<version>-preflight.json 供发布后回查。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assert,
  auditDir,
  listGeneratedPackages,
  loadConfig,
  mainDistDir,
  readMainVersion,
  splitDistDir,
} from "./lib.ts";

console.log("🚧 Gate 4a: 发布前总核对...");

const version = readMainVersion();
const config = loadConfig();
const packages = listGeneratedPackages();

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
const record = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, ok, detail });
  if (!ok) {
    console.error(`❌ [${name}] ${detail ?? ""}`);
    process.exit(1);
  }
  console.log(`  ✅ ${name}`);
};

assert(existsSync(splitDistDir), "缺少拆分产物 dist/split，请先运行 Gate 1");
assert(
  existsSync(join(splitDistDir, "manifest.json")),
  "缺少 dist/split/manifest.json",
);
assert(existsSync(mainDistDir), "缺少主包产物 dist/date-fns，请先构建主包");

record("主包产物存在", existsSync(join(mainDistDir, "index.js")));

const mainBuilt = JSON.parse(
  readFileSync(join(mainDistDir, "package.json"), "utf8"),
);
record(
  "主包产物版本 = 源码版本",
  mainBuilt.version === version,
  `${mainBuilt.version} vs ${version}`,
);

const manifest = JSON.parse(
  readFileSync(join(splitDistDir, "manifest.json"), "utf8"),
);
record("manifest 版本一致", manifest.version === version);
record(
  "包数与拆分配置一致",
  packages.length === config.packages.length,
  `产物 ${packages.length} / 配置 ${config.packages.length}`,
);

for (const pkg of packages) {
  const pkgJson = JSON.parse(
    readFileSync(join(pkg.dir, "package.json"), "utf8"),
  );
  const prefix = `${pkg.name}: `;
  record(prefix + "版本一致", pkg.version === version, pkg.version);
  record(
    prefix + "声明随包",
    existsSync(join(pkg.dir, "index.d.ts")) &&
      (pkgJson.exports?.["."]?.types || pkgJson.exports?.["."]?.import?.types),
  );
  record(prefix + "sideEffects 标记", pkgJson.sideEffects === false);
  const deps = Object.keys(pkg.dependencies);
  record(
    prefix + "只依赖主包",
    deps.length === 1 && deps[0] === "date-fns",
    deps.join(","),
  );
  record(
    prefix + "依赖版本匹配",
    pkg.dependencies["date-fns"] === `^${version}`,
  );
  record(
    prefix + "门面非空壳",
    pkg.facadeSpecs.length > 0 &&
      pkg.facadeSpecs.every((spec) => {
        const moduleName = spec.slice("date-fns/".length);
        return existsSync(
          moduleName.startsWith("fp/")
            ? join(mainDistDir, "fp", `${moduleName.slice(3)}.js`)
            : join(mainDistDir, `${moduleName}.js`),
        );
      }),
  );
}

mkdirSync(auditDir, { recursive: true });
const report = {
  version,
  checkedAt: new Date().toISOString(),
  packageCount: packages.length,
  packages: packages.map((pkg) => pkg.name),
  checks,
};
const reportPath = join(auditDir, `${version}-preflight.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(
  `🟢 发布前核对全部通过（${checks.length} 项，${packages.length} 包），审计写入 ${reportPath}`,
);
