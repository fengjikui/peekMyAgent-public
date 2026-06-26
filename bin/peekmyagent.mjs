#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { normalizeOpenClawProxyCapture } from "../src/adapters/openclaw-proxy.mjs";
import { normalizeClaudeOtelRequestFile } from "../src/adapters/claude-otel.mjs";
import { disableTraeCn, enableTraeCn, inspectTraeCn, syncTraeCn } from "../src/adapters/trae-cn-integration.mjs";
import { mergeClaudeCodeProcessEnv, resolveClaudeCodeTargetBaseUrl } from "../src/core/claude-code-settings.mjs";
import { clearViewerRegistry, readViewerRegistry, viewerRegistryPath } from "../src/core/viewer-registry.mjs";
import { openBrowser, startViewerServer } from "../src/viewer/server.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const command = args[0];
let rest = args.slice(1);
const DEFAULT_DAEMON_HOST = "127.0.0.1";
const DEFAULT_DAEMON_API_PORT = 43110;
const DEFAULT_DAEMON_CAPTURE_PORT = 43111;

function usage(exitCode = 0) {
  const text = `peekmyagent

Usage:
  peekmyagent [--reuse|--new|--ask] [--open] claude [claude args...]
  peekmyagent [--reuse|--new] [--open] openclaw [openclaw args...]
  peekmyagent normalize openclaw-capture <capture.json> [--out <file>]
  peekmyagent normalize claude-otel <request.json> [--out <file>] [--delete-raw-after-import]
  peekmyagent daemon [--host <host>] [--api-port <port>] [--capture-port <port>] [--open]
  peekmyagent open [--source <id>] [--print] [--no-open]
  peekmyagent shutdown [--viewer-url <url>] [--force] [--json]
  peekmyagent restart [--print] [--no-open] [--force] [--json]
  peekmyagent view [--source <id>] [--print] [--no-open]
  peekmyagent enable trae-cn [--json]
  peekmyagent disable trae-cn [--json]
  peekmyagent sync trae-cn [--json]
  peekmyagent status trae-cn [--json]
  peekmyagent dev view [--demo openclaw-subagent|openclaw-multiturn|claude-subagent|claude-proxy-resume] [--evidence <dir>] [--port <port>] [--open]
  peekmyagent run claude [--watch ask|reuse|new] [peekMyAgent options] -- [claude args...]
  peekmyagent run openclaw [--watch reuse|new] [peekMyAgent options] -- [openclaw args...]
  peekmyagent watch-current [--agent claude-code|openclaw] [--mode next_request|single_session|privacy_guard] [--viewer-url <url>] [--json] [--open] [--new] [--pause] [--resume] [--stop] [--clear] [--session-key <key>] [--patch-openclaw] [--openclaw-profile <name>] [--provider <id>] [--model <id>] [--target-base-url <url>] [--refresh-profile]
  peekmyagent install-claude-skill [--scope user|project] [--commands] [--dest <claude-dir>] [--json]
  peekmyagent install-openclaw-skill [--agent <id>] [--global] [--force] [--json]

Notes:
  - The shortest daily path is to prefix the original Agent command: "peekmyagent claude -c" or "peekmyagent openclaw chat".
  - openclaw-capture expects one proxy capture record with method/path/headers/body.
  - claude-otel expects one Claude Code OTel .request.json file.
  - output is normalized JSON and does not print raw secrets beyond adapter redaction.
  - run is the advanced compatibility path. Starting an Agent through peekMyAgent is the user's explicit consent to capture that process. For Claude --continue/--resume, peekMyAgent asks where to write capture by default when a matching watch exists; use --reuse to reuse automatically or --new to force a new watch.
  - daemon starts the stable local API/dashboard plus fixed capture proxy. open opens that shared dashboard and starts the daemon if needed. shutdown stops it, and restart reloads it on the fixed ports. view is kept as a compatibility alias for open unless demo/evidence/port is provided.
  - enable/disable/sync/status trae-cn manages Trae CN's selected custom OpenAI-compatible model URL through a reversible stable proxy route.
  - dev view starts a foreground demo/evidence viewer for development only. Use Ctrl-C to stop it.
  - watch-current is intended to run inside an Agent shell/tool call. It reads current session env and registers, reuses, pauses, resumes, stops, or clears a live watch with a running dashboard. Pause keeps forwarding requests but stops saving captures until resume. For OpenClaw, --patch-openclaw only modifies an isolated profile, never the original profile.
  - install-claude-skill copies the peekMyAgent control skill into Claude Code's skill directory. Use --commands to also install /peekmyagent slash-command templates.
  - install-openclaw-skill installs the local OpenClaw peek-watch skill through "openclaw skills install".
`;
  (exitCode ? console.error : console.log)(text);
  process.exit(exitCode);
}

function optionValue(name) {
  const index = rest.indexOf(name);
  if (index === -1) return null;
  return rest[index + 1] || null;
}

function hasFlag(name) {
  return rest.includes(name);
}

