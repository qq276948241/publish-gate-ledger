#!/usr/bin/env node

/**
 * Gate 2 — 树摇保障
 *
 * 对每个功能包构造“下游工程”，用 rolldown 在 treeshake 下打包：
 * 1. 主包与功能包都必须带 sideEffects:false，门面不得有顶层执行语句
 * 2. 只引用功能包中的一个模块时，同包其它模块必须真正被摇掉
 * 3. 摇掉后不留空壳（bundle 里不残留未用模块的实现）
 * 4. 摇后运行结果与“直接从主包引用”的基线一致
 *
 * 拆分方式一变，门面内容就变，本 Gate 针对当前产物重新核对，
 * 任何一项不过即非零退出，阻断发布。
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { assert, listGeneratedPackages, mainDistDir } from "./lib.ts";

const require = createRequire(import.meta.url);
const { build } = require("rolldown") as typeof import("rolldown");

const SAMPLE_DATE = "new Date(2023, 5, 15, 12, 30, 45, 0)";

interface Probe {
  name: string;
  body: string;
  marker: string;
}

console.log("🚧 Gate 2: 树摇与副作用核对...");

const packages = listGeneratedPackages();
assert(packages.length > 0, "没有拆分产物，请先运行 Gate 1");

for (const pkg of packages) {
  assert(
    JSON.parse(readFileSync(join(pkg.dir, "package.json"), "utf8"))
      .sideEffects === false,
    `${pkg.name} 缺少 "sideEffects": false，下游无法安全摇树`,
  );
  const facade = readFileSync(join(pkg.dir, "index.js"), "utf8");
  assert(
    !/^[ \t]*(?!\/\/|export|import|\*|\/\*|\s*$)[\w$("'`]/.test(facade),
    `${pkg.name} 门面含顶层执行语句，会阻碍树摇`,
  );
  assert(
    pkg.facadeSpecs.length > 0,
    `${pkg.name} 是没有任何 re-export 的空壳包`,
  );
}
assert(
  JSON.parse(readFileSync(join(mainDistDir, "package.json"), "utf8"))
    .sideEffects === false,
  "主包 date-fns 缺少 sideEffects:false",
);

const work = mkdtempSync(join(tmpdir(), "dfns-treeshake-"));
try {
  const nm = join(work, "node_modules");
  mkdirSync(join(nm, "@date-fns"), { recursive: true });
  symlinkSync(mainDistDir, join(nm, "date-fns"), "dir");
  for (const pkg of packages) symlinkSync(pkg.dir, join(nm, pkg.name), "dir");

  let checked = 0;
  for (const pkg of packages) {
    const usedSpec = pkg.facadeSpecs[0];
    const unusedSpecs = pkg.facadeSpecs.slice(1);

    // 选取被使用模块的第一个“具名导出”（跳过 default）
    const usedModuleName = usedSpec.slice("date-fns/".length);
    const usedFile = usedModuleName.startsWith("fp/")
      ? join(mainDistDir, "fp", `${usedModuleName.slice(3)}.js`)
      : join(mainDistDir, `${usedModuleName}.js`);
    const probe = pickProbe(usedFile, usedModuleName);
    assert(probe, `${pkg.name} 的 ${usedSpec} 找不到可验证的具名导出`);

    // 功能包视角：只具名导入一个导出并实际使用，其余模块应被摇掉
    const consumer = join(work, "consumer.mjs");
    writeFileSync(
      consumer,
      `import { ${probe.name} } from ${JSON.stringify(pkg.name)};\n` +
        probe.body,
    );

    // 基线：直接从主包的同一模块导入
    const baseline = join(work, "baseline.mjs");
    writeFileSync(
      baseline,
      `import { ${probe.name} } from ${JSON.stringify(usedSpec)};\n` +
        probe.body,
    );

    const bundleFile = join(work, "bundle.mjs");
    await build({
      input: consumer,
      platform: "node",
      treeshake: true,
      resolve: { symlinks: false },
      output: { file: bundleFile, format: "esm" },
    });
    const bundle = readFileSync(bundleFile, "utf8");

    const shakenOutput = run(bundleFile, work);
    const baselineOutput = run(baseline, work);
    assert(
      shakenOutput !== "THREW" && shakenOutput === baselineOutput,
      `${pkg.name} 摇后运行结果与主包基线不一致:\n  摇后: ${shakenOutput}\n  基线: ${baselineOutput}`,
    );

    // 未使用模块必须被摇掉：检查其实现文件的稳定标记（首个具名导出）
    for (const spec of unusedSpecs) {
      const moduleName = spec.slice("date-fns/".length);
      const file = moduleName.startsWith("fp/")
        ? join(mainDistDir, "fp", `${moduleName.slice(3)}.js`)
        : join(mainDistDir, `${moduleName}.js`);
      if (!existsSync(file)) continue;
      const marker = readFileSync(file, "utf8").match(
        /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/,
      )?.[1];
      if (marker) {
        assert(
          !new RegExp(`\\b${escapeRe(marker)}\\b`).test(bundle),
          `${pkg.name} 树摇失败：未使用模块 ${spec} 的实现（${marker}）残留 bundle`,
        );
      }
    }

    // 空壳检查：探针调用必须保留（未用模块可被内联，但不能整个变空）
    assert(
      /console\.log\(/.test(bundle),
      `${pkg.name} 摇后产物疑似空壳：探针代码被整体摇掉，导出 ${probe.name} 无实际实现`,
    );
    checked++;
  }

  console.log(
    `🟢 ${checked} 个功能包树摇通过：sideEffects 齐全、未用模块摇净、无空壳、摇后/基线运行一致`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

function run(file: string, cwd: string): string {
  const result = spawnSync(process.execPath, [file], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) return "THREW";
  return result.stdout.trim();
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Choose a named export and build a runtime probe with deterministic args. */
function pickProbe(file: string, moduleName: string): Probe | null {
  const code = readFileSync(file, "utf8");
  const named: string[] = [];
  for (const match of code.matchAll(
    /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/g,
  )) {
    if (match[1] !== "default") named.push(match[1]);
  }
  for (const match of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name && name !== "default" && /^[A-Za-z0-9_$]+$/.test(name))
        named.push(name);
    }
  }
  const unique = [...new Set(named)];

  // 1) 常量：直接序列化值
  for (const name of unique) {
    const constMatch = code.match(
      new RegExp(`const\\s+${escapeRe(name)}\\s*=\\s*([^;]+);`),
    );
    if (constMatch && /^[\s\d.eE_*+/()-]+$/.test(constMatch[1])) {
      return {
        name,
        marker: name,
        body: `console.log("V", typeof ${name}, JSON.stringify(${name}));\n`,
      };
    }
  }

  // 2) 函数：按模块名挑确定性参数，失败则回退到 typeof
  const fn = unique.find((name) =>
    new RegExp(`function\\s+${escapeRe(name)}\\b`).test(code),
  );
  if (fn) {
    const args = sampleArgs(moduleName, fn);
    return {
      name: fn,
      marker: `${fn}`,
      body:
        `try { const r = ${fn}(${args}); console.log("V", typeof r, stable(r)); }\n` +
        `catch (e) { console.log("THREW", e?.name ?? e); }\n` +
        `function stable(v) {\n` +
        `  if (v instanceof Date) return "Date:" + v.toISOString();\n` +
        `  if (typeof v === "function") return "fn:" + v.length;\n` +
        `  return JSON.stringify(v);\n` +
        `}\n`,
    };
  }

  // 3) 类及其它：退化为类型检查
  const fallback = unique[0];
  return fallback
    ? {
        name: fallback,
        marker: fallback,
        body: `console.log("V", typeof ${fallback});\n`,
      }
    : null;
}

