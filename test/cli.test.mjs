import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const bin = resolve("dist/cli.js");
async function cli(env, ...args) {
  try {
    const r = await promisify(execFile)(bin, [...args, "--json"], {
      env: { ...process.env, ...env },
    });
    return { code: 0, data: JSON.parse(r.stdout) };
  } catch (e) {
    return { code: e.code, data: JSON.parse(e.stdout) };
  }
}
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "WhichTree test "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "keep"), "unrelated");
  return dir;
}
test("parallel demos use fresh markers and remove only their own trees", async (t) => {
  const dir = sandbox(t);
  const traces = [1, 2].map((i) => join(dir, "trace" + i));
  const runs = await Promise.all(
    traces.map((p) => cli({ TMPDIR: dir }, "demo", "--private-trace", p)),
  );
  const markers = new Set();
  for (const [i, { code, data }] of runs.entries()) {
    assert.equal(code, 0);
    assert.deepEqual(
      data.observations.map((x) => x.verdict),
      ["match", "mismatch"],
    );
    assert.equal(data.cleaned, true);
    const lines = readFileSync(traces[i], "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(statSync(traces[i]).mode & 0o777, 0o600);
    for (const line of lines.filter((l) => l.direction === "receive")) {
      const marker =
        line.message.result.content[0].text.match(/"([0-9a-f]{32})"/)[1];
      markers.add(marker);
      assert.equal(JSON.stringify(data).includes(marker), false);
      assert.equal(
        JSON.stringify(lines.filter((l) => l.direction === "send")).includes(
          marker,
        ),
        false,
      );
    }
    assert(!JSON.stringify(data).includes(dir));
  }
  assert.equal(markers.size, 4);
  assert.notEqual(runs[0].data.runId, runs[1].data.runId);
  assert.deepEqual(readdirSync(dir).sort(), ["keep", "trace1", "trace2"]);
  assert.equal(
    (await cli({ TMPDIR: dir }, "demo", "--private-trace", join(dir, "keep")))
      .code,
    2,
  );
  assert.equal(readFileSync(join(dir, "keep"), "utf8"), "unrelated");
});
test("cold SDK controls use the official server and distinct exits", async () => {
  for (const [scenario, expected] of [
    ["cold", 0],
    ["cold-stale", 1],
  ]) {
    const r = await cli({}, "sdk", scenario);
    assert.equal(r.code, expected);
    assert.equal(r.data.driver, "sdk-real-server");
    assert.equal(r.data.mcp.rootsExchange, "none observed");
  }
});
test("missing executable yields sanitized inconclusive evidence", async (t) => {
  const dir = sandbox(t);
  const r = await cli(
    { WHICHTREE_CODEX: join(dir, "missing"), TMPDIR: dir },
    "host",
  );
  assert.equal(r.code, 2);
  assert.match(r.data.diagnostic, /requires Codex/);
  assert.deepEqual(readdirSync(dir), ["keep"]);
});
test("an accepted settings update without the new cwd cannot establish a switch", async (t) => {
  const dir = sandbox(t),
    fake = join(dir, "fake");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs=require('fs'), readline=require('readline');
if(process.argv.includes('--version')) { console.log('codex-cli 0.171.0'); process.exit(); }
let cwd;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const {id,method,params}=JSON.parse(line); if(!id)return;
 let result={};
 if(method==='thread/start') {cwd=params.cwd;result={cwd,thread:{id:'thread',cwd}}}
 if(method==='thread/read')result={thread:{id:'thread',cwd}};
 if(method==='mcpServerStatus/list')result={data:[{name:'probe',tools:{read_text_file:{name:'read_text_file'}}}]};
 if(method==='mcpServer/tool/call')result={content:[{type:'text',text:fs.readFileSync(cwd+'/src/probe.ts','utf8')}]};
 console.log(JSON.stringify({id,result}));
});`,
    { mode: 0o755 },
  );
  const r = await cli({ WHICHTREE_CODEX: fake, TMPDIR: dir }, "host");
  assert.equal(r.code, 2);
  assert.match(r.data.diagnostic, /could not be verified/);
  assert.deepEqual(
    r.data.observations.map((r) => r.scenario),
    ["baseline"],
  );
});
test("interrupt cleans up the running host and leaves a sibling process alive", async (t) => {
  const dir = sandbox(t),
    fake = join(dir, "slow"),
    ready = join(dir, "pid");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('codex-cli 0.171.0'); process.exit(); }
require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));
setInterval(()=>{},1000);`,
    { mode: 0o755 },
  );
  const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  t.after(() => other.kill());
  const p = spawn(bin, ["host", "--json"], {
    env: { ...process.env, TMPDIR: dir, WHICHTREE_CODEX: fake },
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(() => p.kill());
  const closed = once(p, "close");
  let text = "";
  p.stdout.on("data", (b) => (text += b));
  for (let i = 0; i < 200 && !existsSync(ready); i++) await delay(25);
  assert(existsSync(ready));
  p.kill("SIGINT");
  assert.equal((await closed)[0], 2);
  assert.equal(JSON.parse(text).cleaned, true);
  assert.throws(() => process.kill(Number(readFileSync(ready, "utf8")), 0), {
    code: "ESRCH",
  });
  assert.doesNotThrow(() => process.kill(other.pid, 0));
  assert.deepEqual(readdirSync(dir).sort(), ["keep", "pid", "slow"]);
});

test("unsupported host selection produces an inconclusive JSON report", async () => {
  const r = await cli({}, "host", "--host", "other");
  assert.equal(r.code, 2);
  assert.match(r.data.diagnostic, /Unsupported host/);
  assert.equal(r.data.observations.length, 0);
});
test("failed app-server spawn cleans its fixture", async (t) => {
  const dir = sandbox(t),
    fake = join(dir, "disappearing-host");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
require('fs').unlinkSync(__filename);
console.log('codex-cli 0.171.0');`,
    { mode: 0o755 },
  );
  const r = await cli({ WHICHTREE_CODEX: fake, TMPDIR: dir }, "host");
  assert.equal(r.code, 2);
  assert.equal(r.data.status, "inconclusive");
  assert.equal(r.data.cleaned, true);
  assert.deepEqual(readdirSync(dir), ["keep"]);
});