function writeOutput(value) {
  const output = `${JSON.stringify(value, null, 2)}\n`;
  const outPath = optionValue("--out");
  if (outPath) fs.writeFileSync(outPath, output);
  else process.stdout.write(output);
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function installClaudeSkill() {
  const scope = optionValue("--scope") || "user";
  if (!["user", "project"].includes(scope)) throw new Error(`Invalid --scope: ${scope}`);
  const claudeDir = optionValue("--dest") || (scope === "project" ? path.join(process.cwd(), ".claude") : path.join(os.homedir(), ".claude"));
  const sourceSkill = path.join(repoRoot, "integrations/claude-code/skills/peekmyagent-control/SKILL.md");
  const targetSkillDir = path.join(claudeDir, "skills", "peekmyagent-control");
  const targetSkill = path.join(targetSkillDir, "SKILL.md");
  fs.rmSync(path.join(claudeDir, "skills", "peek-watch"), { recursive: true, force: true });
  fs.mkdirSync(targetSkillDir, { recursive: true });
  fs.copyFileSync(sourceSkill, targetSkill);

  const commandPaths = [];
  if (hasFlag("--commands")) {
    const sourceCommandDir = path.join(repoRoot, "integrations/claude-code/commands");
    const targetCommandDir = path.join(claudeDir, "commands");
    fs.mkdirSync(targetCommandDir, { recursive: true });
    fs.rmSync(path.join(targetCommandDir, "peek-watch.md"), { force: true });
    for (const fileName of claudeCommandFileNames(sourceCommandDir)) {
      const sourceCommand = path.join(sourceCommandDir, fileName);
      const targetCommand = path.join(targetCommandDir, fileName);
      fs.copyFileSync(sourceCommand, targetCommand);
      commandPaths.push(targetCommand);
    }
  }

  return {
    scope,
    claude_dir: claudeDir,
    skill_path: targetSkill,
    command_path: commandPaths[0] || null,
    command_paths: commandPaths,
    removed_legacy: ["commands/peek-watch.md", "skills/peek-watch"],
  };
}

function claudeCommandFileNames(sourceCommandDir) {
  const preferred = [
    "peekmyagent.md",
    "peekmyagent-status.md",
    "peekmyagent-pause.md",
    "peekmyagent-resume.md",
    "peekmyagent-stop.md",
    "peekmyagent-clear.md",
  ];
  const available = new Set(fs.readdirSync(sourceCommandDir).filter((file) => file.endsWith(".md")));
  return [...preferred.filter((file) => available.delete(file)), ...[...available].sort()];
}

function installOpenClawSkill() {
  const skillDir = path.join(repoRoot, "integrations/openclaw/skills/peek-watch");
  const slug = "peek-watch";
  const installArgs = ["skills", "install", skillDir, "--as", slug];
  const agent = optionValue("--agent");
  if (agent) installArgs.push("--agent", agent);
  if (hasFlag("--global")) installArgs.push("--global");
  if (hasFlag("--force")) installArgs.push("--force");
  const result = spawnSync("openclaw", installArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`openclaw ${installArgs.join(" ")} failed: ${result.stderr || result.stdout}`);
  return {
    slug,
    skill_dir: skillDir,
    agent: agent || null,
    global: hasFlag("--global"),
    stdout: result.stdout.trim(),
  };
}

function parseAgentShortcut(values) {
  const wrapperArgs = [];
  let watchPolicy = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (isAgentName(value)) {
      if (watchPolicy) wrapperArgs.push("--watch", watchPolicy);
      return {
        agent: normalizeShortcutAgent(value),
        runRest: [normalizeShortcutAgent(value), ...wrapperArgs, "--", ...values.slice(index + 1)],
      };
    }
    if (value === "--reuse" || value === "--new" || value === "--ask") {
      watchPolicy = mergeWatchPolicy(watchPolicy, value.slice(2));
      continue;
    }
    if (value === "--open") {
      wrapperArgs.push("--open-viewer");
      continue;
    }
    if (value === "--watch") {
      const policy = values[index + 1];
      if (!policy) throw new Error("Missing value for --watch");
      watchPolicy = mergeWatchPolicy(watchPolicy, policy);
      index += 1;
      continue;
    }
    if (isShortcutWrapperValueOption(value)) {
      const next = values[index + 1];
      if (!next) throw new Error(`Missing value for ${value}`);
      wrapperArgs.push(value, next);
      index += 1;
      continue;
    }
    if (isShortcutWrapperFlag(value)) {
      wrapperArgs.push(value);
      continue;
    }
    return null;
  }
  return null;

  function mergeWatchPolicy(current, next) {
    if (current && current !== next) throw new Error(`Conflicting watch policies: ${current} and ${next}`);
    return next;
  }
}

function isAgentName(value) {
  return /^(claude|claude-code|openclaw)$/i.test(value || "");
}

function normalizeShortcutAgent(value) {
  return /^claude(?:-code)?$/i.test(value) ? "claude" : "openclaw";
}

function isShortcutWrapperValueOption(value) {
  return ["--viewer-url", "--mode", "--openclaw-profile", "--provider", "--target-base-url"].includes(value);
}

function isShortcutWrapperFlag(value) {
  return ["--open-viewer", "--refresh-profile"].includes(value);
}

