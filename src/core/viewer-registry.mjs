import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REGISTRY_DIR = path.join(os.homedir(), ".peekmyagent");
const REGISTRY_FILE = path.join(REGISTRY_DIR, "viewer.json");

export function viewerRegistryPath() {
  return REGISTRY_FILE;
}

export function writeViewerRegistry(entry) {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    REGISTRY_FILE,
    `${JSON.stringify(
      {
        ...entry,
        pid: process.pid,
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

export function readViewerRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function clearViewerRegistry(expectedUrl) {
  const current = readViewerRegistry();
  if (expectedUrl && current?.url !== expectedUrl) return;
  try {
    fs.rmSync(REGISTRY_FILE);
  } catch {
    // Ignore missing/stale registry files.
  }
}
