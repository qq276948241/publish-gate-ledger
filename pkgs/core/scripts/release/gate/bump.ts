#!/usr/bin/env node

/**
 * 一把升版本 + 随版本生成变更记录
 *
 * 用法:
 *   node scripts/release/gate/bump.ts <major|minor|patch|x.y.z>
 *
 * - 同步更新源码 package.json 版本
 * - 在 CHANGELOG.md 顶部写入带版本号的空变更段（Fixed/Changed/Added 小节）
 * - 发布时 Gate 1 会把同一版本写进所有功能包，天然“一把到位”
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, coreRoot } from "./lib.ts";

const input = process.argv[2];
assert(input, "用法: bump.ts <major|minor|patch|x.y.z>");

const pkgPath = join(coreRoot, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const next = bumpVersion(pkg.version, input);
assert(/^\d+\.\d+\.\d+$/.test(next), `非法版本号: ${next}`);

pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const changelogPath = join(coreRoot, "CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");
const today = new Date().toISOString().slice(0, 10);
const section =
  `## ${next} - ${today}\n\n` +
  `### Fixed\n\n- \n\n` +
  `### Changed\n\n- \n\n` +
  `### Added\n\n- \n\n`;
writeFileSync(changelogPath, section + changelog);

console.log(`🟢 版本已升至 ${next}，CHANGELOG.md 已生成对应变更段`);

function bumpVersion(current: string, spec: string): string {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;
  const [major, minor, patch] = current.split(".").map(Number);
  if (spec === "major") return `${major + 1}.0.0`;
  if (spec === "minor") return `${major}.${minor + 1}.0`;
  if (spec === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`不支持的版本参数: ${spec}`);
}