try {
  if (!command || command === "--help" || command === "-h") usage(0);
  const shortcut = parseAgentShortcut(args);
  if (shortcut) {
    rest = shortcut.runRest;
    const result = await runAgent();
    process.exit(result.exit_code);
  } else if (command === "run") {
    const result = await runAgent();
    process.exit(result.exit_code);
  } else if (command === "daemon") {
    await startForegroundDaemon();
  } else if (command === "open" || command === "dashboard") {
    await openDashboard();
  } else if (command === "shutdown") {
    const result = await shutdownDashboard();
    printDaemonControlResult(result);
  } else if (command === "restart") {
    const result = await restartDashboard();
    printDaemonControlResult(result);
  } else if (command === "view") {
    if (hasLegacyViewOptions(rest)) await startForegroundDevViewer();
    else await openDashboard();
  } else if (["enable", "disable", "sync", "status"].includes(command)) {
    await manageIntegration(command);
  } else if (command === "dev") {
    const [subcommand, ...devRest] = rest;
    rest = devRest;
    if (subcommand === "view") await startForegroundDevViewer();
    else usage(1);
  } else if (command === "watch-current") {
    const result = hasFlag("--pause")
      ? await controlCurrentWatch({ status: "paused" })
      : hasFlag("--resume")
        ? await controlCurrentWatch({ status: "watching" })
        : hasFlag("--stop") || hasFlag("--clear")
          ? await stopCurrentWatch({ clear: hasFlag("--clear") })
          : await watchCurrent();
    if (hasFlag("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.action === "stop") {
      console.log(`peekMyAgent watch ${result.status}: ${result.watch_id}`);
      console.log(`dashboard: ${result.viewer_url}`);
      console.log(`conversation: ${result.conversation_id || "not detected"}`);
      if (result.request_count != null) console.log(`captured requests: ${result.request_count}`);
    } else if (result.action === "pause" || result.action === "resume") {
      console.log(`peekMyAgent watch ${result.action === "pause" ? "paused" : "resumed"}: ${result.watch_id}`);
      console.log(`dashboard: ${result.viewer_url}?source=${encodeURIComponent(result.id)}`);
      console.log(`conversation: ${result.conversation_id || "not detected"}`);
      console.log(`captured requests: ${result.request_count}`);
      if (result.skipped_while_paused) console.log(`skipped while paused: ${result.skipped_while_paused}`);
    } else {
      console.log(`peekMyAgent watch ${result.reused ? "reused" : "registered"}: ${result.watch_id}`);
      console.log(`dashboard: ${result.viewer_url}?source=${encodeURIComponent(result.id)}`);
      console.log(`agent: ${result.agent}`);
      console.log(`workspace: ${result.workspace}`);
      console.log(`conversation: ${result.conversation_id || "not detected"}`);
      console.log(`proxy base URL: ${result.base_url}`);
      if (result.resume_command) {
        console.log("exact capture for this Claude session:");
        console.log(result.resume_command);
      }
      if (result.openclaw_command_hint) {
        console.log("run OpenClaw through the isolated peekMyAgent profile:");
        console.log(result.openclaw_command_hint);
      }
      console.log(result.note);
    }
    if (hasFlag("--open") && result.id) {
      const { command: openCommand, args } = openBrowser(`${result.viewer_url}?source=${encodeURIComponent(result.id)}`);
      spawn(openCommand, args, { stdio: "ignore", detached: true }).unref();
    }
  } else if (command === "install-claude-skill") {
    const result = installClaudeSkill();
    if (hasFlag("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      console.log(`Installed Claude Code skill: ${result.skill_path}`);
      for (const commandPath of result.command_paths || []) console.log(`Installed slash command: ${commandPath}`);
      console.log(`scope: ${result.scope}`);
    }
  } else if (command === "install-openclaw-skill") {
    const result = installOpenClawSkill();
    if (hasFlag("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      console.log(`Installed OpenClaw skill: ${result.skill_dir}`);
      console.log(`as: ${result.slug}`);
      if (result.agent) console.log(`agent: ${result.agent}`);
      if (result.global) console.log("scope: global");
    }
  } else if (command === "normalize") {
    const [adapter, file, ...normalizeRest] = rest;
    rest = normalizeRest;
    if (!adapter || !file) usage(1);

    if (adapter === "openclaw-capture") {
      writeOutput(normalizeOpenClawProxyCapture(readJson(file)));
    } else if (adapter === "claude-otel") {
      writeOutput(normalizeClaudeOtelRequestFile(file, { deleteRaw: hasFlag("--delete-raw-after-import") }));
    } else {
      usage(1);
    }
  } else {
    usage(1);
  }
} catch (error) {
  console.error(`peekmyagent error: ${error.message}`);
  process.exit(1);
}

async function watchCurrent() {
  const viewerUrl = optionValue("--viewer-url") || process.env.PEEKMYAGENT_VIEWER_URL || (await ensureDashboard({ open: false })).url;
  if (!viewerUrl) {
    throw new Error(`No running peekMyAgent dashboard found. Run "peekmyagent open" or pass --viewer-url. Registry checked: ${viewerRegistryPath()}`);
  }
  const agent = normalizeAgent(optionValue("--agent") || detectAgent());
  const conversationId = detectConversationId(agent);
  const workspace = process.env.PWD || process.cwd();
  const mode = optionValue("--mode") || "single_session";
  const openclawPatch = /openclaw/i.test(agent) && hasFlag("--patch-openclaw") ? prepareOpenClawProfilePatch() : null;
  const response = await postJson(`${trimSlash(viewerUrl)}/api/watch/start`, {
    agent,
    mode,
    workspace,
    conversation_id: conversationId,
    started_by: "agent-command",
    reuse: !hasFlag("--new"),
    target_base_url: openclawPatch?.target_base_url,
    provider_id: openclawPatch?.provider_id,
    config_patched: Boolean(openclawPatch),
  });
  if (openclawPatch) patchOpenClawProviderBaseUrl(openclawPatch.profile, openclawPatch.provider_id, response.base_url);
  return {
    ...response,
    viewer_url: trimSlash(viewerUrl),
    workspace,
    conversation_id: conversationId,
    openclaw_profile: openclawPatch?.profile || null,
    openclaw_provider: openclawPatch?.provider_id || null,
    openclaw_command_hint: openclawPatch ? buildOpenClawCommandHint(openclawPatch.profile, conversationId) : null,
    resume_command: buildResumeCommand(agent, response.base_url, conversationId),
    note: buildWatchCurrentNote(agent, conversationId),
  };
}

async function runAgent() {
  const parsed = parseRunArgs(rest);
  if (!parsed.agent || ["--help", "-h"].includes(parsed.agent)) {
    console.log(`Usage:
  peekmyagent run claude [--watch ask|reuse|new] [--viewer-url <url>] [--open-viewer] [--mode <mode>] -- [claude args...]
  peekmyagent run openclaw [--watch reuse|new] [--viewer-url <url>] [--open-viewer] [--mode <mode>] [--session-key <key>] [--openclaw-profile <name>] [--provider <id>] -- [openclaw args...]`);
    return { exit_code: 0 };
  }

  const viewer = await ensureViewerForRun(parsed);
  if (hasFlagIn(parsed.wrapperArgs, "--open-viewer")) {
    const { command: openCommand, args } = openBrowser(viewer.url);
    spawn(openCommand, args, { stdio: "ignore", detached: true }).unref();
  }

  if (/^claude(?:-code)?$/i.test(parsed.agent)) return runClaudeAgent(parsed, viewer.url);
  if (/^openclaw$/i.test(parsed.agent)) return runOpenClawAgent(parsed, viewer.url);
  throw new Error(`Unsupported agent for run: ${parsed.agent}`);
}

async function runClaudeAgent(parsed, viewerUrl) {
  const workspace = process.cwd();
  const targetBaseUrl = resolveClaudeCodeTargetBaseUrl({ cwd: workspace, env: process.env });
  if (!targetBaseUrl) {
    throw new Error("Missing Claude Code upstream base URL. Set PEEK_CLAUDE_TARGET_BASE_URL or ANTHROPIC_BASE_URL, or configure ANTHROPIC_BASE_URL in Claude Code settings.json.");
  }
  const conversationId = inferClaudeConversationId(parsed.childArgs);
  const reuseWatchId = await resolveClaudeRunWatchChoice({ parsed, viewerUrl, conversationId });
  const watch = await postJson(`${trimSlash(viewerUrl)}/api/watch/start`, {
    agent: "Claude Code",
    mode: optionValueIn(parsed.wrapperArgs, "--mode") || "single_session",
    workspace,
    conversation_id: conversationId,
    started_by: "peekmyagent-run",
    reuse: Boolean(reuseWatchId),
    reuse_watch_id: reuseWatchId,
    target_base_url: targetBaseUrl,
  });
  printRunStarted({ viewerUrl, watch, command: "claude", args: parsed.childArgs });
  const result = await runChild(
    "claude",
    parsed.childArgs,
    mergeClaudeCodeProcessEnv({
      cwd: workspace,
      env: process.env,
      overrides: { ANTHROPIC_BASE_URL: watch.base_url },
    }),
  );
  await stopRunWatch(viewerUrl, watch, null);
  return result;
}

async function runOpenClawAgent(parsed, viewerUrl) {
  const previousRest = rest;
  rest = ["watch-current", "--agent", "openclaw", "--patch-openclaw", ...parsed.wrapperArgs, ...parsed.childArgs];
  let openclawPatch;
  try {
    openclawPatch = prepareOpenClawProfilePatch();
  } finally {
    rest = previousRest;
  }
  const conversationId = optionValueIn([...parsed.wrapperArgs, ...parsed.childArgs], "--session-key") || null;
  const watchPolicy = normalizeWatchPolicy(optionValueIn(parsed.wrapperArgs, "--watch"), { allowAsk: false });
  const watch = await postJson(`${trimSlash(viewerUrl)}/api/watch/start`, {
    agent: "OpenClaw",
    mode: optionValueIn(parsed.wrapperArgs, "--mode") || "single_session",
    workspace: process.cwd(),
    conversation_id: conversationId,
    started_by: "peekmyagent-run",
    reuse: watchPolicy === "reuse" && !hasFlagIn(parsed.wrapperArgs, "--new"),
    target_base_url: openclawPatch.target_base_url,
    provider_id: openclawPatch.provider_id,
    config_patched: true,
  });
  patchOpenClawProviderBaseUrl(openclawPatch.profile, openclawPatch.provider_id, watch.base_url);
  const childArgs = ["--profile", openclawPatch.profile, ...normalizeOpenClawChildArgs(parsed.childArgs)];
  printRunStarted({ viewerUrl, watch, command: "openclaw", args: childArgs });
  const result = await runChild("openclaw", childArgs, process.env);
  await stopRunWatch(viewerUrl, watch, openclawPatch.profile);
  return result;
}

function normalizeOpenClawChildArgs(childArgs) {
  const args = childArgs.length ? [...childArgs] : ["chat"];
  const command = args[0];
  if (/^(tui|terminal)$/i.test(command) && !hasFlagIn(args, "--local") && !hasFlagIn(args, "--url")) {
    return [...args, "--local"];
  }
  if (/^agent$/i.test(command) && !hasFlagIn(args, "--local")) {
    return [...args, "--local"];
  }
  return args;
}

function parseRunArgs(values) {
  const [agent, ...runArgs] = values;
  const separatorIndex = runArgs.indexOf("--");
  const wrapperArgs = separatorIndex === -1 ? runArgs : runArgs.slice(0, separatorIndex);
  const childArgs = separatorIndex === -1 ? stripRunWrapperArgs(runArgs) : runArgs.slice(separatorIndex + 1);
  return { agent, wrapperArgs, childArgs };
}

function stripRunWrapperArgs(values) {
  const output = [];
  const skipNext = new Set(["--viewer-url", "--mode", "--openclaw-profile", "--provider", "--target-base-url", "--watch"]);
  const skipSingle = new Set(["--open-viewer", "--new", "--refresh-profile"]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (skipSingle.has(value)) continue;
    if (skipNext.has(value)) {
      index += 1;
      continue;
    }
    output.push(value);
  }
  return output;
}

async function resolveClaudeRunWatchChoice({ parsed, viewerUrl, conversationId }) {
  const explicitPolicy = optionValueIn(parsed.wrapperArgs, "--watch");
  const continuation = Boolean(conversationId || isClaudeContinue(parsed.childArgs));
  const watchPolicy = explicitPolicy ? normalizeWatchPolicy(explicitPolicy, { allowAsk: true }) : continuation ? "ask" : "new";
  if (hasFlagIn(parsed.wrapperArgs, "--new") || watchPolicy === "new") return null;
  const shouldConsiderReuse = Boolean(continuation || watchPolicy === "reuse" || explicitPolicy === "ask");
  if (!shouldConsiderReuse) return null;

  const candidates = await findClaudeRunWatchCandidates({ parsed, viewerUrl, conversationId });
  const best = candidates[0] || null;
  if (watchPolicy === "reuse") {
    if (!best) console.error("peekMyAgent: 没有找到可复用的 Claude Code 监听，本次将新建监听。");
    return best?.id || null;
  }

  if (!best) return null;
  if (!isInteractiveStdio()) {
    console.error("peekMyAgent: 检测到 Claude Code continue/resume，但当前不是交互式终端；本次将新建监听。可用 --watch reuse 显式复用。");
    return null;
  }
  return (await askClaudeWatchReuse({ conversationId, candidate: best })) ? best.id : null;
}

function normalizeWatchPolicy(value, { allowAsk = false } = {}) {
  if (!value) return allowAsk ? "ask" : "new";
  if (["reuse", "new"].includes(value)) return value;
  if (allowAsk && value === "ask") return value;
  throw new Error(`Invalid --watch: ${value}. Expected ${allowAsk ? "ask, " : ""}reuse, or new.`);
}

async function findClaudeRunWatchCandidates({ parsed, viewerUrl, conversationId }) {
  const mode = optionValueIn(parsed.wrapperArgs, "--mode") || "single_session";
  const workspace = process.cwd();
  const data = await fetchJson(`${trimSlash(viewerUrl)}/api/watch/status`);
  return (Array.isArray(data) ? data : [])
    .filter((watch) => watch.agent === "Claude Code")
    .filter((watch) => watch.mode === mode)
    .filter((watch) => watch.workspace === workspace)
    .filter((watch) => (conversationId ? watch.conversation_id === conversationId : true))
    .sort((a, b) => Date.parse(b.last_seen || b.stopped_at || b.created_at || 0) - Date.parse(a.last_seen || a.stopped_at || a.created_at || 0));
}

async function askClaudeWatchReuse({ conversationId, candidate }) {
  const heading = conversationId
    ? `检测到你正在恢复 Claude Code 会话：\n  ${conversationId}`
    : "检测到你使用了 claude --continue。";
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(`\n${heading}\n\n`);
    process.stderr.write("peekMyAgent 找到了可能对应的历史监听：\n");
    process.stderr.write(`  1. 继续写入已有监听：${formatWatchCandidate(candidate)}\n`);
    process.stderr.write("  2. 新建一个监听\n\n");
    process.stderr.write("你希望这次捕获写到哪里？\n");
    const answer = await rl.question("请选择 [1/2]，默认 1：");
    return !answer.trim() || answer.trim() === "1";
  } finally {
    rl.close();
  }
}

function formatWatchCandidate(candidate) {
  const parts = [];
  parts.push(candidate.conversation_id ? shorten(candidate.conversation_id, 18) : shorten(candidate.watch_id, 18));
  parts.push(`状态 ${candidate.status === "watching" ? "监听中" : "已停止"}`);
  parts.push(`请求数 ${candidate.request_count || 0}`);
  if (candidate.last_seen) parts.push(`上次捕获 ${new Date(candidate.last_seen).toLocaleString()}`);
  return parts.join("，");
}

function isClaudeContinue(childArgs) {
  return hasFlagIn(childArgs, "--continue") || hasFlagIn(childArgs, "-c");
}

function isInteractiveStdio() {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

function shorten(value, length) {
  const text = String(value || "");
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(0, length - 1))}…`;
}

async function ensureViewerForRun(parsed) {
  const explicitUrl = optionValueIn(parsed.wrapperArgs, "--viewer-url");
  if (explicitUrl) return ensureDashboard({ explicitUrl });
  return ensureDashboard({ open: false });
}

async function ensureDashboard({ explicitUrl = null } = {}) {
  if (explicitUrl) {
    await waitForViewer(trimSlash(explicitUrl));
    return { url: trimSlash(explicitUrl) };
  }
  const daemonUrl = defaultDaemonUrl();
  if (await canReachDaemon(daemonUrl)) return { url: daemonUrl };
  const registered = readViewerRegistry();
  if (!hasDaemonEndpointOverride() && registered?.url && registered?.capture_url && (await canReachDaemon(registered.url))) return { url: trimSlash(registered.url) };
  if (await canConnect(defaultDaemonHost(), defaultDaemonApiPort())) {
    throw new Error(`Port ${defaultDaemonApiPort()} is already in use, but it is not a peekMyAgent daemon. Stop that process or set PEEKMYAGENT_DAEMON_PORT.`);
  }
  if (await canConnect(defaultDaemonHost(), defaultDaemonCapturePort())) {
    throw new Error(`Port ${defaultDaemonCapturePort()} is already in use, but the peekMyAgent daemon is not reachable. Stop that process or set PEEKMYAGENT_CAPTURE_PORT.`);
  }

  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url),
    "daemon",
    "--host",
    defaultDaemonHost(),
    "--api-port",
    String(defaultDaemonApiPort()),
    "--capture-port",
    String(defaultDaemonCapturePort()),
  ], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const started = await waitForDaemon(daemonUrl);
  return { url: trimSlash(started.url) };
}

async function openDashboard() {
  const explicitUrl = optionValue("--viewer-url") || process.env.PEEKMYAGENT_DASHBOARD_URL || null;
  const dashboard = await ensureDashboard({ explicitUrl });
  const url = buildDashboardUrl(dashboard.url, optionValue("--source"));
  const shouldOpen = !hasFlag("--no-open") && !hasFlag("--print");
  if (shouldOpen || hasFlag("--open")) {
    const { command: openCommand, args } = openBrowser(url);
    spawn(openCommand, args, { stdio: "ignore", detached: true }).unref();
  }
  console.log(`peekMyAgent dashboard: ${url}`);
}

async function shutdownDashboard() {
  const explicitUrl = optionValue("--viewer-url") || process.env.PEEKMYAGENT_DASHBOARD_URL || null;
  const targets = daemonControlTargets(explicitUrl);
  const errors = [];
  for (const target of targets) {
    const result = await shutdownDaemonTarget(target).catch((error) => {
      errors.push(`${target.url}: ${error.message}`);
      return null;
    });
    if (result) return result;
  }
  if (errors.length) throw new Error(`Could not stop peekMyAgent daemon. ${errors.join("; ")}`);
  return {
    action: "shutdown",
    status: "not_running",
    url: explicitUrl || defaultDaemonUrl(),
    message: "No running peekMyAgent daemon was found.",
  };
}

async function restartDashboard() {
  const stopped = await shutdownDashboard();
  const dashboard = await ensureDashboard({ explicitUrl: null });
  const url = buildDashboardUrl(dashboard.url, optionValue("--source"));
  const shouldOpen = !hasFlag("--no-open") && !hasFlag("--print");
  if (shouldOpen || hasFlag("--open")) {
    const { command: openCommand, args } = openBrowser(url);
    spawn(openCommand, args, { stdio: "ignore", detached: true }).unref();
  }
  return {
    action: "restart",
    status: "started",
    stopped,
    url,
  };
}

function daemonControlTargets(explicitUrl) {
  if (explicitUrl) return [{ url: trimSlash(explicitUrl), source: "explicit" }];
  const output = [{ url: defaultDaemonUrl(), source: "default" }];
  const registered = readViewerRegistry();
  if (registered?.url && trimSlash(registered.url) !== output[0].url) {
    output.push({ url: trimSlash(registered.url), source: "registry", pid: registered.pid });
  } else if (registered?.pid) {
    output[0].pid = registered.pid;
  }
  return output;
}

async function shutdownDaemonTarget(target) {
  let allowPidFallback = false;
  if (await canReachDaemon(target.url)) {
    try {
      const result = await postJson(`${trimSlash(target.url)}/api/daemon/shutdown`, {});
      await waitForDaemonDown(target.url);
      return {
        action: "shutdown",
        status: "stopped",
        url: trimSlash(target.url),
        pid: result.pid || target.pid || null,
        method: "api",
      };
    } catch (error) {
      if (!isMissingShutdownEndpoint(error)) throw error;
      allowPidFallback = true;
    }
  } else if (!(await canConnectToUrl(target.url))) {
    return null;
  }

  const registry = readViewerRegistry();
  const pid = target.pid || (registry?.url && trimSlash(registry.url) === trimSlash(target.url) ? registry.pid : null) || ((allowPidFallback || hasFlag("--force")) ? listeningPidForUrl(target.url) : null);
  if (!allowPidFallback && !hasFlag("--force")) return null;
  if (!pid) throw new Error(`No registry PID for ${target.url}${allowPidFallback ? " after detecting an older daemon" : ""}.`);
  process.kill(Number(pid), "SIGTERM");
  await waitForDaemonDown(target.url);
  clearViewerRegistry(trimSlash(target.url));
  return {
    action: "shutdown",
    status: "stopped",
    url: trimSlash(target.url),
    pid: Number(pid),
    method: "pid",
  };
}

function isMissingShutdownEndpoint(error) {
  return /HTTP 404|Not found/i.test(error?.message || "");
}

function listeningPidForUrl(url) {
  const parsed = new URL(trimSlash(url));
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const result = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (result.status !== 0 && !result.stdout) return null;
  return (
    result.stdout
      .split(/\s+/)
      .map((pid) => pid.trim())
      .find(Boolean) || null
  );
}

async function waitForDaemonDown(url) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (!(await canConnectToUrl(url))) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for peekMyAgent daemon to stop at ${url}.`);
}

