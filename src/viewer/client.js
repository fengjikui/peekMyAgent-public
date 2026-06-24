const state = {
  sources: [],
  data: null,
  activeId: null,
  activeRequestId: null,
  activeSourceId: null,
  rawOpen: true,
  activeRawSection: "full",
  rawWidth: 0,
  sidebarOpen: true,
  sidebarWidth: 0,
  autoRefreshTimer: 0,
  autoRefreshInFlight: false,
  sessionInfoControlsBound: false,
  responseExpanded: new Set(),
  upstreamExpanded: new Set(),
  latestOnly: false,
  translationMode: "source",
  translations: null,
  translationLookup: new Map(),
  translationGenerate: { loading: false, error: "", message: "" },
  translationAutoRefresh: new Set(),
  translationActionItems: new Map(),
  nextTranslationActionId: 1,
  collapsedAgentBranches: new Set(),
  agentSend: { loading: false, error: "", message: "", result: null },
};

const LIVE_REFRESH_MS = 1200;
const LATEST_ONLY_KEY = "peekmyagent.latestOnly";
const LOCAL_SOURCE_META_KEY = "peekmyagent.sourceMeta";
const PROJECT_COLLAPSE_KEY = "peekmyagent.collapsedProjects";
const TRANSLATION_MODE_KEY = "peekmyagent.translationMode";
const TARGET_TRANSLATION_LANGUAGE = "zh-CN";
const RAW_WIDTH_KEY = "peekmyagent.rawWidth";
const RAW_WIDTH_MIN = 320;
const RAW_WIDTH_MAX = 760;
const SIDEBAR_WIDTH_KEY = "peekmyagent.sidebarWidth";
const SIDEBAR_WIDTH_MIN = 220;
const SIDEBAR_WIDTH_MAX = 420;
const MAIN_PANEL_MIN = 520;
const RESIZER_WIDTH = 6;
const TURN_RAIL_MAX_ITEMS = 15;
const RAW_BUCKET_LABELS_ZH = {
  tool_calls: {
    current: "本轮新增工具调用",
    cumulative: "累计下发工具调用",
  },
  tool_results: {
    current: "本轮新增工具结果",
    cumulative: "累计工具结果",
  },
};

const els = {
  appShell: document.querySelector(".app-shell"),
  toggleSidebar: document.querySelector("#toggleSidebar"),
  rawToggle: document.querySelector("#rawToggle"),
  sessionNav: document.querySelector("#sessionNav"),
  pageTitle: document.querySelector("#pageTitle"),
  stats: document.querySelector("#stats"),
  mainPanel: document.querySelector(".main-panel"),
  sidebarResizer: document.querySelector("#sidebarResizer"),
  watchSummary: document.querySelector("#watchSummary"),
  timeline: document.querySelector("#timeline"),
  agentComposer: document.querySelector("#agentComposer"),
  turnRail: document.querySelector("#turnRail"),
  sessionInfoModal: document.querySelector("#sessionInfoModal"),
  sessionInfoBody: document.querySelector("#sessionInfoBody"),
  rawPanel: document.querySelector("#rawPanel"),
  rawResizer: document.querySelector("#rawResizer"),
  rawTitle: document.querySelector("#rawTitle"),
  rawTree: document.querySelector("#rawTree"),
};

let scrollRaf = 0;

init();

async function init() {
  state.rawOpen = localStorage.getItem("peekmyagent.rawOpen") !== "false";
  state.rawWidth = readRawPanelWidth();
  if (state.rawWidth) applyRawPanelWidth(state.rawWidth);
  state.sidebarOpen = localStorage.getItem("peekmyagent.sidebarOpen") !== "false";
  state.sidebarWidth = readSidebarWidth();
  state.latestOnly = localStorage.getItem(LATEST_ONLY_KEY) === "true";
  state.translationMode = localStorage.getItem(TRANSLATION_MODE_KEY) === TARGET_TRANSLATION_LANGUAGE ? TARGET_TRANSLATION_LANGUAGE : "source";
  if (state.sidebarWidth) applySidebarWidth(state.sidebarWidth);
  setRawPanelOpen(state.rawOpen);
  setSidebarOpen(state.sidebarOpen);
  state.sources = applyLocalSourceMeta(await fetchJson("/api/sources"));
  renderSessionNav();
  const requestedSource = new URLSearchParams(window.location.search).get("source");
  const first =
    state.sources.find((source) => source.id === requestedSource && source.available) ||
    state.sources.find((source) => source.available) ||
    state.sources[0];
  if (first) await loadSource(first.id);
  els.rawToggle.addEventListener("click", () => setRawPanelOpen(!state.rawOpen));
  els.toggleSidebar.addEventListener("click", () => setSidebarOpen(!state.sidebarOpen));
  els.rawTree.addEventListener("click", (event) => {
    const retranslateButton = event.target.closest("[data-translation-retranslate]");
    if (retranslateButton && els.rawTree.contains(retranslateButton)) {
      event.preventDefault();
      event.stopPropagation();
      retranslateTranslationBlock(retranslateButton.dataset.translationRetranslate);
      return;
    }
    const translationButton = event.target.closest("[data-translation-mode]");
    if (translationButton && els.rawTree.contains(translationButton)) {
      setTranslationMode(translationButton.dataset.translationMode || "source", translationButton.dataset.translationSection || "system");
      return;
    }
    const generateButton = event.target.closest("[data-translation-generate]");
    if (generateButton && els.rawTree.contains(generateButton)) {
      generateTranslationsForActiveSource(generateButton.dataset.translationSection || "system");
      return;
    }
    const button = event.target.closest("[data-raw]");
    if (!button || !els.rawTree.contains(button)) return;
    showRaw(button.dataset.raw, button.dataset.rawSection || "full");
  });
  document.addEventListener("click", (event) => {
    const retranslateButton = event.target.closest("[data-translation-retranslate]");
    if (!retranslateButton || els.rawTree.contains(retranslateButton)) return;
    event.preventDefault();
    event.stopPropagation();
    retranslateTranslationBlock(retranslateButton.dataset.translationRetranslate);
  });
  els.turnRail.addEventListener("click", (event) => {
    const button = event.target.closest("[data-turn]");
    if (!button || !els.turnRail.contains(button)) return;
    markActiveTurn(button.dataset.turn, true);
  });
  bindSidebarResizer();
  bindRawResizer();
  els.mainPanel.addEventListener("scroll", scheduleActiveSync, { passive: true });
  window.addEventListener("resize", () => {
    if (state.sidebarWidth) setSidebarWidth(state.sidebarWidth, { persist: false });
    if (state.rawWidth) setRawPanelWidth(state.rawWidth, { persist: false });
    scheduleActiveSync();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshLiveData({ force: true });
  });
  startAutoRefresh();
}

async function loadSource(sourceId, { preserveScroll = false } = {}) {
  const scrollTop = els.mainPanel.scrollTop;
  state.data = applyLocalSourceMetaToData(await fetchJson(`/api/view?source=${encodeURIComponent(sourceId)}`));
  await loadTranslationsForActiveSource();
  const turnIds = activeTurnIds();
  if (!preserveScroll || !turnIds.includes(state.activeId)) {
    state.activeId = turnIds[0] || null;
  }
  if (!preserveScroll || !state.data.requests.some((request) => request.id === state.activeRequestId)) {
    state.activeRequestId = state.data.requests[0]?.id || null;
  }
  state.activeSourceId = state.data.source.id;
  const url = new URL(window.location.href);
  url.searchParams.set("source", state.activeSourceId);
  window.history.replaceState(null, "", url);
  renderAll();
  if (preserveScroll) els.mainPanel.scrollTop = scrollTop;
  else els.mainPanel.scrollTop = 0;
  scheduleActiveSync();
}

async function refreshSources() {
  state.sources = applyLocalSourceMeta(await fetchJson("/api/sources"));
  renderSessionNav();
  if (state.activeSourceId && !state.sources.some((source) => source.id === state.activeSourceId)) {
    const first = state.sources.find((source) => source.available) || state.sources[0];
    if (first) await loadSource(first.id);
  }
}

function startAutoRefresh() {
  if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
  state.autoRefreshTimer = setInterval(() => refreshLiveData(), LIVE_REFRESH_MS);
}

async function refreshLiveData({ force = false } = {}) {
  if (state.autoRefreshInFlight || document.hidden) return;
  const activeBefore = currentSourceFromList();
  const shouldPoll = force || hasAnyWatchingLiveSource() || state.data?.source?.live_status === "watching";
  if (!shouldPoll) return;

  state.autoRefreshInFlight = true;
  try {
    const nextSources = applyLocalSourceMeta(await fetchJson("/api/sources"));
    const sourceChanged = sourcesSignature(nextSources) !== sourcesSignature(state.sources);
    state.sources = nextSources;
    if (sourceChanged) renderSessionNav();

    const activeAfter = currentSourceFromList();
    if (!state.activeSourceId || !activeAfter) return;
    if (!activeAfter.available) return;
    const activeNeedsReload =
      force ||
      activeAfter.request_count !== activeBefore?.request_count ||
      activeAfter.response_count !== activeBefore?.response_count ||
      activeAfter.live_status !== activeBefore?.live_status ||
      activeAfter.last_seen !== activeBefore?.last_seen ||
      activeAfter.last_response_seen !== activeBefore?.last_response_seen;

    if (activeNeedsReload) await refreshActiveSource(activeAfter);
  } catch (error) {
    console.warn("peekMyAgent auto refresh failed", error);
  } finally {
    state.autoRefreshInFlight = false;
  }
}

async function refreshActiveSource(activeSource) {
  const previousData = state.data;
  const nextData = applyLocalSourceMetaToData(await fetchJson(`/api/view?source=${encodeURIComponent(activeSource.id)}`));
  if (!shouldRenderRefreshedData(previousData, nextData)) return;

  const wasNearBottom = isMainPanelNearBottom();
  const previousScrollTop = els.mainPanel.scrollTop;
  state.data = nextData;
  state.activeSourceId = nextData.source.id;
  await loadTranslationsForActiveSource();
  const turnIds = activeTurnIds(nextData);
  if (!turnIds.includes(state.activeId)) {
    state.activeId = turnIds.at(-1) || null;
  }
  if (!nextData.requests.some((request) => request.id === state.activeRequestId)) {
    state.activeRequestId = nextData.requests.at(-1)?.id || nextData.requests[0]?.id || null;
  }
  renderAll();
  if (wasNearBottom) {
    els.mainPanel.scrollTop = els.mainPanel.scrollHeight;
  } else {
    els.mainPanel.scrollTop = previousScrollTop;
  }
  scheduleActiveSync();
}

async function loadTranslationsForActiveSource({ autoRefresh = true } = {}) {
  const agents = translationAgentCandidatesForData(state.data);
  if (!agents.length) {
    state.translations = null;
    state.translationLookup = new Map();
    return;
  }
  try {
    const attempts = [];
    for (const agent of agents) {
      const translations = await fetchJson(`/api/translations?agent=${encodeURIComponent(agent)}&target_language=${encodeURIComponent(TARGET_TRANSLATION_LANGUAGE)}`);
      attempts.push(translations);
      if (translations.available) {
        state.translations = translations;
        state.translationLookup = await buildTranslationLookup(state.data?.requests || [], translations);
        return;
      }
    }
    state.translations = attempts[0] || { available: false, target_language: TARGET_TRANSLATION_LANGUAGE, entries: {} };
    state.translationLookup = new Map();
    if (autoRefresh) maybeAutoRefreshTranslations(agents[0] || "OpenClaw");
  } catch (error) {
    console.warn("peekMyAgent translation cache unavailable", error);
    state.translations = { available: false, error: error.message, target_language: TARGET_TRANSLATION_LANGUAGE, entries: {} };
    state.translationLookup = new Map();
  }
}

function maybeAutoRefreshTranslations(agent) {
  const sourceId = state.data?.source?.id || state.activeSourceId || "";
  const key = `${sourceId}\0${agent}\0${TARGET_TRANSLATION_LANGUAGE}`;
  if (!sourceId || state.translationAutoRefresh.has(key) || state.translationGenerate.loading) return;
  state.translationAutoRefresh.add(key);
  setTimeout(() => {
    generateTranslationsForActiveSource(state.activeRawSection || "tools", { automatic: true, agent }).catch((error) => {
      console.warn("peekMyAgent auto translation refresh failed", error);
    });
  }, 0);
}

async function generateTranslationsForActiveSource(section, { automatic = false, agent = null } = {}) {
  if (state.translationGenerate.loading) return;
  const selectedAgent = agent || translationAgentCandidatesForData(state.data)[0] || "Claude Code";
  const activeSection = section || state.activeRawSection || "system";
  const activeRequest = (state.data?.requests || []).find((request) => request.id === state.activeRequestId);
  state.translationGenerate = {
    loading: true,
    error: "",
    message: automatic ? "未找到中文缓存，正在自动更新翻译..." : "正在更新当前区块翻译...",
  };
  if (state.activeRequestId) showRaw(state.activeRequestId, activeSection);
  try {
    const result = await fetchJson("/api/translations/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: selectedAgent,
        source_id: state.data?.source?.id || state.activeSourceId || "",
        request_id: state.activeRequestId || "",
        section: activeSection,
        force: !automatic,
        target_language: TARGET_TRANSLATION_LANGUAGE,
      }),
    });
    await loadTranslationsForActiveSource({ autoRefresh: false });
    const translated = Number(result.translate?.translated || 0);
    const remaining = Number(result.translate?.remaining || 0);
    const stats = activeRequest ? translationSectionStats(activeRequest, activeSection) : { total: 0, hit: 0, missing: 0 };
    const cacheAvailable = Boolean(state.translations?.available);
    const message = translationGenerateMessage({ cacheAvailable, translated, remaining, stats });
    state.translationGenerate = {
      loading: false,
      error: "",
      message: automatic && message === "中文缓存已是最新。" ? "已自动更新翻译。" : message,
    };
    if (cacheAvailable && stats.hit > 0) {
      state.translationMode = TARGET_TRANSLATION_LANGUAGE;
      localStorage.setItem(TRANSLATION_MODE_KEY, state.translationMode);
    }
  } catch (error) {
    state.translationGenerate = {
      loading: false,
      error: error.message,
      message: "",
    };
  }
  if (state.activeRequestId) showRaw(state.activeRequestId, activeSection);
}

async function retranslateTranslationBlock(actionId) {
  const item = state.translationActionItems.get(actionId);
  if (!item || state.translationGenerate.loading) return;
  const selectedAgent = translationAgentCandidatesForData(state.data)[0] || "Claude Code";
  state.translationGenerate = { loading: true, error: "", message: "正在重译当前块..." };
  if (item.surface === "raw" && state.activeRequestId) showRaw(state.activeRequestId, item.section || state.activeRawSection || "system");
  try {
    const result = await fetchJson("/api/translations/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: selectedAgent,
        source_id: state.data?.source?.id || state.activeSourceId || "",
        request_id: item.requestId || state.activeRequestId || "",
        target_language: TARGET_TRANSLATION_LANGUAGE,
        force: true,
        materials: [
          {
            kind: item.kind,
            source_text: item.sourceText,
            metadata: item.metadata || {},
          },
        ],
      }),
    });
    await loadTranslationsForActiveSource({ autoRefresh: false });
    const translated = Number(result.translate?.translated || 0);
    state.translationGenerate = {
      loading: false,
      error: "",
      message: translated ? "已重译当前块。" : "当前块翻译已是最新。",
    };
    state.translationMode = TARGET_TRANSLATION_LANGUAGE;
    localStorage.setItem(TRANSLATION_MODE_KEY, state.translationMode);
  } catch (error) {
    state.translationGenerate = {
      loading: false,
      error: error.message,
      message: "",
    };
  }
  renderAll();
  if (item.surface === "raw" && state.activeRequestId) showRaw(state.activeRequestId, item.section || state.activeRawSection || "system");
}

function translationGenerateMessage({ cacheAvailable, translated, remaining, stats }) {
  if (!cacheAvailable) return "生成已结束，但仍未找到中文缓存。";
  if (stats.total && stats.hit < stats.total) {
    return translated
      ? `已补齐 ${translated} 条；当前区块命中 ${stats.hit}/${stats.total}，剩余 ${remaining} 条。`
      : `中文缓存存在，但当前区块仍只命中 ${stats.hit}/${stats.total}。`;
  }
  if (translated) return `已补齐 ${translated} 条中文缓存，当前区块 ${stats.hit}/${stats.total} 已缓存。`;
  return stats.total ? `中文缓存已是最新，当前区块 ${stats.hit}/${stats.total} 已缓存。` : "中文缓存已是最新。";
}

function translationAgentCandidatesForData(data) {
  const values = [];
  add(data?.source?.agent);
  add(data?.source?.id);
  add(data?.source?.store_watch_id);
  for (const request of data?.requests || []) {
    add(request.agent_profile);
    add(request.raw?.agent_profile);
    add(request.watch_id);
    add(request.raw?.watch_id);
    add(request.raw?.body?.metadata?.agent);
  }
  if (values.some((value) => /claude-code|claude|anthropic|\bcc\b/i.test(value))) add("Claude Code");
  if (values.some((value) => /trae-cn|trae/i.test(value))) add("Trae CN");
  return values;

  function add(value) {
    const normalized = String(value || "").trim();
    if (normalized && !values.includes(normalized)) values.push(normalized);
  }
}

