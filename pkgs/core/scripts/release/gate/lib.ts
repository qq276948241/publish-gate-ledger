#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const coreRoot = resolve(new URL("../../..", import.meta.url).pathname);
export const srcDir = join(coreRoot, "src");
export const distDir = join(coreRoot, "dist");
export const mainDistDir = join(distDir, "date-fns");
export const splitDistDir = join(distDir, "split");
export const configPath = join(coreRoot, "release/split.config.json");
export const auditDir = join(coreRoot, "release/audit");

export interface SplitPackage {
  name: string;
  modules: string[];
}

export interface GeneratedPackage {
  dir: string;
  name: string;
  version: string;
  dependencies: Record<string, string>;
  facadeSpecs: string[];
}

export interface SplitConfig {
  packages: SplitPackage[];
}

export function loadConfig(): SplitConfig {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

export function configHash(config: SplitConfig): string {
  return createHash("sha1")
    .update(JSON.stringify(config.packages))
    .digest("hex")
    .slice(0, 14);
}

export function readMainVersion(): string {
  return JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf8"))
    .version;
}

/** Top-level distributable modules shipped by the main package. */
export function listSourceModules(): Set<string> {
  const modules = new Set<string>();
  for (const entry of readdirSync(srcDir)) {
    if (entry.startsWith("_") || entry === "fp") continue;
    const path = join(srcDir, entry);
    if (!statSync(path).isDirectory()) continue;
    if (existsSync(join(path, "index.ts"))) modules.add(entry);
  }
  modules.add("fp");
  return modules;
}

/**
 * Files (relative to src) reachable from a module entry, following relative
 * imports. Shared internals (`_lib`, other module dirs, `constants`) are
 * included so the import graph is visible, but ownership is assigned only to
 * the module's own files.
 */
export function moduleFiles(module: string): string[] {
  const seen = new Set<string>();
  const stack: string[] = [];
  if (module === "fp") {
    for (const file of walkTs(join(srcDir, "fp"))) stack.push(file);
    stack.push(join(srcDir, "fp/index.ts"));
  } else {
    stack.push(join(srcDir, module, "index.ts"));
  }
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of extractRelativeSpecs(readFileSync(file, "utf8"))) {
      const resolved = resolveTs(join(dirname(file), spec));
      if (resolved && resolved.startsWith(srcDir)) stack.push(resolved);
    }
  }
  return [...seen].map((file) => file.slice(srcDir.length + 1));
}

/** The files that belong to the module itself, excluding shared internals. */
export function moduleOwnFiles(module: string): string[] {
  const root = module === "fp" ? join(srcDir, "fp") : join(srcDir, module);
  return walkTs(root)
    .map((file) => file.slice(srcDir.length + 1))
    .filter((file) => !/(^|\/)_lib\//.test(file));
}

export function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) files.push(...walkTs(path));
    else if (/\.ts$|\.js$/.test(entry) && !/\.d\.ts$/.test(entry))
      files.push(path);
  }
  return files;
}

const importSpecRe =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'](\.[^"']+)["']/g;

export function extractRelativeSpecs(code: string): string[] {
  return [...code.matchAll(importSpecRe)].map((match) => match[1]);
}

export function resolveTs(path: string): string | null {
  const candidates = [
    path,
    `${path}.ts`,
    `${path}.tsx`,
    `${path}.js`,
    join(path, "index.ts"),
    join(path, "index.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Map every src file (relative path) to the top-level module that owns it. */
export function buildFileOwnership(config: SplitConfig): Map<string, string> {
  const ownership = new Map<string, string>();
  for (const pkg of config.packages) {
    for (const module of pkg.modules) {
      for (const file of moduleOwnFiles(module)) {
        const owner = ownership.get(file);
        if (owner && owner !== pkg.name) {
          throw new Error(
            `模块 ${module} 与 ${owner} 共享源文件 ${file}：功能包间禁止重叠，公共代码必须留在主包`,
          );
        }
        ownership.set(file, pkg.name);
      }
    }
  }
  return ownership;
}

/**
 * Logical dependency graph between split packages, derived from the source
 * import graph. Re-exported facades keep all code in the main package, so
 * dependencies never carry duplicated code.
 */
export function buildPackageGraph(
  config: SplitConfig,
): Map<string, Set<string>> {
  const ownership = buildFileOwnership(config);
  const graph = new Map<string, Set<string>>();
  for (const pkg of config.packages) graph.set(pkg.name, new Set());

  for (const pkg of config.packages) {
    for (const module of pkg.modules) {
      const ownFiles = new Set(moduleOwnFiles(module));
      for (const file of ownFiles) {
        // fp sources are generation internals only; the fp facade re-exports
        // `date-fns/fp/*`, so imports into main implementation don't count.
        if (module === "fp" && /^fp\/_lib\//.test(file)) continue;
        const absolute = join(srcDir, file);
        const specs = extractRelativeSpecs(readFileSync(absolute, "utf8"));
        for (const spec of specs) {
          const resolved = resolveTs(join(dirname(absolute), spec));
          if (!resolved) continue;
          const relative = resolved.slice(srcDir.length + 1);
          const target = ownership.get(relative);
          if (target && target !== pkg.name) graph.get(pkg.name)!.add(target);
        }
      }
    }
  }
  return graph;
}

export function findCycles(graph: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (node: string) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const nextState = state.get(next) ?? 0;
      if (nextState === 1) {
        const start = stack.indexOf(next);
        cycles.push([...stack.slice(start), next]);
      } else if (nextState === 0) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of graph.keys()) {
    if ((state.get(node) ?? 0) === 0) visit(node);
  }
  return cycles;
}

/** Read a generated split package from dist: manifest deps + facade specifiers. */
export function readGeneratedPackage(dir: string): GeneratedPackage {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
  };
  const facade = readFileSync(join(dir, "index.js"), "utf8");
  const facadeSpecs = [...facade.matchAll(/from\s*["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  return {
    dir,
    name: pkg.name,
    version: pkg.version,
    dependencies: pkg.dependencies ?? {},
    facadeSpecs,
  };
}

export function listGeneratedPackages(): GeneratedPackage[] {
  const scope = join(splitDistDir, "@date-fns");
  if (!existsSync(scope)) return [];
  return readdirSync(scope)
    .filter((entry) => statSync(join(scope, entry)).isDirectory())
    .map((entry) => readGeneratedPackage(join(scope, entry)));
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`❌ ${message}`);
    process.exit(1);
  }
}