async function canConnectToUrl(url) {
  const parsed = new URL(trimSlash(url));
  return canConnect(parsed.hostname, Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)));
}

function printDaemonControlResult(result) {
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result.action === "restart") {
    console.log(`peekMyAgent restarted: ${result.url}`);
    if (result.stopped?.status === "not_running") console.log("previous daemon: not running");
    return;
  }
  if (result.status === "not_running") {
    console.log("peekMyAgent daemon: not running");
    return;
  }
  console.log(`peekMyAgent daemon stopped: ${result.url}`);
  if (result.pid) console.log(`pid: ${result.pid}`);
}

async function manageIntegration(action) {
  const target = rest[0];
  if (target !== "trae-cn") usage(1);
  let result;
  if (action === "enable" || action === "sync") {
    const dashboard = await ensureDashboard({ explicitUrl: optionValue("--viewer-url") });
    const status = await fetchJson(`${trimSlash(dashboard.url)}/api/daemon/status`);
    if (!status.capture_url) throw new Error("peekMyAgent daemon has no shared capture proxy.");
    result = action === "enable" ? enableTraeCn({ captureBaseUrl: status.capture_url }) : syncTraeCn({ captureBaseUrl: status.capture_url });
  } else if (action === "disable") {
    result = disableTraeCn();
  } else if (action === "status") {
    result = inspectTraeCn();
  } else {
    usage(1);
  }
  if (hasFlag("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else printIntegrationResult(result);
}

function printIntegrationResult(result) {
  if (result.action === "enable" || result.action === "sync") {
    console.log(`peekMyAgent ${result.action} ${result.id}: ${result.enabled ? "enabled" : "disabled"}`);
    console.log(`stable URL: ${result.stable_url}`);
    console.log(`patched models: ${result.patched_count || 0}`);
  } else if (result.action === "disable") {
    console.log(`peekMyAgent disable ${result.id}: disabled`);
    console.log(`restored models: ${result.restored_count || 0}`);
  } else {
    console.log(`peekMyAgent status ${result.id}: ${result.enabled ? "enabled" : "disabled"}`);
    console.log(`available: ${result.available ? "yes" : "no"}`);
    if (result.stable_url) console.log(`stable URL: ${result.stable_url}`);
    console.log(`selected models: ${(result.selected_models || []).join(", ") || "none"}`);
    console.log(`custom models: ${result.custom_model_count || 0}`);
    console.log(`patched models: ${result.patched_models || 0}`);
    console.log(`workspaces: ${result.workspace_count || 0}`);
  }
  for (const warning of result.warnings || []) console.error(`warning: ${warning}`);
}

async function startForegroundDaemon() {
  const host = optionValue("--host") || process.env.PEEKMYAGENT_DAEMON_HOST || DEFAULT_DAEMON_HOST;
  const apiPort = parsePort(optionValue("--api-port") || process.env.PEEKMYAGENT_DAEMON_PORT || DEFAULT_DAEMON_API_PORT, "api port");
  const capturePort = parsePort(optionValue("--capture-port") || process.env.PEEKMYAGENT_CAPTURE_PORT || DEFAULT_DAEMON_CAPTURE_PORT, "capture port");
  const daemon = await startViewerServer({ cwd: process.cwd(), host, port: apiPort, captureHost: host, capturePort });
  console.log(`peekMyAgent daemon: ${daemon.url}`);
  console.log(`peekMyAgent capture proxy: ${daemon.captureUrl}`);
  console.log("Press Ctrl-C to stop.");
  if (hasFlag("--open")) {
    const { command: openCommand, args } = openBrowser(daemon.url);
    spawn(openCommand, args, { stdio: "ignore", detached: true }).unref();
  }
  process.on("SIGINT", async () => {
    await daemon.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await daemon.close();
    process.exit(0);
  });
}

async function startForegroundDevViewer() {
  const demo = optionValue("--demo") || "openclaw-subagent";
  const evidencePath = optionValue("--evidence");
  const portValue = optionValue("--port");
  const port = portValue ? Number(portValue) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid --port: ${portValue}`);
  const viewer = await startViewerServer({ cwd: process.cwd(), demo, evidencePath, port });
  console.log(`peekMyAgent dev viewer: ${viewer.url}`);
  console.log(`demo=${demo}${evidencePath ? ` evidence=${evidencePath}` : ""}`);
  console.log("Press Ctrl-C to stop.");
  if (hasFlag("--open")) {
    const { command: openCommand, args } = openBrowser(viewer.url);
    spawn(openCommand, args, { stdio: "ignore", detached: true }).unref();
  }
  process.on("SIGINT", async () => {
    await viewer.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await viewer.close();
    process.exit(0);
  });
}

function hasLegacyViewOptions(values) {
  return ["--demo", "--evidence", "--port"].some((flag) => values.includes(flag));
}

function buildDashboardUrl(baseUrl, sourceId) {
  const url = new URL(trimSlash(baseUrl));
  if (sourceId) url.searchParams.set("source", sourceId);
  return url.toString().replace(/\/$/, "");
}

function defaultDaemonHost() {
  return process.env.PEEKMYAGENT_DAEMON_HOST || DEFAULT_DAEMON_HOST;
}

function defaultDaemonApiPort() {
  return parsePort(process.env.PEEKMYAGENT_DAEMON_PORT || DEFAULT_DAEMON_API_PORT, "daemon api port");
}

function defaultDaemonCapturePort() {
  return parsePort(process.env.PEEKMYAGENT_CAPTURE_PORT || DEFAULT_DAEMON_CAPTURE_PORT, "daemon capture port");
}

function defaultDaemonUrl() {
  return `http://${defaultDaemonHost()}:${defaultDaemonApiPort()}`;
}

function hasDaemonEndpointOverride() {
  return Boolean(process.env.PEEKMYAGENT_DAEMON_HOST || process.env.PEEKMYAGENT_DAEMON_PORT || process.env.PEEKMYAGENT_CAPTURE_PORT);
}

async function waitForDaemon(url) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (await canReachDaemon(url)) return { url };
    await delay(100);
  }
  throw new Error(`Timed out waiting for peekMyAgent daemon at ${url}.`);
}