async function buildTranslationLookup(requests, translations) {
  const entries = translations?.entries || {};
  if (!translations?.available || !Object.keys(entries).length || !window.crypto?.subtle) return new Map();
  const unique = new Map();
  for (const request of requests) {
    for (const item of collectTranslationMaterials(request)) {
      const sourceText = normalizeTranslationText(item.source_text);
      if (sourceText) unique.set(translationLookupKey(item.kind, sourceText), { ...item, source_text: sourceText });
    }
  }
  const pairs = await Promise.all(
    [...unique.values()].map(async (item) => {
      const hash = await materialHash(item.kind, item.source_text);
      const entry = entries[hash];
      return entry?.translated_text ? [translationLookupKey(item.kind, item.source_text), entry] : null;
    }),
  );
  return new Map(pairs.filter(Boolean));
}

function setTranslationMode(mode, section) {
  state.translationMode = mode === TARGET_TRANSLATION_LANGUAGE ? TARGET_TRANSLATION_LANGUAGE : "source";
  localStorage.setItem(TRANSLATION_MODE_KEY, state.translationMode);
  if (state.activeRequestId) showRaw(state.activeRequestId, section || state.activeRawSection || "full");
}

function shouldRenderRefreshedData(previousData, nextData) {
  if (!previousData) return true;
  return dataSignature(previousData) !== dataSignature(nextData);
}

function dataSignature(data) {
  const requests = data?.requests || [];
  return [
    data?.source?.id || "",
    data?.source?.live_status || "",
    data?.source?.conversation_id || "",
    requests.length,
    requests.at(-1)?.id || "",
    requests.at(-1)?.captured_at || "",
    requests
      .map((request) =>
        [
          request.id,
          request.summary?.response?.captured ? "r" : "",
          request.summary?.response?.received_at || "",
          request.summary?.response?.raw_body_bytes || "",
          request.summary?.response?.truncated ? "truncated" : "",
        ].join(":"),
      )
      .join(","),
  ].join("|");
}

function sourcesSignature(sources) {
  return (sources || [])
    .map((source) =>
      [
        source.id,
        source.label || "",
        source.pinned ? "pinned" : "",
        source.live_status || "",
        source.request_count || 0,
        source.response_count || 0,
        source.last_seen || "",
        source.last_response_seen || "",
        source.conversation_id || "",
      ].join(":"),
    )
    .join("|");
}

function currentSourceFromList() {
  return state.sources.find((source) => source.id === state.activeSourceId) || null;
}

function hasAnyWatchingLiveSource() {
  return state.sources.some((source) => source.live_watch_id && source.live_status === "watching");
}

function isMainPanelNearBottom() {
  const gap = els.mainPanel.scrollHeight - els.mainPanel.scrollTop - els.mainPanel.clientHeight;
  return gap < 160;
}

function renderSessionNav() {
  els.sessionNav.innerHTML = renderSourceGroups(state.sources);
  document.querySelectorAll("[data-project-toggle]").forEach((button) => {
    button.addEventListener("click", () => toggleProjectGroup(button.dataset.projectToggle));
  });
  document.querySelectorAll("[data-source]").forEach((button) => {
    button.addEventListener("click", () => loadSource(button.dataset.source));
  });
  document.querySelectorAll("[data-source-action]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      handleSourceAction(button.dataset.sourceAction, button.dataset.sourceId);
    });
  });
}

function renderSourceGroups(sources) {
  const collapsed = readCollapsedProjects();
  const agentGroups = groupSourcesByAgentAndProject(sources);
  return agentGroups
    .map(
      (agentGroup) => `
        <section class="source-agent-group">
          <p class="source-agent-title">${escapeHtml(agentGroup.agent)}</p>
          ${agentGroup.projects.map((projectGroup) => renderProjectGroup(projectGroup, collapsed)).join("")}
        </section>
      `,
    )
    .join("");
}

function renderProjectGroup(projectGroup, collapsed) {
  const isCollapsed = collapsed[projectGroup.key] === true;
  return `
    <section class="source-project-group ${isCollapsed ? "collapsed" : ""}">
      <button class="source-project-toggle" type="button" data-project-toggle="${escapeHtml(projectGroup.key)}" aria-expanded="${String(!isCollapsed)}">
        <span class="source-project-chevron" aria-hidden="true">›</span>
        <span class="source-project-name">${escapeHtml(projectGroup.project)}</span>
        <span class="source-project-count">${projectGroup.sources.length}</span>
      </button>
      ${isCollapsed ? "" : `<div class="source-project-sessions">${projectGroup.sources.map(renderSessionItem).join("")}</div>`}
    </section>
  `;
}

function groupSourcesByAgentAndProject(sources) {
  const agentMap = new Map();
  for (const source of sources || []) {
    const agent = source.agent || "Unknown Agent";
    const project = source.project || projectNameFromWorkspace(source.workspace) || "未归属项目";
    const projectKey = projectGroupKey(agent, project);
    if (!agentMap.has(agent)) agentMap.set(agent, { agent, projectMap: new Map() });
    const agentGroup = agentMap.get(agent);
    if (!agentGroup.projectMap.has(projectKey)) agentGroup.projectMap.set(projectKey, { key: projectKey, project, sources: [] });
    agentGroup.projectMap.get(projectKey).sources.push(source);
  }
  return [...agentMap.values()].map((agentGroup) => ({
    agent: agentGroup.agent,
    projects: [...agentGroup.projectMap.values()],
  }));
}

function toggleProjectGroup(key) {
  const collapsed = readCollapsedProjects();
  collapsed[key] = !collapsed[key];
  writeCollapsedProjects(collapsed);
  renderSessionNav();
}

function renderSessionItem(source) {
  const active = source.id === state.activeSourceId ? "active" : "";
  const disabled = source.available ? "" : "disabled";
  const status = source.live_watch_id ? source.live_status || "stopped" : "static";
  const subtitle = source.conversation_id ? shortId(source.conversation_id) : source.agent;
  const label = displaySourceLabel(source.label);
  return `
    <div class="session-item ${active} ${source.pinned ? "pinned" : ""}" data-status="${escapeHtml(status)}">
      <button class="session-main" type="button" data-source="${escapeHtml(source.id)}" title="${escapeHtml(label)}" ${disabled}>
        <span class="session-dot" aria-hidden="true"></span>
        <span class="session-copy">
          <span class="session-title">${escapeHtml(label)}</span>
          <span class="session-subtitle">${escapeHtml(subtitle)} · ${source.request_count || 0} 请求</span>
        </span>
      </button>
      <span class="session-actions" aria-label="会话操作">
        <button class="session-action ${source.pinned ? "active" : ""}" type="button" data-source-action="pin" data-source-id="${escapeHtml(source.id)}" title="${source.pinned ? "取消置顶" : "置顶"}">P</button>
        <button class="session-action" type="button" data-source-action="rename" data-source-id="${escapeHtml(source.id)}" title="重命名">R</button>
        <button class="session-action danger" type="button" data-source-action="remove" data-source-id="${escapeHtml(source.id)}" title="移除">×</button>
      </span>
    </div>
  `;
}

async function handleSourceAction(action, sourceId) {
  const source = state.sources.find((item) => item.id === sourceId);
  if (!source) return;
  if (action === "pin") {
    await updateSourceMeta(sourceId, { pinned: !source.pinned });
    return;
  }
  if (action === "rename") {
    const title = window.prompt("重命名会话", source.user_title || source.label);
    if (title == null) return;
    await updateSourceMeta(sourceId, { title });
    return;
  }
  if (action === "remove") {
    const message =
      source.live_watch_id && source.live_status === "watching"
        ? "移除会停止并清空这条监听，确定继续吗？"
        : "确定从左侧移除这条会话吗？";
    if (!window.confirm(message)) return;
    await updateSourceMeta(sourceId, { remove: true });
  }
}

async function updateSourceMeta(sourceId, payload) {
  try {
    const response = await fetchJson("/api/source/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: sourceId, ...payload }),
    });
    state.sources = applyLocalSourceMeta(response.sources || (await fetchJson("/api/sources")));
  } catch (error) {
    console.warn("peekMyAgent source update fallback", error);
    await updateSourceMetaLocally(sourceId, payload);
    state.sources = applyLocalSourceMeta(await fetchJson("/api/sources"));
  }
  if (payload.remove && state.activeSourceId === sourceId) {
    const first = state.sources.find((source) => source.available) || state.sources[0];
    if (first) await loadSource(first.id);
    else renderSessionNav();
    return;
  }
  renderSessionNav();
  if (state.activeSourceId === sourceId && Object.prototype.hasOwnProperty.call(payload, "title")) {
    await loadSource(sourceId, { preserveScroll: true });
  }
}

async function updateSourceMetaLocally(sourceId, payload) {
  const source = state.sources.find((item) => item.id === sourceId);
  const meta = readLocalSourceMeta();
  const item = { ...(meta[sourceId] || {}) };
  if (payload.remove) {
    if (source?.live_watch_id) {
      try {
        await fetchJson("/api/watch/stop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: sourceId, clear: true }),
        });
      } catch (error) {
        console.warn("peekMyAgent live remove fallback failed", error);
      }
    }
    item.hidden = true;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "pinned")) item.pinned = Boolean(payload.pinned);
  if (Object.prototype.hasOwnProperty.call(payload, "title")) {
    const title = String(payload.title || "").trim().slice(0, 80);
    if (title) item.title = title;
    else delete item.title;
  }
  if (item.hidden || item.pinned || item.title) meta[sourceId] = item;
  else delete meta[sourceId];
  writeLocalSourceMeta(meta);
}

function applyLocalSourceMeta(sources) {
  const meta = readLocalSourceMeta();
  return (sources || [])
    .map((source, order) => ({ ...decorateSourceLocally(source, meta[source.id]), source_order: order }))
    .filter((source) => !source.hidden)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.source_order - b.source_order)
    .map(({ source_order, ...source }) => source);
}

function applyLocalSourceMetaToData(data) {
  if (!data?.source) return data;
  const [source] = applyLocalSourceMeta([data.source]);
  return source ? { ...data, source } : data;
}

function decorateSourceLocally(source, meta = {}) {
  if (!meta) return source;
  return {
    ...source,
    original_label: source.original_label || source.label,
    label: meta.title || source.label,
    user_title: meta.title || source.user_title || null,
    pinned: Boolean(meta.pinned || source.pinned),
    hidden: Boolean(meta.hidden || source.hidden),
  };
}

function readLocalSourceMeta() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_SOURCE_META_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeLocalSourceMeta(meta) {
  localStorage.setItem(LOCAL_SOURCE_META_KEY, JSON.stringify(meta));
}

function readCollapsedProjects() {
  try {
    return JSON.parse(localStorage.getItem(PROJECT_COLLAPSE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeCollapsedProjects(collapsed) {
  localStorage.setItem(PROJECT_COLLAPSE_KEY, JSON.stringify(collapsed));
}

function renderAll() {
  const { source, stats, requests, turns } = state.data;
  els.pageTitle.textContent = displaySourceLabel(source.label);
  els.stats.innerHTML = [
    ["请求", stats.request_count],
    ["回复", stats.response_count || 0],
    ["子代理", stats.subagent_instance_count ?? stats.subagent_count],
    ["工具调用", stats.tool_call_count],
    ["工具结果", stats.tool_result_count],
    ["Raw", formatBytes(stats.raw_body_bytes)],
  ]
    .map(([label, value]) => `<span class="stat">${label}: ${escapeHtml(String(value))}</span>`)
    .join("") +
    `<button class="stat stat-button ${state.latestOnly ? "active" : ""}" type="button" data-latest-only>${state.latestOnly ? "显示全部轮次" : "只看最新轮次"}</button>` +
    '<button class="stat stat-button session-info-trigger" type="button" data-session-info>会话信息</button>';
  els.watchSummary.innerHTML = "";
  els.sessionInfoBody.innerHTML = renderSessionInfo(source, stats, requests);
  renderSessionNav();
  const visibleTurns = visibleTurnList(turns, requests);
  els.timeline.innerHTML = requests.length ? renderTurnTimeline(visibleTurns, requests) : renderEmptyTimeline(source.workbench);
  els.agentComposer.innerHTML = renderAgentComposer(source);
  renderTurnRail();
  bindSessionInfoControls();
  bindWatchControls();
  bindAgentComposer();
  bindRequestEvents();
  if (state.activeId) markActiveTurn(state.activeId, false);
  if (state.activeRequestId) markActiveRequest(state.activeRequestId, false);
}

function visibleTurnList(turns, requests) {
  const normalizedTurns = Array.isArray(turns) && turns.length ? turns : fallbackTurns(requests);
  if (!state.latestOnly || normalizedTurns.length <= 1) return normalizedTurns;
  return [normalizedTurns.at(-1)];
}

function renderEmptyTimeline(summary) {
  return `
    <section class="empty-timeline">
      <h3>等待 Agent 发出下一次模型请求</h3>
      <p>这个 watch 已经创建。把 Agent 的 provider/base URL 指向本地代理后，请求会出现在这里。</p>
      <div class="empty-grid">
        ${renderSummaryMetric("状态", summary?.status || "监听中")}
        ${renderSummaryMetric("Watch", summary?.watch_ids?.join(", ") || "未记录")}
        ${renderSummaryMetric("捕获", summary?.capture_label || "exact proxy capture")}
      </div>
    </section>
  `;
}

function renderSessionInfo(source, stats, requests) {
  const summary = source.workbench;
  if (!summary) return renderSessionRequestFacts(requests);
  const watchText = summary.watch_ids?.length ? summary.watch_ids.join(", ") : "未记录";
  const conversationText = summary.conversation_ids?.length ? summary.conversation_label : "按监听任务归档";
  const redactionText = summary.redaction_count ? `${summary.redaction_count} 处 header 脱敏` : "未发现 header 脱敏";
  return `
    <section class="summary-hero" aria-label="当前会话统计信息">
      <div class="summary-head">
        <div>
          <p class="eyeline">本地 Agent 透明度工作台</p>
          <h3>${escapeHtml(summary.agent)} · ${escapeHtml(summary.mode)}</h3>
          <p class="summary-note">${escapeHtml(summary.project)} · ${escapeHtml(captureLabelText(summary.capture_label))} · ${escapeHtml(summary.status)}</p>
        </div>
        <div class="summary-badges">
          <span class="badge ${summary.capture_label === "exact proxy capture" ? "exact" : "partial"}" title="${escapeHtml(captureLabelHelp(summary.capture_label))}">${escapeHtml(captureLabelText(summary.capture_label))}</span>
          ${summary.subagent_count ? `<span class="badge subagent">子代理 ${summary.subagent_count}</span>` : ""}
          <span class="badge ${summary.redaction_count ? "risk" : "muted"}">${escapeHtml(redactionText)}</span>
        </div>
      </div>
      <div class="summary-grid">
        ${renderSummaryMetric("Agent", summary.agent)}
        ${renderSummaryMetric("项目", summary.project)}
        ${renderSummaryMetric("Watch", watchText)}
        ${renderSummaryMetric("会话", conversationText)}
        ${renderSummaryMetric("请求", `${stats.request_count} 条`)}
        ${renderSummaryMetric("Raw", formatBytes(stats.raw_body_bytes))}
      </div>
      ${renderSessionRequestFacts(requests)}
      ${renderLiveWatchActions(source)}
    </section>
  `;
}

function renderSessionRequestFacts(requests) {
  if (!requests?.length) return "";
  const first = requests[0];
  const last = requests[requests.length - 1];
  return `
    <section class="session-facts" aria-label="请求默认信息">
      <h3>请求默认信息</h3>
      <div class="summary-grid compact">
        ${renderSummaryMetric("Endpoint", joinUnique(requests.map((request) => [request.method, request.path].filter(Boolean).join(" "))))}
        ${renderSummaryMetric("Model", joinUnique(requests.map((request) => request.model)))}
        ${renderSummaryMetric("Provider", joinUnique(requests.map((request) => request.summary?.protocol?.provider_label || providerLabel(request.provider))))}
        ${renderSummaryMetric("Protocol", joinUnique(requests.map((request) => request.summary?.protocol?.protocol_label || protocolLabel(request.protocol))))}
        ${renderSummaryMetric("扩展", joinUnique(requests.flatMap((request) => request.summary?.protocol?.extensions || []).map(extensionLabel)) || "无")}
        ${renderSummaryMetric("Debug source", joinUnique(requests.map((request) => request.debug_source)))}
        ${renderSummaryMetric("首次捕获", formatTimestamp(first.captured_at))}
        ${renderSummaryMetric("最近捕获", formatTimestamp(last.captured_at))}
        ${renderSummaryMetric("会话", joinUnique(requests.map((request) => shortId(request.conversation_id))))}
      </div>
    </section>
  `;
}

function renderLiveWatchActions(source) {
  if (!source.live_watch_id) return "";
  const stopped = source.live_status !== "watching";
  return `
    <div class="watch-control-bar" data-watch-controls>
      <div>
        <strong>${stopped ? "监听已停止" : "监听正在运行"}</strong>
        <span>${stopped ? "已保留当前捕获结果，可以清空左侧条目。" : "关闭页面不会停止监听；需要停止时请在这里操作。"}</span>
      </div>
      <div class="watch-control-actions">
        ${
          stopped
            ? ""
            : `<button class="secondary-button small" type="button" data-watch-action="stop">仅停止监听</button>
               <button class="danger-button small" type="button" data-watch-action="clear">停止并清空</button>`
        }
        ${stopped ? `<button class="danger-button small" type="button" data-watch-action="clear">清空条目</button>` : ""}
      </div>
    </div>
  `;
}

function renderAgentComposer(source) {
  const live = Boolean(source?.live_watch_id);
  const watching = source?.live_status === "watching";
  const supported = /claude|openclaw/i.test(source?.agent || "");
  const enabled = live && watching && supported && !state.agentSend.loading;
  const statusText = composerStatusText(source, { live, watching, supported });
  const result = state.agentSend.result;
  const statusClass = state.agentSend.error || result?.exit_code ? "error" : "";
  const statusMessage = state.agentSend.error || state.agentSend.message || (result ? agentSendResultText(result) : "");
  return `
    <form class="agent-compose-form ${enabled ? "" : "disabled"}" data-agent-compose data-source-id="${escapeHtml(source?.id || "")}">
      <div class="agent-compose-target">
        <strong>${escapeHtml(source?.agent || "Agent")}</strong>
        <span>${escapeHtml(statusText)}</span>
      </div>
      <div class="agent-compose-row">
        <textarea
          class="agent-compose-input"
          name="message"
          rows="1"
          placeholder="${escapeHtml(enabled ? "输入消息，Enter 发送，Shift+Enter 换行" : statusText)}"
          ${enabled ? "" : "disabled"}
        ></textarea>
        <button class="primary-button small agent-compose-send" type="submit" ${enabled ? "" : "disabled"}>
          ${state.agentSend.loading ? "发送中" : "发送"}
        </button>
      </div>
      <p class="agent-compose-status ${statusClass}" data-agent-compose-status ${statusMessage ? "" : "hidden"}>${escapeHtml(statusMessage)}</p>
    </form>
  `;
}

function composerStatusText(source, { live, watching, supported }) {
  if (!live) return "当前记录不可发送";
  if (!supported) return "当前 Agent 暂不支持页面发送";
  if (!watching) return source?.live_status === "paused" ? "监听已暂停" : "监听已停止";
  const project = source.project || projectNameFromWorkspace(source.workspace) || "当前项目";
  const conversation = source.conversation_id ? ` · ${shortId(source.conversation_id)}` : "";
  return `${project}${conversation}`;
}

function agentSendResultText(result) {
  const code = Number(result?.exit_code || 0);
  const output = cleanDisplayText(result?.stdout || result?.stderr || "");
  const preview = output ? ` · ${shortPreview(output, 120)}` : "";
  return code ? `发送失败 exit ${code}${preview}` : `已发送${preview}`;
}

function bindAgentComposer() {
  const form = document.querySelector("[data-agent-compose]");
  if (!form) return;
  const textarea = form.querySelector("textarea[name='message']");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    sendAgentComposerMessage(textarea?.value || "");
  });
  textarea?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendAgentComposerMessage(textarea.value || "");
    }
  });
}

