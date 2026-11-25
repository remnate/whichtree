import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  Diagnostic,
  Experiment,
  fsEntry,
  query,
  requireProof,
  tool,
  witness,
  type Row,
  type Tree,
} from "./experiment.js";

type Message = Record<string, any>;
class Host {
  private child;
  private closed: Promise<void>;
  onStatus?: (params: Message) => void;
  private seq = 0;
  private pending?: {
    id: number;
    accept: (r: Message) => void;
    reject: (e: Error) => void;
  };
  private failed = false;

  constructor(
    private exp: Experiment,
    bin: string,
    private session: string,
    cwd: string,
    private signal: AbortSignal,
  ) {
    this.child = spawn(bin, ["app-server", "--stdio"], {
      cwd,
      env: exp.env,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const fail = () => {
      this.failed = true;
      this.pending?.reject(
        new Diagnostic("Codex app-server closed the local RPC connection."),
      );
    };
    this.closed = new Promise((resolve) =>
      this.child.once("close", () => {
        fail();
        resolve();
      }),
    );
    this.child.on("error", fail);
    this.child.stdin.on("error", fail);
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        this.exp.record(session, "receive", msg);
        if (msg.method === "mcpServer/startupStatus/updated" && msg.params)
          this.onStatus?.(msg.params);
        if (this.pending && msg.id === this.pending.id && !("method" in msg))
          this.pending.accept(msg);
      } catch {
        fail();
      }
    });
  }
  notify(method: string) {
    this.send({ method });
  }
  private send(message: Message) {
    this.exp.record(this.session, "send", message);
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  async rpc(method: string, params: Message) {
    this.signal.throwIfAborted();
    requireProof(!this.failed, "Codex app-server is unavailable.");
    const request = { id: ++this.seq, method, params };
    const abort = () =>
      this.pending?.reject(new Diagnostic("Run interrupted."));
    this.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      () =>
        this.pending?.reject(
          new Diagnostic(`Timed out waiting for ${method}.`),
        ),
      25000,
    );
    try {
      const reply = await new Promise<Message>((accept, reject) => {
        this.pending = { id: request.id, accept, reject };
        this.send(request);
      });
      requireProof(
        method === "mcpServer/tool/call" ||
          (!("error" in reply) && reply.result != null),
        `Codex did not complete ${method}.`,
      );
      return { request, reply, data: reply.result };
    } finally {
      clearTimeout(timeout);
      this.signal.removeEventListener("abort", abort);
      this.pending = undefined;
    }
  }
  async close() {
    this.child.stdin.end();
    const killGroup = (signal: NodeJS.Signals) => {
      if (!this.child.pid) return;
      try {
        process.kill(-this.child.pid, signal);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
    };
    await Promise.race([this.closed, delay(400, undefined, { ref: false })]);
    killGroup("SIGTERM");
    await Promise.race([this.closed, delay(400, undefined, { ref: false })]);
    killGroup("SIGKILL");
    await this.closed;
  }
}

function register(exp: Experiment, tree: Tree) {
  writeFileSync(
    join(exp.codexHome, "config.toml"),
    [
      "[mcp_servers.probe]",
      "command = " + JSON.stringify(process.execPath),
      "args = " + JSON.stringify([fsEntry, exp.trees[tree]]),
      "",
    ].join("\n"),
  );
}
export interface Event {
  session: string;
  event: string;
  rpcId?: number;
  cwd?: Tree;
}
export interface Protocol {
  serverCapabilities?: string[];
  clientCapabilities: unknown;
  negotiated: string;
  rootsExchange: string;
}
export interface Findings {
  hostCapabilities?: { experimentalApi: boolean };
  rows: Row[];
  events: Event[];
  protocol: Protocol;
  codex?: string;
}

