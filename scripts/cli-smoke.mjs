import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();
const bin = path.join(root, "bin", "peekmyagent.mjs");
const outDir = path.join(root, "tmp", "cli-smoke");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const openclawOut = path.join(outDir, "openclaw.normalized.json");
const claudeOut = path.join(outDir, "claude.normalized.json");

run(["normalize", "openclaw-capture", path.join(root, "fixtures", "openclaw-chat-completions-capture.json"), "--out", openclawOut]);
run(["normalize", "claude-otel", path.join(root, "fixtures", "claude-otel-request.json"), "--out", claudeOut]);

const openclaw = JSON.parse(fs.readFileSync(openclawOut, "utf8"));
const claude = JSON.parse(fs.readFileSync(claudeOut, "utf8"));

assert.equal(openclaw.adapter_name, "openclaw-openai-proxy");
assert.equal(openclaw.capture_confidence, "exact");
assert.equal(openclaw.source.headers.authorization, "[REDACTED:header]");
assert.equal(claude.adapter_name, "claude-code-otel-raw-body");
assert.equal(claude.capture_confidence, "exact");
assert.equal(claude.system[0].role, "system");

const reportPath = path.join(root, "docs", "cli-smoke-report.md");
const report = [
  "# CLI smoke report",
  "",
  `生成时间：${new Date().toISOString()}`,
  "",
  "| Command | Output | Adapter | Confidence |",
  "| --- | --- | --- | --- |",
  `| normalize openclaw-capture | ${openclawOut} | ${openclaw.adapter_name} | ${openclaw.capture_confidence} |`,
  `| normalize claude-otel | ${claudeOut} | ${claude.adapter_name} | ${claude.capture_confidence} |`,
  "",
  "结论：最小 CLI 已能把 OpenClaw proxy capture 和 Claude OTel request 文件规范化为统一 JSON。",
  "",
].join("\n");
fs.writeFileSync(reportPath, report);
console.log(`Wrote ${reportPath}`);

function run(args) {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`command failed: ${args.join(" ")}`);
  }
}

