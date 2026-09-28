/* ══════════════════════════════════════════════════════════════
   Notion API 클라이언트 (Cloudflare Worker 프록시 경유)
   팀 공용 Notion 워크스페이스에 연결하는 거라, 진짜 Notion 토큰은 절대
   브라우저에 두면 안 된다 — Cloudflare Worker(work-hub-proxy)가 토큰을
   Secret으로 들고 있고, 프론트엔드는 앱 비밀번호(X-App-Secret)만 보낸다.
   Notion의 최신 "data sources" API(2025-09-03)를 쓴다 — 팀 work-hub
   백엔드(src/notion/client.ts)와 동일한 버전/엔드포인트.
══════════════════════════════════════════════════════════════ */

const NOTION_API_BASE = "https://work-hub-notion-proxy.work-hub-proxy.workers.dev/v1";

const SETTINGS_KEY = "wh-settings"; // { appSecret, tasksDbId, projectsDbId, meetingsDbId }

function getSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function hasValidSettings() {
  const s = getSettings();
  return !!(s.appSecret && s.tasksDbId);
}

async function notionFetch(path, options = {}) {
  const { appSecret } = getSettings();
  if (!appSecret) throw new Error("NOTION_NOT_CONFIGURED");
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    ...options,
    headers: {
      "X-App-Secret": appSecret,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || `Notion API 오류 (${res.status})`);
    err.status = res.status;
    err.code = body.code;
    throw err;
  }
  return res.json();
}

// 데이터소스 전체 페이지를 페이지네이션 처리해서 다 모아 온다
async function queryDatabaseAll(dataSourceId, body = {}) {
  const results = [];
  let cursor = undefined;
  do {
    const page = await notionFetch(`/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: JSON.stringify({ ...body, start_cursor: cursor }),
    });
    results.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function createPage(dataSourceId, properties) {
  return notionFetch("/pages", {
    method: "POST",
    body: JSON.stringify({ parent: { type: "data_source_id", data_source_id: dataSourceId }, properties }),
  });
}

async function updatePageProperties(pageId, properties) {
  return notionFetch(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

async function archivePage(pageId) {
  return notionFetch(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
  });
}

async function getBlockChildren(blockId) {
  const results = [];
  let cursor = undefined;
  do {
    const qs = cursor ? `?start_cursor=${cursor}` : "";
    const page = await notionFetch(`/blocks/${blockId}/children${qs}`);
    results.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function appendBlockChildren(blockId, children) {
  return notionFetch(`/blocks/${blockId}/children`, {
    method: "PATCH",
    body: JSON.stringify({ children }),
  });
}

// ── 프로퍼티 값 빌더 (Notion이 요구하는 형식으로 감싸주는 헬퍼들) ──
function buildTitle(text) {
  return { title: [{ text: { content: (text || "").slice(0, 2000) } }] };
}
function buildRichText(text) {
  const chunks = chunkString(text || "", 2000);
  return { rich_text: chunks.map((c) => ({ text: { content: c } })) };
}
function buildSelect(name) {
  return name ? { select: { name } } : { select: null };
}
function buildMultiSelect(names) {
  return { multi_select: (names || []).map((name) => ({ name })) };
}
function buildDate(dateStr) {
  return { date: dateStr ? { start: dateStr } : null };
}
function buildPeople(ids) {
  return { people: (ids || []).map((id) => ({ id })) };
}
function buildRelation(ids) {
  return { relation: (ids || []).map((id) => ({ id })) };
}
function buildCheckbox(v) {
  return { checkbox: !!v };
}
function buildNumber(n) {
  return { number: n === undefined || n === null || n === "" ? null : Number(n) };
}

// 긴 텍스트를 Notion rich_text 한 블록 제한(2000자)에 맞게 쪼갠다
function chunkString(str, size) {
  if (!str) return [""];
  const chunks = [];
  for (let i = 0; i < str.length; i += size) chunks.push(str.slice(i, i + size));
  return chunks.length ? chunks : [""];
}

// ── 프로퍼티 값 읽기 헬퍼 (Notion 응답 -> 평범한 JS 값) ──
function readTitle(prop) {
  return (prop?.title || []).map((t) => t.plain_text).join("");
}
function readRichText(prop) {
  return (prop?.rich_text || []).map((t) => t.plain_text).join("");
}
function readSelect(prop) {
  return prop?.select?.name ?? null;
}
function readMultiSelect(prop) {
  return (prop?.multi_select || []).map((s) => s.name);
}
function readDate(prop) {
  return prop?.date?.start ?? null;
}
function readDateEnd(prop) {
  return prop?.date?.end ?? null;
}
function readPeople(prop) {
  return (prop?.people || []).map((p) => ({ id: p.id, name: p.name }));
}
function readRelation(prop) {
  return (prop?.relation || []).map((r) => r.id);
}
function readCheckbox(prop) {
  return !!prop?.checkbox;
}
function readNumber(prop) {
  return prop?.number ?? null;
}

window.NotionClient = {
  getSettings, saveSettings, hasValidSettings,
  queryDatabaseAll, createPage, updatePageProperties, archivePage,
  getBlockChildren, appendBlockChildren,
  buildTitle, buildRichText, buildSelect, buildMultiSelect, buildDate,
  buildPeople, buildRelation, buildCheckbox, buildNumber, chunkString,
  readTitle, readRichText, readSelect, readMultiSelect, readDate, readDateEnd,
  readPeople, readRelation, readCheckbox, readNumber,
};