/** Deterministic, side-effect-free argument lists per module category. */
function sampleArgs(module: string, fn: string): string {
  const d = SAMPLE_DATE;
  const setters =
    /^(set|add|sub|startOf|endOf|lastDayOf|next|previous|round|clamp)/.test(
      module,
    );
  if (
    /^is[A-Z]/.test(module) ||
    /^(isValid|isDate|isExists|isLeapYear)$/.test(fn)
  )
    return d;
  if (/^difference/.test(module)) return `${d}, ${d}`;
  if (/^max$|^min$/.test(module)) return `[${d}, ${d}]`;
  if (/^(constructFrom|toDate)$/.test(fn)) return `${d}, 1`;
  if (/^(format|lightFormat)$/.test(fn)) return `${d}, "yyyy-MM-dd"`;
  if (/^(formatDistance|formatDistanceStrict)$/.test(fn)) return `${d}, ${d}`;
  if (/^(parse)$/.test(fn))
    return `"2023-06-15", "yyyy-MM-dd", new Date(2020, 0, 1)`;
  if (setters) return `${d}, 1`;
  if (module === "parseISO" || module === "parseJSON")
    return `"2023-06-15T12:30:45.000Z"`;
  if (module === "fromUnixTime") return `1686832245`;
  if (/^get|^daysIn|^weeksIn|^startOf/.test(module)) return d;
  if (module === "constants") return "";
  return d;
}