async function sendAgentComposerMessage(rawMessage) {
  const message = String(rawMessage || "").trim();
  if (!message || !state.data?.source?.id || state.agentSend.loading) return;
  const sourceId = state.data.source.id;
  state.agentSend = { loading: true, error: "", message: "已发送，等待 Agent 回应...", result: null };
  updateAgentComposerUi(sourceId, { loading: true, message: state.agentSend.message, value: "" });
  await nextUiTick();
  try {
    const result = await fetchJson("/api/agent/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_id: sourceId,
        message,
      }),
    });
    state.agentSend = {
      loading: false,
      error: "",
      message: "",
      result,
    };
    updateAgentComposerUi(sourceId, { loading: false, message: "已发送，正在刷新捕获...", result });
    await loadSource(sourceId, { preserveScroll: true });
  } catch (error) {
    state.agentSend = { loading: false, error: error.message, message: "", result: null };
    updateAgentComposerUi(sourceId, { loading: false, error: error.message, value: rawMessage });
  }
}

function updateAgentComposerUi(sourceId, { loading, message = "", error = "", result = null, value } = {}) {
  const form = document.querySelector("[data-agent-compose]");
  if (!form || form.dataset.sourceId !== sourceId) return;
  const textarea = form.querySelector("textarea[name='message']");
  const button = form.querySelector(".agent-compose-send");
  const status = form.querySelector("[data-agent-compose-status]");
  form.classList.toggle("disabled", Boolean(loading));
  if (textarea) {
    textarea.disabled = Boolean(loading);
    if (value !== undefined) textarea.value = String(value || "");
  }
  if (button) {
    button.disabled = Boolean(loading);
    button.textContent = loading ? "发送中" : "发送";
  }
  if (status) {
    const statusText = error || message || (result ? agentSendResultText(result) : "");
    status.textContent = statusText;
    status.hidden = !statusText;
    status.classList.toggle("error", Boolean(error || Number(result?.exit_code || 0)));
  }
}

function nextUiTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function bindWatchControls() {
  document.querySelectorAll("[data-watch-action]").forEach((button) => {
    button.addEventListener("click", () => stopActiveWatch(button.dataset.watchAction === "clear"));
  });
}

function bindSessionInfoControls() {
  document.querySelectorAll("[data-session-info]").forEach((button) => {
    button.addEventListener("click", showSessionInfoModal);
  });
  if (state.sessionInfoControlsBound) return;
  state.sessionInfoControlsBound = true;
  document.querySelectorAll("[data-session-info-close]").forEach((button) => {
    button.addEventListener("click", hideSessionInfoModal);
  });
  els.sessionInfoModal.addEventListener("click", (event) => {
    if (event.target === els.sessionInfoModal) hideSessionInfoModal();
  });
}

function showSessionInfoModal() {
  els.sessionInfoModal.classList.remove("hidden");
  els.sessionInfoModal.setAttribute("aria-hidden", "false");
}

function hideSessionInfoModal() {
  els.sessionInfoModal.classList.add("hidden");
  els.sessionInfoModal.setAttribute("aria-hidden", "true");
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.sessionInfoModal.classList.contains("hidden")) hideSessionInfoModal();
});

async function stopActiveWatch(clear) {
  if (!state.data?.source?.live_watch_id) return;
  try {
    await fetchJson("/api/watch/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: state.data.source.id,
        clear,
      }),
    });
    state.sources = applyLocalSourceMeta(await fetchJson("/api/sources"));
    renderSessionNav();
    if (clear) {
      const first = state.sources.find((source) => source.available) || state.sources[0];
      if (first) await loadSource(first.id);
      return;
    }
    await loadSource(state.data.source.id);
  } catch (error) {
    showSessionInfoModal();
    els.sessionInfoBody.insertAdjacentHTML(
      "beforeend",
      `<div class="inline-error"><strong>监听操作失败</strong><span>${escapeHtml(error.message)}</span></div>`,
    );
  }
}

function renderSummaryMetric(label, value) {
  return `
    <div class="summary-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "未记录")}</strong>
    </div>
  `;
}

function requestDisplayTitle(request) {
  if (request.source_hint.type === "metadata") return request.source_hint.label || "元数据请求";
  if (request.summary?.command_message) return commandMessageLabel(request.summary.command_message);
  return request.is_subagent ? "子代理请求" : request.source_hint.type === "parent_spawn" ? "启动子代理" : "主代理请求";
}

function requestExcerpt(request) {
  if (request.summary?.command_message) return commandMessagePreview(request.summary.command_message);
  return request.source_hint.type === "metadata"
    ? request.summary.internal_request_preview || request.summary.current_user || request.summary.assistant_preview || "(无文本摘要)"
    : request.summary.current_user || request.summary.assistant_preview || "(无文本摘要)";
}

function commandMessageLabel(commandMessage) {
  return `Command ${commandMessage?.command || ""}`.trim();
}

function commandMessagePreview(commandMessage) {
  const command = commandMessage?.command || "/command";
  const body = cleanDisplayText(commandMessage?.body || commandMessage?.preview || "");
  return body ? `${command} · ${shortPreview(body, 180)}` : `Command ${command}`;
}

function renderTurnRailItem(turn) {
  const title = turnTitleText(turn);
  const excerpt = turnExcerptText(turn);
  const hasSubagent = Boolean(turn.subagent_count);
  const active = turn.id === state.activeId;
  return `
    <button class="turn-mark ${hasSubagent ? "subagent" : ""} ${active ? "active" : ""}" type="button" data-turn="${escapeHtml(turn.id)}" aria-label="跳转到 Turn ${turn.index}">
      <span class="turn-line"></span>
      <span class="turn-tooltip">
        <strong>Turn ${escapeHtml(turn.index)} · ${escapeHtml(title)}</strong>
        <span>${escapeHtml(excerpt)}</span>
      </span>
    </button>
  `;
}

function renderTurnRail() {
  if (!els.turnRail || !state.data?.requests?.length) {
    if (els.turnRail) els.turnRail.innerHTML = "";
    return;
  }
  const turns = visibleRailTurns();
  const allTurns = railTurnUniverse();
  const activeIndex = allTurns.findIndex((turn) => turn.id === state.activeId);
  const windowStart = turns.length ? allTurns.findIndex((turn) => turn.id === turns[0].id) : 0;
  const windowEnd = windowStart + turns.length;
  const topHint = windowStart > 0 ? '<span class="turn-window-edge" aria-hidden="true"></span>' : "";
  const bottomHint = windowEnd < allTurns.length ? '<span class="turn-window-edge" aria-hidden="true"></span>' : "";
  els.turnRail.innerHTML = `
    ${topHint}
    ${turns.map(renderTurnRailItem).join("")}
    ${bottomHint}
  `;
  els.turnRail.setAttribute(
    "aria-label",
    activeIndex >= 0 ? `轮次导航，当前第 ${activeIndex + 1} 轮，共 ${allTurns.length} 轮` : `轮次导航，共 ${allTurns.length} 轮`,
  );
}

function visibleRailTurns() {
  const allTurns = railTurnUniverse();
  if (allTurns.length <= TURN_RAIL_MAX_ITEMS) return allTurns;
  const activeIndex = Math.max(0, allTurns.findIndex((turn) => turn.id === state.activeId));
  const halfWindow = Math.floor(TURN_RAIL_MAX_ITEMS / 2);
  const maxStart = Math.max(0, allTurns.length - TURN_RAIL_MAX_ITEMS);
  const start = Math.min(Math.max(0, activeIndex - halfWindow), maxStart);
  return allTurns.slice(start, start + TURN_RAIL_MAX_ITEMS);
}

function railTurnUniverse(data = state.data) {
  const requests = data?.requests || [];
  const turns = data?.turns || [];
  return visibleTurnList(turns, requests);
}

function activeTurnIds(data = state.data) {
  return railTurnUniverse(data).map((turn) => turn.id);
}

function turnTitleText(turn) {
  if (turn.command_message) return commandMessagePreview(turn.command_message);
  return cleanDisplayText(turn.user_input || turn.title || `#${turn.first_request_index || ""}-${turn.last_request_index || ""}`) || `Turn ${turn.index}`;
}

function turnExcerptText(turn) {
  const parts = [
    turn.command_message ? commandMessagePreview(turn.command_message) : turn.user_input ? shortPreview(cleanDisplayText(turn.user_input), 150) : "",
    `${turn.request_count || turn.request_ids?.length || 0} 请求`,
    turn.internal_request_count ? `${turn.internal_request_count} 内部` : "",
    turn.tool_call_count || turn.tool_result_count ? `工具 ${turn.tool_call_count || 0}/${turn.tool_result_count || 0}` : "",
    `#${turn.first_request_index || ""}-${turn.last_request_index || ""}`,
  ].filter(Boolean);
  return parts.join(" · ");
}

function renderNavItem(request) {
  const title = requestDisplayTitle(request);
  return `
    <button class="nav-item" type="button" data-jump="${escapeHtml(request.id)}">
      <span class="nav-index">${request.request_index}</span>
      <span>
        <span class="nav-title">
          ${escapeHtml(title)}
          ${request.is_subagent ? '<span class="badge subagent">subagent</span>' : ""}
        </span>
        <span class="nav-excerpt">${escapeHtml(requestExcerpt(request))}</span>
      </span>
    </button>
  `;
}

function renderTurnTimeline(turns, requests) {
  const normalizedTurns = Array.isArray(turns) && turns.length ? turns : fallbackTurns(requests);
  const requestMap = new Map(requests.map((request) => [request.id, request]));
  return normalizedTurns.map((turn) => renderTurnGroup(turn, requestMap)).join("");
}

function fallbackTurns(requests) {
  return requests.map((request, index) => ({
    id: `turn-${index + 1}`,
    index: index + 1,
    title: requestExcerpt(request),
    user_input: requestExcerpt(request),
    request_ids: [request.id],
    request_indexes: [request.request_index],
    first_request_index: request.request_index,
    last_request_index: request.request_index,
    request_count: 1,
    main_request_count: request.source_hint?.type === "metadata" ? 0 : 1,
    internal_request_count: request.source_hint?.type === "metadata" ? 1 : 0,
    subagent_count: request.is_subagent ? 1 : 0,
    parent_spawn_count: request.source_hint?.type === "parent_spawn" ? 1 : 0,
    tool_call_count: request.summary?.current_tool_calls?.length || 0,
    tool_result_count: request.summary?.current_tool_results?.length || 0,
    raw_body_bytes: request.counts?.raw_body_bytes || 0,
  }));
}

function renderTurnGroup(turn, requestMap) {
  const requests = turn.request_ids.map((id) => requestMap.get(id)).filter(Boolean);
  let primaryRequests = requests.filter(isPrimaryTurnRequest);
  let fallbackPrimaryId = null;
  if (!primaryRequests.length) {
    const fallbackPrimary = requests.find((request) => isFallbackPrimaryTurnRequest(request, turn));
    if (fallbackPrimary) {
      primaryRequests = [fallbackPrimary];
      fallbackPrimaryId = fallbackPrimary.id;
    }
  }
  const primaryIds = new Set(primaryRequests.map((request) => request.id));
  const responseRequests = requests.filter((request) => !primaryIds.has(request.id) && !isPrimaryTurnRequest(request) && isTurnResponseRequest(request));
  const supportingRequests = requests.filter((request) => !primaryIds.has(request.id) && !isTurnResponseRequest(request));
  return `
    <section class="turn-group" id="${escapeHtml(turn.id)}" data-turn-group="${escapeHtml(turn.id)}">
      <header class="turn-header">
        <div class="turn-heading">
          <span class="turn-number">Turn ${escapeHtml(turn.index)}</span>
        </div>
      </header>
      ${
        primaryRequests.length
          ? `<div class="turn-request-list primary-requests">${primaryRequests.map((request) => renderTurnRequest(request, fallbackPrimaryId === request.id ? turn : null)).join("")}</div>`
          : ""
      }
      ${renderAgentBranchesForTurn(turn, requestMap)}
      ${responseRequests.length ? `<div class="turn-request-list response-requests">${responseRequests.map(renderTurnRequest).join("")}</div>` : ""}
      ${renderSupportingRequests(supportingRequests)}
    </section>
  `;
}

function isPrimaryTurnRequest(request) {
  if (request.source_hint?.type === "metadata") return false;
  if (request.is_subagent) return false;
  if ((request.summary?.current_tool_results?.length || 0) > 0) return false;
  return shouldShowTimelineRequestContent(request) || Boolean(request.summary?.command_message);
}

function isFallbackPrimaryTurnRequest(request, turn) {
  if (request.source_hint?.type === "metadata") return false;
  if (request.is_subagent) return false;
  if (request.source_hint?.type === "parent_spawn") return false;
  const requestUser = normalizeTurnDisplayText(request.summary?.current_user || "");
  const turnUser = normalizeTurnDisplayText(turn.user_input || turn.title || "");
  return Boolean(requestUser && turnUser && requestUser === turnUser);
}

function normalizeTurnDisplayText(value) {
  return cleanDisplayText(value).replace(/\s+/g, " ").trim();
}

function isTurnResponseRequest(request) {
  if (request.source_hint?.type === "metadata") return false;
  if (request.is_subagent) return false;
  return shouldShowTimelineAssistantResponse(request);
}

function renderSupportingRequests(requests) {
  if (!requests.length) return "";
  return `
    <details class="turn-supporting-requests">
      <summary>内部请求与回传 · ${escapeHtml(String(requests.length))} 条</summary>
      <div class="turn-request-list supporting-requests">
        ${requests.map(renderTurnRequest).join("")}
      </div>
    </details>
  `;
}

