import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readBody } from "../src/core/capture-proxy.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-run-claude-"));
const binDir = path.join(tmpDir, "bin");
fs.mkdirSync(binDir);
const runId = `run-smoke-${Date.now()}-${process.pid}`;
const resumeSession = `${runId}-resume`;
const continueSession = `${runId}-continue`;
const shortcutSession = `${runId}-shortcut`;

const upstream = http.createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "msg_smoke", type: "message", content: [{ type: "text", text: "ok" }] }));
});

const upstreamUrl = await listen(upstream);
const viewer = await startViewerServer({ cwd, demo: "openclaw-subagent" });

try {
  const fakeClaude = path.join(binDir, "claude");
  fs.writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const resumeIndex = process.argv.indexOf('--resume');
const shortResumeIndex = process.argv.indexOf('-r');
const sessionId = process.argv.includes('--continue') || process.argv.includes('-c')
  ? '${continueSession}'
  : resumeIndex !== -1
    ? process.argv[resumeIndex + 1]
    : shortResumeIndex !== -1
      ? process.argv[shortResumeIndex + 1]
      : '${resumeSession}';
const url = process.env.ANTHROPIC_BASE_URL + '/v1/messages';
const response = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-claude-code-session-id': sessionId,
    authorization: 'Bearer smoke'
  },
  body: JSON.stringify({
    model: 'mock-claude',
    system: 'run wrapper smoke',
    messages: [{ role: 'user', content: 'hello from run wrapper' }]
  })
});
if (!response.ok) process.exit(2);
console.log('fake claude ok');
`,
    { mode: 0o755 },
  );

  const result = await runCli(["run", "claude", "--viewer-url", viewer.url, "--", "--resume", resumeSession], {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ANTHROPIC_BASE_URL: upstreamUrl,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /peekMyAgent watch:/);
  assert.match(result.stdout, /fake claude ok/);

  const sources = await getJson(`${viewer.url}/api/sources`);
  const live = sources.find((source) => source.agent === "Claude Code" && source.conversation_id === resumeSession);
  assert.ok(live);
  assert.equal(live.live_status, "stopped");
  assert.equal(live.request_count, 1);

  const data = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(live.id)}`);
  assert.equal(data.stats.request_count, 1);
  assert.equal(data.requests[0].conversation_id, resumeSession);
  assert.equal(data.requests[0].request_index, 1);

  const reuseResult = await runCli(["run", "claude", "--viewer-url", viewer.url, "--watch", "reuse", "--", "--resume", resumeSession], {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ANTHROPIC_BASE_URL: upstreamUrl,
  });
  assert.equal(reuseResult.code, 0, reuseResult.stderr);
  assert.match(reuseResult.stdout, /fake claude ok/);

  const sourcesAfterReuse = await getJson(`${viewer.url}/api/sources`);
  const liveAfterReuse = sourcesAfterReuse.filter((source) => source.agent === "Claude Code" && source.conversation_id === resumeSession);
  assert.equal(liveAfterReuse.length, 1);
  assert.equal(liveAfterReuse[0].id, live.id);
  assert.equal(liveAfterReuse[0].live_status, "stopped");
  assert.equal(liveAfterReuse[0].request_count, 2);

  const reusedData = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(live.id)}`);
  assert.equal(reusedData.stats.request_count, 2);
  assert.deepEqual(
    reusedData.requests.map((request) => request.request_index),
    [1, 2],
  );

  const continueResult = await runCli(["run", "claude", "--viewer-url", viewer.url, "--", "--continue"], {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ANTHROPIC_BASE_URL: upstreamUrl,
  });
  assert.equal(continueResult.code, 0, continueResult.stderr);
  assert.match(continueResult.stderr, /当前不是交互式终端；本次将新建监听/);
  assert.match(continueResult.stdout, /fake claude ok/);

  const sourcesAfterContinue = await getJson(`${viewer.url}/api/sources`);
  const continueLive = sourcesAfterContinue.find((source) => source.agent === "Claude Code" && source.conversation_id === continueSession);
  assert.ok(continueLive);
  assert.equal(continueLive.request_count, 1);

  const shortcutResult = await runCli(["claude", "-r", shortcutSession], {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ANTHROPIC_BASE_URL: upstreamUrl,
  });
  assert.equal(shortcutResult.code, 0, shortcutResult.stderr);
  assert.match(shortcutResult.stdout, /fake claude ok/);

  const shortcutReuseResult = await runCli(["--reuse", "claude", "-r", shortcutSession], {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ANTHROPIC_BASE_URL: upstreamUrl,
  });
  assert.equal(shortcutReuseResult.code, 0, shortcutReuseResult.stderr);
  assert.match(shortcutReuseResult.stdout, /fake claude ok/);

  const sourcesAfterShortcut = await getJson(`${viewer.url}/api/sources`);
  const shortcutLive = sourcesAfterShortcut.filter((source) => source.agent === "Claude Code" && source.conversation_id === shortcutSession);
  assert.equal(shortcutLive.length, 1);
  assert.equal(shortcutLive[0].request_count, 2);

  console.log("run claude wrapper smoke passed");
} finally {
  await viewer.close();
  await closeServer(upstream);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/peekmyagent.mjs", ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
