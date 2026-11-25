// Run from the checkout. Pass --isolated-network on Linux to disable networking
// for the installed commands using unprivileged user and network namespaces.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "whichtree package "));
const install = join(dir, "clean üser");
const offline = process.argv.includes("--isolated-network");
try {
  const pack = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", dir], {
      encoding: "utf8",
    }),
  )[0];
  assert.equal(
    pack.files.find((f) => f.path === "dist/cli.js").mode & 0o777,
    0o755,
  );
  for (const f of pack.files)
    assert.match(
      f.path,
      /^(dist\/[a-z]+\.js|docs\/[a-z]+\.md|evidence\/v0\.1\.0\/[a-z-]+\.json|README\.md|NOTICE\.md|CONTRIBUTING\.md|LICENSE|package\.json)$/,
    );
  mkdirSync(install);
  writeFileSync(
    join(install, "package.json"),
    JSON.stringify({ private: true }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(dir, pack.filename),
    ],
    { cwd: install },
  );
  const bin = join(install, "node_modules", ".bin", "whichtree");
  assert.equal(statSync(bin).mode & 0o111, 0o111);
  const run = (...args) =>
    execFileSync(
      offline ? "unshare" : bin,
      offline
        ? ["--user", "--map-root-user", "--net", "--", bin, ...args]
        : args,
      {
        cwd: install,
        encoding: "utf8",
        env: { ...process.env, npm_config_offline: "true" },
      },
    );
  assert.match(run("--help"), /Usage: whichtree/);
  const demo = JSON.parse(run("demo", "--json"));
  assert.equal(demo.status, "passed");
  assert.deepEqual(
    demo.observations.map((x) => x.verdict),
    ["match", "mismatch"],
  );
  assert.equal(demo.cleaned, true);
  assert.equal(JSON.parse(run("sdk", "cold", "--json")).status, "match");
  console.log(
    `${pack.filename}: ${pack.entryCount} entries, ${pack.size} bytes; bin mode 0755, production install, help, demo, SDK passed${offline ? " in a network namespace" : ""}.`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