export async function hostRun(
  exp: Experiment,
  scenario: string,
  out: Findings,
  signal: AbortSignal,
) {
  requireProof(
    process.platform === "linux",
    "Host adapter is qualified only on Linux.",
  );
  const bin = process.env.WHICHTREE_CODEX || "codex";
  const version = spawnSync(bin, ["--version"], {
    cwd: exp.dir,
    env: exp.env,
    encoding: "utf8",
    timeout: 4000,
  });
  const v = version.stdout?.trim().match(/^codex-cli (\d+\.\d+\.\d+)$/)?.[1];
  out.codex = v ?? "unknown";
  requireProof(
    version.status === 0 && v === "0.171.0",
    "Host requires Codex CLI 0.171.0 on PATH or WHICHTREE_CODEX.",
  );
  async function launch(retained: boolean, root: Tree) {
    const session = retained ? "retained" : "cold";
    const start = retained ? "A" : "B";
    register(exp, root);
    const host = new Host(exp, bin, session, exp.trees[start], signal);
    try {
      const capabilities = { experimentalApi: true };
      const handshake = await host.rpc("initialize", {
        clientInfo: { name: "whichtree", version: "0.1.0" },
        capabilities,
      });
      out.hostCapabilities = capabilities;
      out.events.push({
        session,
        event: "initialize",
        rpcId: handshake.request.id,
      });
      host.notify("initialized");
      const started = await host.rpc("thread/start", {
        cwd: exp.trees[start],
        ephemeral: true,
        approvalPolicy: "never",
      });
      const id = started.data.thread?.id;
      requireProof(
        typeof id === "string" &&
          id.length &&
          started.data.cwd === exp.trees[start] &&
          started.data.thread.cwd === exp.trees[start],
        "Thread start directory could not be verified.",
      );
      const event = (name: string, rpcId: number, cwd?: Tree) =>
        out.events.push({ session, event: name, rpcId, cwd });
      event("thread/start", started.request.id, start);
      host.onStatus = (p) => {
        if (
          p.threadId === id &&
          p.name === "probe" &&
          ["starting", "ready"].includes(p.status)
        )
          out.events.push({ session, event: "probe/" + p.status });
      };
      const read = async (phase: string, expected: Tree, configured: Tree) => {
        const inventory = await host.rpc("mcpServerStatus/list", {
          threadId: id,
          serverName: "probe",
        });
        const probe = inventory.data.data?.find(
          (s: Message) => s.name === "probe",
        );
        if (probe?.serverCapabilities)
          out.protocol.serverCapabilities = [
            "tools",
            "resources",
            "prompts",
            "logging",
          ].filter((k) => k in probe.serverCapabilities);
        requireProof(
          probe?.tools?.[tool]?.name === tool,
          "Filesystem tool discovery failed.",
        );
        event("mcpServerStatus/list", inventory.request.id);
        const result = await host.rpc("mcpServer/tool/call", {
          threadId: id,
          server: "probe",
          tool,
          arguments: query,
        });
        const packet = (message: Message) => ({
          run: exp.id,
          session,
          message,
        });
        out.rows.push(
          witness(
            exp,
            "host-rpc",
            phase,
            session,
            id,
            configured,
            expected,
            packet(result.request),
            packet(result.reply),
          ),
        );
      };
      await read(
        retained ? "baseline" : root === "A" ? "cold-stale" : "cold",
        start,
        root,
      );
      if (!retained) return;
      const update = await host.rpc("thread/settings/update", {
        threadId: id,
        cwd: exp.trees.B,
      });
      event("thread/settings/update", update.request.id);
      const confirm = async () => {
        const { data, request } = await host.rpc("thread/read", {
          threadId: id,
        });
        requireProof(
          data.thread?.id === id && data.thread.cwd === exp.trees.B,
          "Same-thread directory B could not be verified.",
        );
        event("thread/read", request.id, "B");
      };
      await confirm();
      await read("stale-after-switch", "B", "A");
      register(exp, "B");
      const reload = await host.rpc("config/mcpServer/reload", {});
      event("config/mcpServer/reload", reload.request.id);
      await confirm();
      await read("after-repair", "B", "B");
    } finally {
      await host.close();
    }
  }
  if (scenario === "sequence") await launch(true, "A");
  await launch(false, scenario === "cold-stale" ? "A" : "B");
}
