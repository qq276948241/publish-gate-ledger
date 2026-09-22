import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODULE_GRAPH, loadLayout } from "../lib/modules.mjs";

export function gateDeps(layout, section) {
  if (layout.cycles.length) {
    for (const cycle of layout.cycles) {
      section.add(`Circular package dependency: ${cycle.join(" -> ")}`);
    }
  }

  // Every dependency declared in package.json must match the graph-derived
  // deps and every graph-derived dep must be declared.
  for (const [name, record] of Object.entries(layout.packages)) {
    const manifestPath = join(
      layout.outRoot,
      record.dir,
      "package.json",
    );
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      section.add(`${name}: cannot read package.json`);
      continue;
    }
    const declared = Object.keys(manifest.dependencies ?? {}).sort();
    const expected = layout.dependsOn[name] ?? [];
    const missing = expected.filter((dep) => !declared.includes(dep));
    const extra = declared.filter((dep) => !expected.includes(dep));
    for (const dep of missing)
      section.add(`${name}: dependency on ${dep} is used but not declared`);
    for (const dep of extra)
      section.add(`${name}: declares unused dependency ${dep}`);
  }

  // Side-effect markers must be set so bundlers can shake unused modules.
  for (const [name, record] of Object.entries(layout.packages)) {
    const manifest = JSON.parse(
      readFileSync(join(layout.outRoot, record.dir, "package.json"), "utf8"),
    );
    if (manifest.sideEffects !== false)
      section.add(`${name}: "sideEffects" must be false for tree shaking`);
  }

  // Each non-aggregator module must have exactly one owning package.
  const ownership = new Map();
  for (const [name, record] of Object.entries(layout.packages)) {
    if (record.aggregator) continue;
    for (const mod of record.modules ?? []) {
      if (ownership.has(mod))
        section.add(
          `Module "${mod}" shipped by both ${ownership.get(mod)} and ${name} (duplicated payload)`,
        );
      ownership.set(mod, name);
    }
  }

  section.detail(
    "moduleGraph",
    Object.fromEntries(
      Object.entries(MODULE_GRAPH).map(([k, v]) => [k, v]),
    ),
  );
  section.detail("packageDependencies", layout.dependsOn);
}

export function validateConfig(config) {
  const layout = loadLayout(config);
  if (layout.cycles.length) {
    throw new Error(
      `Config "${config.id}" has circular package dependencies: ${layout.cycles
        .map((c) => c.join(" -> "))
        .join("; ")}`,
    );
  }
  return layout;
}
