import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-agent-send-"));
const workspace = path.join(tmpDir, "workspace");
const fakeBin = path.join(tmpDir, "bin");
const storePath = path.join(tmpDir, "store.sqlite");
const fakeClaudeLog = path.join(tmpDir, "fake-claude.json");
let previousPath = process.env.PATH || "";
let viewer = null;

try {
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "claude"),
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(fakeClaudeLog)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || null
}, null, 2));
console.log("fake claude response");
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;

  viewer = await startViewerServer({ cwd: workspace, port: 0, capturePort: 0, storePath });
  const watch = await postJson(`${viewer.url}/api/watch/start`, {
    agent: "Claude Code",
    mode: "single_session",
    workspace,
    conversation_id: "11111111-1111-4111-8111-111111111111",
    target_base_url: "http://127.0.0.1:9",
    reuse: false,
  });

  const send = await postJson(`${viewer.url}/api/agent/send`, {
    source_id: watch.id,
    message: "hello from dashboard",
  });

  assert.equal(send.ok, true);
  assert.equal(send.exit_code, 0);
  assert.equal(send.stdout.trim(), "fake claude response");
  const call = JSON.parse(fs.readFileSync(fakeClaudeLog, "utf8"));
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(workspace));
  assert.equal(call.anthropicBaseUrl, watch.base_url);
  assert.deepEqual(call.argv, [
    "-p",
    "--output-format",
    "text",
    "--resume",
    "11111111-1111-4111-8111-111111111111",
    "hello from dashboard",
  ]);

  console.log("agent send smoke passed");
} finally {
  process.env.PATH = previousPath;
  if (viewer) await viewer.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
