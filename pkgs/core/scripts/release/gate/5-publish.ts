#!/usr/bin/env node

/**
 * Gate 4b/5 — 发布编排
 *
 * 默认 dry-run：完整跑核对 + npm pack 校验，不触碰 registry。
 * 显式 --publish 才会真正 `npm publish`。
 *
 * 发布前：强制重跑 Gate 1/1b/2/3/4a，任一失败立即停止。
 * 发布后：把“本次核了哪些、过了哪些、发了哪些包”写入
 * release/audit/<version>-publish.json，可随时回查。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditDir,
  listGeneratedPackages,
  mainDistDir,
  readMainVersion,
  splitDistDir,
} from "./lib.ts";

const doPublish = process.argv.includes("--publish");
const gateDir = new URL(".", import.meta.url).pathname;

const gates = [
  "1-split.ts",
  "1b-deps.ts",
  "2-treeshake.ts",
  "3-types.ts",
  "4-preflight.ts",
];
console.log(
  doPublish
    ? "🚀 发布模式：--publish（将真正推送到 registry）"
    : "🧪 演练模式：dry-run（加 --publish 才会真正发布）",
);

const gateResults: Array<{ gate: string; ok: boolean }> = [];
for (const gate of gates) {
  console.log(`\n=== 运行 ${gate} ===`);
  const result = spawnSync(process.execPath, [join(gateDir, gate)], {
    stdio: "inherit",
  });
  gateResults.push({ gate, ok: result.status === 0 });
  if (result.status !== 0) {
    console.error(`🛑 ${gate} 未通过，发布中止`);
    process.exit(1);
  }
}

const version = readMainVersion();
const packages = listGeneratedPackages();
mkdirSync(auditDir, { recursive: true });

// npm pack / publish：主包先发，功能包跟随
const targets = [
  { name: "date-fns", dir: mainDistDir },
  ...packages.map((pkg) => ({ name: pkg.name, dir: pkg.dir })),
];
const publishResults: Array<{
  name: string;
  ok: boolean;
  artifact?: string;
  error?: string;
}> = [];

for (const target of targets) {
  const command = doPublish
    ? ["publish", "--access", "public"]
    : ["pack", "--pack-destination", auditDir];
  const result = spawnSync("npm", command, {
    cwd: target.dir,
    encoding: "utf8",
  });
  const ok = result.status === 0;
  if (!ok) {
    publishResults.push({ name: target.name, ok, error: result.stderr.trim() });
    console.error(
      `🛑 ${target.name} ${doPublish ? "publish" : "pack"} 失败，发布中止:\n${result.stderr}`,
    );
    writeAudit("failed");
    process.exit(1);
  }
  const artifact = doPublish
    ? `${target.name}@${version}`
    : result.stdout.trim().split("\n").pop();
  publishResults.push({ name: target.name, ok, artifact });
  console.log(
    `  📦 ${target.name} ${doPublish ? "已发布" : "打包完成"} ${artifact ?? ""}`,
  );
}

writeAudit(doPublish ? "published" : "dry-run");
console.log(
  `\n🟢 ${doPublish ? "发布完成" : "演练通过"}：${targets.length} 个包，审计见 release/audit/${version}-publish.json`,
);

function writeAudit(status: string) {
  const preflightPath = join(auditDir, `${version}-preflight.json`);
  const report = {
    version,
    status,
    publishedAt: new Date().toISOString(),
    gates: gateResults,
    preflight: existsSync(preflightPath)
      ? JSON.parse(readFileSync(preflightPath, "utf8"))
      : null,
    packages: publishResults,
    splitManifest: JSON.parse(
      readFileSync(join(splitDistDir, "manifest.json"), "utf8"),
    ),
  };
  writeFileSync(
    join(auditDir, `${version}-publish.json`),
    JSON.stringify(report, null, 2) + "\n",
  );
}
