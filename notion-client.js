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

// 데이터소스 ID는 config.js의 기본값이 항상 있어서 사실상 언제나 true — 뷰(조회)는
// 아무 설정 없이도 바로 되어야 한다는 요구사항 때문에 별도 "설정 완료 여부" 게이트는 두지 않는다.
function hasValidSettings() {
  return true;
}

// 조회(읽기)는 비밀번호 없이, 생성/수정/삭제(쓰기)만 비밀번호가 필요 — 기존 work-hub와 동일.
// 쓰기 시도 시점에 비밀번호가 없으면 UI에 물어보게 하는 콜백을 app.js가 등록해둔다.
let authPrompter = null;
function setAuthPrompter(fn) { authPrompter = fn; }

// "사용자 모드로 전환" 버튼처럼, 쓰기 시도와 무관하게 수동으로 비밀번호 입력창을 띄우고 싶을 때 쓴다
async function promptAppSecret() {
  if (!authPrompter) return false;
  const entered = await authPrompter();
  if (!entered) return false;
  saveSettings({ ...getSettings(), appSecret: entered });
  return true;
}

function isReadPath(path, method) {
  if (method === "GET" || method === undefined) return true;
  return /\/(data_sources|databases)\/[^/]+\/query$/.test(path);
}

async function ensureAppSecret() {
  const existing = getSettings().appSecret;
  if (existing) return existing;
  if (!authPrompter) throw new Error("비밀번호가 필요합니다");
  const entered = await authPrompter();
  if (!entered) throw new Error("취소되었습니다");
  saveSettings({ ...getSettings(), appSecret: entered });
  return entered;
}

async function notionFetch(path, options = {}) {
  const method = options.method || "GET";
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (!isReadPath(path, method)) {
    headers["X-App-Secret"] = await ensureAppSecret();
  } else {
    const { appSecret } = getSettings();
    if (appSecret) headers["X-App-Secret"] = appSecret; // 있으면 같이 보내도 무해함
  }
  const res = await fetch(`${NOTION_API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) saveSettings({ ...getSettings(), appSecret: "" }); // 틀린 비번은 지워서 다음 시도 때 다시 묻게
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

async function getPage(pageId) {
  return notionFetch(`/pages/${pageId}`);
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

async function deleteBlock(blockId) {
  return notionFetch(`/blocks/${blockId}`, { method: "DELETE" });
}

async function listUsers() {
  const results = [];
  let cursor;
  do {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const page = await notionFetch(`/users${qs}`);
    results.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return results;
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
// 원본 work-hub 백엔드(notion/mappers.ts)와 동일하게 Notion이 준 날짜 문자열을 그대로 돌려준다 —
// 시간이 있는 값("2026-09-28T04:30:00.000+00:00")도 그대로 두는 게 맞다. app.js가 이미
// splitDateTime()/combineDateTime()으로 날짜·시간부를 알아서 나누고 합치도록 만들어져 있어서,
// 여기서 미리 잘라버리면 태스크의 마감 "시각"(예: 오후 3시 마감)이 통째로 사라진다.
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
  getSettings, saveSettings, hasValidSettings, setAuthPrompter, promptAppSecret,
  queryDatabaseAll, createPage, updatePageProperties, archivePage, getPage,
  getBlockChildren, appendBlockChildren, deleteBlock, listUsers,
  buildTitle, buildRichText, buildSelect, buildMultiSelect, buildDate,
  buildPeople, buildRelation, buildCheckbox, buildNumber, chunkString,
  readTitle, readRichText, readSelect, readMultiSelect, readDate, readDateEnd,
  readPeople, readRelation, readCheckbox, readNumber,
};
