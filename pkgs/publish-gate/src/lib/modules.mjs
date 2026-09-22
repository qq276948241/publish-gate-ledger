import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tzSrc } from "./fs.mjs";

export const MODULES = [
  "constants",
  "tzName",
  "tzOffset",
  "date/mini",
  "date",
  "tzScan",
  "tz",
];

export const AGGREGATOR_SUBPATHS = [
  "constants",
  "date",
  "date/mini",
  "tzName",
  "tzOffset",
  "tzScan",
  "tz",
];

export function moduleEntry(mod) {
  return join(tzSrc, mod, "index.ts").replace(/index\.ts$/, (p) =>
    p,
  );
}

const MODULE_SOURCE_FILE = {
  constants: "constants/index.ts",
  tzName: "tzName/index.ts",
  tzOffset: "tzOffset/index.ts",
  "date/mini": "date/mini.js",
  date: "date/index.js",
  tzScan: "tzScan/index.ts",
  tz: "tz/index.ts",
};

function moduleSourcePath(mod) {
  return join(tzSrc, MODULE_SOURCE_FILE[mod]);
}

const RELATIVE_IMPORT_RE =
  /(?:from|import|require)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

export function moduleRelativeImports(mod) {
  const file = moduleSourcePath(mod);
  const code = readFileSync(file, "utf8");
  const out = [];
  for (const match of code.matchAll(RELATIVE_IMPORT_RE)) {
    let spec = match[1];
    spec = spec.replace(/\.(ts|js|cts|mjs|cjs)$/, "");
    out.push(spec);
  }
  return out;
}

export function moduleDependencies(mod) {
  const result = new Set();
  const fromFile = mod === "date/mini" ? "date/mini" : `${mod}/index`;
  const fromDir = fromFile.slice(0, fromFile.lastIndexOf("/"));
  for (const spec of moduleRelativeImports(mod)) {
    const parts = fromDir ? fromDir.split("/") : [];
    for (const piece of spec.split("/")) {
      const clean = piece.replace(/\.(ts|js|cjs|mjs)$/, "");
      if (clean === "..") parts.pop();
      else if (clean !== ".") parts.push(clean);
    }
    let target = parts.join("/");
    if (target === "date/mini") {
      result.add("date/mini");
      continue;
    }
    target = target.replace(/\/index$/, "");
    if (MODULES.includes(target)) result.add(target);
  }
  return [...result];
}

export const MODULE_GRAPH = Object.fromEntries(
  MODULES.map((mod) => [mod, moduleDependencies(mod)]),
);

export function findCycles(graph) {
  const cycles = [];
  const stack = [];
  const seen = new Set();

  function visit(node) {
    if (stack.includes(node)) {
      cycles.push([...stack.slice(stack.indexOf(node)), node]);
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    stack.push(node);
    for (const dep of graph[node] ?? []) visit(dep);
    stack.pop();
  }

  for (const node of Object.keys(graph)) visit(node);
  return cycles;
}

export function loadLayout(config) {
  const packages = config.packages;
  const moduleOwners = new Map();
  const aggregators = [];

  for (const [name, pkg] of Object.entries(packages)) {
    if (pkg.aggregator) aggregators.push(name);
    for (const mod of pkg.aggregator ? [] : pkg.modules ?? []) {
      if (!MODULES.includes(mod)) {
        throw new Error(`Unknown module "${mod}" in package ${name}`);
      }
      if (moduleOwners.has(mod)) {
        throw new Error(
          `Module "${mod}" owned by both ${moduleOwners.get(mod)} and ${name}`,
        );
      }
      moduleOwners.set(mod, name);
    }
  }

  const owned = new Set(moduleOwners.keys());
  const missing = MODULES.filter((mod) => !owned.has(mod));
  if (missing.length) {
    throw new Error(`Modules not assigned to any package: ${missing.join(", ")}`);
  }

  const dependsOn = {};
  for (const [name, pkg] of Object.entries(packages)) {
    if (pkg.aggregator) {
      const deps = new Set();
      for (const mod of pkg.modules ?? []) deps.add(moduleOwners.get(mod));
      deps.delete(name);
      dependsOn[name] = [...deps].sort();
      continue;
    }
    const deps = new Set();
    for (const mod of pkg.modules ?? []) {
      for (const depMod of MODULE_GRAPH[mod]) {
        const owner = moduleOwners.get(depMod);
        if (owner && owner !== name) deps.add(owner);
      }
    }
    dependsOn[name] = [...deps].sort();
  }

  const cycles = findCycles(dependsOn);

  return { config, packages, moduleOwners, aggregators, dependsOn, cycles };
}

export function ownerOf(layout, mod) {
  return layout.moduleOwners.get(mod);
}

export function externalSpecifier(layout, fromMod, targetMod) {
  const fromOwner = layout.moduleOwners.get(fromMod);
  const targetOwner = layout.moduleOwners.get(targetMod);
  if (fromOwner === targetOwner) return null;
  return `${targetOwner}/${targetMod}`;
}
