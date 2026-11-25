import test from "node:test";
import assert from "node:assert/strict";
import {
  Experiment,
  query,
  witness,
  markerSource,
} from "../dist/experiment.js";

test("accept only the complete designated export on the live call", () => {
  const exp = new Experiment();
  try {
    const session = "retained",
      thread = "synthetic-id";
    const packet = (message) => ({ run: exp.id, session, message });
    const request = packet({
      id: 3,
      method: "mcpServer/tool/call",
      params: {
        threadId: thread,
        server: "probe",
        tool: "read_text_file",
        arguments: { ...query },
      },
    });
    const source = markerSource(exp.markers.B);
    const reply = packet({
      id: 3,
      result: {
        content: [{ type: "text", text: source }],
        structuredContent: { content: source },
      },
    });
    const check = (s, r) =>
      witness(exp, "host-rpc", "after-repair", session, thread, "B", "B", s, r)
        .verdict;
    assert.equal(check(request, reply), "match");
    for (const mutate of [
      (s, r) => {
        s.run = "previous";
      },
      (s, r) => {
        r.run = "previous";
      },
      (s, r) => {
        r.session = "cold";
      },
      (s, r) => {
        r.message.id++;
      },
      (s) => {
        s.message.params.threadId = "wrong";
      },
      (s) => {
        s.message.params.tool = "shell";
      },
      (s) => {
        s.message.method = "command/exec";
      },
      (s) => {
        s.message.params.server = "other";
      },
      (s) => {
        s.message.params.arguments.head = 1;
      },
      (s, r) => {
        r.message.result.isError = true;
      },
      (s, r) => {
        r.message.error = {};
      },
      (s, r) => {
        r.message.result.truncated = true;
      },
      (s, r) => {
        r.message.result.structuredContent.content = markerSource(
          exp.markers.A,
        );
      },
    ]) {
      const s = structuredClone(request),
        r = structuredClone(reply);
      mutate(s, r);
      assert.equal(check(s, r), "inconclusive", String(mutate));
    }
    for (const body of [
      markerSource("0".repeat(32)),
      source + markerSource(exp.markers.A),
      source.slice(0, -2),
      source.replace("witness", "other"),
      "",
      exp.markers.B,
    ]) {
      const r = structuredClone(reply);
      r.message.result.content[0].text =
        r.message.result.structuredContent.content = body;
      assert.equal(check(request, r), "inconclusive");
    }
  } finally {
    exp.close();
  }
});