function renderAgentBranchesForTurn(turn, requestMap) {
  const trace = state.data?.agent_trace;
  const branches = (trace?.branches || []).filter((branch) => (turn.agent_branches || []).includes(branch.id));
  if (!branches.length) return "";
  const sortedBranches = [...branches].sort((left, right) => Number(left.first_request_index || 0) - Number(right.first_request_index || 0));
  const spawnIndexes = [...new Set(branches.map((branch) => branch.spawn?.parent_request_index).filter(Boolean))];
  const returnIndexes = [...new Set(branches.map((branch) => branch.return?.parent_request_index).filter(Boolean))];
  return `
    <section class="agent-branch-map" aria-label="多 Agent 分支">
      <div class="agent-branch-head">
        <div>
          <p class="block-title">multi-agent · ${escapeHtml(String(branches.length))}</p>
          <p>${escapeHtml(agentTraceSummary(trace, branches))}</p>
        </div>
        <div class="agent-branch-head-meta">
          ${spawnIndexes.length ? `<span>spawn #${escapeHtml(spawnIndexes.join(", #"))}</span>` : ""}
          ${returnIndexes.length ? `<span>return #${escapeHtml(returnIndexes.join(", #"))}</span>` : ""}
          <span>${escapeHtml(branchConfidenceLabel(trace?.confidence))}</span>
        </div>
      </div>
      <div class="agent-flow-map">
        ${sortedBranches.map((branch, index) => renderAgentMapCard(branch, index)).join("")}
      </div>
      ${renderAgentEventStrip(sortedBranches)}
      <div class="agent-branch-details" aria-label="子 Agent 详情">
        <p class="block-title">子 Agent 详情</p>
        <div class="agent-branch-grid">
          ${sortedBranches.map((branch, index) => renderAgentBranch(branch, index, requestMap)).join("")}
        </div>
      </div>
    </section>
  `;
}

function agentTraceSummary(trace, branches) {
  const returned = branches.filter((branch) => branch.status === "returned").length;
  const requestCount = branches.reduce((sum, branch) => sum + (branch.request_ids?.length || 0), 0);
  const toolCalls = branches.reduce((sum, branch) => sum + (branch.response_tool_call_count || 0), 0);
  const toolResults = branches.reduce((sum, branch) => sum + (branch.request_tool_result_count || 0), 0);
  const signal = trace?.signals?.child_instance || "agent id";
  return `${requestCount} 个子请求按 ${signal} 分成 ${branches.length} 条实例链；${returned} 条已回流主 Agent；工具 ${toolCalls}/${toolResults}。`;
}

function renderAgentBranch(branch, index, requestMap) {
  const firstRequest = requestMap.get(branch.request_ids?.[0]);
  const title = branch.label || branch.agent_type || `子 Agent ${index + 1}`;
  const collapsed = state.collapsedAgentBranches.has(branch.id);
  const summary = agentBranchCompactSummary(branch);
  const agentLabel = `子agent${index + 1}`;
  return `
    <article class="agent-branch-card ${collapsed ? "collapsed" : ""}" data-branch="${escapeHtml(branch.id)}">
      <button class="agent-branch-toggle" type="button" data-agent-branch-toggle="${escapeHtml(branch.id)}" aria-expanded="${escapeHtml(String(!collapsed))}">
        <span class="agent-branch-index">${escapeHtml(`${index + 1}${collapsed ? " ▸" : " ▾"}`)}</span>
        <div>
          <strong>${escapeHtml(agentLabel)} · ${escapeHtml(title)}</strong>
          <p>${escapeHtml(branch.agent_type || requestDisplayTitle(firstRequest || {}))} · ${escapeHtml(shortId(branch.agent_id))}</p>
          <p class="agent-branch-compact">${escapeHtml(summary)}</p>
        </div>
        <span class="agent-branch-status ${escapeHtml(branch.status || "unknown")}">${escapeHtml(branchStatusLabel(branch.status))}</span>
      </button>
      <div class="agent-branch-body">
        ${branch.spawn ? renderBranchEdge("父级调用", branch.spawn.parent_request_id, `#${branch.spawn.parent_request_index} · ${branch.spawn.label || branch.spawn.id}`) : ""}
        <div class="agent-branch-steps">
          ${(branch.steps || []).map((step) => renderAgentBranchStep(step)).join("")}
        </div>
        ${branch.return ? renderBranchEdge("结果回流", branch.return.parent_request_id, `#${branch.return.parent_request_index} · ${shortPreview(branch.return.result_preview, 90)}`) : ""}
        <p class="agent-branch-note">${escapeHtml(branch.linkage_note || "")}</p>
      </div>
    </article>
  `;
}

function renderAgentMapCard(branch, index) {
  const title = branch.label || branch.agent_type || `子 Agent ${index + 1}`;
  const indexes = [
    branch.spawn?.parent_request_index ? `#${branch.spawn.parent_request_index}` : "",
    ...(branch.request_indexes || []).slice(0, 4).map((requestIndex) => `#${requestIndex}`),
    branch.return?.parent_request_index ? `#${branch.return.parent_request_index}` : "",
  ].filter(Boolean);
  const overflow = Math.max(0, (branch.request_indexes?.length || 0) - 4);
  return `
    <button class="agent-map-card ${escapeHtml(branch.status || "unknown")}" type="button" data-agent-branch-jump="${escapeHtml(branch.id)}" title="${escapeHtml(branch.linkage_note || "跳到这个子 Agent 的详情。")}">
      <span class="agent-map-topline">
        <span class="agent-map-dot" aria-hidden="true"></span>
        <strong>子agent${escapeHtml(String(index + 1))}</strong>
        <em>${escapeHtml(branchStatusLabel(branch.status))}</em>
      </span>
      <span class="agent-map-title">${escapeHtml(shortPreview(title, 44))}</span>
      <span class="agent-map-indexes">${escapeHtml(indexes.join(" → ") || "未记录请求")}${overflow ? ` <span>+${escapeHtml(String(overflow))}</span>` : ""}</span>
    </button>
  `;
}

function agentBranchCompactSummary(branch) {
  const requestCount = branch.request_ids?.length || 0;
  const toolUse = branch.response_tool_call_count || 0;
  const toolResult = branch.request_tool_result_count || 0;
  const edges = [branch.spawn ? `spawn #${branch.spawn.parent_request_index}` : "", branch.return ? `return #${branch.return.parent_request_index}` : ""].filter(Boolean).join(" · ");
  return [`${requestCount} 个请求`, toolUse || toolResult ? `工具 ${toolUse}/${toolResult}` : "", edges].filter(Boolean).join(" · ");
}

function renderAgentEventStrip(branches) {
  const events = agentFlowEvents(branches);
  if (!events.length) return "";
  return `
    <div class="agent-event-strip" aria-label="子 Agent 事件顺序">
      <span class="agent-event-label">事件顺序</span>
      <div class="agent-event-list">
        ${events.map(renderAgentEvent).join("")}
      </div>
    </div>
  `;
}

function agentFlowEvents(branches) {
  const events = [];
  for (const [index, branch] of branches.entries()) {
    const agentLabel = `子${index + 1}`;
    if (branch.spawn?.parent_request_index) {
      events.push({
        order: events.length,
        request_id: branch.spawn.parent_request_id,
        request_index: branch.spawn.parent_request_index,
        label: `${agentLabel} spawn`,
      });
    }
    for (const step of branch.steps || []) {
      events.push({
        order: events.length,
        request_id: step.request_id,
        request_index: step.request_index,
        label: `${agentLabel} ${agentStepEventLabel(step)}`,
      });
    }
    if (branch.return?.parent_request_index) {
      events.push({
        order: events.length,
        request_id: branch.return.parent_request_id,
        request_index: branch.return.parent_request_index,
        label: `${agentLabel} return`,
      });
    }
  }
  return events.sort((left, right) => Number(left.request_index || 0) - Number(right.request_index || 0) || left.order - right.order);
}

function agentStepEventLabel(step) {
  if (step.request_tool_results?.length) return "tool_result";
  if (step.response_tool_calls?.length) return "tool_use";
  if (step.finish_reason === "end_turn") return "done";
  return "request";
}

function renderAgentEvent(event) {
  return `
    <button class="agent-event" type="button" data-agent-jump="${escapeHtml(event.request_id || "")}">
      <strong>#${escapeHtml(event.request_index || "")}</strong>
      <span>${escapeHtml(event.label)}</span>
    </button>
  `;
}

function renderBranchEdge(label, requestId, text) {
  return `
    <button class="branch-edge" type="button" data-agent-jump="${escapeHtml(requestId || "")}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(text || "未记录")}</strong>
    </button>
  `;
}

function renderAgentBranchStep(step) {
  const responseCalls = step.response_tool_calls || [];
  const requestResults = step.request_tool_results || [];
  const title = responseCalls.length ? `请求工具 ${responseCalls.map((call) => call.name).join(", ")}` : step.finish_reason === "end_turn" ? "子 Agent 回复" : "模型请求";
  return `
    <button class="agent-branch-step" type="button" data-agent-jump="${escapeHtml(step.request_id)}">
      <span class="step-request">#${escapeHtml(step.request_index)}</span>
      <span class="step-body">
        <strong>${escapeHtml(title)}</strong>
        <em>${escapeHtml([step.response_id ? `response ${shortId(step.response_id)}` : "", step.finish_reason ? `finish ${step.finish_reason}` : ""].filter(Boolean).join(" · "))}</em>
        ${responseCalls.length ? `<small>tool_use ${escapeHtml(responseCalls.map((call) => `${call.name}${call.id ? `:${shortId(call.id)}` : ""}`).join(", "))}</small>` : ""}
        ${requestResults.length ? `<small>tool_result ${escapeHtml(requestResults.map((result) => shortId(result.id)).join(", "))}</small>` : ""}
        ${step.response_preview ? `<small>${escapeHtml(shortPreview(step.response_preview, 110))}</small>` : ""}
      </span>
    </button>
  `;
}

function branchStatusLabel(status) {
  if (status === "returned") return "已回流";
  if (status === "completed") return "已完成";
  if (status === "running") return "运行中";
  return "未知";
}

function branchConfidenceLabel(confidence) {
  if (confidence === "high") return "高置信";
  if (confidence === "medium") return "中置信";
  if (confidence === "none") return "无分支";
  return confidence || "未评估";
}

function renderProviderUsageStats(request) {
  return renderRequestAgentBranchStat(request);
}

function renderRequestAgentBranchStat(request) {
  const branch = request.trace?.agent_branch;
  const agentId = branch?.agent_id || request.trace?.claude_agent_id || null;
  if (!agentId && !request.is_subagent) return "";
  const label = branch?.index ? `子agent${branch.index}` : "子agent";
  const titleParts = [
    branch?.label ? `分支：${branch.label}` : "",
    branch?.agent_type ? `类型：${branch.agent_type}` : "",
    agentId ? `x-claude-code-agent-id：${agentId}` : "",
    branch?.status ? `状态：${branchStatusLabel(branch.status)}` : "",
  ].filter(Boolean);
  const text = escapeHtml(label);
  const title = escapeHtml(titleParts.join("；") || "这条请求来自 Claude Code 子 Agent。");
  if (branch?.id) {
    return `<button class="stat-chip subagent jumpable" type="button" data-agent-branch-jump="${escapeHtml(branch.id)}" title="${title} 点击跳到对应的 Agent 分支。">${text}</button>`;
  }
  return `<span class="stat-chip subagent" title="${title}">${text}</span>`;
}

function aggregateProviderUsage(requests) {
  return requests.reduce(
    (stats, request) => {
      const usage = request.summary?.response?.usage || {};
      const hasPromptTokens = usage.prompt_tokens != null;
      const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
      const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
      const cache = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0);
      stats.input += input;
      stats.output += output;
      stats.cache += cache;
      stats.actual_input += Math.max(0, hasPromptTokens ? input - cache : input);
      stats.total += hasPromptTokens ? input : input + cache;
      if (hasPromptTokens) {
        stats.input_title = "OpenAI-compatible usage.prompt_tokens 聚合值。cached_tokens 是其中的子集。";
        stats.cache_title = "OpenAI-compatible usage.prompt_tokens_details.cached_tokens 聚合值。";
      }
      return stats;
    },
    {
      input: 0,
      output: 0,
      cache: 0,
      actual_input: 0,
      total: 0,
      input_title: "模型厂商 usage.input_tokens 聚合值。",
      cache_title: "模型厂商 usage.cache_read_input_tokens 聚合值。",
    },
  );
}

function renderUpstreamEntry(request) {
  const expanded = state.upstreamExpanded.has(request.id);
  const showInlineContent = shouldShowTimelineRequestContent(request);
  const meta = renderProviderUsageStats(request);
  return `
    <section class="upstream-entry ${escapeHtml(upstreamKindClass(request))} ${showInlineContent ? "" : "compact"}">
      <div class="upstream-entry-row">
        <div class="upstream-entry-title">
          <span class="request-index">#${escapeHtml(request.request_index)}</span>
          <span class="upstream-label">${escapeHtml(upstreamEntryLabel(request))}</span>
        </div>
        ${meta ? `<div class="upstream-entry-meta" aria-label="请求归属">${meta}</div>` : ""}
        <div class="upstream-entry-actions">
          ${renderUpstreamQuickActions(request, expanded)}
        </div>
      </div>
      ${showInlineContent ? `<div class="upstream-entry-preview">${escapeHtml(upstreamEntryPreview(request))}</div>` : ""}
    </section>
  `;
}

function renderUpstreamQuickActions(request, expanded) {
  const hasToolCalls = (request.summary?.current_tool_calls || []).length > 0;
  const hasToolResults = (request.summary?.current_tool_results || []).length > 0;
  const rawSections = [
    ["system", "System"],
    ["tools", "Tools"],
    ...(hasToolCalls ? [["tool_calls", "Tool calls"]] : []),
    ...(hasToolResults ? [["tool_results", "Tool results"]] : []),
    ["response", "Response"],
  ];
  return `
    <button class="inspect-button upstream-toggle-button" type="button" data-upstream-toggle="${escapeHtml(request.id)}" aria-expanded="${expanded ? "true" : "false"}">
      <span class="toggle-label">${expanded ? "折叠上行" : "展开上行"}</span>
    </button>
    ${rawSections
      .map(
        ([section, label]) => `
          <button class="raw-section-button" type="button" data-raw="${escapeHtml(request.id)}" data-raw-section="${escapeHtml(section)}">${escapeHtml(label)}</button>
        `,
      )
      .join("")}
    <button class="raw-button compact" type="button" data-raw="${escapeHtml(request.id)}">Raw</button>
  `;
}

function shouldShowTimelineRequestContent(request) {
  if (request.source_hint?.type === "metadata") return false;
  if (request.summary?.command_message) return false;
  if (request.is_subagent) return false;
  if (request.source_hint?.type === "parent_spawn") return false;
  if ((request.summary?.current_tool_results?.length || 0) > 0) return false;
  if ((request.summary?.current_tool_calls?.length || 0) > 0) return false;
  return Boolean(cleanDisplayText(request.summary?.current_user || ""));
}

function renderUpstreamBadges(request) {
  return [
    renderConfidenceBadge(request.confidence),
    request.is_subagent ? '<span class="badge subagent">子代理</span>' : "",
    request.source_hint.type === "parent_spawn" ? '<span class="badge subagent">启动子代理</span>' : "",
    request.summary?.command_message ? `<span class="badge command" title="Claude Code slash command 展开后的命令消息。">${escapeHtml(commandMessageLabel(request.summary.command_message))}</span>` : "",
    request.redaction_count ? `<span class="badge risk" title="已隐藏 ${escapeHtml(String(request.redaction_count))} 个敏感 header 字段，例如 authorization、cookie 或 token。">已脱敏 ${escapeHtml(String(request.redaction_count))}</span>` : "",
    ...renderChangeBadges(request),
  ]
    .filter(Boolean)
    .join("");
}

function renderUpstreamDetailMeta(request) {
  const badges = renderUpstreamBadges(request);
  if (!badges) return "";
  return `
    <section class="upstream-detail-meta">
      <p class="block-title">捕获与变化</p>
      <div class="upstream-detail-badges">${badges}</div>
    </section>
  `;
}

function upstreamKindClass(request) {
  if (request.source_hint?.type === "metadata") return "metadata";
  if (request.summary?.command_message) return "command-message";
  if ((request.summary?.current_tool_results?.length || 0) > 0) return "tool-result";
  if ((request.summary?.current_tool_calls?.length || 0) > 0) return "tool-use";
  return "user";
}

function upstreamEntryLabel(request) {
  if (request.source_hint?.type === "metadata") return requestDisplayTitle(request);
  if (request.summary?.command_message) return commandMessageLabel(request.summary.command_message);
  if ((request.summary?.current_tool_results?.length || 0) > 0) return "Tool result 回传";
  if ((request.summary?.current_tool_calls?.length || 0) > 0) return "Tool use 上行";
  if (request.is_subagent) return "Subagent input";
  return "User input";
}

function upstreamEntryPreview(request) {
  if (request.source_hint?.type === "metadata") {
    const frameworkReminder = [...(request.summary?.history_stack || [])].reverse().find((item) => item.kind === "framework_reminder");
    return shortPreview(request.summary.internal_request_preview || frameworkReminder?.text || requestDisplayTitle(request), 260);
  }
  if (request.summary?.command_message) return commandMessagePreview(request.summary.command_message);
  const toolResults = request.summary?.current_tool_results || [];
  if (toolResults.length) {
    return `Result 回传 · ${toolResults.length} 个工具结果`;
  }
  const toolCalls = request.summary?.current_tool_calls || [];
  if (toolCalls.length) {
    const text = toolCalls.map((call) => `${call.name || "unknown"} ${stableJson(call.arguments ?? null)}`).join("\n");
    if (text) return shortPreview(text, 320);
  }
  return shortPreview(cleanDisplayText(request.summary.current_user || requestExcerpt(request)), 420);
}