async function waitForViewer(url) {
  if (await canReachViewer(url)) return;
  throw new Error(`Could not reach peekMyAgent dashboard at ${url}`);
}

async function canReachViewer(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600);
    const response = await fetch(`${trimSlash(url)}/api/sources`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function canReachDaemon(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600);
    const response = await fetch(`${trimSlash(url)}/api/daemon/status`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return false;
    const data = await response.json();
    return Boolean(data?.shared_capture_proxy);
  } catch {
    return false;
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

function inferClaudeConversationId(childArgs) {
  return optionValueIn(childArgs, "--resume") || optionValueIn(childArgs, "-r") || optionAssignmentValueIn(childArgs, "--resume") || null;
}

function optionValueIn(values, name) {
  const index = values.indexOf(name);
  if (index === -1) return null;
  return values[index + 1] || null;
}

function hasFlagIn(values, name) {
  return values.includes(name);
}

function optionAssignmentValueIn(values, name) {
  const prefix = `${name}=`;
  const value = values.find((item) => String(item).startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function printRunStarted({ viewerUrl, watch, command, args }) {
  console.error(`peekMyAgent dashboard: ${trimSlash(viewerUrl)}?source=${encodeURIComponent(watch.id)}`);
  console.error(`peekMyAgent watch: ${watch.watch_id}`);
  console.error(`running: ${[command, ...args].join(" ")}`);
}

function runChild(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    });
    const forward = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
    child.on("error", (error) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      reject(error);
    });
    child.on("close", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve({ exit_code: code ?? signalExitCode(signal) });
    });
  });
}

