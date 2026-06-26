import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIRECT_ENV_KEYS = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]);

export function readClaudeCodeSettingsEnv({ cwd = process.cwd(), env = process.env } = {}) {
  const merged = {};
  for (const filePath of claudeCodeSettingsPaths(cwd, env)) {
    const settings = readJsonFile(filePath);
    if (!settings) continue;
    Object.assign(merged, extractClaudeCodeEnv(settings));
  }
  return merged;
}

export function resolveClaudeCodeTargetBaseUrl({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.PEEK_CLAUDE_TARGET_BASE_URL) return env.PEEK_CLAUDE_TARGET_BASE_URL;
  if (env.ANTHROPIC_BASE_URL) return env.ANTHROPIC_BASE_URL;
  return readClaudeCodeSettingsEnv({ cwd, env }).ANTHROPIC_BASE_URL || null;
}

export function mergeClaudeCodeProcessEnv({ cwd = process.cwd(), env = process.env, overrides = {} } = {}) {
  return {
    ...readClaudeCodeSettingsEnv({ cwd, env }),
    ...env,
    ...overrides,
  };
}

function claudeCodeSettingsPaths(cwd, env) {
  const home = resolveHome(env);
  const paths = [];
  if (home) {
    paths.push(path.join(home, ".claude", "settings.json"));
    paths.push(path.join(home, ".claude", "settings.local.json"));
  }
  for (const dir of workspaceAncestors(cwd, home)) {
    paths.push(path.join(dir, ".claude", "settings.json"));
    paths.push(path.join(dir, ".claude", "settings.local.json"));
  }
  return [...new Set(paths)];
}

function resolveHome(env) {
  return env.HOME || env.USERPROFILE || os.homedir() || null;
}

function workspaceAncestors(cwd, home) {
  const start = path.resolve(cwd || process.cwd());
  const homeResolved = home ? path.resolve(home) : null;
  const ancestors = [];
  let current = start;
  while (current && current !== path.dirname(current)) {
    ancestors.unshift(current);
    if (homeResolved && current === homeResolved) break;
    current = path.dirname(current);
  }
  ancestors.unshift(current);
  return [...new Set(ancestors.filter(Boolean))];
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    return null;
  }
}

function extractClaudeCodeEnv(settings) {
  const result = {};
  mergeEnvObject(result, settings?.env);
  mergeEnvObject(result, settings?.environmentVariables);
  mergeEnvObject(result, settings?.["claude-code.environmentVariables"]);
  for (const key of DIRECT_ENV_KEYS) {
    if (Object.hasOwn(settings || {}, key)) mergeEnvValue(result, key, settings[key]);
  }
  return result;
}

function mergeEnvObject(result, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== "string" || !key) continue;
    mergeEnvValue(result, key, entry);
  }
}

function mergeEnvValue(result, key, value) {
  if (value == null) return;
  if (!["string", "number", "boolean"].includes(typeof value)) return;
  result[key] = String(value);
}