function renderTurnRequest(request, turnInput = null) {
  return renderRequestCard(request, { turnInput });
}

function renderRequestCard(request, options = {}) {
  const toolNames = request.summary.tool_names.slice(0, 18);
  const moreTools = Math.max(0, request.summary.tool_names.length - toolNames.length);
  const showInlineContent = shouldShowTimelineRequestContent(request);
  const assistantResponse = shouldShowTimelineAssistantResponse(request) ? renderAssistantResponse(request) : "";
  const toolExchange = showInlineContent ? renderToolExchange(request) : "";
  const upstreamOpen = state.upstreamExpanded.has(request.id);
  return `
    <article class="request-card" id="${escapeHtml(request.id)}" data-card="${escapeHtml(request.id)}">
      ${options.turnInput ? renderTurnInputEntry(request, options.turnInput) : renderUpstreamEntry(request)}
      <details class="request-upstream-details request-upstream-panel" data-upstream-panel="${escapeHtml(request.id)}" ${upstreamOpen ? "open" : ""}>
        <summary class="upstream-panel-summary">上行详情 #${escapeHtml(request.request_index)}</summary>
        <div class="request-body">
          <details>
            <summary class="metric-summary">
              <span>System 摘要 · ${request.counts.system} 段</span>
              ${renderCompositionSectionStat(request, "system")}
            </summary>
            <div class="details-body">${renderPre(request.summary.system_preview || "(无 system 摘要)")}</div>
          </details>
          <details>
            <summary class="metric-summary">
              <span>Tools · ${request.counts.tools} 个</span>
              ${renderCompositionSectionStat(request, "tools")}
            </summary>
            <div class="details-body">
              <div class="tool-list">
                ${toolNames.map((name) => `<span class="tool-chip">${escapeHtml(name)}</span>`).join("")}
                ${moreTools ? `<span class="tool-chip">+${moreTools}</span>` : ""}
              </div>
            </div>
          </details>
          ${renderHistoryStack(request)}
          ${renderInternalRequestBlock(request)}
          ${renderCurrentMessageDelta(request)}
          ${renderContextComposition(request)}
        </div>
      </details>
      ${toolExchange}
      ${assistantResponse}
    </article>
  `;
}

function renderTurnInputEntry(request, turn) {
  const expanded = state.upstreamExpanded.has(request.id);
  const inputText = cleanDisplayText(turn.command_message ? commandMessagePreview(turn.command_message) : turn.user_input || turn.title || "");
  const meta = renderProviderUsageStats(request);
  return `
    <section class="upstream-entry user">
      <div class="upstream-entry-row">
        <div class="upstream-entry-title">
          <span class="request-index">#${escapeHtml(request.request_index)}</span>
          <span class="upstream-label">${escapeHtml(turn.command_message ? commandMessageLabel(turn.command_message) : "User input")}</span>
        </div>
        ${meta ? `<div class="upstream-entry-meta" aria-label="请求归属">${meta}</div>` : ""}
        <div class="upstream-entry-actions">
          ${renderUpstreamQuickActions(request, expanded)}
        </div>
      </div>
      ${inputText ? `<div class="upstream-entry-preview">${escapeHtml(inputText)}</div>` : ""}
    </section>
  `;
}

function shouldShowTimelineAssistantResponse(request) {
  if (request.source_hint?.type === "metadata") return false;
  const response = request.summary?.response;
  if (!response?.captured) return false;
  return Boolean(response.text || response.preview || response.thinking || (response.tool_calls || []).length);
}

function renderHistoryStack(request) {
  const stack = request.summary.history_stack || [];
  const roleSummary = request.summary.roles.join(" -> ");
  return `
    <details>
      <summary class="metric-summary">
        <span>History / message stack · ${escapeHtml(String(stack.length || request.counts.messages))} 条</span>
        ${renderCompositionSectionStat(request, "history_context")}
      </summary>
      <div class="details-body">
        <div class="history-stack-meta">
          <span>roles: ${escapeHtml(roleSummary || "empty")}</span>
          <span>history=${escapeHtml(String(request.counts.history))}</span>
          <span>raw=${escapeHtml(formatBytes(request.counts.raw_body_bytes))}</span>
        </div>
        ${
          stack.length
            ? `<div class="history-stack">${stack.map(renderHistoryStackItem).join("")}</div>`
            : '<div class="empty-box">没有可展示的历史消息。</div>'
        }
      </div>
    </details>
  `;
}

function renderHistoryStackItem(item) {
  const toolCalls = item.tool_calls || [];
  const toolResults = item.tool_results || [];
  if (item.kind === "framework_reminder") return renderFrameworkReminderHistoryItem(item);
  const chips = [
    `<span class="history-chip role">role: ${escapeHtml(item.role || "unknown")}</span>`,
    renderHistoryContextChip(item.context_status),
    item.is_current_user ? '<span class="history-chip current">当前用户输入</span>' : "",
    item.command_message ? `<span class="history-chip command">${escapeHtml(commandMessageLabel(item.command_message))}</span>` : "",
    ...toolCalls.map((call) => `<span class="history-chip tool">call ${escapeHtml(call.name || "unknown")}${call.id ? ` · ${escapeHtml(shortId(call.id))}` : ""}</span>`),
    ...toolResults.map((result) => `<span class="history-chip result">result${result.id ? ` · ${escapeHtml(shortId(result.id))}` : ""}</span>`),
  ].join("");
  return `
    <article class="history-stack-item ${escapeHtml(item.kind || "message")} role-${escapeHtml(item.role || "unknown")}">
      <header>
        <span class="history-index">#${escapeHtml(String(item.index || ""))}</span>
        <strong>${escapeHtml(item.label || messageKindLabel(item.kind, item.role))}</strong>
        <div class="history-chips">${chips}</div>
      </header>
      ${item.text ? `<p>${escapeHtml(item.text)}</p>` : '<p class="muted">没有文本内容。</p>'}
      ${toolCalls.length ? `<div class="history-tool-detail">${toolCalls.map((call) => renderPre(`参数 ${call.name || "unknown"}${call.id ? ` (${call.id})` : ""}\n${call.arguments_preview || "(empty)"}`)).join("")}</div>` : ""}
      ${toolResults.length ? `<div class="history-tool-detail">${toolResults.map((result) => renderPre(`结果${result.id ? ` (${result.id})` : ""}\n${result.content || "(empty)"}`)).join("")}</div>` : ""}
    </article>
  `;
}

function renderHistoryContextChip(status) {
  if (status === "reused") return '<span class="history-chip reused">历史重放</span>';
  if (status === "new") return '<span class="history-chip new">本次新增</span>';
  if (status === "baseline") return '<span class="history-chip baseline">基线</span>';
  return "";
}

function renderFrameworkReminderHistoryItem(item) {
  return `
    <article class="history-stack-item framework_reminder role-${escapeHtml(item.role || "unknown")}">
      <details>
        <summary>
          <span class="history-index">#${escapeHtml(String(item.index || ""))}</span>
          <strong>${escapeHtml(item.label || "框架提醒")}</strong>
          <span class="history-chip framework">Claude Code 自动补充</span>
          ${item.char_count ? `<span class="history-chip">${escapeHtml(formatCharCount(item.char_count))}</span>` : ""}
        </summary>
        <div class="history-framework-body">
          ${renderPre(item.full_text || item.text || "(empty)")}
        </div>
      </details>
    </article>
  `;
}

function renderContextDelta(request) {
  const delta = request.context_delta;
  if (!delta) return "";
  const fixed = delta.fixed_context || {};
  const fixedParts = [
    ["System", fixed.system],
    ["Tools", fixed.tools],
    ["Params", fixed.params],
  ];
  const roleText = formatRoleCounts(delta.new_roles || {});
  const reuseText = delta.baseline
    ? `基线请求 · ${delta.total_messages || request.counts.messages} 条上下文消息`
    : `复用 ${delta.reused_messages || 0}/${delta.total_messages || 0} 条消息 · 新增 ${delta.new_messages || 0} 条`;
  return `
    <section class="summary-block context-delta-block">
      <p class="block-title">上下文复用</p>
      <div class="context-delta-grid">
        <span><strong>${escapeHtml(reuseText)}</strong></span>
        <span>${fixedParts.map(([label, status]) => `${label}: ${contextStatusLabel(status)}`).join(" · ")}</span>
        <span>${escapeHtml(roleText || "无新增角色")}</span>
      </div>
      ${renderMessageDeltaDetails(delta)}
    </section>
  `;
}

function renderMessageDeltaDetails(delta) {
  const previews = delta.previews || [];
  if (!previews.length) return "";
  return `
    <details class="message-delta-details">
      <summary>新增消息明细 · ${escapeHtml(String(delta.new_messages || previews.length))} 条</summary>
      <div class="message-delta-list">
        ${previews
          .map(
            (item) => `
              <article class="message-delta-item">
                <span>${escapeHtml(messageKindLabel(item.kind, item.role))}</span>
                <p>${escapeHtml(item.text || "(empty)")}</p>
              </article>
            `,
          )
          .join("")}
      </div>
    </details>
  `;
}