async function stopRunWatch(viewerUrl, watch, openclawProfile) {
  const stopped = await postJson(`${trimSlash(viewerUrl)}/api/watch/stop`, {
    id: watch.id,
    clear: false,
  });
  if (openclawProfile && stopped.config_patched && stopped.provider_id && stopped.target_base_url) {
    patchOpenClawProviderBaseUrl(openclawProfile, stopped.provider_id, stopped.target_base_url);
  }
}

function signalExitCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function controlCurrentWatch({ status }) {
  const viewerUrl = optionValue("--viewer-url") || process.env.PEEKMYAGENT_VIEWER_URL || (await ensureDashboard({ open: false })).url;
  if (!viewerUrl) {
    throw new Error(`No running peekMyAgent dashboard found. Run "peekmyagent open" or pass --viewer-url. Registry checked: ${viewerRegistryPath()}`);
  }
  const agent = normalizeAgent(optionValue("--agent") || detectAgent());
  const conversationId = detectConversationId(agent);
  const workspace = process.env.PWD || process.cwd();
  const response = await postJson(`${trimSlash(viewerUrl)}/api/watch/pause`, {
    agent,
    workspace,
    conversation_id: conversationId,
    status,
  });
  return {
    ...response,
    viewer_url: trimSlash(viewerUrl),
    workspace,
    conversation_id: conversationId,
  };
}

