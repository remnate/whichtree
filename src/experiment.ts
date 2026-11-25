import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  openSync,
  closeSync,
  writeSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

export const tool = "read_text_file";
export const query = Object.freeze({ path: "src/probe.ts" });
export type Tree = "A" | "B";
export type Driver = "host-rpc" | "fixture" | "sdk-real-server";
export type Verdict = "match" | "mismatch" | "inconclusive";
export class Diagnostic extends Error {}
export function requireProof(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Diagnostic(message);
}

const resolve = createRequire(import.meta.url).resolve;
export const fsEntry = resolve(
  "@modelcontextprotocol/server-filesystem/package.json",
).replace(/package\.json$/, "dist/index.js");
export function packageVersion(manifest: string): string {
  return JSON.parse(readFileSync(manifest, "utf8")).version;
}
export const runtime = {
  whichtree: packageVersion(
    fileURLToPath(new URL("../package.json", import.meta.url)),
  ),
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  filesystem: packageVersion(
    resolve("@modelcontextprotocol/server-filesystem/package.json"),
  ),
  sdk: packageVersion(
    resolve("@modelcontextprotocol/sdk/client/index.js").replace(
      /dist[/\\]cjs[/\\]client[/\\]index\.js$/,
      "package.json",
    ),
  ),
};

export function markerSource(marker: string) {
  return `export const witness = "${marker}";\n`;
}

export class Experiment {
  readonly id = randomUUID();
  readonly dir = mkdtempSync(join(realpathSync(tmpdir()), "whichtree-"));
  readonly trees = { A: join(this.dir, "tree A"), B: join(this.dir, "tree B") };
  readonly home = join(this.dir, "home");
  readonly codexHome = join(this.home, ".codex");
  readonly env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: this.home,
    CODEX_HOME: this.codexHome,
    TMPDIR: this.dir,
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  readonly markers = {
    A: randomBytes(16).toString("hex"),
    B: randomBytes(16).toString("hex"),
  };
  private trace?: number;
  gitVersion = "";
  init(tracePath?: string) {
    if (tracePath) this.trace = openSync(tracePath, "wx", 0o600);
    requireProof(
      this.markers.A !== this.markers.B,
      "Marker collision. Run again.",
    );
    mkdirSync(this.codexHome, { recursive: true });
    const git = (...args: string[]) => {
      const p = spawnSync("git", args, {
        cwd: this.dir,
        env: this.env,
        encoding: "utf8",
        timeout: 10000,
      });
      requireProof(
        p.status === 0,
        "Git fixture setup failed. Check Git and temporary directory access.",
      );
      return p.stdout.trim();
    };
    this.gitVersion =
      git("--version").match(/^git version ([\d.]+)/)?.[1] ?? "unknown";
    git("init", "--template=", "-b", "main", this.trees.A);
    git(
      "-C",
      this.trees.A,
      "-c",
      "user.name=WhichTree",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Fixture",
    );
    git(
      "-C",
      this.trees.A,
      "worktree",
      "add",
      "--detach",
      this.trees.B,
      "HEAD",
    );
    for (const tree of ["A", "B"] as const) {
      mkdirSync(join(this.trees[tree], "src"));
      writeFileSync(
        join(this.trees[tree], query.path),
        markerSource(this.markers[tree]),
      );
    }
  }
  record(session: string, direction: string, message: unknown) {
    if (this.trace !== undefined)
      writeSync(
        this.trace,
        JSON.stringify({ runId: this.id, session, direction, message }) + "\n",
      );
  }
  close() {
    try {
      if (this.trace !== undefined) closeSync(this.trace);
    } finally {
      rmSync(this.dir, { recursive: true, force: true, maxRetries: 4 });
    }
  }
}

export interface Packet {
  run: string;
  session: string;
  // Messages are validated at the wire boundary and again against the exact query below.
  message: Record<string, any>;
}
export interface Row {
  scenario: string;
  session: string;
  configured: Tree;
  expected: Tree;
  observed: Tree | null;
  callId: number | null;
  verdict: Verdict;
  reason?: string;
}
export function witness(
  exp: Experiment,
  driver: Driver,
  scenario: string,
  session: string,
  threadId: string,
  configured: Tree,
  expected: Tree,
  sent: Packet,
  received: Packet,
): Row {
  const q = sent.message,
    r = received.message;
  const row: Row = {
    scenario,
    session,
    configured,
    expected,
    observed: null,
    callId: null,
    verdict: "inconclusive",
  };
  const invalid = (reason: string) => ({ ...row, reason });
  if (
    [sent, received].some((p) => p.run !== exp.id || p.session !== session) ||
    !Number.isSafeInteger(q.id) ||
    r.id !== q.id ||
    "method" in r
  )
    return invalid("Uncorrelated call or reply.");
  row.callId = q.id;
  const p = q.params;
  const target =
    driver === "host-rpc"
      ? q.method === "mcpServer/tool/call" &&
        p?.server === "probe" &&
        p?.threadId === threadId &&
        p?.tool === tool
      : q.method === "tools/call" && p?.name === tool;
  if (
    !target ||
    p.arguments?.path !== query.path ||
    Object.keys(p.arguments).length !== 1
  )
    return invalid("Unexpected tool or arguments.");
  const result = r.result;
  if (
    "error" in r ||
    !result ||
    (result.isError != null && result.isError !== false) ||
    !Array.isArray(result.content) ||
    result.content.length !== 1 ||
    result.content[0]?.type !== "text"
  )
    return invalid("Missing successful text result.");
  // This adapter accepts the complete, pinned reader response. Unrecognized
  // annotations (including truncation flags) require a reviewed adapter update.
  if (
    Object.keys(result).some(
      (k) => !["content", "structuredContent", "isError"].includes(k),
    ) ||
    Object.keys(result.content[0]).some((k) => !["type", "text"].includes(k)) ||
    (result.structuredContent &&
      Object.keys(result.structuredContent).some((k) => k !== "content"))
  )
    return invalid("Unrecognized result annotations.");
  const body = result.content[0].text;
  if (
    result.structuredContent !== undefined &&
    result.structuredContent?.content !== body
  )
    return invalid("Conflicting representations of the file.");
  const observed = (["A", "B"] as const).find(
    (label) => markerSource(exp.markers[label]) === body,
  );
  if (!observed)
    return invalid("The complete witness export could not be identified.");
  return {
    ...row,
    observed,
    verdict: observed === expected ? "match" : "mismatch",
  };
}
