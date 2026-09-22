import { build } from "rolldown";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateRoot } from "../lib/fs.mjs";

const ENTRY_CASES = [
  {
    name: "constants-only",
    source:
      'import { constructFromSymbol } from "@date-fns/tz";\nexport const value = typeof constructFromSymbol;\n',
    mustContain: ["constructDateFrom"],
    mustNotContain: ["tzOffset", "tzName", "class TZDate", "DateTimeFormat"],
  },
  {
    name: "offset-only",
    source:
      'import { tzOffset } from "@date-fns/tz";\nexport const value = tzOffset("UTC", new Date(0));\n',
    mustContain: ["longOffset"],
    mustNotContain: ["class TZDate", "constructDateFrom"],
  },
];

export async function gateTreeshake(layout, section) {
  const workRoot = join(gateRoot, "work", layout.config.id, "treeshake");
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });

  const linkDir = join(workRoot, "node_modules", "@date-fns");
  mkdirSync(linkDir, { recursive: true });
  for (const [name, pkg] of Object.entries(layout.packages)) {
    symlinkSync(
      join(layout.outRoot, pkg.dir),
      join(linkDir, name.replace("@date-fns/", "")),
      "dir",
    );
  }

  for (const test of ENTRY_CASES) {
    const entry = join(workRoot, `${test.name}.js`);
    const outFile = join(workRoot, `${test.name}.bundle.js`);
    writeFileSync(entry, test.source);

    const bundle = await build({
      input: entry,
      platform: "neutral",
      treeshake: true,
      output: {
        format: "esm",
        minify: false,
        file: outFile,
      },
    });
    const generated = bundle.output?.[0];
    if (!generated)
      throw new Error(`${test.name}: rolldown produced no output chunk`);
    writeFileSync(outFile, generated.code);
    if (typeof bundle.close === "function") await bundle.close();

    const output = await import(`${outFile}?${Date.now()}`);
    if (typeof output.value === "undefined")
      section.add(`${test.name}: shaken bundle lost the exported value`);

    const { readFile } = await import("node:fs/promises");
    const code = await readFile(outFile, "utf8");

    for (const token of test.mustContain)
      if (!code.includes(token))
        section.add(
          `${test.name}: shaken bundle is missing required code "${token}"`,
        );
    for (const token of test.mustNotContain)
      if (code.includes(token))
        section.add(
          `${test.name}: dead code "${token}" survived tree shaking`,
        );

    // Empty shell: a surviving re-export module whose target was removed.
    if (/export\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?\s*$/.test(code.trim()))
      section.add(`${test.name}: shaken output left an empty re-export shell`);
  }

  // Behavior parity: aggregator and subpackage entry resolve the same symbol.
  const parityFile = join(workRoot, "parity.mjs");
  writeFileSync(
    parityFile,
    [
      'import * as aggregate from "@date-fns/tz";',
      'import { tzOffset as sub } from "@date-fns/tz/tzOffset";',
      "if (aggregate.tzOffset !== sub) process.exit(2);",
      "const a = aggregate.tzOffset('UTC', new Date(0));",
      "if (a !== 0) process.exit(3);",
    ].join("\n") + "\n",
  );
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync(process.execPath, [parityFile], {
      cwd: workRoot,
      stdio: "pipe",
    });
  } catch (error) {
    section.add(
      `aggregator/subpath parity check failed (exit ${error.status ?? "?"}): ${String(error.stderr ?? error.message).slice(0, 300)}`,
    );
  }

  section.detail("cases", ENTRY_CASES.map((c) => c.name));
  section.detail("workRoot", workRoot);
}