async function stopCurrentWatch({ clear }) {
  const viewerUrl = optionValue("--viewer-url") || process.env.PEEKMYAGENT_VIEWER_URL || (await ensureDashboard({ open: false })).url;
  if (!viewerUrl) {
    throw new Error(`No running peekMyAgent dashboard found. Run "peekmyagent open" or pass --viewer-url. Registry checked: ${viewerRegistryPath()}`);
  }
  const agent = normalizeAgent(optionValue("--agent") || detectAgent());
  const conversationId = detectConversationId(agent);
  const workspace = process.env.PWD || process.cwd();
  const response = await postJson(`${trimSlash(viewerUrl)}/api/watch/stop`, {
    agent,
    workspace,
    conversation_id: conversationId,
    clear,
  });
  const openclawProfile = optionValue("--openclaw-profile") || process.env.PEEK_OPENCLAW_PROFILE || "peekmyagent";
  if (/openclaw/i.test(agent) && response.config_patched && response.provider_id && response.target_base_url) {
    patchOpenClawProviderBaseUrl(openclawProfile, response.provider_id, response.target_base_url);
  }
  return {
    ...response,
    action: "stop",
    viewer_url: trimSlash(viewerUrl),
    workspace,
    conversation_id: conversationId,
    openclaw_profile: /openclaw/i.test(agent) ? openclawProfile : null,
  };
}

