import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  Experiment,
  fsEntry,
  query,
  tool,
  requireProof,
  witness,
  type Packet,
  type Tree,
} from "./experiment.js";
import type { Findings } from "./host.js";

export function fixture(exp: Experiment, configured: Tree, out: Findings) {
  const session = "fixture-" + configured;
  const packet = (message: Packet["message"]) => ({
    run: exp.id,
    session,
    message,
  });
  const sent = packet({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: query },
  });
  exp.record(session, "send", sent.message);
  const body = readFileSync(
    join(exp.trees[configured], sent.message.params.arguments.path),
    "utf8",
  );
  const received = packet({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: body }] },
  });
  exp.record(session, "receive", received.message);
  out.rows.push(
    witness(
      exp,
      "fixture",
      configured === "B" ? "cold" : "cold-stale",
      session,
      "",
      configured,
      "B",
      sent,
      received,
    ),
  );
}

export async function sdk(
  exp: Experiment,
  root: Tree,
  out: Findings,
  signal: AbortSignal,
) {
  const session = "sdk";
  const wire = new StdioClientTransport({
    command: process.execPath,
    args: [fsEntry, exp.trees[root]],
    cwd: exp.trees.B,
    env: exp.env,
    stderr: "ignore",
  });
  let request: Packet | undefined, reply: Packet | undefined, initId: unknown;
  let roots = 0;
  const trace = (direction: string, message: Packet["message"]) => {
    exp.record(session, direction, message);
    const packet = { run: exp.id, session, message };
    if (direction === "send") {
      if (message.method === "initialize") {
        initId = message.id;
        out.protocol.clientCapabilities = message.params.capabilities;
      }
      if (message.method === "tools/call") request = packet;
    } else {
      if (
        message.id === initId &&
        typeof message.result?.protocolVersion === "string"
      )
        out.protocol.negotiated = message.result.protocolVersion;
      if (message.method === "roots/list") roots++;
      if (
        request &&
        message.id === request.message.id &&
        !("method" in message)
      )
        reply = packet;
    }
  };
  const transport: Transport = {
    start: async () => {
      wire.onmessage = (m) => {
        trace("receive", m);
        transport.onmessage?.(m);
      };
      wire.onclose = () => transport.onclose?.();
      wire.onerror = (e) => transport.onerror?.(e);
      await wire.start();
    },
    send: async (m) => {
      trace("send", m);
      await wire.send(m);
    },
    close: () => wire.close(),
  };
  const client = new Client(
    { name: "whichtree", version: "0.1.0" },
    { capabilities: {} },
  );
  const options = { signal, timeout: 15000 };
  try {
    await client.connect(transport, options);
    out.protocol.serverCapabilities = Object.keys(
      client.getServerCapabilities() ?? {},
    );
    const inventory = await client.listTools({}, options);
    requireProof(
      inventory.tools.some((t) => t.name === tool),
      "SDK tool discovery failed.",
    );
    await client.callTool({ name: tool, arguments: query }, undefined, options);
    requireProof(
      request && reply,
      "SDK transport did not capture a correlated result.",
    );
    out.protocol.rootsExchange =
      roots === 0 ? "none observed" : `${roots} requests`;
    out.rows.push(
      witness(
        exp,
        "sdk-real-server",
        root === "A" ? "cold-stale" : "cold",
        session,
        "",
        root,
        "B",
        request,
        reply,
      ),
    );
  } finally {
    await client.close();
  }
}
