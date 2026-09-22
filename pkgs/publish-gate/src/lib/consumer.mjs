import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gateRoot } from "./fs.mjs";

const CONSUMER_TYPES_SOURCE = `import {
  TZDate,
  TZDateMini,
  constructFromSymbol,
  tz,
  tzName,
  tzOffset,
  tzScan,
} from "@date-fns/tz";
import type {
  TZChange,
  TZChangeInterval,
  TZNameFormat,
} from "@date-fns/tz";

const date: TZDate = tz("UTC")(new Date(0));
const MiniCtor: typeof TZDateMini = TZDateMini;
const mini: InstanceType<typeof TZDateMini> = new MiniCtor(0, "UTC");
const symbol: symbol = constructFromSymbol;
const offset: number = tzOffset("UTC", date);
const name: string = tzName("UTC", date);
const format: TZNameFormat = "long";
const interval: TZChangeInterval = { start: new Date(0), end: new Date(1e9) };
const changes: TZChange[] = tzScan("UTC", interval);

console.log(
  date.getTime(),
  mini.getTime(),
  symbol,
  offset,
  name,
  format,
  changes.length,
);

export { date, mini, symbol, offset, name, format, changes };
`;

const CONSUMER_RUNTIME_SOURCE = `import {
  TZDateMini,
  constructFromSymbol,
  tz,
  tzName,
  tzOffset,
  tzScan,
} from "@date-fns/tz";

const date = tz("UTC")(new Date(0));
const mini = new TZDateMini(0, "UTC");
const symbol = constructFromSymbol;
const offset = tzOffset("UTC", date);
const name = tzName("UTC", date);
const interval = { start: new Date(0), end: new Date(1e9) };
const changes = tzScan("UTC", interval);

if (date.getTime() !== 0) throw new Error("TZDate mismatch");
if (mini.getTime() !== 0) throw new Error("TZDateMini mismatch");
if (typeof symbol !== "symbol") throw new Error("symbol mismatch");
if (offset !== 0) throw new Error("tzOffset mismatch");
if (!name.includes("Coordinated Universal Time")) throw new Error("tzName mismatch");
if (!Array.isArray(changes)) throw new Error("tzScan mismatch");

console.log("runtime consumer ok");
`;

const TS_CONFIG = {
  compilerOptions: {
    strict: true,
    noEmit: true,
    module: "nodenext",
    moduleResolution: "nodenext",
    target: "es2022",
    skipLibCheck: false,
  },
  include: ["main.ts"],
};

export function setupConsumer(layout, kind) {
  const root = join(gateRoot, "work", layout.config.id, kind);
  rmSync(root, { recursive: true, force: true });
  const modulesDir = join(root, "node_modules", "@date-fns");
  mkdirSync(modulesDir, { recursive: true });
  for (const [name, pkg] of Object.entries(layout.packages)) {
    symlinkSync(
      join(layout.outRoot, pkg.dir),
      join(modulesDir, name.replace("@date-fns/", "")),
      "dir",
    );
  }
  return root;
}

export async function gateConsumer(layout, section) {
  const runtimeRoot = setupConsumer(layout, "consumer");
  writeFileSync(
    join(runtimeRoot, "main.mjs"),
    CONSUMER_RUNTIME_SOURCE,
  );
  try {
    execFileSync(process.execPath, [join(runtimeRoot, "main.mjs")], {
      cwd: runtimeRoot,
      stdio: "pipe",
    });
  } catch (error) {
    section.add(
      `runtime consumer failed: ${String(error.stderr ?? error.message).slice(0, 400)}`,
    );
  }

  const typesRoot = setupConsumer(layout, "consumer-types");
  writeFileSync(join(typesRoot, "main.ts"), CONSUMER_TYPES_SOURCE);
  writeFileSync(
    join(typesRoot, "tsconfig.json"),
    JSON.stringify(TS_CONFIG, null, 2),
  );
  try {
    const tsgo = join(gateRoot, "..", "..", "node_modules", ".bin", "tsgo");
    execFileSync(tsgo, ["--noEmit", "-p", join(typesRoot, "tsconfig.json")], {
      cwd: typesRoot,
      stdio: "pipe",
    });
  } catch (error) {
    section.add(
      `downstream typecheck failed:\n${String(error.stdout ?? "").slice(0, 800)}${String(error.stderr ?? "").slice(0, 400)}`,
    );
  }
}
