const COLORS = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  reset: "\x1b[0m",
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(color, text) {
  return useColor ? `${COLORS[color]}${text}${COLORS.reset}` : text;
}

export function info(msg) {
  console.log(`${paint("cyan", "•")} ${msg}`);
}

export function pass(msg) {
  console.log(`${paint("green", "✓")} ${msg}`);
}

export function warn(msg) {
  console.log(`${paint("yellow", "!")} ${msg}`);
}

export function fail(msg) {
  console.error(`${paint("red", "✗")} ${msg}`);
}

export function dim(msg) {
  return paint("gray", msg);
}

export class CheckFailure extends Error {
  constructor(check, violations) {
    super(`${check} failed with ${violations.length} violation(s)`);
    this.name = "CheckFailure";
    this.check = check;
    this.violations = violations;
  }
}

export class Report {
  constructor(id) {
    this.id = id;
    this.checks = [];
  }

  section(check) {
    const entry = { check, status: "running", violations: [], details: {} };
    this.checks.push(entry);
    return {
      violations: entry.violations,
      detail(key, value) {
        entry.details[key] = value;
      },
      add(violation) {
        entry.violations.push(violation);
      },
    };
  }

  finish(entry, status) {
    entry.status = status;
  }

  get ok() {
    return this.checks.every((c) => c.status === "pass");
  }

  print() {
    for (const check of this.checks) {
      if (check.status === "pass") pass(check.check);
      else fail(`${check.check} (${check.violations.length})`);
      for (const v of check.violations) fail(`    ${v}`);
    }
  }

  toJSON() {
    return {
      id: this.id,
      generatedAt: new Date().toISOString(),
      ok: this.ok,
      checks: this.checks,
    };
  }
}
