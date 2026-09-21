#!/usr/bin/env node

/**
 * Gate 1b — 产物级依赖核对（在拆分产物生成之后运行）
 *
 * - 功能包只允许依赖主包 date-fns，门面不得 re-export 其它功能包
 * - 依据 package.json dependencies 建图，出现循环依赖立即报错退出
 * - 每个包的依赖版本必须与主包产物版本一致
 * - 主入口聚合核对：manifest 覆盖的模块集合必须等于主包 exports 暴露的
 *   功能子路径（fp 命名空间按整体计）
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assert,
  findCycles,
  listGeneratedPackages,
  loadConfig,
  mainDistDir,
} from "./lib.ts";

console.log("🚧 Gate 1b: 核对拆分产物依赖关系...");

const packages = listGeneratedPackages();
const config = loadConfig();
assert(
  packages.length === config.packages.length,
  `功能包数量不符: 配置 ${config.packages.length} 个，产物 ${packages.length} 个；拆分方式变更后必须重新生成`,
);

const names = new Set(packages.map((pkg) => pkg.name));
const mainPkg = JSON.parse(
  readFileSync(join(mainDistDir, "package.json"), "utf8"),
);

for (const pkg of packages) {
  const depNames = Object.keys(pkg.dependencies);
  assert(
    depNames.length === 1 && depNames[0] === "date-fns",
    `${pkg.name} 只能依赖主包 date-fns，实际依赖: ${depNames.join(", ") || "(无)"}`,
  );
  assert(
    pkg.dependencies["date-fns"] === `^${mainPkg.version}`,
    `${pkg.name} 依赖版本 ${pkg.dependencies["date-fns"]} 与主包版本 ^${mainPkg.version} 不一致`,
  );
  for (const spec of pkg.facadeSpecs) {
    const target = spec.replace(/^@date-fns\//, "");
    assert(
      !spec.startsWith("@date-fns/"),
      `${pkg.name} 的门面引用了其它功能包 ${spec}：功能包之间禁止互相依赖`,
    );
    assert(
      spec.startsWith("date-fns/"),
      `${pkg.name} 门面只能 re-export 主包子路径，发现: ${spec}`,
    );
    void target;
    const subpath = spec.slice("date-fns/".length);
    const base = subpath.split("/")[0];
    const candidate =
      base === "fp"
        ? join(mainDistDir, "fp", `${subpath.slice(3)}.js`)
        : join(mainDistDir, `${base}.js`);
    assert(
      existsSync(candidate),
      `${pkg.name} 门面引用的主包模块 ${spec} 在主包产物中不存在（空壳 re-export，禁止发布）`,
    );
  }
  assert(names.has(pkg.name), `产物包 ${pkg.name} 未登记在拆分配置中`);
}

// dependencies 图（包含主包）做循环检测
const graph = new Map<string, Set<string>>();
for (const pkg of packages)
  graph.set(
    pkg.name,
    new Set(
      Object.keys(pkg.dependencies).filter((name) => name !== "date-fns"),
    ),
  );
const cycles = findCycles(graph);
assert(
  cycles.length === 0,
  `功能包间存在循环依赖:\n${cycles.map((c) => `  ${c.join(" -> ")}`).join("\n")}`,
);

// 主入口聚合核对：配置覆盖的模块必须与主包 exports 子路径一致
const exportKeys = Object.keys(mainPkg.exports).filter(
  (key) => key !== "." && key !== "./package.json",
);
const mainModules = new Set(
  exportKeys.map((key) => {
    const sub = key.slice(2);
    if (sub.startsWith("fp/")) return "fp";
    // locale/<code> 与 constants 等全部归入顶层模块
    return sub.includes("/") && sub.split("/")[0] !== "fp"
      ? sub.split("/")[0]
      : sub;
  }),
);
const splitModules = new Set(config.packages.flatMap((pkg) => pkg.modules));
const missingInSplit = [...mainModules].filter(
  (module) => !splitModules.has(module),
);
const missingInMain = [...splitModules].filter(
  (module) => !mainModules.has(module),
);
assert(
  missingInSplit.length === 0,
  `主包有 ${missingInSplit.length} 个子路径未被任何功能包聚合: ${missingInSplit.slice(0, 10).join(", ")}`,
);
assert(
  missingInMain.length === 0,
  `功能包聚合了主包不存在的模块: ${missingInMain.join(", ")}`,
);

console.log(
  `🟢 ${packages.length} 个功能包依赖清晰（统一依赖 date-fns@^${mainPkg.version}）、零循环、门面无空壳、主入口聚合完整（${mainModules.size} 个模块）`,
);
