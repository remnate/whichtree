#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  Experiment,
  Diagnostic,
  runtime,
  query,
  tool,
  requireProof,
  type Driver,
} from "./experiment.js";
import { hostRun, type Findings } from "./host.js";
import { fixture, sdk } from "./readers.js";

const help = `WhichTree 0.1.0 — witness which checkout a file reader returns

Usage: whichtree COMMAND [SCENARIO] [--json] [--private-trace NEW_FILE]

  host [sequence]         Codex thread A → B, fixed A control, repair, fresh B
  host cold|cold-stale    Start a new Codex process and thread in B
  sdk [cold]|cold-stale   Start the official filesystem server from B
  fixture [cold]|cold-stale  Read the synthetic checkout directly
  demo                    Assert both fixture verdicts and cleanup
  --help                  Show this help

cold configures B; cold-stale deliberately configures A.
Exit 0 match (or demo assertions passed), 1 mismatch, 2 inconclusive.
The full host sequence exits 1 when its intentional mismatch is observed.
--json emits sanitized evidence. The optional exclusive private JSONL file
contains complete synthetic messages, including private paths and markers.
--host codex selects the host driver for the host command. Other hosts are inconclusive.
WHICHTREE_CODEX selects the Codex executable (Linux, version 0.171.0).`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      host: { type: "string" },
      json: { type: "boolean" },
      "private-trace": { type: "string" },
    },
  });
  if (values.help || process.argv.length === 2) {
    console.log(help);
    return 0;
  }
  const [cmd, scenario = cmd === "host" ? "sequence" : "cold"] = positionals;
  requireProof(
    ["fixture", "host", "sdk", "demo"].includes(cmd) &&
      positionals.length <= 2 &&
      (cmd === "demo"
        ? positionals.length === 1
        : [
            "cold",
            "cold-stale",
            ...(cmd === "host" ? ["sequence"] : []),
          ].includes(scenario)),
    "Unknown command or scenario. See --help.",
  );
  requireProof(
    values["private-trace"] !== "",
    "Provide a new private trace filename.",
  );
  requireProof(
    !values.host || cmd === "host",
    "--host applies to the host command.",
  );
  const driver: Driver =
    cmd === "host" ? "host-rpc" : cmd === "sdk" ? "sdk-real-server" : "fixture";
  const exp = new Experiment();
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const out: Findings = {
    rows: [],
    events: [],
    protocol: {
      clientCapabilities: "unknown",
      negotiated: "unknown",
      rootsExchange: "unknown",
    },
  };
  let diagnostic: string | undefined;
  let cleaned = false;
  try {
    requireProof(
      values.host === undefined || values.host === "codex",
      "Unsupported host. WhichTree v0.1 supports Codex app-server 0.171.0.",
    );
    exp.init(values["private-trace"]);
    if (cmd === "host") await hostRun(exp, scenario, out, controller.signal);
    else if (cmd === "sdk")
      await sdk(exp, scenario === "cold" ? "B" : "A", out, controller.signal);
    else {
      if (cmd === "demo") fixture(exp, "B", out);
      fixture(
        exp,
        cmd === "demo" || scenario === "cold-stale" ? "A" : "B",
        out,
      );
    }
  } catch (e) {
    diagnostic = controller.signal.aborted
      ? "Run interrupted."
      : e instanceof Diagnostic
        ? e.message
        : (e as NodeJS.ErrnoException).code === "EEXIST"
          ? "Private trace destination already exists."
          : "Run failed during fixture setup, trace access, or transport.";
  } finally {
    try {
      exp.close();
      cleaned = true;
    } catch {
      diagnostic = "Temporary fixture cleanup failed.";
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  if (
    cmd === "demo" &&
    out.rows.map((r) => r.verdict).join(",") !== "match,mismatch"
  )
    diagnostic ??= "Fixture assertions failed.";
  const status =
    diagnostic ||
    !out.rows.length ||
    out.rows.some((r) => r.verdict === "inconclusive")
      ? "inconclusive"
      : cmd === "demo"
        ? "passed"
        : out.rows.some((r) => r.verdict === "mismatch")
          ? "mismatch"
          : "match";
  const report = {
    schemaVersion: 1,
    runId: exp.id,
    recordedAt: new Date().toISOString(),
    driver,
    scenario: cmd === "demo" ? "demo" : scenario,
    runtime: { ...runtime, git: exp.gitVersion, codex: out.codex },
    tool,
    arguments: query,
    appServerClientCapabilities: out.hostCapabilities,
    mcp: out.protocol,
    events: out.events,
    observations: out.rows,
    status,
    diagnostic,
    cleaned,
  };
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `${driver} · ${report.scenario} · ${tool}(${JSON.stringify(query)})`,
    );
    for (const r of out.rows)
      console.log(
        `${r.session} #${r.callId} ${r.scenario}: expected ${r.expected}, observed ${r.observed ?? "unknown"} — ${r.verdict}${r.reason ? " (" + r.reason + ")" : ""}`,
      );
    console.log(diagnostic ? `${status}: ${diagnostic}` : status);
  }
  return status === "inconclusive" ? 2 : status === "mismatch" ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(
      e instanceof Diagnostic
        ? e.message
        : "Unable to start WhichTree. Check --help and temporary directory access.",
    );
    process.exitCode = 2;
  });