function renderCurrentMessageDelta(request) {
  const delta = request.context_delta || {};
  const previews = delta.previews || [];
  if (!previews.length) return "";
  return `
    <section class="summary-block message-delta-block">
      <div class="block-title-row">
        <p class="block-title">本轮新增消息</p>
        <span class="block-title-meta">
          ${renderCompositionSectionStat(request, "current_user", "当前用户")}
          <span class="message-delta-count">${escapeHtml(String(delta.new_messages || previews.length))} 条</span>
        </span>
      </div>
      <div class="message-delta-list">
        ${previews
          .map(
            (item) => `
              <article class="message-delta-item">
                <span>${escapeHtml(messageKindLabel(item.kind, item.role))}</span>
                <p>${escapeHtml(item.text || "(empty)")}</p>
              </article>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderContextComposition(request) {
  const composition = request.summary?.composition;
  if (!composition?.total_payload_chars) return "";
  const usage = aggregateProviderUsage([request]);
  const actualRatio = usage.total ? usage.actual_input / usage.total : 0;
  const cacheRatio = usage.total ? usage.cache / usage.total : 0;
  const tokenStats = [
    usage.input ? ["input", formatCompactNumber(usage.input), "模型厂商输入 token。"] : null,
    usage.cache ? ["cache", `${formatCompactNumber(usage.cache)} · ${formatPercent(cacheRatio)}`, "缓存命中 token 及比例。"] : null,
    usage.cache ? ["actual", formatPercent(actualRatio), "非 cache read 的输入 token 占比。"] : null,
    usage.output ? ["output", formatCompactNumber(usage.output), "模型厂商输出 token。"] : null,
  ].filter(Boolean);
  return `
    <section class="summary-block composition-block">
      <div class="block-title-row">
        <div class="composition-heading">
          <p class="block-title">厂商 token 统计</p>
          ${tokenStats.map(([label, value, title]) => renderCompositionMetric(label, value, title)).join("")}
        </div>
        <span class="composition-total">实际上行 ${escapeHtml(formatCharCount(composition.total_payload_chars))}</span>
      </div>
    </section>
  `;
}

function renderCompositionSectionStat(request, key, label) {
  const item = request.summary?.composition?.sections?.[key];
  if (!item || !item.chars) return "";
  return `
    <span class="composition-metric ${escapeHtml(compositionSectionClass(key))}">
      ${label ? `<em>${escapeHtml(label)}</em>` : ""}
      <strong>${escapeHtml(formatPercent(item.ratio))}</strong>
      <small>${escapeHtml(formatCharCount(item.chars))}</small>
    </span>
  `;
}

function compositionSectionClass(key) {
  if (key === "current_user") return "user";
  if (key === "history_context") return "history";
  if (key === "tool_result") return "tool";
  return key || "params";
}

function renderCompositionMetric(label, value, title) {
  return `
    <span class="composition-token" title="${escapeHtml(title || "")}">
      <em>${escapeHtml(label)}</em>
      <strong>${escapeHtml(value)}</strong>
    </span>
  `;
}

function formatRoleCounts(counts) {
  return Object.entries(counts)
    .filter(([, count]) => Number(count) > 0)
    .map(([role, count]) => `${messageKindLabel(role, role)} ${count}`)
    .join(" · ");
}

function contextStatusLabel(status) {
  if (status === "reused") return "复用";
  if (status === "changed") return "变化";
  if (status === "baseline") return "基线";
  return "未知";
}

function messageKindLabel(kind, role) {
  if (kind === "framework_reminder") return "框架提醒";
  if (kind === "agent_internal") return "Agent 内部";
  if (kind === "tool_result") return "Tool result";
  if (kind === "tool_use") return "Tool use";
  if (kind === "assistant") return "Assistant";
  if (kind === "user") return "User";
  if (kind === "system") return "System";
  return role || kind || "Message";
}

function renderInternalRequestBlock(request) {
  if (request.source_hint.type !== "metadata" || !request.summary.internal_request_preview) return "";
  return `
    <details class="internal-request">
      <summary>Agent 内部请求 · ${escapeHtml(shortPreview(request.summary.internal_request_preview, 72))}</summary>
      <div class="details-body">${renderPre(request.summary.internal_request_preview)}</div>
    </details>
  `;
}

function shortPreview(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function markdownPreview(value, limit) {
  const text = cleanDisplayText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}...`;
}

function renderChangeBadges(request) {
  if (request.request_index === 1) return ['<span class="badge muted" title="这条请求是本会话中用于对比后续变化的第一条请求。">基线请求</span>'];
  const badges = [];
  if (request.changes.system_changed) {
    badges.push(
      `<button class="badge changed badge-button" type="button" data-system-diff="${escapeHtml(request.id)}" title="查看本次 system prompt 相对上一条请求的差异。">系统变化</button>`,
    );
  }
  if (request.changes.tools_changed) badges.push('<span class="badge changed" title="本次请求里的工具 schema 或工具列表与上一条请求不同。">工具变化</span>');
  if (request.changes.params_changed) badges.push('<span class="badge muted" title="模型参数或请求参数发生变化，例如 model、temperature、stream、beta 等。">参数变化</span>');
  return badges;
}

function renderStructureStrip(request) {
  const currentToolCalls = request.summary.current_tool_calls?.length ?? request.counts.tool_calls;
  const currentToolResults = request.summary.current_tool_results?.length ?? request.counts.tool_results;
  const cells = [
    ["Messages", request.counts.messages, signedDelta(request.changes.messages_delta), "messages"],
    ["System", request.counts.system, request.changes.system_changed ? "changed" : "", "system"],
    ["Tools", request.counts.tools, signedDelta(request.changes.tools_delta), "tools"],
    ["Tool calls", currentToolCalls, currentToolCalls === request.counts.tool_calls ? "" : `累计 ${request.counts.tool_calls}`, "tool_calls"],
    ["Tool results", currentToolResults, currentToolResults === request.counts.tool_results ? "" : `累计 ${request.counts.tool_results}`, "tool_results"],
    ["Response", request.summary.response?.captured ? formatBytes(request.counts.response_body_bytes || 0) : "未捕获", "", "response"],
    ["Raw", formatBytes(request.counts.raw_body_bytes), signedBytes(request.changes.raw_bytes_delta), "full"],
  ];
  return `
    <section class="structure-strip" aria-label="上行请求结构摘要">
      ${cells
        .map(
          ([label, value, delta, section]) => `
            <button class="structure-cell" type="button" data-raw="${escapeHtml(request.id)}" data-raw-section="${escapeHtml(section)}" title="在右侧查看 ${escapeHtml(label)} Raw">
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(value)}</strong>
              ${delta ? `<em>${escapeHtml(delta)}</em>` : ""}
              <small class="structure-raw-chip">Raw</small>
            </button>
          `,
        )
        .join("")}
    </section>
  `;
}

function renderToolExchange(request) {
  const calls = request.summary.current_tool_calls || [];
  const results = request.summary.current_tool_results || [];
  if (!calls.length && !results.length) return "";
  const pairs = pairToolEvents(calls, results);
  return `
    <section class="summary-block">
      <p class="block-title">本轮 Tool use / result · ${calls.length} / ${results.length}</p>
      <div class="tool-exchange-list">
        ${pairs
          .map((pair) => renderToolExchangeItem(pair))
          .join("")}
      </div>
    </section>
  `;
}

function renderAssistantResponse(request) {
  const response = request.summary.response;
  if (!response?.captured) return "";
  const responseText = response.text || response.preview || "";
  const longResponse = cleanDisplayText(responseText).length > 200;
  const expanded = state.responseExpanded.has(request.id);
  const visibleText = longResponse && !expanded ? markdownPreview(responseText, 200) : responseText;
  const meta = [
    response.status ? `HTTP ${response.status}` : "",
    response.latency_ms != null ? `${response.latency_ms}ms` : "",
    response.finish_reason ? `finish: ${response.finish_reason}` : "",
    response.stream ? `stream ${response.event_count || 0} events` : "json",
    response.truncated ? "已截断" : "",
    ...formatResponseUsageMeta(response.usage),
  ].filter(Boolean);
  return `
    <section class="summary-block assistant-response-block ${expanded ? "expanded" : ""}">
      <div class="block-title-row">
        <div class="response-heading">
          <p class="block-title">Assistant 回复</p>
          <div class="response-meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
        </div>
        <div class="response-actions">
          ${
            longResponse
              ? `<button class="mini-raw-button response-toggle-button" type="button" data-response-toggle="${escapeHtml(request.id)}">${expanded ? "收起" : "查看全部"}</button>`
              : ""
          }
          <button class="mini-raw-button" type="button" data-raw="${escapeHtml(request.id)}" data-raw-section="response">Raw</button>
        </div>
      </div>
      ${renderAssistantThinking(response, request)}
      ${renderAssistantToolCalls(response.tool_calls || [])}
      ${
        visibleText
          ? `<div class="text-box assistant-response-text assistant-response-markdown ${longResponse && !expanded ? "collapsed" : ""}">${renderSafeMarkdown(visibleText)}</div>`
          : (response.tool_calls || []).length
            ? ""
            : '<div class="empty-box">已捕获响应，但没有解析出文本回复。</div>'
      }
      ${longResponse ? `<p class="response-hint">${expanded ? "已展开，内容区内部滚动；点击收起回到摘要。" : "仅显示前200字，点击查看全部后展开。"}</p>` : ""}
    </section>
  `;
}

function renderAssistantToolCalls(toolCalls) {
  if (!toolCalls.length) return "";
  return `
    <section class="assistant-tool-calls">
      <p class="block-title">Assistant 发起工具调用 · ${escapeHtml(String(toolCalls.length))}</p>
      <div class="assistant-tool-list">
        ${toolCalls.map((call) => renderPre(`工具 ${call.name || "unknown"}${call.id ? ` (${call.id})` : ""}\n${stableJson(call.arguments ?? null)}`)).join("")}
      </div>
    </section>
  `;
}

function renderAssistantThinking(response, request) {
  const thinking = response?.thinking || "";
  if (!thinking) return "";
  const preview = response.thinking_preview || shortPreview(thinking, 120);
  const translation = translatedTextFor("assistant_thinking", thinking);
  const actionId = registerTranslationAction({
    kind: "assistant_thinking",
    sourceText: thinking,
    section: "response",
    requestId: request.id,
    surface: "timeline",
    metadata: { source: "response.thinking" },
  });
  return `
    <details class="assistant-thinking">
      <summary>
        <span>Thinking</span>
        <em>${escapeHtml(formatCharCount(thinking.length))}</em>
        <small>${escapeHtml(preview)}</small>
      </summary>
      <div class="details-body">
        <div class="thinking-translation-toolbar">
          <button type="button" class="translation-inline-button" data-translation-retranslate="${escapeHtml(actionId)}" ${state.translationGenerate.loading ? "disabled" : ""}>${translation ? "重译 Thinking" : "翻译 Thinking"}</button>
        </div>
        ${translation ? `<div class="thinking-translation">${renderMarkdownPreview(translation)}</div>` : ""}
        ${renderPre(thinking)}
      </div>
    </details>
  `;
}

function formatResponseUsageMeta(usage) {
  if (!usage || typeof usage !== "object") return [];
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  const cache = usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  const total = usage.total_tokens;
  const items = [
    input != null ? `input ${formatCompactNumber(Number(input))}` : "",
    cache != null ? `cache ${formatCompactNumber(Number(cache))}` : "",
    output != null ? `output ${formatCompactNumber(Number(output))}` : "",
    total != null ? `total ${formatCompactNumber(Number(total))}` : "",
  ].filter(Boolean);
  if (items.length) return items;
  return Object.entries(usage)
    .filter(([, value]) => value != null && typeof value !== "object")
    .slice(0, 4)
    .map(([key, value]) => `${key} ${String(value)}`);
}

function pairToolEvents(calls, results) {
  const remainingResults = [...results];
  const pairs = calls.map((call) => {
    const matchIndex = remainingResults.findIndex((result) => result.id && call.id && result.id === call.id);
    const result = matchIndex >= 0 ? remainingResults.splice(matchIndex, 1)[0] : null;
    return { call, result, confidence: result ? "id" : "call_only" };
  });
  for (const result of remainingResults) pairs.push({ call: null, result, confidence: "result_only" });
  return pairs;
}

function renderToolExchangeItem({ call, result, confidence }) {
  const title = call?.name || result?.id || "tool_result";
  const confidenceLabel = confidence === "id" ? "已按 id 配对" : confidence === "call_only" ? "等待结果或未捕获" : "未配对结果";
  return `
    <article class="tool-exchange">
      <header>
        <span class="tool-exchange-kind">${call ? "Tool use" : "Tool result"}</span>
        <strong>${escapeHtml(title)}</strong>
        ${call?.id || result?.id ? `<code>${escapeHtml(call?.id || result?.id)}</code>` : ""}
        <em>${escapeHtml(confidenceLabel)}</em>
      </header>
      ${
        call
          ? `<div class="tool-event tool-use">
              <p>参数</p>
              ${renderPre(JSON.stringify(call.arguments, null, 2))}
            </div>`
          : ""
      }
      ${
        result
          ? `<div class="tool-event tool-result">
              <p>结果</p>
              ${renderPre(result.content || "(empty)")}
            </div>`
          : '<div class="tool-event empty-tool-result">本次捕获中还没有匹配到工具结果。</div>'
      }
    </article>
  `;
}

function rawMessagesForToolCalls(messages) {
  return messages.filter((message) => {
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) return true;
    const parts = Array.isArray(message.content) ? message.content : [];
    return parts.some((part) => part?.type === "tool_use");
  });
}

function rawMessagesForToolResults(messages) {
  return messages.filter((message) => {
    if (message.role === "tool") return true;
    const parts = Array.isArray(message.content) ? message.content : [];
    return parts.some((part) => part?.type === "tool_result");
  });
}

function renderRawSectionNav(request, activeSection) {
  const sections = [
    ["full", "完整"],
    ["system", "System"],
    ...(previousRequest(request) ? [["system_diff", "System diff"]] : []),
    ["tools", "Tools"],
    ["messages", "Messages"],
    ["tool_calls", "Tool calls"],
    ["tool_results", "Tool results"],
    ["response", "Response"],
    ["metadata", "Metadata"],
  ];
  return `
    <div class="raw-section-nav">
      ${sections
        .map(
          ([section, label]) => `
            <button class="${section === activeSection ? "active" : ""}" type="button" data-raw="${escapeHtml(request.id)}" data-raw-section="${escapeHtml(section)}">
              ${escapeHtml(label)}
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

function rawSectionData(request, section) {
  const body = request.raw?.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (section === "system") {
    return {
      title: "system",
      value: {
        body_system: body.system ?? null,
        message_system: messages.filter((message) => message.role === "system"),
      },
    };
  }
  if (section === "tools") return { title: "tools", value: body.tools ?? null };
  if (section === "messages") return { title: "messages / history", value: messages };
  if (section === "tool_calls") {
    const labels = RAW_BUCKET_LABELS_ZH.tool_calls;
    return {
      title: "tool calls",
      value: {
        [labels.current]: request.summary.current_tool_calls || [],
        [labels.cumulative]: request.summary.tool_calls,
        raw_messages: rawMessagesForToolCalls(messages),
      },
    };
  }
  if (section === "tool_results") {
    const labels = RAW_BUCKET_LABELS_ZH.tool_results;
    return {
      title: "tool results",
      value: {
        [labels.current]: request.summary.current_tool_results || [],
        [labels.cumulative]: request.summary.tool_results,
        raw_messages: rawMessagesForToolResults(messages),
      },
    };
  }
  if (section === "response") {
    return {
      title: "upstream response",
      value: {
        summary: request.summary.response,
        raw: request.raw?.response || null,
      },
    };
  }
  if (section === "metadata") {
    return {
      title: "headers / metadata",
      value: {
        headers: request.raw?.headers,
        header_redactions: request.raw?.header_redactions,
        capture_id: request.raw?.capture_id,
        watch_id: request.raw?.watch_id,
        conversation_id: request.raw?.conversation_id,
        workspace: request.raw?.workspace,
        path: request.raw?.path,
        upstream_status: request.raw?.upstream_status,
        context_delta: request.context_delta,
        composition: request.summary.composition,
        response: request.summary.response,
      },
    };
  }
  return { title: "完整捕获", value: request.raw };
}

function renderRawDetail(title, value) {
  return `
    <details open>
      <summary>${escapeHtml(title)}</summary>
      <div class="json-node">${renderJson(value)}</div>
    </details>
  `;
}

function renderPre(text) {
  return `<pre>${escapeHtml(text)}</pre>`;
}

function bindRequestEvents() {
  document.querySelectorAll("[data-latest-only]").forEach((button) => {
    button.addEventListener("click", toggleLatestOnly);
  });
  document.querySelectorAll("[data-response-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleResponseExpansion(button.dataset.responseToggle);
    });
  });
  document.querySelectorAll("[data-upstream-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleUpstreamDetails(button.dataset.upstreamToggle);
    });
  });
  document.querySelectorAll("[data-raw]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showRaw(button.dataset.raw, button.dataset.rawSection || "full");
    });
  });
  document.querySelectorAll("[data-agent-jump]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      jumpToRequest(button.dataset.agentJump);
    });
  });
  document.querySelectorAll("[data-agent-branch-jump]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      jumpToAgentBranch(button.dataset.agentBranchJump);
    });
  });
  document.querySelectorAll("[data-agent-branch-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleAgentBranch(button.dataset.agentBranchToggle);
    });
  });
  document.querySelectorAll("[data-system-diff]").forEach((button) => {
    button.addEventListener("click", () => showSystemDiff(button.dataset.systemDiff));
  });
}

function jumpToRequest(requestId) {
  if (!requestId) return;
  const request = state.data?.requests?.find((item) => item.id === requestId);
  if (!request) return;
  markActiveRequest(requestId, true);
  if (request.turn_id && request.turn_id !== state.activeId) markActiveTurn(request.turn_id, false);
}

function jumpToAgentBranch(branchId) {
  if (!branchId) return;
  if (state.collapsedAgentBranches.has(branchId)) {
    state.collapsedAgentBranches.delete(branchId);
    renderAll();
  }
  const target = document.querySelector(`[data-branch="${cssEscape(branchId)}"]`);
  if (!target) return;
  const turn = target.closest("[data-turn-group]");
  if (turn?.dataset.turnGroup && turn.dataset.turnGroup !== state.activeId) markActiveTurn(turn.dataset.turnGroup, false);
  scrollElementIntoView(target, { blockOffset: 90 });
  target.classList.add("focus");
  setTimeout(() => target.classList.remove("focus"), 1800);
}

function toggleAgentBranch(branchId) {
  if (!branchId) return;
  if (state.collapsedAgentBranches.has(branchId)) state.collapsedAgentBranches.delete(branchId);
  else state.collapsedAgentBranches.add(branchId);
  renderAll();
}

function scrollElementIntoView(target, { blockOffset = 0 } = {}) {
  const scroller = nearestScrollParent(target);
  if (!scroller || scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const targetRect = target.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  scroller.scrollTo({
    top: scroller.scrollTop + targetRect.top - scrollerRect.top - blockOffset,
  });
}

function nearestScrollParent(element) {
  let current = element?.parentElement || null;
  while (current) {
    const style = getComputedStyle(current);
    if (/(auto|scroll)/.test(`${style.overflow}${style.overflowY}${style.overflowX}`) && current.scrollHeight > current.clientHeight) return current;
    current = current.parentElement;
  }
  return document.scrollingElement;
}

function toggleUpstreamDetails(requestId) {
  if (!requestId) return;
  const panel = document.querySelector(`[data-upstream-panel="${cssEscape(requestId)}"]`);
  const nextOpen = !panel?.open;
  if (nextOpen) state.upstreamExpanded.add(requestId);
  else state.upstreamExpanded.delete(requestId);
  if (panel) {
    panel.open = nextOpen;
    if (nextOpen) {
      const internalWrapper = panel.closest(".turn-internal-request");
      if (internalWrapper) internalWrapper.open = true;
    }
  }
  document.querySelectorAll(`[data-upstream-toggle="${cssEscape(requestId)}"]`).forEach((button) => {
    button.setAttribute("aria-expanded", nextOpen ? "true" : "false");
    button.closest(".upstream-entry")?.classList.toggle("active", nextOpen);
    const label = button.querySelector(".toggle-label");
    if (label) label.textContent = nextOpen ? "折叠上行" : "展开上行";
  });
}

function toggleLatestOnly() {
  state.latestOnly = !state.latestOnly;
  localStorage.setItem(LATEST_ONLY_KEY, String(state.latestOnly));
  renderAll();
  if (state.latestOnly) {
    const latestTurn = visibleTurnList(state.data?.turns, state.data?.requests || [])[0];
    if (latestTurn?.id) markActiveTurn(latestTurn.id, true);
  } else if (state.activeId) {
    markActiveTurn(state.activeId, false);
  }
}

function toggleResponseExpansion(requestId) {
  if (!requestId) return;
  if (state.responseExpanded.has(requestId)) state.responseExpanded.delete(requestId);
  else state.responseExpanded.add(requestId);
  renderAll();
  document.getElementById(requestId)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function markActiveTurn(id, scroll) {
  state.activeId = id;
  renderTurnRail();
  document.querySelectorAll("[data-turn]").forEach((button) => button.classList.toggle("active", button.dataset.turn === id));
  document.querySelectorAll("[data-turn-group]").forEach((group) => group.classList.toggle("active", group.dataset.turnGroup === id));
  const target = document.getElementById(id);
  if (scroll) target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function markActiveRequest(id, scroll) {
  state.activeRequestId = id;
  document.querySelectorAll("[data-card]").forEach((card) => card.classList.toggle("active", card.dataset.card === id));
  const target = document.getElementById(id);
  if (scroll) target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setRawPanelOpen(open) {
  state.rawOpen = open;
  if (open) {
    if (state.rawWidth) applyRawPanelWidth(state.rawWidth);
    else els.appShell.style.removeProperty("--raw-width");
  } else {
    els.appShell.style.setProperty("--raw-width", "0px");
  }
  els.appShell.classList.toggle("raw-collapsed", !open);
  els.rawToggle.classList.toggle("active", open);
  els.rawToggle.title = open ? "折叠 Raw JSON 面板" : "展开 Raw JSON 面板";
  els.rawToggle.setAttribute("aria-pressed", String(open));
  localStorage.setItem("peekmyagent.rawOpen", String(open));
  scheduleActiveSync();
}

function bindRawResizer() {
  if (!els.rawResizer) return;
  els.rawResizer.addEventListener("pointerdown", (event) => {
    if (window.matchMedia("(max-width: 1080px)").matches) return;
    event.preventDefault();
    setRawPanelOpen(true);
    els.appShell.classList.add("resizing-raw");
    els.rawResizer.setPointerCapture(event.pointerId);
    updateRawPanelWidthFromPointer(event.clientX, { persist: false });
  });
  els.rawResizer.addEventListener("mousedown", (event) => {
    if (els.appShell.classList.contains("resizing-raw")) return;
    if (window.matchMedia("(max-width: 1080px)").matches) return;
    event.preventDefault();
    setRawPanelOpen(true);
    els.appShell.classList.add("resizing-raw");
    updateRawPanelWidthFromPointer(event.clientX, { persist: false });
  });
  els.rawResizer.addEventListener("pointermove", (event) => {
    if (!els.appShell.classList.contains("resizing-raw")) return;
    updateRawPanelWidthFromPointer(event.clientX, { persist: false });
  });
  document.addEventListener("mousemove", (event) => {
    if (!els.appShell.classList.contains("resizing-raw")) return;
    updateRawPanelWidthFromPointer(event.clientX, { persist: false });
  });
  els.rawResizer.addEventListener("pointerup", (event) => finishRawResize(event));
  els.rawResizer.addEventListener("pointercancel", (event) => finishRawResize(event));
  document.addEventListener("mouseup", (event) => finishRawResize(event));
  els.rawResizer.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setRawPanelOpen(true);
    const step = event.shiftKey ? 80 : 24;
    const direction = event.key === "ArrowLeft" ? 1 : -1;
    setRawPanelWidth((state.rawWidth || currentRawPanelWidth()) + direction * step);
  });
}

function finishRawResize(event) {
  if (!els.appShell.classList.contains("resizing-raw")) return;
  els.appShell.classList.remove("resizing-raw");
  try {
    els.rawResizer.releasePointerCapture(event.pointerId);
  } catch {
    // Pointer capture can already be released by the browser on cancel.
  }
  if (state.rawWidth) localStorage.setItem(RAW_WIDTH_KEY, String(state.rawWidth));
  scheduleActiveSync();
}

function updateRawPanelWidthFromPointer(clientX, { persist = true } = {}) {
  const shellRect = els.appShell.getBoundingClientRect();
  const width = shellRect.right - clientX;
  setRawPanelWidth(width, { persist });
}

function setRawPanelWidth(width, { persist = true } = {}) {
  const nextWidth = clampRawPanelWidth(width);
  state.rawWidth = nextWidth;
  applyRawPanelWidth(nextWidth);
  if (persist) localStorage.setItem(RAW_WIDTH_KEY, String(nextWidth));
  scheduleActiveSync();
}

function applyRawPanelWidth(width) {
  els.appShell.style.setProperty("--raw-width", `${Math.round(width)}px`);
  els.rawResizer?.setAttribute("aria-valuenow", String(Math.round(width)));
  els.rawResizer?.setAttribute("aria-valuemin", String(RAW_WIDTH_MIN));
  els.rawResizer?.setAttribute("aria-valuemax", String(Math.round(maxRawPanelWidth())));
}

function readRawPanelWidth() {
  const stored = Number(localStorage.getItem(RAW_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampRawPanelWidth(stored) : 0;
}

function currentRawPanelWidth() {
  return els.rawPanel.getBoundingClientRect().width || Math.min(Math.max(window.innerWidth * 0.34, 380), 560);
}

function clampRawPanelWidth(width) {
  return Math.round(Math.min(Math.max(Number(width) || RAW_WIDTH_MIN, RAW_WIDTH_MIN), maxRawPanelWidth()));
}

function maxRawPanelWidth() {
  const shellWidth = els.appShell.getBoundingClientRect().width || window.innerWidth;
  const sidebarWidth = state.sidebarOpen ? state.sidebarWidth || currentSidebarWidth() : 0;
  const sidebarResizerWidth = state.sidebarOpen ? RESIZER_WIDTH : 0;
  const roomForRaw = shellWidth - sidebarWidth - sidebarResizerWidth - MAIN_PANEL_MIN - RESIZER_WIDTH;
  return Math.max(RAW_WIDTH_MIN, Math.min(RAW_WIDTH_MAX, roomForRaw));
}

function setSidebarOpen(open) {
  state.sidebarOpen = open;
  if (open) {
    if (state.sidebarWidth) applySidebarWidth(state.sidebarWidth);
    else els.appShell.style.removeProperty("--sidebar-width");
  } else {
    els.appShell.style.setProperty("--sidebar-width", "0px");
  }
  els.appShell.classList.toggle("sidebar-collapsed", !open);
  els.toggleSidebar.title = open ? "折叠会话栏" : "展开会话栏";
  els.toggleSidebar.classList.toggle("active", open);
  els.toggleSidebar.setAttribute("aria-pressed", String(open));
  localStorage.setItem("peekmyagent.sidebarOpen", String(open));
  if (state.rawWidth) setRawPanelWidth(state.rawWidth, { persist: false });
  scheduleActiveSync();
}

function bindSidebarResizer() {
  if (!els.sidebarResizer) return;
  els.sidebarResizer.addEventListener("pointerdown", (event) => {
    if (window.matchMedia("(max-width: 1080px)").matches) return;
    event.preventDefault();
    setSidebarOpen(true);
    els.appShell.classList.add("resizing-sidebar");
    els.sidebarResizer.setPointerCapture(event.pointerId);
    updateSidebarWidthFromPointer(event.clientX, { persist: false });
  });
  els.sidebarResizer.addEventListener("mousedown", (event) => {
    if (els.appShell.classList.contains("resizing-sidebar")) return;
    if (window.matchMedia("(max-width: 1080px)").matches) return;
    event.preventDefault();
    setSidebarOpen(true);
    els.appShell.classList.add("resizing-sidebar");
    updateSidebarWidthFromPointer(event.clientX, { persist: false });
  });
  els.sidebarResizer.addEventListener("pointermove", (event) => {
    if (!els.appShell.classList.contains("resizing-sidebar")) return;
    updateSidebarWidthFromPointer(event.clientX, { persist: false });
  });
  document.addEventListener("mousemove", (event) => {
    if (!els.appShell.classList.contains("resizing-sidebar")) return;
    updateSidebarWidthFromPointer(event.clientX, { persist: false });
  });
  els.sidebarResizer.addEventListener("pointerup", (event) => finishSidebarResize(event));
  els.sidebarResizer.addEventListener("pointercancel", (event) => finishSidebarResize(event));
  document.addEventListener("mouseup", (event) => finishSidebarResize(event));
  els.sidebarResizer.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setSidebarOpen(true);
    const step = event.shiftKey ? 80 : 24;
    const direction = event.key === "ArrowRight" ? 1 : -1;
    setSidebarWidth((state.sidebarWidth || currentSidebarWidth()) + direction * step);
  });
}

function finishSidebarResize(event) {
  if (!els.appShell.classList.contains("resizing-sidebar")) return;
  els.appShell.classList.remove("resizing-sidebar");
  try {
    els.sidebarResizer.releasePointerCapture(event.pointerId);
  } catch {
    // Pointer capture can already be released by the browser on cancel.
  }
  if (state.sidebarWidth) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(state.sidebarWidth));
  scheduleActiveSync();
}

function updateSidebarWidthFromPointer(clientX, { persist = true } = {}) {
  const shellRect = els.appShell.getBoundingClientRect();
  const width = clientX - shellRect.left;
  setSidebarWidth(width, { persist });
}

function setSidebarWidth(width, { persist = true } = {}) {
  const nextWidth = clampSidebarWidth(width);
  state.sidebarWidth = nextWidth;
  applySidebarWidth(nextWidth);
  if (persist) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth));
  if (state.rawWidth) setRawPanelWidth(state.rawWidth, { persist: false });
  scheduleActiveSync();
}

function applySidebarWidth(width) {
  els.appShell.style.setProperty("--sidebar-width", `${Math.round(width)}px`);
  els.sidebarResizer?.setAttribute("aria-valuenow", String(Math.round(width)));
  els.sidebarResizer?.setAttribute("aria-valuemin", String(SIDEBAR_WIDTH_MIN));
  els.sidebarResizer?.setAttribute("aria-valuemax", String(Math.round(maxSidebarWidth())));
}

function readSidebarWidth() {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : 0;
}

function currentSidebarWidth() {
  return Number.parseFloat(getComputedStyle(els.appShell).getPropertyValue("--sidebar-width")) || SIDEBAR_WIDTH_MIN;
}

function clampSidebarWidth(width) {
  return Math.round(Math.min(Math.max(Number(width) || SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MIN), maxSidebarWidth()));
}

function maxSidebarWidth() {
  const shellWidth = els.appShell.getBoundingClientRect().width || window.innerWidth;
  const rawWidth = state.rawOpen ? state.rawWidth || currentRawPanelWidth() : 0;
  const rawResizerWidth = state.rawOpen ? RESIZER_WIDTH : 0;
  const roomForSidebar = shellWidth - rawWidth - rawResizerWidth - MAIN_PANEL_MIN - RESIZER_WIDTH;
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, roomForSidebar));
}

function scheduleActiveSync() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    syncActiveFromScroll();
  });
}

function syncActiveFromScroll() {
  if (!state.data?.requests?.length) return;
  const turnGroups = [...document.querySelectorAll("[data-turn-group]")];
  if (!turnGroups.length) return;

  const { scrollTop, scrollHeight, clientHeight } = els.mainPanel;
  const bottomSnap = Math.min(160, clientHeight * 0.18);
  if (scrollTop + clientHeight >= scrollHeight - bottomSnap) {
    const last = turnGroups.at(-1);
    if (last?.dataset.turnGroup && last.dataset.turnGroup !== state.activeId) {
      markActiveTurn(last.dataset.turnGroup, false);
    }
    return;
  }

  const activePosition = scrollTop + 118;
  let candidate = turnGroups[0];

  for (let index = 1; index < turnGroups.length; index += 1) {
    const previousTop = turnGroups[index - 1].offsetTop;
    const currentTop = turnGroups[index].offsetTop;
    const switchPoint = previousTop + (currentTop - previousTop) / 2;
    if (activePosition >= switchPoint) {
      candidate = turnGroups[index];
    } else {
      break;
    }
  }

  if (candidate.dataset.turnGroup && candidate.dataset.turnGroup !== state.activeId) {
    markActiveTurn(candidate.dataset.turnGroup, false);
  }
}

function showRaw(id, section = "full") {
  const request = state.data.requests.find((item) => item.id === id);
  if (!request) return;
  markActiveRequest(id, false);
  state.activeRawSection = section;
  setRawPanelOpen(true);
  els.rawTitle.textContent = `Request ${request.request_index} · ${rawSectionLabel(section)}`;
  els.rawTree.className = "raw-tree";
  els.rawTree.innerHTML = renderRawSections(request, section);
}

function showSystemDiff(id) {
  showRaw(id, "system_diff");
}

function renderRawSections(request, activeSection = "full") {
  const body = request.raw?.body || {};
  if (activeSection === "system_diff") {
    return `
      ${renderRawSourceNotice(request)}
      ${renderRawSectionNav(request, activeSection)}
      ${renderSystemDiff(request)}
    `;
  }
  const sectionData = rawSectionData(request, activeSection);
  if (activeSection !== "full") {
    return `
      ${renderRawSourceNotice(request)}
      ${renderRawSectionNav(request, activeSection)}
      ${renderTranslationControls(request, activeSection)}
      ${renderRawSectionContent(request, activeSection, sectionData)}
    `;
  }
  return `
    ${renderRawSourceNotice(request)}
    ${renderRawSectionNav(request, activeSection)}
    ${renderRawDetail("完整捕获", request.raw)}
    ${renderRawDetail("system", body.system ?? null)}
    ${renderRawDetail("tools", body.tools ?? null)}
    ${renderRawDetail("messages / history", body.messages ?? null)}
    ${renderRawDetail("upstream response", rawSectionData(request, "response").value)}
    ${renderRawDetail("headers / metadata", rawSectionData(request, "metadata").value)}
  `;
}

function renderRawSectionContent(request, section, sectionData) {
  if (state.translationMode === TARGET_TRANSLATION_LANGUAGE && state.translations?.available) {
    if (section === "system") return renderTranslatedSystemSection(request);
    if (section === "tools") return renderTranslatedToolsSection(request);
  }
  return renderRawDetail(sectionData.title, sectionData.value);
}

function renderTranslationControls(request, section) {
  if (!["system", "tools"].includes(section)) return "";
  const stats = translationSectionStats(request, section);
  const cache = state.translations;
  const available = Boolean(cache?.available);
  const generating = Boolean(state.translationGenerate.loading);
  const generateMessage = state.translationGenerate.error || state.translationGenerate.message || "";
  const statusText = available
    ? `${stats.hit}/${stats.total} 已缓存 · ${cache.target_language || TARGET_TRANSLATION_LANGUAGE}`
    : `未找到 ${TARGET_TRANSLATION_LANGUAGE} 缓存`;
  return `
    <div class="translation-toolbar">
      <div class="translation-segmented" role="group" aria-label="语言切换">
        <button type="button" class="${state.translationMode === "source" ? "active" : ""}" data-translation-mode="source" data-translation-section="${escapeHtml(section)}">原文</button>
        <button type="button" class="${state.translationMode === TARGET_TRANSLATION_LANGUAGE ? "active" : ""}" data-translation-mode="${escapeHtml(TARGET_TRANSLATION_LANGUAGE)}" data-translation-section="${escapeHtml(section)}" ${available ? "" : "disabled"}>中文</button>
      </div>
      <div class="translation-toolbar-actions">
        <span class="translation-status ${state.translationGenerate.error ? "error" : stats.missing ? "partial" : "ready"}">${escapeHtml(generateMessage || statusText)}</span>
        <button type="button" class="translation-generate-button" data-translation-generate="true" data-translation-section="${escapeHtml(section)}" ${generating ? "disabled" : ""} title="仅更新当前请求的 ${escapeHtml(rawSectionLabel(section))} 翻译块；已缓存内容也会重译。">${generating ? "更新中..." : "更新当前区块"}</button>
      </div>
    </div>
  `;
}

function renderTranslatedSystemSection(request) {
  const materials = collectSystemTranslationMaterials(request);
  if (!materials.length) return '<div class="empty-box">这条请求没有可翻译的 system prompt。</div>';
  return `
    <section class="translation-list">
      ${materials
        .map((item, index) =>
          renderTranslationBlock({
            label: `${item.metadata.source || "system"} #${index + 1}`,
            kind: item.kind,
            sourceText: item.source_text,
          }),
        )
        .join("")}
    </section>
  `;
}

function renderTranslatedToolsSection(request) {
  const materials = collectToolTranslationMaterials(request);
  if (!materials.length) return '<div class="empty-box">这条请求没有可翻译的 tool 描述。</div>';
  return `
    <section class="translation-list">
      ${materials
        .map((item) =>
          renderTranslationBlock({
            label: toolTranslationLabel(item),
            kind: item.kind,
            sourceText: item.source_text,
          }),
        )
        .join("")}
    </section>
  `;
}

function renderTranslationBlock({ label, kind, sourceText }) {
  const translation = translatedTextFor(kind, sourceText);
  const hit = Boolean(translation);
  const kindClass = translationKindClass(kind);
  const displayText = translation || sourceText || "";
  const actionId = registerTranslationAction({ kind, sourceText, section: state.activeRawSection || "tools", surface: "raw", metadata: { label } });
  return `
    <article class="translation-block ${escapeHtml(kindClass)} ${hit ? "hit" : "miss"}">
      <header>
        <strong>${escapeHtml(label)}</strong>
        <span class="translation-block-meta">
          <span class="translation-kind">${escapeHtml(translationKindLabel(kind))}</span>
          <span class="translation-cache-state">${escapeHtml(hit ? "中文缓存" : "缺少翻译")}</span>
          <button type="button" class="translation-inline-button" data-translation-retranslate="${escapeHtml(actionId)}" ${state.translationGenerate.loading ? "disabled" : ""}>${hit ? "重译" : "翻译"}</button>
        </span>
      </header>
      ${renderMarkdownPreview(displayText)}
      <details>
        <summary>原文</summary>
        <div class="details-body">${renderPre(sourceText || "")}</div>
      </details>
    </article>
  `;
}

function registerTranslationAction({ kind, sourceText, section, requestId = "", surface = "raw", metadata = {} }) {
  const id = String(state.nextTranslationActionId++);
  state.translationActionItems.set(id, {
    kind,
    sourceText,
    section,
    requestId: requestId || state.activeRequestId || "",
    surface,
    metadata,
  });
  return id;
}

function translationKindClass(kind) {
  if (kind === "tool_description") return "tool-description";
  if (kind === "tool_parameter_description") return "tool-parameter";
  if (kind === "system_prompt") return "system-prompt";
  if (kind === "system_injected_context") return "system-injected";
  if (kind === "assistant_thinking") return "assistant-thinking-kind";
  return "other-kind";
}

function translationKindLabel(kind) {
  if (kind === "tool_description") return "工具说明";
  if (kind === "tool_parameter_description") return "参数说明";
  if (kind === "system_prompt") return "System";
  if (kind === "system_injected_context") return "注入上下文";
  if (kind === "assistant_thinking") return "Thinking";
  return "说明";
}

function renderMarkdownPreview(text) {
  return `<div class="translation-markdown">${renderSafeMarkdown(text)}</div>`;
}

function renderSafeMarkdown(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let list = null;
  let fence = null;
  let code = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.map((line) => renderInlineMarkdown(line.trim())).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`<${list.type}>${list.items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  const flushCode = () => {
    if (!fence) return;
    html.push(`<pre class="markdown-code"><code>${escapeHtml(code.join("\n"))}</code></pre>`);
    fence = null;
    code = [];
  };
  const flushBlocks = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^(\s*)(```|~~~)/);
    if (fence) {
      if (fenceMatch) {
        flushCode();
      } else {
        code.push(line);
      }
      continue;
    }
    if (fenceMatch) {
      flushBlocks();
      fence = fenceMatch[2];
      code = [];
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      flushBlocks();
      continue;
    }
    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushBlocks();
      html.push("<hr>");
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushBlocks();
      const level = Math.min(4, heading[1].length + 2);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      if (!list || list.type !== "ul") flushList();
      if (!list) list = { type: "ul", items: [] };
      list.items.push(unordered[1].trim());
      continue;
    }
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (!list || list.type !== "ol") flushList();
      if (!list) list = { type: "ol", items: [] };
      list.items.push(ordered[1].trim());
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  flushCode();
  flushBlocks();
  return html.join("") || "<p></p>";
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function translationSectionStats(request, section) {
  const materials = section === "system" ? collectSystemTranslationMaterials(request) : section === "tools" ? collectToolTranslationMaterials(request) : [];
  const hit = materials.filter((item) => translatedTextFor(item.kind, item.source_text)).length;
  return { total: materials.length, hit, missing: Math.max(0, materials.length - hit) };
}

function translatedTextFor(kind, sourceText) {
  const source = normalizeTranslationText(sourceText);
  return source ? state.translationLookup.get(translationLookupKey(kind, source))?.translated_text || "" : "";
}

function toolTranslationLabel(item) {
  const toolName = item.metadata?.tool_name || "unknown";
  if (item.kind === "tool_description") return `${toolName} · description`;
  return `${toolName} · ${item.metadata?.field_name || item.metadata?.path || "parameter"}`;
}

function renderRawSourceNotice(request) {
  const source = request.raw?.body_source || "original";
  const reconstructed = source === "reconstructed";
  return `
    <div class="raw-source-notice ${reconstructed ? "reconstructed" : "original"}">
      <strong>${reconstructed ? "Raw reconstructed" : "Raw original"}</strong>
      <span>${reconstructed ? "原始 body 已不可用；当前内容由 ordered request tree 和 content blobs 重建。" : "当前内容来自捕获时保存的原始 JSON body。"}</span>
    </div>
  `;
}

function rawSectionLabel(section) {
  const labels = {
    full: "完整",
    system: "System",
    system_diff: "System diff",
    tools: "Tools",
    messages: "Messages",
    tool_calls: "Tool calls",
    tool_results: "Tool results",
    response: "Response",
    metadata: "Metadata",
  };
  return labels[section] || "Raw";
}

function renderSystemDiff(request) {
  const previous = previousRequest(request);
  if (!previous) {
    return '<div class="empty-box">这条请求没有上一条请求，无法生成 system diff。</div>';
  }
  const before = systemTextFromRequest(previous);
  const after = systemTextFromRequest(request);
  const diffRows = createLineDiff(before, after);
  const compactRows = compactDiffRows(diffRows, 4);
  const added = diffRows.filter((row) => row.type === "add").length;
  const removed = diffRows.filter((row) => row.type === "remove").length;
  const changed = added || removed;
  return `
    <section class="system-diff">
      <div class="diff-summary">
        <div>
          <h3>System prompt diff</h3>
          <p>#${escapeHtml(previous.request_index)} → #${escapeHtml(request.request_index)} · ${changed ? `+${added} / -${removed} 行` : "没有可见行级变化"}</p>
        </div>
        <div class="diff-legend" aria-label="diff 图例">
          <span class="legend-remove">删除</span>
          <span class="legend-add">新增</span>
          <span class="legend-context">上下文</span>
        </div>
      </div>
      ${
        changed
          ? `<div class="diff-lines">${compactRows.map(renderDiffRow).join("")}</div>`
          : '<div class="empty-box">hash 显示 system 发生变化，但按当前文本抽取结果没有发现行级差异。可能是结构、空白或非文本字段变化；可以切到 System Raw 继续检查。</div>'
      }
    </section>
  `;
}

function previousRequest(request) {
  const requests = state.data?.requests || [];
  const index = requests.findIndex((item) => item.id === request.id);
  return index > 0 ? requests[index - 1] : null;
}

function systemTextFromRequest(request) {
  const body = request.raw?.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const parts = [];
  if (typeof body.system === "string") parts.push(body.system);
  if (Array.isArray(body.system)) {
    for (const part of body.system) parts.push(extractContentText(part));
  }
  for (const message of messages) {
    if (message.role === "system") parts.push(extractContentText(message.content));
  }
  return parts.filter(Boolean).join("\n\n");
}

function collectTranslationMaterials(request) {
  return [...collectSystemTranslationMaterials(request), ...collectToolTranslationMaterials(request), ...collectResponseTranslationMaterials(request)];
}

function collectResponseTranslationMaterials(request) {
  const thinking = normalizeTranslationText(request.summary?.response?.thinking || "");
  if (!thinking) return [];
  return [
    {
      kind: "assistant_thinking",
      source_text: thinking,
      metadata: { source: "response.thinking" },
    },
  ];
}

function collectSystemTranslationMaterials(request) {
  const body = request.raw?.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const materials = [];
  extractSystemPartsForTranslation(body, messages).forEach((part, index) => {
    const sourceText = normalizeTranslationText(part.text);
    const kind = systemTranslationKind(sourceText);
    if (isSkippableTranslationMaterial(kind, sourceText)) return;
    materials.push({
      kind,
      source_text: sourceText,
      metadata: { source: part.source, index },
    });
  });
  return dedupeTranslationMaterials(materials);
}

function collectToolTranslationMaterials(request) {
  const body = request.raw?.body || {};
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const materials = [];
  tools.forEach((tool, toolIndex) => {
    const toolName = toolNameOf(tool);
    const description = toolDescriptionOf(tool);
    if (description) {
      materials.push({
        kind: "tool_description",
        source_text: description,
        metadata: { tool_name: toolName, path: `tools[${toolIndex}].description` },
      });
    }
    const schema = tool.input_schema || tool.function?.parameters || tool.parameters || null;
    for (const item of extractSchemaDescriptionsForTranslation(schema, { rootPath: `tools[${toolIndex}].input_schema` })) {
      materials.push({
        kind: "tool_parameter_description",
        source_text: item.description,
        metadata: { tool_name: toolName, path: item.path, field_name: item.field_name },
      });
    }
  });
  return dedupeTranslationMaterials(materials);
}

function extractSystemPartsForTranslation(body, messages) {
  const output = [];
  if (typeof body.system === "string") output.push({ source: "body.system", text: body.system });
  if (Array.isArray(body.system)) {
    for (const part of body.system) output.push({ source: "body.system", text: extractContentText(part) });
  }
  for (const message of messages) {
    if (message.role === "system") output.push({ source: "messages.system", text: extractContentText(message.content) });
  }
  return output.filter((part) => normalizeTranslationText(part.text));
}

function extractSchemaDescriptionsForTranslation(schema, { rootPath }) {
  const output = [];
  visit(schema, rootPath, "");
  return output;

  function visit(value, currentPath, fieldName) {
    if (!value || typeof value !== "object") return;
    if (typeof value.description === "string" && value.description.trim()) {
      output.push({
        field_name: fieldName || null,
        path: `${currentPath}.description`,
        description: value.description,
      });
    }
    const properties = value.properties && typeof value.properties === "object" ? value.properties : {};
    for (const [key, child] of Object.entries(properties)) visit(child, `${currentPath}.properties.${key}`, key);
    if (value.items) visit(value.items, `${currentPath}.items`, fieldName);
    for (const key of ["oneOf", "anyOf", "allOf"]) {
      if (Array.isArray(value[key])) value[key].forEach((child, index) => visit(child, `${currentPath}.${key}[${index}]`, fieldName));
    }
  }
}

function dedupeTranslationMaterials(materials) {
  return [...new Map(materials.map((item) => [translationLookupKey(item.kind, normalizeTranslationText(item.source_text)), { ...item, source_text: normalizeTranslationText(item.source_text) }])).values()].filter(
    (item) => item.source_text,
  );
}

function toolNameOf(tool) {
  return tool?.name || tool?.function?.name || tool?.type || "unknown";
}

function toolDescriptionOf(tool) {
  return normalizeTranslationText(tool?.description || tool?.function?.description || "");
}

function normalizeTranslationText(value) {
  return normalizeVolatileSystemLines(stripVolatileSystemPreamble(String(value || "").replace(/\r\n/g, "\n").trim())).trim();
}

function stripVolatileSystemPreamble(text) {
  return String(text || "")
    .replace(/^The date has changed\. Today's date is now \d{4}-\d{2}-\d{2}\. DO NOT mention this to the user explicitly because they are already aware\.\n\n/, "")
    .replace(/^Today's date is now \d{4}-\d{2}-\d{2}\. DO NOT mention this to the user explicitly because they are already aware\.\n\n/, "");
}

function isSkippableTranslationMaterial(kind, sourceText) {
  if (kind !== "system_prompt") return false;
  return /^x-anthropic-billing-header:\s*/i.test(sourceText);
}

function normalizeVolatileSystemLines(text) {
  return String(text || "")
    .replace(/^(\s*-\s*You are powered by the model\s+).+?(\.?)$/gm, "$1<model>$2")
    .replace(/^(\s*-\s*Primary working directory:\s+).+$/gm, "$1<workspace>")
    .replace(/(You have a persistent file-based memory at\s+)`[^`]+`/g, "$1`<project-memory>`");
}

function systemTranslationKind(text) {
  const value = String(text || "").trim();
  if (/^Called the .+ tool with the following input/i.test(value) && /Result of calling the .+ tool/i.test(value)) {
    return "system_injected_context";
  }
  return "system_prompt";
}

function translationLookupKey(kind, sourceText) {
  return `${kind}\0${sourceText}`;
}

async function materialHash(kind, sourceText) {
  const bytes = new TextEncoder().encode(translationLookupKey(kind, sourceText));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function extractContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractContentText).filter(Boolean).join("\n");
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string" || Array.isArray(content.content)) return extractContentText(content.content);
    return JSON.stringify(content);
  }
  return "";
}

function createLineDiff(before, after) {
  const beforeLines = splitDiffLines(before);
  const afterLines = splitDiffLines(after);
  const table = Array.from({ length: beforeLines.length + 1 }, () => Array(afterLines.length + 1).fill(0));
  for (let row = beforeLines.length - 1; row >= 0; row -= 1) {
    for (let col = afterLines.length - 1; col >= 0; col -= 1) {
      table[row][col] =
        beforeLines[row] === afterLines[col] ? table[row + 1][col + 1] + 1 : Math.max(table[row + 1][col], table[row][col + 1]);
    }
  }
  const rows = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < beforeLines.length && newIndex < afterLines.length) {
    if (beforeLines[oldIndex] === afterLines[newIndex]) {
      rows.push({ type: "context", oldLine: oldIndex + 1, newLine: newIndex + 1, text: beforeLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      rows.push({ type: "remove", oldLine: oldIndex + 1, newLine: "", text: beforeLines[oldIndex] });
      oldIndex += 1;
    } else {
      rows.push({ type: "add", oldLine: "", newLine: newIndex + 1, text: afterLines[newIndex] });
      newIndex += 1;
    }
  }
  while (oldIndex < beforeLines.length) {
    rows.push({ type: "remove", oldLine: oldIndex + 1, newLine: "", text: beforeLines[oldIndex] });
    oldIndex += 1;
  }
  while (newIndex < afterLines.length) {
    rows.push({ type: "add", oldLine: "", newLine: newIndex + 1, text: afterLines[newIndex] });
    newIndex += 1;
  }
  return rows;
}

function splitDiffLines(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized ? normalized.split("\n") : [];
}

function compactDiffRows(rows, contextSize) {
  const changedIndexes = rows.flatMap((row, index) => (row.type === "context" ? [] : [index]));
  if (!changedIndexes.length) return rows;
  const keep = new Set();
  for (const index of changedIndexes) {
    const start = Math.max(0, index - contextSize);
    const end = Math.min(rows.length - 1, index + contextSize);
    for (let cursor = start; cursor <= end; cursor += 1) keep.add(cursor);
  }
  const output = [];
  let skipped = 0;
  rows.forEach((row, index) => {
    if (keep.has(index)) {
      if (skipped) {
        output.push({ type: "skip", count: skipped });
        skipped = 0;
      }
      output.push(row);
    } else {
      skipped += 1;
    }
  });
  if (skipped) output.push({ type: "skip", count: skipped });
  return output;
}

function renderDiffRow(row) {
  if (row.type === "skip") return `<div class="diff-skip">跳过 ${escapeHtml(row.count)} 行未变化内容</div>`;
  const marker = row.type === "add" ? "+" : row.type === "remove" ? "-" : " ";
  return `
    <div class="diff-line ${escapeHtml(row.type)}">
      <span class="diff-marker">${marker}</span>
      <span class="diff-line-number">${escapeHtml(row.oldLine)}</span>
      <span class="diff-line-number">${escapeHtml(row.newLine)}</span>
      <code>${escapeHtml(row.text || " ")}</code>
    </div>
  `;
}

function renderJson(value, key) {
  if (Array.isArray(value)) {
    const summary = `[${value.length}]`;
    return `<details open><summary>${key ? `<span class="json-key">${escapeHtml(key)}</span>: ` : ""}${summary}</summary><div class="json-node">${value.map((item, index) => renderJson(item, String(index))).join("")}</div></details>`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    return `<details open><summary>${key ? `<span class="json-key">${escapeHtml(key)}</span>: ` : ""}{${keys.length}}</summary><div class="json-node">${keys.map((itemKey) => renderJson(value[itemKey], itemKey)).join("")}</div></details>`;
  }
  return `<div>${key ? `<span class="json-key">${escapeHtml(key)}</span>: ` : ""}${renderPrimitive(value)}</div>`;
}

function renderPrimitive(value) {
  if (value === null) return '<span class="json-null">null</span>';
  if (typeof value === "string") return `<span class="json-string">"${escapeHtml(value)}"</span>`;
  if (typeof value === "number") return `<span class="json-number">${value}</span>`;
  if (typeof value === "boolean") return `<span class="json-boolean">${value}</span>`;
  return escapeHtml(String(value));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed.error || text;
    } catch {
      message = text;
    }
    throw new Error(message);
  }
  return response.json();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function displaySourceLabel(label) {
  return cleanDisplayText(label) || "未命名会话";
}

function projectNameFromWorkspace(workspace) {
  if (!workspace) return "";
  const normalized = String(workspace).replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) || normalized || "";
}

function projectGroupKey(agent, project) {
  return `${encodeURIComponent(agent || "Unknown Agent")}::${encodeURIComponent(project || "未归属项目")}`;
}

function cleanDisplayText(value) {
  return String(value || "")
    .replace(/<\/?session>/gi, "")
    .replace(/<\/?user_input>/gi, "")
    .replace(/<command-message\b[^>]*>([\s\S]*?)<\/command-message>/gi, "$1")
    .replace(/<command-name\b[^>]*>([\s\S]*?)<\/command-name>/gi, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderConfidenceBadge(confidence) {
  const exact = confidence === "exact";
  return `<span class="badge ${exact ? "exact" : "partial"}" title="${escapeHtml(exact ? "通过本地代理捕获到 Agent 发给模型服务的真实上行请求。" : "这条数据来自调试、导入或不完整来源，不能等同于完整上行请求。")}">${escapeHtml(exact ? "精确捕获" : "部分捕获")}</span>`;
}

function captureLabelText(label) {
  if (label === "exact proxy capture") return "精确代理捕获";
  if (label === "otel raw body") return "OTel Raw 请求体";
  return label || "未知捕获方式";
}

function captureLabelHelp(label) {
  if (label === "exact proxy capture") return "通过本地代理捕获 Agent 发给模型服务的上行请求。";
  if (label === "otel raw body") return "通过 OTel raw body 文件读取请求体，HTTP 层信息可能不完整。";
  return "当前数据源的捕获方式。";
}

function protocolLabel(protocol) {
  const labels = {
    openai_chat_completions: "OpenAI Chat",
    openai_responses: "OpenAI Responses",
    anthropic_messages: "Anthropic",
    gemini_generate_content: "Gemini",
    unknown: "未知协议",
  };
  return labels[protocol] || protocol || "";
}

function providerLabel(provider) {
  const labels = {
    xiaomi_mimo: "MiMo",
    openai: "OpenAI",
    anthropic: "Anthropic",
    google_gemini: "Google Gemini",
    deepseek: "DeepSeek",
    qwen: "Qwen",
    moonshot: "Moonshot",
    unknown: "未知厂商",
  };
  return labels[provider] || provider || "";
}

function extensionLabel(extension) {
  const labels = {
    reasoning_content: "reasoning",
    thinking: "thinking",
  };
  return labels[extension] || extension;
}

function formatTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const datePart = [date.getFullYear(), pad2(date.getMonth() + 1), pad2(date.getDate())].join("-");
  const timePart = [pad2(date.getHours()), pad2(date.getMinutes()), pad2(date.getSeconds())].join(":");
  return `${datePart} ${timePart} ${timezoneOffsetLabel(date)}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function timezoneOffsetLabel(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return minutes ? `GMT${sign}${hours}:${pad2(minutes)}` : `GMT${sign}${hours}`;
}

function shortPath(value) {
  const parts = String(value || "").split("/");
  if (parts.length <= 4) return value;
  return `.../${parts.slice(-4).join("/")}`;
}

function shortId(value) {
  const text = String(value || "");
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function formatCharCount(count) {
  const number = Number(count) || 0;
  return `${number.toLocaleString()} chars`;
}

function formatCompactNumber(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) >= 1000000) return `${(number / 1000000).toFixed(1)}m`;
  if (Math.abs(number) >= 10000) return `${(number / 1000).toFixed(1)}k`;
  return number.toLocaleString();
}

function formatPercent(ratioValue) {
  const value = Number(ratioValue || 0) * 100;
  if (value >= 10) return `${value.toFixed(0)}%`;
  if (value >= 1) return `${value.toFixed(1)}%`;
  if (value > 0) return `${value.toFixed(2)}%`;
  return "0%";
}

function joinUnique(values, fallback = "未记录") {
  const unique = [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
  if (!unique.length) return fallback;
  if (unique.length <= 2) return unique.join(" / ");
  return `${unique.slice(0, 2).join(" / ")} +${unique.length - 2}`;
}

function signedDelta(value) {
  const number = Number(value || 0);
  if (!number) return "";
  return number > 0 ? `+${number}` : String(number);
}

function signedBytes(value) {
  const number = Number(value || 0);
  if (!number) return "";
  return `${number > 0 ? "+" : "-"}${formatBytes(Math.abs(number))}`;
}

function stableJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}
