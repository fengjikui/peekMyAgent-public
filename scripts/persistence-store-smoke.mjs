import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { openPersistenceStore, sourceIdForWatch } from "../src/core/persistence-store.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peekmyagent-store-"));
const storePath = path.join(tmpDir, "store.sqlite");
const cwd = process.cwd();
const originalTarget = process.env.PEEK_CLAUDE_TARGET_BASE_URL;

const upstream = http.createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "msg_mock", role: "assistant", content: [{ type: "text", text: "ok" }] }));
});

const upstreamUrl = await listen(upstream);
process.env.PEEK_CLAUDE_TARGET_BASE_URL = upstreamUrl;

let firstRequestId = null;
let secondRequestId = null;
let sourceId = null;
let watchId = null;

try {
  const firstViewer = await startViewerServer({ cwd, storePath });
  try {
    const watch = await postJson(`${firstViewer.url}/api/watch/start`, {
      agent: "Claude Code",
      mode: "single_session",
      workspace: cwd,
      conversation_id: "persisted-smoke-session",
      target_base_url: upstreamUrl,
    });
    sourceId = watch.id;
    watchId = watch.watch_id;

    await postModelRequest(watch.base_url, {
      model: "mock-claude",
      system: [
        { type: "text", text: "volatile cc header: aaa" },
        { type: "text", text: "stable system block" },
      ],
      messages: [{ role: "user", content: "hello persisted store" }],
      tools: [{ name: "read", input_schema: { type: "object" } }],
    });
    await postModelRequest(watch.base_url, {
      model: "mock-claude",
      system: [
        { type: "text", text: "volatile cc header: bbb" },
        { type: "text", text: "stable system block" },
      ],
      messages: [
        { role: "user", content: "hello persisted store" },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: "second request" },
      ],
      tools: [{ name: "read", input_schema: { type: "object" } }],
    });

    const liveView = await getJson(`${firstViewer.url}/api/view?source=${encodeURIComponent(sourceId)}`);
    assert.equal(liveView.stats.request_count, 2);
    firstRequestId = liveView.requests[0].id;
    secondRequestId = liveView.requests[1].id;
  } finally {
    await firstViewer.close();
  }

  const secondViewer = await startViewerServer({ cwd, storePath });
  try {
    const sources = await getJson(`${secondViewer.url}/api/sources`);
    const persisted = sources.find((source) => source.id === sourceIdForWatch(watchId));
    assert.ok(persisted, "persisted source should be listed after viewer restart");
    assert.equal(persisted.request_count, 2);

    const persistedView = await getJson(`${secondViewer.url}/api/view?source=${encodeURIComponent(persisted.id)}`);
    assert.equal(persistedView.stats.request_count, 2);
    assert.equal(persistedView.requests[0].summary.current_user, "hello persisted store");
    assert.equal(persistedView.requests[1].changes.system_changed, true);
    assert.equal(persistedView.requests[1].raw.body_source, "original");
  } finally {
    await secondViewer.close();
  }

  const store = openPersistenceStore(storePath);
  try {
    store.clearRawBody(secondRequestId);
    const stats = store.blobStats();
    const systemStats = stats.find((item) => item.kind === "system_block");
    assert.equal(systemStats.count, 3);
    assert.ok(systemStats.refs >= 4);
    const reconstructed = store.reconstructBody(secondRequestId);
    assert.equal(reconstructed.system[0].text, "volatile cc header: bbb");
    assert.equal(reconstructed.system[1].text, "stable system block");
  } finally {
    store.close();
  }

  const thirdViewer = await startViewerServer({ cwd, storePath });
  try {
    const reconstructedView = await getJson(`${thirdViewer.url}/api/view?source=${encodeURIComponent(sourceIdForWatch(watchId))}`);
    assert.equal(reconstructedView.requests[1].raw.body_source, "reconstructed");
    assert.equal(reconstructedView.requests[1].summary.current_user, "second request");
  } finally {
    await thirdViewer.close();
  }

  assert.ok(firstRequestId);
  console.log("persistence-store smoke passed");
} finally {
  await closeServer(upstream);
  if (originalTarget == null) delete process.env.PEEK_CLAUDE_TARGET_BASE_URL;
  else process.env.PEEK_CLAUDE_TARGET_BASE_URL = originalTarget;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function postModelRequest(baseUrl, body) {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer smoke" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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
