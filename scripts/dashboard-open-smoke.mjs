import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-dashboard-open-"));
const storePath = path.join(tmpDir, "store.sqlite");
const apiPort = await freePort();
const capturePort = await freePort();
const dashboardUrl = `http://127.0.0.1:${apiPort}`;
const captureUrl = `http://127.0.0.1:${capturePort}`;

const env = {
  ...process.env,
  PEEKMYAGENT_DAEMON_PORT: String(apiPort),
  PEEKMYAGENT_CAPTURE_PORT: String(capturePort),
  PEEKMYAGENT_STORE_PATH: storePath,
};

try {
  killListeningPort(apiPort);
  killListeningPort(capturePort);

  const openResult = runCli(["open", "--print", "--no-open"], env);
  assert.equal(openResult.status, 0, openResult.stderr);
  assert.equal(openResult.stdout.trim(), `peekMyAgent dashboard: ${dashboardUrl}`);

  const status = await getJson(`${dashboardUrl}/api/daemon/status`);
  assert.equal(status.shared_capture_proxy, true);
  assert.equal(status.capture_url, captureUrl);
  assert.equal(typeof status.pid, "number");

  const viewResult = runCli(["view", "--print", "--no-open"], env);
  assert.equal(viewResult.status, 0, viewResult.stderr);
  assert.equal(viewResult.stdout.trim(), `peekMyAgent dashboard: ${dashboardUrl}`);

  const sourceResult = runCli(["dashboard", "--source", "live-test-watch", "--print", "--no-open"], env);
  assert.equal(sourceResult.status, 0, sourceResult.stderr);
  assert.equal(sourceResult.stdout.trim(), `peekMyAgent dashboard: ${dashboardUrl}/?source=live-test-watch`);

  const shutdownResult = runCli(["shutdown"], env);
  assert.equal(shutdownResult.status, 0, shutdownResult.stderr);
  assert.match(shutdownResult.stdout, new RegExp(`peekMyAgent daemon stopped: ${escapeRegExp(dashboardUrl)}`));
  assert.equal(await canConnect("127.0.0.1", apiPort), false);
  assert.equal(await canConnect("127.0.0.1", capturePort), false);

  const shutdownAgainResult = runCli(["shutdown"], env);
  assert.equal(shutdownAgainResult.status, 0, shutdownAgainResult.stderr);
  assert.equal(shutdownAgainResult.stdout.trim(), "peekMyAgent daemon: not running");

  const restartResult = runCli(["restart", "--print", "--no-open"], env);
  assert.equal(restartResult.status, 0, restartResult.stderr);
  assert.match(restartResult.stdout, new RegExp(`peekMyAgent restarted: ${escapeRegExp(dashboardUrl)}`));

  const restartedStatus = await getJson(`${dashboardUrl}/api/daemon/status`);
  assert.equal(restartedStatus.shared_capture_proxy, true);
  assert.equal(restartedStatus.capture_url, captureUrl);

  console.log("dashboard open smoke passed");
} finally {
  killListeningPort(apiPort);
  killListeningPort(capturePort);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runCli(args, commandEnv) {
  return spawnSync(process.execPath, ["bin/peekmyagent.mjs", ...args], {
    cwd,
    env: commandEnv,
    encoding: "utf8",
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

function killListeningPort(port) {
  const result = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  const pids = result.stdout
    .split(/\s+/)
    .map((pid) => pid.trim())
    .filter(Boolean);
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {
      // The process may have exited between lsof and kill.
    }
  }
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 300);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