function detectAgent() {
  if (process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDECODE) return "Claude Code";
  if (process.env.OPENCLAW_SESSION_KEY || process.env.OPENCLAW_BASE_URL || hasFlag("--patch-openclaw")) return "OpenClaw";
  return "Claude Code";
}

function normalizeAgent(value) {
  if (/openclaw/i.test(value)) return "OpenClaw";
  return "Claude Code";
}

function detectConversationId(agent) {
  if (/claude/i.test(agent)) return process.env.CLAUDE_CODE_SESSION_ID || null;
  return optionValue("--session-key") || process.env.OPENCLAW_SESSION_KEY || process.env.PEEK_CONVERSATION_ID || null;
}

function buildResumeCommand(agent, proxyBaseUrl, conversationId) {
  if (!/claude/i.test(agent) || !conversationId) return null;
  return `ANTHROPIC_BASE_URL=${shellQuote(proxyBaseUrl)} claude --resume ${shellQuote(conversationId)}`;
}

function buildWatchCurrentNote(agent, conversationId) {
  if (/claude/i.test(agent) && conversationId) {
    return "The current Claude Code session was identified from CLAUDE_CODE_SESSION_ID. A shell command cannot rewrite the already-running parent Claude process, so exact proxy capture begins after resuming or starting Claude Code with the proxy base URL.";
  }
  if (/openclaw/i.test(agent) && hasFlag("--patch-openclaw")) {
    return "OpenClaw capture is active on the isolated peekMyAgent profile. Run OpenClaw with the reported --profile value so the original profile remains untouched.";
  }
  return "The watch is registered with the dashboard. Point the Agent provider/base URL at the proxy base URL before the requests you want to inspect.";
}

function prepareOpenClawProfilePatch() {
  const profile = optionValue("--openclaw-profile") || process.env.PEEK_OPENCLAW_PROFILE || "peekmyagent";
  ensureOpenClawProfile(profile, { refresh: hasFlag("--refresh-profile") });
  const model = optionValue("--model") || runOpenClawConfig(["config", "get", "agents.defaults.model.primary"], { profile }).trim();
  const providerId = optionValue("--provider") || providerFromModel(model);
  const targetBaseUrl = optionValue("--target-base-url") || runOpenClawConfig(["config", "get", `models.providers.${providerId}.baseUrl`], { profile }).trim();
  if (!targetBaseUrl) throw new Error(`Could not resolve OpenClaw provider baseUrl for provider ${providerId} in profile ${profile}`);
  return {
    profile,
    provider_id: providerId,
    target_base_url: targetBaseUrl,
  };
}

function ensureOpenClawProfile(profile, { refresh = false } = {}) {
  const defaultConfigPath = expandHomePath(runOpenClawConfig(["config", "file"], { profile: null }).trim());
  const profileConfigPath = expandHomePath(runOpenClawConfig(["config", "file"], { profile }).trim());
  if (!fs.existsSync(defaultConfigPath)) throw new Error(`OpenClaw default config not found: ${defaultConfigPath}`);
  if (!refresh && fs.existsSync(profileConfigPath)) return;
  fs.mkdirSync(path.dirname(profileConfigPath), { recursive: true });
  fs.copyFileSync(defaultConfigPath, profileConfigPath);
}

function expandHomePath(value) {
  const text = String(value || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function patchOpenClawProviderBaseUrl(profile, providerId, baseUrl) {
  runOpenClawConfig(["config", "patch", "--stdin"], {
    profile,
    stdin: JSON.stringify({ models: { providers: { [providerId]: { baseUrl } } } }),
  });
}

function runOpenClawConfig(args, { profile, stdin } = {}) {
  const finalArgs = profile ? ["--profile", profile, ...args] : args;
  const result = spawnSync("openclaw", finalArgs, {
    cwd: process.cwd(),
    input: stdin || "",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`openclaw ${finalArgs.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return cleanOpenClawConfigOutput(result.stdout);
}

function cleanOpenClawConfigOutput(output) {
  const lines = String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) || "";
}

function providerFromModel(model) {
  const provider = String(model || "").split("/")[0];
  if (!provider || provider === String(model || "")) throw new Error(`Cannot infer OpenClaw provider from model: ${model}`);
  return provider;
}

function buildOpenClawCommandHint(profile, conversationId) {
  const session = conversationId ? ` --session-key ${shellQuote(conversationId)}` : "";
  return `openclaw --profile ${shellQuote(profile)} agent${session} --message '<your message>'`;
}

async function postJson(url, payload) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new Error(`Could not reach peekMyAgent dashboard at ${url}: ${error.message}`);
  }
  const body = await response.text();
  const data = body ? JSON.parse(body) : {};
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`Could not reach peekMyAgent dashboard at ${url}: ${error.message}`);
  }
  const body = await response.text();
  const data = body ? JSON.parse(body) : {};
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function trimSlash(value) {
  return String(value || "").replace(/\/$/, "");
}

function parsePort(value, label = "port") {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid ${label}: ${value}`);
  return port;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
