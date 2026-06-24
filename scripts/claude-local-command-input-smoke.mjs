import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readBody } from "../src/core/capture-proxy.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-local-command-input-"));
const upstream = http.createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "msg_local_command_smoke", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] }));
});

let viewer = null;

try {
  const upstreamUrl = await listen(upstream);
  viewer = await startViewerServer({ cwd: process.cwd(), port: 0, storePath: path.join(tmpDir, "store.sqlite") });
  const watch = await postJson(`${viewer.url}/api/watch/start`, {
    agent: "Claude Code",
    mode: "single_session",
    workspace: process.cwd(),
    conversation_id: "local-command-input-smoke",
    target_base_url: upstreamUrl,
  });

  await postModelRequest(watch.base_url, {
    messages: [
      { role: "user", content: [{ type: "text", text: "你好" }] },
      { role: "assistant", content: [{ type: "text", text: "你好！有什么我可以帮你的吗？" }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `<local-command-caveat>Caveat: local command output.</local-command-caveat>

<command-name>/model</command-name>
            <command-message>model</command-message>
            <command-args></command-args>

<local-command-stdout>Set model to \u001b[1mdeepseek-v4-pro[1m]\u001b[22m</local-command-stdout>

<local-command-caveat>Caveat: local command output.</local-command-caveat>

<command-name>/model</command-name>
            <command-message>model</command-message>
            <command-args></command-args>

<local-command-stdout>Set model to \u001b[1mdeepseek-v4-pro\u001b[22m</local-command-stdout>

演示工具调用`,
          },
        ],
      },
    ],
  });

  await postModelRequest(watch.base_url, {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `<local-command-caveat>Caveat: local command output.</local-command-caveat>

<command-name>/model</command-name>
            <command-message>model</command-message>
            <command-args></command-args>

<local-command-stdout>Set model to deepseek-v4-pro</local-command-stdout>`,
          },
        ],
      },
    ],
  });

  const data = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(watch.id)}`);
  assert.equal(data.requests[0].summary.current_user, "演示工具调用");
  assert.equal(data.requests[0].summary.command_message, null);
  assert.equal(data.turns[0].title, "演示工具调用");
  assert.equal(data.requests[1].summary.current_user.startsWith("Command /model"), true);
  assert.equal(data.requests[1].summary.command_message.command, "/model");

  console.log("claude local command input smoke passed");
} finally {
  if (viewer) await viewer.close().catch(() => {});
  await closeServer(upstream).catch(() => {});
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function postModelRequest(baseUrl, body) {
  const response = await fetch(`${baseUrl}/v1/messages?beta=true`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-claude-code-session-id": "local-command-input-smoke",
      authorization: "Bearer smoke",
    },
    body: JSON.stringify({
      model: "mock-claude",
      max_tokens: 8,
      ...body,
    }),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
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
