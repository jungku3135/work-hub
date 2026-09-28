const TASK_STATUS = ["할 일", "진행중", "완료", "계획 취소"];
const CATEGORY = ["개인", "팀"];
const PRIORITY = ["높음", "보통", "낮음"];
const priorityRank = (t) => { const i = PRIORITY.indexOf(t.priority); return i === -1 ? PRIORITY.length : i; };
const RECURRENCE = ["없음", "매일", "매주", "매월"];
const WORK_TYPE = ["없음", "제품 개발/개선", "타부서 업무지원", "집진기 점검", "제품 설치", "사장님 지시", "상무님 지시", "휴가 및 사내 행사"];
const PROJECT_STATUS = ["계획", "진행중", "완료", "보류"];
const MEETING_TYPE = ["주간회의", "킥오프", "리뷰", "의사결정", "기타"];

const HIDDEN_PEOPLE_NAMES = new Set(["Notion MCP", "Testonic"]);

function visiblePeople() {
  return state.people.filter((p) => !HIDDEN_PEOPLE_NAMES.has(p.name));
}

// 태스크에 연결할 프로젝트 목록에서 완료·보류된 프로젝트는 뺀다 — 더 이상 진행하지 않는
// 프로젝트가 새 태스크의 선택지로 계속 뜨는 걸 막기 위함. 다만 이미 그 프로젝트로 연결된
// 기존 태스크를 수정할 때는(currentProjectId) 선택지가 사라져 연결이 끊기지 않도록 예외로 둔다.
function selectableProjectsFor(currentProjectId) {
  return state.projects.filter((p) => p.id === currentProjectId || (p.status !== "완료" && p.status !== "보류"));
}

const UTIL_LINK_ICON = "🔗";
const UTIL_LINKS = [
  { label: "모뎀 설치 현황 구글 시트", url: "https://docs.google.com/spreadsheets/d/1tw3OLjKuFf9Udyb5YIOet-cgUXHdyvTAGh5t2hE8zvE/edit?gid=59190594#gid=59190594" },
  { label: "집진기 점검 기록표 구글 시트", url: "https://docs.google.com/spreadsheets/d/1aZ6HAkcB1YRiLyXIq_ZzKYi4-iE_7E-hApki0PIzXMs/edit?usp=sharing" },
  // 이 사이트는 X-Frame-Options: SAMEORIGIN을 응답에 실어보내서 다른 도메인의 iframe에 못 들어감
  // (우리 쪽에서 우회할 방법이 없음) — 미리보기 없이 그냥 새 탭으로 열리게 둔다
  { label: "AIR MAX 대시보드", url: "https://airmax.testonic.co.kr/", noPreview: true },
  { label: "AIR MAX 점검 대시보드", url: "https://testonicrnd.github.io/airmax-inspector/" },
  { label: "3D Print Viewer", url: "https://user.tail1e87bb.ts.net/" },
  // http(평문) 사이트라 https인 이 앱 안에서 iframe으로 못 불러옴(Mixed Content, 브라우저가 강제 차단) —
  // 우리 쪽에서 우회할 방법이 없음. 미리보기 없이 그냥 새 탭으로 열리게 둔다
  { label: "Web Mail", url: "http://mail.testonic.co.kr/", noPreview: true },
];

const state = {
  tab: "dashboard",
  detailId: null,
  taskView: "board",
  showAllCompleted: false,
  filters: { category: "", projectId: "", assigneeId: "" },
  tasks: [],
  allTasks: [],
  projects: [],
  meetings: [],
  people: [],
  customPeople: [],
  dashboard: null,
  lastSyncTime: null,
  calendarYear: new Date().getFullYear(),
  calendarMonthIndex: new Date().getMonth(),
  holidaysByYear: {}, // { [year]: { "YYYY-MM-DD": "홀리데이명" } }
  reportTeamName: "시스템팀",
  reportStart: defaultWeekRange().start,
  reportEnd: defaultWeekRange().end,
};

const app = document.getElementById("app");
const modalRoot = document.getElementById("modal-root");
const authModalRoot = document.getElementById("auth-modal-root");
const toastEl = document.getElementById("toast");

// ---------- theme ----------

const THEME_KEY = "workhub-theme";

function currentEffectiveTheme() {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit) return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function updateThemeButton() {
  const btn = document.getElementById("theme-toggle-btn");
  if (btn) btn.textContent = currentEffectiveTheme() === "dark" ? "☀️" : "🌙";
}

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");
  updateThemeButton();
}

function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY));
  document.getElementById("theme-toggle-btn").onclick = () => {
    const next = currentEffectiveTheme() === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  };
}
initTheme();

// ---------- write-access auth gate ----------
// 서버 세션 대신 Cloudflare Worker 프록시가 매 쓰기 요청마다 비밀번호(X-App-Secret)를
// 검사하는 구조라(notion-client.js), "세션이 서버 재시작으로 끊긴다" 같은 개념 자체가 없다.
// 저장된 비밀번호가 있는지만 보면 되고, 틀렸으면 그 요청이 401로 실패하면서 자동으로 지워진다.

function getAuthToken() {
  return NC.getSettings().appSecret || null;
}

// notion-client.js가 쓰기 시도 시점에 이 프롬프터를 호출한다 — 기존 인증 모달 UI를 그대로 재활용
NC.setAuthPrompter(() => new Promise((resolve) => {
  openAuthModal(
    `<h3>🔒 비밀번호 확인</h3>
    <p class="muted" style="margin-top:-0.4rem;">작성·수정·삭제하려면 비밀번호를 입력하세요. 한 번 입력하면 이 브라우저에서는 다시 묻지 않습니다.</p>
    <form id="auth-form">
      <div class="field"><input type="password" name="password" placeholder="비밀번호" required /></div>
      <div class="modal-actions">
        <span></span>
        <div class="modal-actions-right">
          <button type="button" class="btn" id="auth-cancel-btn">취소</button>
          <button type="submit" class="btn btn-primary">확인</button>
        </div>
      </div>
    </form>`,
    (modal) => {
      modal.querySelector('input[name="password"]').focus();
      modal.querySelector("#auth-cancel-btn").onclick = () => { closeAuthModal(); resolve(null); };
      modal.querySelector("#auth-form").onsubmit = (e) => {
        e.preventDefault();
        closeAuthModal();
        updateModeIndicator();
        resolve(e.target.password.value);
      };
    }
  );
}));

// ---------- API (Notion 직통 어댑터로 위임 — notion-adapter.js) ----------
async function api(method, url, body) {
  return window.NotionAdapter.api(method, url, body);
}

function showToast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  toastEl.classList.toggle("toast-error", isError);
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.add("hidden"), 2800);
}

// 저장/수정 버튼을 두 번 눌러서 요청이 겹치는 걸 막는 공용 헬퍼 — 버튼을 "저장 중..."으로
// 바꾸고 비활성화했다가 끝나면(성공/실패 상관없이) 원래대로 되돌린다.
async function withSubmitGuard(button, loadingText, fn) {
  if (button.disabled) return;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = loadingText;
  try {
    await fn();
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

// ---------- 태스크 카드 빠른 상태 변경 버튼 ----------
// 태스크만 나열되는 여러 목록(마감 태스크 모달, 프로젝트 상세의 관련 태스크, 태스크 보드 등)에서
// 매번 수정 모달을 열지 않고도 바로 다음 단계로 넘길 수 있게 하는 공용 버튼.
// 노션 보드 뷰에서 드래그 없이도 카드 체크 한 번으로 상태를 바꾸는 느낌을 재현한 것.
// 할 일 -> 완료로 한 번에 건너뛰지 않도록, 한 단계씩만(할 일→진행중, 진행중→완료) 버튼을 보여준다.
function taskQuickActionsHtml(t) {
  if (t.status === "할 일") {
    return `<div class="task-quick-actions"><button type="button" class="btn task-quick-btn" data-task-id="${t.id}" data-status="진행중" title="진행중으로 변경">▶</button></div>`;
  }
  if (t.status === "진행중") {
    return `<div class="task-quick-actions"><button type="button" class="btn btn-primary task-quick-btn" data-task-id="${t.id}" data-status="완료" title="완료 처리">✓</button></div>`;
  }
  return "";
}

// root 안의 .task-quick-btn들에 클릭 핸들러를 붙인다. 카드 자체의 클릭(수정 모달 열기)으로
// 이벤트가 번지지 않게 막고, 성공하면 onSuccess(taskId, newStatus)로 알려줘서 호출하는 쪽에서
// (모달이면 카드 제거, 일반 화면이면 이미 refreshAfterTaskChange가 다시 그려주므로 필요시에만) 후처리한다
function attachTaskQuickActionEvents(root, onSuccess) {
  root.querySelectorAll(".task-quick-btn").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const taskId = btn.dataset.taskId;
      const status = btn.dataset.status;
      await withSubmitGuard(btn, status === "완료" ? "완료 처리 중..." : "변경 중...", async () => {
        try {
          await api("PATCH", `api/tasks/${taskId}`, { status });
          await refreshAfterTaskChange();
          showToast(status === "완료" ? "완료 처리되었습니다" : "진행중으로 변경되었습니다");
          onSuccess?.(taskId, status);
        } catch (err) {
          showToast(err.message, true);
        }
      });
    };
  });
}

// ---------- data loading ----------

async function loadAll() {
  const [tasks, projects, meetings, people, customPeople, dashboard, sync] = await Promise.all([
    api("GET", "api/tasks"),
    api("GET", "api/projects"),
    api("GET", "api/meetings"),
    api("GET", "api/people"),
    api("GET", "api/custom-people"),
    api("GET", "api/dashboard"),
    api("GET", "api/sync"),
  ]);
  Object.assign(state, {
    tasks,
    allTasks: tasks,
    projects,
    meetings,
    people,
    customPeople,
    dashboard,
    lastSyncTime: sync.lastSyncTime,
  });
  updateSyncLabel();
}

async function reloadTasks() {
  const q = new URLSearchParams();
  if (state.filters.category) q.set("category", state.filters.category);
  if (state.filters.projectId) q.set("projectId", state.filters.projectId);
  if (state.filters.assigneeId) q.set("assigneeId", state.filters.assigneeId);
  state.tasks = await api("GET", `api/tasks?${q}`);
}

// 필터와 무관하게 대시보드 달력 등에서 쓸 전체 태스크 목록 + 요약을 새로고침하고 현재 탭을 다시 그린다.
async function refreshAfterTaskChange() {
  const [filtered, all, dashboard] = await Promise.all([
    (async () => {
      const q = new URLSearchParams();
      if (state.filters.category) q.set("category", state.filters.category);
      if (state.filters.projectId) q.set("projectId", state.filters.projectId);
      if (state.filters.assigneeId) q.set("assigneeId", state.filters.assigneeId);
      return api("GET", `api/tasks?${q}`);
    })(),
    api("GET", "api/tasks"),
    api("GET", "api/dashboard"),
  ]);
  state.tasks = filtered;
  state.allTasks = all;
  state.dashboard = dashboard;
  render();
  // 새로 만들거나 시간을 바꾼 태스크도 리마인더가 걸리게, 태스크가 바뀔 때마다 오늘 몫을 다시 예약함
  // (페이지 새로고침 때만 걸리면 로드 이후에 만든 태스크는 리마인더가 영영 안 걸림)
  scheduleTodayReminders(tasksForDay(todayISO()));
}

function updateSyncLabel() {
  const label = document.getElementById("last-sync-label");
  if (!state.lastSyncTime) {
    label.textContent = "동기화 전";
    return;
  }
  const d = new Date(state.lastSyncTime);
  label.textContent = `마지막 동기화 ${d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`;
}

// 서버가 백그라운드에서 주기적으로 동기화해도 탭을 계속 열어두면 화면이 그 시점 그대로 멈춰 있던 문제 —
// 1분마다 마지막 동기화 시각을 확인해서, 서버 쪽에서 새로 동기화된 게 있으면 조용히 데이터를 새로고침한다.
const SYNC_POLL_MS = 60_000;

function startSyncStatusPoll() {
  setInterval(async () => {
    try {
      const sync = await api("GET", "api/sync");
      if (sync.lastSyncTime && sync.lastSyncTime !== state.lastSyncTime) {
        await loadAll();
        render();
      }
    } catch {
      // 조용히 실패, 다음 폴링에서 재시도
    }
  }, SYNC_POLL_MS);
}

// ---------- helpers ----------

function personName(id) {
  return state.people.find((p) => p.id === id)?.name ?? "?";
}

// Notion 계정이 있는 담당자(people)와 커스텀(자유 입력) 담당자 이름을 합쳐서 다룰 때 공통으로 쓰는 헬퍼들
function combinedNames(people, customNames) {
  return [...(people || []).map((p) => p.name), ...(customNames || [])];
}

function combinedTags(people, customNames) {
  const names = combinedNames(people, customNames);
  if (!names.length) return `<span class="muted">-</span>`;
  return names.map((n) => `<span class="tag">${escapeHtml(n)}</span>`).join(" ");
}

function combinedNamesText(people, customNames) {
  const names = combinedNames(people, customNames);
  return names.length ? names.map((n) => escapeHtml(n)).join(", ") : "-";
}

function allAssigneeTags(task) {
  return combinedTags(task.assignees, task.customAssignees);
}

function allAssigneeNamesText(task) {
  return combinedNamesText(task.assignees, task.customAssignees);
}

function tag(value, className) {
  if (!value) return "";
  const safeClass = value.replace(/\s+/g, "-");
  return `<span class="tag ${className}-${safeClass}">${escapeHtml(value)}</span>`;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- date/time helpers ----------

function pad2(n) {
  return String(n).padStart(2, "0");
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDaysISO(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

// Notion 날짜 값은 "YYYY-MM-DD" 또는 시간 포함 ISO 문자열일 수 있음 → 편집 폼에서 쓸 수 있게 분리
function splitDateTime(iso) {
  if (!iso) return { date: "", time: "" };
  if (!iso.includes("T")) return { date: iso.slice(0, 10), time: "" };
  const d = new Date(iso);
  if (isNaN(d)) return { date: iso.slice(0, 10), time: "" };
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  };
}

function combineDateTime(date, time) {
  if (!date) return null;
  if (!time) return date;
  const d = new Date(`${date}T${time}`);
  return isNaN(d) ? date : d.toISOString();
}

function formatTaskDate(iso) {
  const { date, time } = splitDateTime(iso);
  if (!date) return "";
  return time ? `${date} ${time}` : date;
}

function formatDotDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${y.slice(2)}.${m}.${d}`;
}

// 태스크가 캘린더/업무일지에서 걸치는 날짜 범위: 시작일~마감일, 한쪽만 있으면 그 날 하루
function taskEffRange(t) {
  const s = splitDateTime(t.startDate).date;
  const d = splitDateTime(t.dueDate).date;
  if (!s && !d) return null;
  return { start: s || d, end: d || s };
}

function defaultWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() + (day === 0 ? -6 : 1 - day));
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return { start: fmt(monday), end: fmt(friday) };
}

function projectName(id) {
  return state.projects.find((p) => p.id === id)?.name ?? "";
}

function options(list, selected) {
  return list.map((v) => `<option value="${v}" ${v === selected ? "selected" : ""}>${v}</option>`).join("");
}

function peopleChecks(name, selectedIds = []) {
  const people = visiblePeople();
  if (!people.length) return `<span class="muted">워크스페이스 사용자가 없습니다</span>`;
  return `<div class="people-checks">${people
    .map(
      (p) =>
        `<label><input type="checkbox" name="${name}" value="${p.id}" ${selectedIds.includes(p.id) ? "checked" : ""}/>${escapeHtml(p.name)}</label>`
    )
    .join("")}</div>`;
}

function customPeopleChecks(name, selectedNames = []) {
  if (!state.customPeople.length) return `<span class="muted">등록된 이름이 없습니다. 아래에서 추가해보세요.</span>`;
  return `<div class="people-checks">${state.customPeople
    .map(
      (n) =>
        `<label><input type="checkbox" name="${name}" value="${escapeHtml(n)}" ${selectedNames.includes(n) ? "checked" : ""}/>${escapeHtml(n)}</label>`
    )
    .join("")}</div>`;
}

function checkedValues(form, name) {
  return Array.from(form.querySelectorAll(`input[name="${name}"]:checked`)).map((el) => el.value);
}

// 담당자/참석자 폼에서 "커스텀 인원(Notion 계정 없는 인원)" 필드 — 태스크/프로젝트/회의록 공통
function customPersonFieldHtml(checkboxFieldName, selectedNames) {
  return `<div class="field">
    <label>커스텀 인원 <span class="muted">(Notion 계정 없는 인원)</span></label>
    <div id="custom-people-checks">${customPeopleChecks(checkboxFieldName, selectedNames)}</div>
    <input type="text" id="new-custom-person" placeholder="새 이름 입력 후 Enter로 추가" />
  </div>`;
}

// 위 필드의 "새 이름 입력 후 Enter" 동작을 연결. checkboxFieldName은 customPersonFieldHtml에 넘긴 것과 같아야 함
function attachCustomPersonInput(modal, form, checkboxFieldName) {
  modal.querySelector("#new-custom-person").addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const input = e.target;
    const name = input.value.trim();
    if (!name) return;
    try {
      const alreadyChecked = checkedValues(form, checkboxFieldName);
      state.customPeople = await api("POST", "api/custom-people", { name });
      input.value = "";
      modal.querySelector("#custom-people-checks").innerHTML = customPeopleChecks(checkboxFieldName, [
        ...alreadyChecked,
        name,
      ]);
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

// ---------- modal ----------

function openModal(html, onMount, extraClass = "", onClose) {
  modalRoot.innerHTML = `<div class="modal ${extraClass}">${html}</div>`;
  modalRoot.classList.remove("hidden");
  modalRoot._onCloseCb = onClose || null;
  onMount?.(modalRoot.querySelector(".modal"));
  modalRoot.onclick = (e) => {
    if (e.target === modalRoot) closeModal();
  };
}

function closeModal() {
  const cb = modalRoot._onCloseCb;
  modalRoot._onCloseCb = null;
  modalRoot.classList.add("hidden");
  modalRoot.innerHTML = "";
  cb?.();
}

// 인증 프롬프트 전용 오버레이 — modalRoot와 완전히 분리해서, 이미 열려있는 모달(예: 태스크 작성 폼)
// 위에 떠도 그 내용을 지우지 않게 한다.
function openAuthModal(html, onMount) {
  authModalRoot.innerHTML = `<div class="modal">${html}</div>`;
  authModalRoot.classList.remove("hidden");
  onMount?.(authModalRoot.querySelector(".modal"));
}

function closeAuthModal() {
  authModalRoot.classList.add("hidden");
  authModalRoot.innerHTML = "";
}

// ---------- tabs ----------

// [data-tab] 한정: 유틸리티 드롭다운 버튼도 스타일 통일을 위해 tab-btn 클래스를 쓰지만
// 실제 탭 전환 대상이 아니라서 여기 걸리면 안 됨 (data-tab 속성이 없음)
document.querySelectorAll(".tab-btn[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn[data-tab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.tab = btn.dataset.tab;
    state.detailId = null;
    render();
  });
});

document.getElementById("sync-now-btn").addEventListener("click", async (e) => {
  e.target.disabled = true;
  e.target.textContent = "동기화 중...";
  try {
    const result = await api("POST", "api/sync");
    state.lastSyncTime = result.lastSyncTime;
    await loadAll();
    render();
    showToast(`동기화 완료 (태스크 ${result.tasks}, 프로젝트 ${result.projects}, 회의록 ${result.meetings})`);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    e.target.disabled = false;
    e.target.textContent = "지금 동기화";
  }
});

// ---------- render router ----------

function render() {
  if (state.tab === "dashboard") return renderDashboard();
  if (state.tab === "tasks") return renderTasks();
  if (state.tab === "projects") return renderProjects();
  if (state.tab === "project-detail") return renderProjectDetail();
  if (state.tab === "meetings") return renderMeetings();
  if (state.tab === "report") return renderReport();
}

// ---------- dashboard ----------

// ---------- 대시보드 상단 위젯 (플립 시계 + 오늘 날씨) ----------

function flipUnitHtml(unit, size = "") {
  return `
    <div class="flip-unit ${size === "sm" ? "flip-unit-sm" : ""}" data-unit="${unit}">
      <div class="flip-half top" data-role="static-top"><span class="flip-num"></span></div>
      <div class="flip-half bottom" data-role="static-bottom"><span class="flip-num"></span></div>
      <div class="flip-leaf flip-leaf-top" data-role="leaf-top"><span class="flip-num"></span></div>
      <div class="flip-leaf flip-leaf-bottom" data-role="leaf-bottom"><span class="flip-num"></span></div>
      <div class="flip-hinge"><span class="flip-pin"></span><span class="flip-pin"></span></div>
    </div>`;
}

function heroWidgetHtml(d) {
  const stat = (id, num, label) => `<div class="hero-stat" id="${id}"><div class="hero-stat-num">${num}</div><div class="hero-stat-label">${label}</div></div>`;
  return `
    <div class="hero-widget">
      <div class="flip-clock">
        <div class="flip-clock-units">
          <div class="flip-ampm" id="flip-ampm">--</div>
          ${flipUnitHtml("hour")}
          <div class="flip-colon">:</div>
          ${flipUnitHtml("minute")}
          <div class="flip-colon">:</div>
          ${flipUnitHtml("second", "sm")}
        </div>
        <div class="flip-clock-base"></div>
      </div>
      <div class="weather-widget">
        <div class="weather-icon" id="weather-icon"></div>
        <div class="weather-info">
          <div class="weather-temp" id="weather-temp">--°</div>
          <div class="weather-label" id="weather-label">날씨 불러오는 중...</div>
        </div>
      </div>
      <div class="hero-stats">
        ${stat("stat-today-tasks", d.todayTaskCount, "오늘 마감 태스크")}
        ${stat("stat-week-tasks", d.weekTaskCount, "이번 주 마감 태스크")}
        ${stat("stat-active-projects", d.activeProjectCount, "진행중 프로젝트")}
        ${stat("stat-all-meetings", state.meetings.length, "전체 회의록")}
      </div>
    </div>`;
}

let flipClockTimer = null;

// 플립 유닛 하나의 표시값을 바꾼다. 최초 렌더(oldValue 없음)는 애니메이션 없이 바로 채우고,
// 이후 값이 바뀔 때만 위쪽 반이 뒤로 접히며 사라지고 → 아래쪽 반이 앞으로 접히며 나타나는
// 2단계 플립(기계식 플립 시계 느낌)으로 전환한다.
function updateFlipUnit(root, newValue) {
  if (!root || root.dataset.value === newValue) return;
  const staticTop = root.querySelector('[data-role="static-top"] .flip-num');
  const staticBottom = root.querySelector('[data-role="static-bottom"] .flip-num');
  const leafTop = root.querySelector('[data-role="leaf-top"]');
  const leafTopNum = leafTop.querySelector(".flip-num");
  const leafBottom = root.querySelector('[data-role="leaf-bottom"]');
  const leafBottomNum = leafBottom.querySelector(".flip-num");
  const oldValue = root.dataset.value;

  if (oldValue === undefined) {
    staticTop.textContent = newValue;
    staticBottom.textContent = newValue;
    leafTopNum.textContent = newValue;
    leafBottomNum.textContent = newValue;
    root.dataset.value = newValue;
    return;
  }

  root.classList.add("is-flipping");
  leafTopNum.textContent = oldValue;
  leafTop.style.transition = "none";
  leafTop.style.transform = "rotateX(0deg)";
  staticTop.textContent = newValue;

  leafBottomNum.textContent = newValue;
  leafBottom.style.transition = "none";
  leafBottom.style.transform = "rotateX(90deg)";

  void leafTop.offsetHeight; // transition:none을 강제로 반영시킨 뒤에 애니메이션을 시작하기 위한 리플로우

  requestAnimationFrame(() => {
    // 위쪽 잎은 중력에 끌려 떨어지듯 가속하며 접히고(ease-in), 아래쪽 잎은 착지할 때 살짝
    // 튕기는 느낌(back-out 계열 베지어)을 줘서 기계식 플립 특유의 "짤깍" 하는 손맛을 낸다
    leafTop.style.transition = "transform 260ms cubic-bezier(0.55, 0, 0.85, 0.35)";
    leafTop.style.transform = "rotateX(-90deg)";
  });
  setTimeout(() => {
    leafBottom.style.transition = "transform 280ms cubic-bezier(0.34, 1.56, 0.64, 1)";
    leafBottom.style.transform = "rotateX(0deg)";
  }, 250);
  setTimeout(() => {
    staticBottom.textContent = newValue;
    leafTop.style.transition = "none";
    leafTop.style.transform = "rotateX(0deg)";
    leafTopNum.textContent = newValue;
    leafBottom.style.transition = "none";
    leafBottom.style.transform = "rotateX(90deg)";
    root.dataset.value = newValue;
    root.classList.remove("is-flipping");
  }, 560);
}

function tickFlipClock() {
  const hourRoot = document.querySelector('.flip-unit[data-unit="hour"]');
  const minuteRoot = document.querySelector('.flip-unit[data-unit="minute"]');
  const secondRoot = document.querySelector('.flip-unit[data-unit="second"]');
  if (!hourRoot || !minuteRoot || !secondRoot) return; // 대시보드가 아닌 다른 화면으로 이동한 상태
  const now = new Date();
  let h = now.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  updateFlipUnit(hourRoot, String(h).padStart(2, "0"));
  updateFlipUnit(minuteRoot, String(now.getMinutes()).padStart(2, "0"));
  updateFlipUnit(secondRoot, String(now.getSeconds()).padStart(2, "0"));
  const ampmEl = document.getElementById("flip-ampm");
  if (ampmEl) ampmEl.textContent = ampm;
}

function initFlipClock() {
  if (flipClockTimer) clearInterval(flipClockTimer);
  tickFlipClock();
  flipClockTimer = setInterval(tickFlipClock, 1000);
}

// 날씨 상태별로 CSS만으로 움직이는 귀여운 아이콘을 그린다 (외부 gif 의존 없음)
function weatherIconHtml(category, isDay) {
  const sun = (small) =>
    `<div class="w-sun${small ? " w-sun-sm" : ""}"><div class="w-sun-core"></div>${Array.from({ length: 8 })
      .map((_, i) => `<div class="w-sun-ray" style="--i:${i}"></div>`)
      .join("")}</div>`;
  const moon = (small) => `<div class="w-moon${small ? " w-moon-sm" : ""}"></div>`;
  // 박스섀도우로 구름 모양을 흉내내면 뭉개져 보여서, 알아보기 쉽게 SVG 3덩이+받침 모양으로 직접 그린다
  const cloud = (cls = "") =>
    `<svg class="w-cloud ${cls}" viewBox="0 0 64 40" xmlns="http://www.w3.org/2000/svg">
      <circle cx="20" cy="18" r="10"/><circle cx="33" cy="13" r="13"/><circle cx="46" cy="19" r="9"/>
      <rect x="10" y="18" width="44" height="16" rx="8"/>
    </svg>`;
  const rain = () =>
    Array.from({ length: 4 })
      .map((_, i) => `<div class="w-rain-drop" style="--i:${i}"></div>`)
      .join("");
  const snow = () =>
    Array.from({ length: 4 })
      .map((_, i) => `<div class="w-snow-flake" style="--i:${i}"></div>`)
      .join("");

  switch (category) {
    case "clear":
      return isDay ? sun(false) : moon(false);
    case "partly-cloudy":
      return `${isDay ? sun(true) : moon(true)}${cloud()}`;
    case "cloudy":
      return `${cloud("w-cloud-back")}${cloud("w-cloud-big")}`;
    case "rain":
      return `${cloud()}${rain()}`;
    case "snow":
      return `${cloud()}${snow()}`;
    case "thunder":
      return `${cloud("w-cloud-dark")}<div class="w-bolt"></div>${rain()}`;
    case "fog":
      return [0, 1, 2].map((i) => `<div class="w-fog-line" style="top:${16 + i * 12}px; animation-delay:${i * 0.4}s"></div>`).join("");
    default:
      return cloud();
  }
}

async function loadWeatherWidget() {
  const iconEl = document.getElementById("weather-icon");
  const tempEl = document.getElementById("weather-temp");
  const labelEl = document.getElementById("weather-label");
  if (!iconEl) return;
  try {
    const w = await api("GET", "api/weather");
    if (!iconEl.isConnected) return; // 응답 오는 사이 다른 화면으로 이동했을 수 있음
    if (!w) {
      labelEl.textContent = "날씨 정보를 가져올 수 없습니다";
      return;
    }
    tempEl.textContent = `${w.temp}°`;
    labelEl.textContent = `${w.location} · ${w.label}`;
    iconEl.className = `weather-icon weather-${w.category}`;
    iconEl.innerHTML = weatherIconHtml(w.category, w.isDay);
  } catch (err) {
    if (labelEl.isConnected) labelEl.textContent = "날씨를 불러올 수 없습니다";
  }
}

async function renderDashboard() {
  await ensureHolidays(state.calendarYear);
  const d = state.dashboard ?? { todayTaskCount: 0, weekTaskCount: 0, activeProjectCount: 0, recentMeetings: [] };
  app.innerHTML = `
    ${heroWidgetHtml(d)}
    <div class="dashboard-main">
      <div class="dashboard-calendar-col">${calendarHtml()}</div>
      <div class="dashboard-todo-col">${todoListHtml()}</div>
    </div>
    <div class="section-header"><h2>최근 회의록</h2></div>
    <div class="card-list" id="recent-meetings"></div>
  `;
  attachCalendarEvents();
  attachStatCardEvents();
  attachTodoListEvents();
  initFlipClock();
  loadWeatherWidget();
  const list = document.getElementById("recent-meetings");
  if (!d.recentMeetings.length) {
    list.innerHTML = `<span class="muted">아직 회의록이 없습니다</span>`;
  } else {
    d.recentMeetings.forEach((m) => list.appendChild(meetingMiniCard(m)));
  }
}

// 대시보드 한편에 보여줄 "할 일" 상태 태스크 목록 — 마감일 빠른 순으로 정렬
function todoListHtml() {
  const todos = state.allTasks
    .filter((t) => t.status === "할 일")
    .sort((a, b) => {
      const da = splitDateTime(a.dueDate).date || "9999-99-99";
      const db = splitDateTime(b.dueDate).date || "9999-99-99";
      return da < db ? -1 : da > db ? 1 : 0;
    });
  const TODO_LIMIT = 10;
  const shown = todos.slice(0, TODO_LIMIT);

  return `
    <div class="todo-panel">
      <div class="todo-panel-header">
        <h3>할 일 목록</h3>
        <span class="tag">${todos.length}</span>
      </div>
      <div class="card-list" id="todo-list">
        ${
          shown.length
            ? shown
                .map(
                  (t) => `
          <div class="mini-card todo-item" data-task-id="${t.id}">
            <div class="title">${escapeHtml(t.name)}</div>
            <div class="meta" style="margin-top:0.3rem; display:flex; gap:0.3rem; flex-wrap:wrap;">
              ${tag(t.priority, "priority")}
              ${t.dueDate ? `<span class="tag">~${formatTaskDate(t.dueDate)}</span>` : ""}
            </div>
          </div>`
                )
                .join("")
            : '<span class="muted">할 일이 없습니다</span>'
        }
      </div>
      ${todos.length > TODO_LIMIT ? `<button type="button" class="btn btn-sm" id="todo-view-all-btn" style="margin-top:0.6rem; width:100%;">전체 ${todos.length}개 보기</button>` : ""}
    </div>
  `;
}

function attachTodoListEvents() {
  document.querySelectorAll(".todo-item").forEach((el) => {
    el.onclick = () => openTaskModal(state.allTasks.find((t) => t.id === el.dataset.taskId));
  });
  document.getElementById("todo-view-all-btn")?.addEventListener("click", () => {
    state.tab = "tasks";
    render();
  });
}

function attachStatCardEvents() {
  document.getElementById("stat-today-tasks").onclick = () => {
    const today = todayISO();
    const tasks = state.allTasks.filter((t) => splitDateTime(t.dueDate).date === today && t.status !== "완료");
    openTaskListModal("오늘 마감 태스크", tasks);
  };
  document.getElementById("stat-week-tasks").onclick = () => {
    const today = todayISO();
    const weekEnd = addDaysISO(today, 7);
    const tasks = state.allTasks.filter((t) => {
      const due = splitDateTime(t.dueDate).date;
      return due && due >= today && due <= weekEnd && t.status !== "완료";
    });
    openTaskListModal("이번 주 마감 태스크", tasks);
  };
  document.getElementById("stat-active-projects").onclick = () => {
    const projects = state.projects.filter((p) => p.status === "진행중");
    openProjectListModal("진행중 프로젝트", projects);
  };
  document.getElementById("stat-all-meetings").onclick = () => {
    openMeetingListModal("전체 회의록", state.meetings);
  };
}

// ---------- calendar ----------

// 공휴일 목록은 연도 단위로 캐시해서 한 번만 불러온다
async function ensureHolidays(year) {
  if (state.holidaysByYear[year]) return;
  try {
    const list = await api("GET", `api/holidays?year=${year}`);
    const map = {};
    for (const h of list) map[h.date] = h.name;
    state.holidaysByYear[year] = map;
  } catch {
    state.holidaysByYear[year] = {}; // 실패해도 캘린더는 정상 표시되게
  }
}

// 주말(토/일) 또는 공휴일인지 — 캘린더에서 "쉬는 날" 여부 판단에 사용
function isOffDay(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  const holidayName = state.holidaysByYear[y]?.[dateKey];
  return dow === 0 || dow === 6 || !!holidayName;
}

// 캘린더 항목(하루짜리 칩 또는 여러 날 막대) 공통 클래스/라벨 계산
function calItemModifierClasses(t) {
  const isClosed = t.status === "완료" || t.status === "계획 취소";
  const doneClass = t.status === "완료" ? "cal-item-done" : t.status === "계획 취소" ? "cal-item-cancelled" : "";
  const priorityClass = !isClosed && t.priority ? `cal-priority-${t.priority}` : "";
  return `${priorityClass} ${doneClass}`;
}

function calItemLabel(t) {
  return `${t.holidayWork ? "🏢 " : ""}${escapeHtml(t.name)}`;
}

function calItemTitle(t) {
  return escapeHtml(`${t.name}${t.holidayWork ? " (휴일 근무)" : ""}`);
}

function calItemChipHtml(t) {
  return `<div class="cal-item ${calItemModifierClasses(t)}" data-task-id="${t.id}" title="${calItemTitle(t)}">${calItemLabel(t)}</div>`;
}

// 이틀 이상 걸치는 태스크를 나타내는 막대 — 요일 칸 격자 위에 겹쳐서(overlay) 그리기 때문에
// 실제 칸 경계와 정확히 맞도록 gap(4px)까지 감안해서 퍼센트 계산을 해준다 (7칸, 칸 사이 gap 6개).
// cellInset은 칸의 테두리(1px)+안쪽 여백만큼인데, 단일 항목 칩도 그만큼 안쪽에서 시작하므로
// 막대의 시작/끝 위치도 똑같이 안쪽으로 들여서 칩과 막대의 시작점이 어긋나지 않게 맞춘다.
function calBarHtml(bar, barTop, cellInset) {
  const t = bar.task;
  const span = bar.endCol - bar.startCol + 1;
  const left = `calc(${bar.startCol} * ((100% - 24px) / 7 + 4px) + ${cellInset}px)`;
  const width = `calc(${span} * (100% - 24px) / 7 + ${Math.max(span - 1, 0)} * 4px - ${cellInset * 2}px)`;
  const style = `left:${left}; width:${width}; top:${barTop}px;`;
  return `<div class="cal-item cal-bar ${calItemModifierClasses(t)}" data-task-id="${t.id}" title="${calItemTitle(t)}" style="${style}">${calItemLabel(t)}</div>`;
}

function calendarHtml() {
  const year = state.calendarYear;
  const month = state.calendarMonthIndex;
  const startWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = todayISO();
  const holidays = state.holidaysByYear[year] ?? {};
  const closedRank = (t) => (t.status === "완료" || t.status === "계획 취소" ? 1 : 0);
  // 칩(.cal-item)과 막대(.cal-bar)는 모두 15px 높이 + 2px 간격 = 17px 간격(row step)으로
  // CSS에서 통일해뒀다 — 이 값이 어긋나면 칩과 막대의 세로 간격이 서로 달라 보인다.
  // 모바일에서는 셀/글자 크기가 작아지므로 별도 상수를 쓴다 (style.css @media 720px 값과 맞춤).
  const isMobile = window.matchMedia("(max-width: 720px)").matches;
  const CELL_HEIGHT = isMobile ? 92 : 132;
  const BAR_TOP_START = isMobile ? 25 : 30; // 칸 padding + 날짜 숫자 한 줄 높이(대략)
  const BAR_LANE_STEP = isMobile ? 14 : 17;
  const ITEMS_PER_CELL = Math.floor((CELL_HEIGHT - BAR_TOP_START) / BAR_LANE_STEP);
  const CELL_INSET = isMobile ? 3 : 5; // 칸 테두리(1px) + 안쪽 여백(모바일 2px / 데스크톱 4px)
  // 겹치는 기간 막대가 너무 많아지면 칸 높이를 뚫고 계속 밑으로 늘어나면서 캘린더 전체가
  // 무너지므로, 레인 수를 여기서 못 박아둔다 — 그 이상은 막대로 그리지 않고 "+N"으로 뭉뚱그림
  const MAX_BAR_LANES = Math.max(1, Math.floor(ITEMS_PER_CELL / 2));

  // 이번 달 날짜를 주(7일) 단위로 묶는다. 달 앞뒤로 남는 칸은 빈 칸(null)으로 채움
  const weeks = [];
  let week = new Array(startWeekday).fill(null);
  for (let day = 1; day <= daysInMonth; day++) {
    week.push({ day, dateKey: `${year}-${pad2(month + 1)}-${pad2(day)}` });
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }

  // 이틀 이상 걸치는 태스크는 특정 하루의 업무가 아니라 기간 자체를 나타내므로,
  // 주말/공휴일 숨김과 무관하게 항상 막대로 이어서 표시한다
  const spanningTasks = state.allTasks.filter((t) => {
    const r = taskEffRange(t);
    return r && r.start !== r.end;
  });

  const weeksHtml = weeks
    .map((weekSlots) => {
      const realSlots = weekSlots.map((s, i) => (s ? { ...s, col: i } : null)).filter(Boolean);
      const bars = [];
      const hiddenBarCountByCol = new Array(7).fill(0);
      if (realSlots.length) {
        const weekStartKey = realSlots[0].dateKey;
        const weekEndKey = realSlots[realSlots.length - 1].dateKey;
        const candidates = [];
        for (const t of spanningTasks) {
          const r = taskEffRange(t);
          if (r.end < weekStartKey || r.start > weekEndKey) continue;
          const clippedStart = r.start < weekStartKey ? weekStartKey : r.start;
          const clippedEnd = r.end > weekEndKey ? weekEndKey : r.end;
          const startSlot = realSlots.find((s) => s.dateKey === clippedStart);
          const endSlot = realSlots.find((s) => s.dateKey === clippedEnd);
          if (!startSlot || !endSlot) continue;
          if (t.holidayWork) {
            // 휴일 근무로 표시된 태스크는 주말/공휴일에도 실제로 일하는 거라 계속 이어서 보여준다
            candidates.push({ task: t, startCol: startSlot.col, endCol: endSlot.col });
          } else {
            // 휴일 근무가 아니면 단일 항목 칩과 똑같이 주말/공휴일 칸은 막대에서 빼야 한다.
            // 이어지는 칸을 통째로 그릴 수 없으니, 근무일이 연속되는 구간별로 막대를 쪼개서 그린다
            let segStart = null;
            for (let col = startSlot.col; col <= endSlot.col; col++) {
              const slot = realSlots.find((s) => s.col === col);
              const off = !slot || isOffDay(slot.dateKey);
              if (!off) {
                if (segStart === null) segStart = col;
              } else if (segStart !== null) {
                candidates.push({ task: t, startCol: segStart, endCol: col - 1 });
                segStart = null;
              }
            }
            if (segStart !== null) candidates.push({ task: t, startCol: segStart, endCol: endSlot.col });
          }
        }
        // 시작 열 순서로 정렬 후, 겹치지 않는 첫 레인에 그리디하게 배정 (구글 캘린더식 레인 packing)
        candidates.sort((a, b) => a.startCol - b.startCol || b.endCol - b.startCol - (a.endCol - a.startCol) || priorityRank(a.task) - priorityRank(b.task));
        const laneEnds = [];
        for (const bar of candidates) {
          let lane = laneEnds.findIndex((end) => end < bar.startCol);
          if (lane === -1) {
            lane = laneEnds.length;
            laneEnds.push(bar.endCol);
          } else {
            laneEnds[lane] = bar.endCol;
          }
          // 레인 상한을 넘는 막대는 그리지 않고, 그 막대가 지나가는 칸들의 "숨은 일정 수"로만 센다
          // (해당 날짜를 클릭하면 openDayTaskList로 전체 목록을 볼 수 있음)
          if (lane < MAX_BAR_LANES) bars.push({ ...bar, lane });
          else for (let c = bar.startCol; c <= bar.endCol; c++) hiddenBarCountByCol[c] = (hiddenBarCountByCol[c] ?? 0) + 1;
        }
      }
      // 막대는 요일 칸 위에 겹쳐서(overlay) 그린다 — 날짜 숫자 바로 아래부터 시작해서 헷갈리지 않게.
      // 그만큼 칸 안의 일반 항목 목록은 아래로 밀어야 하는데, 주 전체의 최대 레인 수를 모든 칸에
      // 똑같이 적용하면 막대가 안 지나가는 칸까지 불필요하게 밀려서 항목이 붕 뜬 섬처럼 보인다.
      // 그래서 각 칸에 실제로 걸치는 막대 레인 수만큼만 그 칸의 항목을 내린다.
      const laneCountByCol = new Array(7).fill(0);
      for (const bar of bars) {
        for (let c = bar.startCol; c <= bar.endCol; c++) {
          laneCountByCol[c] = Math.max(laneCountByCol[c], bar.lane + 1);
        }
      }

      const cellsHtml = weekSlots
        .map((slot, col) => {
          if (!slot) return `<div class="cal-cell cal-empty" style="grid-column:${col + 1};"></div>`;
          const { day, dateKey } = slot;
          const dow = col;
          const holidayName = holidays[dateKey];
          const dayIsOff = holidayName ? true : dow === 0 || dow === 6;
          const cellClasses = [
            dateKey === todayKey ? "cal-today" : "",
            holidayName ? "cal-holiday" : dow === 0 ? "cal-sunday" : dow === 6 ? "cal-saturday" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const items = state.allTasks
            .filter((t) => {
              const r = taskEffRange(t);
              if (!r || r.start !== dateKey || r.end !== dateKey) return false; // 여러 날 걸치는 태스크는 막대로만 표시
              if (dayIsOff && !t.holidayWork) return false;
              return true;
            })
            .sort((a, b) => closedRank(a) - closedRank(b) || priorityRank(a) - priorityRank(b));
          const itemsMarginTop = laneCountByCol[col] * BAR_LANE_STEP;
          // 그 칸을 지나가는 막대가 차지한 줄 수만큼 뺀 "실제로 남는 줄 수"를 기준으로 넘치는 항목을 계산한다.
          // 넘칠 때는 한 줄을 "+N" 표시용으로 남겨두고, 남는 줄이 아예 없으면 아무것도 그리지 않는다(막대만 보임).
          // 레인 상한에 걸려 막대로 못 그린 기간 일정도 이 "+N"에 합쳐서 표시한다.
          const availableRows = Math.max(0, ITEMS_PER_CELL - laneCountByCol[col]);
          const hiddenBars = hiddenBarCountByCol[col];
          const needIndicator = items.length > availableRows || hiddenBars > 0;
          const showCount = needIndicator ? Math.max(0, Math.min(items.length, availableRows - 1)) : items.length;
          const hiddenCount = items.length - showCount + hiddenBars;
          return `
            <div class="cal-cell ${cellClasses}" data-date="${dateKey}" style="grid-column:${col + 1};">
              <div class="cal-day">
                <span class="cal-day-num">${day}</span>
                ${holidayName ? `<span class="cal-holiday-name" title="${escapeHtml(holidayName)}">${escapeHtml(holidayName)}</span>` : ""}
              </div>
              <div class="cal-items" style="${itemsMarginTop ? `margin-top:${itemsMarginTop}px;` : ""}">
                ${items.slice(0, showCount).map((t) => calItemChipHtml(t)).join("")}
                ${hiddenCount > 0 && availableRows > 0 ? `<div class="cal-more">+${hiddenCount}</div>` : ""}
              </div>
            </div>`;
        })
        .join("");

      const barsHtml = bars.map((bar) => calBarHtml(bar, BAR_TOP_START + bar.lane * BAR_LANE_STEP, CELL_INSET)).join("");

      return `<div class="cal-week"><div class="cal-week-cells">${cellsHtml}</div><div class="cal-week-bars">${barsHtml}</div></div>`;
    })
    .join("");

  return `
    <div class="calendar">
      <div class="calendar-header">
        <button class="btn btn-sm" id="cal-prev">‹</button>
        <div class="calendar-title">${year}년 ${month + 1}월</div>
        <button class="btn btn-sm" id="cal-next">›</button>
      </div>
      <div class="cal-grid cal-grid-header">${["일", "월", "화", "수", "목", "금", "토"].map((w) => `<div class="cal-weekday">${w}</div>`).join("")}</div>
      <div class="cal-weeks">${weeksHtml}</div>
    </div>
  `;
}

function attachCalendarEvents() {
  document.getElementById("cal-prev").onclick = async () => {
    shiftCalendarMonth(-1);
    await renderDashboard();
  };
  document.getElementById("cal-next").onclick = async () => {
    shiftCalendarMonth(1);
    await renderDashboard();
  };
  document.querySelectorAll(".cal-item").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      openTaskModal(state.allTasks.find((t) => t.id === el.dataset.taskId));
    };
  });
  document.querySelectorAll(".cal-cell[data-date]").forEach((cell) => {
    cell.onclick = () => openDayTaskList(cell.dataset.date);
  });
}

// 특정 날짜(dateKey)에 해당하는 태스크 목록 — 캘린더 날짜 클릭과 "오늘의 업무" 팝업이 공유
function tasksForDay(dateKey) {
  const dayIsOff = isOffDay(dateKey);
  const items = state.allTasks.filter((t) => {
    const r = taskEffRange(t);
    if (!(r && r.start <= dateKey && r.end >= dateKey)) return false;
    // 여러 날 걸치는 태스크도 단일 항목과 똑같이, 휴일 근무가 아니면 주말/공휴일엔 표시하지 않는다
    if (dayIsOff && !t.holidayWork) return false;
    return true;
  });
  const closedRank = (t) => (t.status === "완료" || t.status === "계획 취소" ? 1 : 0);
  items.sort((a, b) => closedRank(a) - closedRank(b) || priorityRank(a) - priorityRank(b));
  return items;
}

function openDayTaskList(dateKey) {
  openTaskListModal(`${dateKey} 태스크`, tasksForDay(dateKey), "이 날짜에 해당하는 태스크가 없습니다");
}

// ---------- 브라우저 알림 공통 (업무 리마인더 + 채팅) ----------
// 허브 탭이 열려있는 동안에만 동작함(진짜 백그라운드 푸시는 서비스 워커+푸시 서버가 필요해서
// 이 앱의 규모에 비해 과함) — 팀이 평소 대시보드를 탭으로 켜두는 사용 패턴을 전제로 한다.
// 브라우저 알림 권한(Notification.permission)은 한 번 "허용"하면 웹페이지가 다시 끌 수 없어서,
// 그 위에 앱 자체의 켜기/끄기 스위치(localStorage)를 하나 더 둬서 사용자가 언제든 우리 쪽에서
// 알림을 잠글 수 있게 한다 — 업무 리마인더(우측 하단 종 모양 버튼)와 채팅(채팅창 안 종 모양
// 버튼)을 따로 켜고 끌 수 있음.

const NOTIF_TASKS_ENABLED_KEY = "workhub-notif-tasks-enabled";
const NOTIF_CHAT_ENABLED_KEY = "workhub-notif-chat-enabled";

function notifPermissionGranted() {
  return "Notification" in window && Notification.permission === "granted";
}
function isTaskNotifEnabled() {
  return notifPermissionGranted() && localStorage.getItem(NOTIF_TASKS_ENABLED_KEY) !== "0";
}
function isChatNotifEnabled() {
  return notifPermissionGranted() && localStorage.getItem(NOTIF_CHAT_ENABLED_KEY) !== "0";
}

const DAILY_POPUP_SHOWN_KEY = "workhub-daily-popup-shown-date";
const NOTIFIED_TASKS_KEY_PREFIX = "workhub-notified-";
const REMINDER_LEAD_MINUTES = 30;

function notifyTaskReminder(t) {
  if (!isTaskNotifEnabled()) return;
  const time = splitDateTime(t.startDate).time;
  new Notification(`⏰ ${REMINDER_LEAD_MINUTES}분 후 시작: ${t.name}`, {
    body: [time ? `${time} 시작 예정` : "", t.note || ""].filter(Boolean).join("\n"),
    tag: `workhub-task-${t.id}`,
  });
}

// 시작 시각이 명시된(날짜만이 아니라 시간까지 있는) 오늘 태스크에 대해서만 리마인더를 건다.
// 페이지를 새로고침해도(탭을 계속 켜둔 채) 다시 호출되므로, 이미 알림을 보낸 태스크는
// localStorage에 하루 단위로 기록해서 같은 리마인더가 중복으로 뜨지 않게 한다.
function scheduleTodayReminders(tasks) {
  if (!("Notification" in window)) return;
  const today = todayISO();
  const notifiedKey = `${NOTIFIED_TASKS_KEY_PREFIX}${today}`;
  const notified = new Set(JSON.parse(localStorage.getItem(notifiedKey) || "[]"));
  const now = Date.now();

  tasks.forEach((t) => {
    if (notified.has(t.id)) return;
    const { date, time } = splitDateTime(t.startDate);
    if (!time || date !== today) return; // 오늘 "시작"하는 태스크만 — 이미 시작된 여러 날짜짜리는 제외
    const startAt = new Date(`${date}T${time}:00`).getTime();
    if (isNaN(startAt)) return;
    const delay = startAt - REMINDER_LEAD_MINUTES * 60 * 1000 - now;
    if (delay <= 0) return; // 리마인드 시점이 이미 지났으면 뒤늦게 띄우지 않음
    setTimeout(() => {
      notifyTaskReminder(t);
      notified.add(t.id);
      localStorage.setItem(notifiedKey, JSON.stringify([...notified]));
    }, delay);
  });
}

// 허브 접속 시 하루에 한 번, 오늘 예정된 업무를 모아 팝업으로 보여준다. 알림 켜기/끄기는
// 우측 하단 종 모양 버튼(notif-fab)에서 상시 가능해서 이 팝업에는 별도 버튼을 두지 않음.
// 팝업은 하루 한 번만 뜨지만, 리마인더 스케줄은 (탭을 새로고침해도 다시 걸리도록) 매번 다시 건다.
function showDailyTaskPopupIfNeeded() {
  const today = todayISO();
  const tasks = tasksForDay(today);
  scheduleTodayReminders(tasks);

  if (localStorage.getItem(DAILY_POPUP_SHOWN_KEY) === today) return;
  localStorage.setItem(DAILY_POPUP_SHOWN_KEY, today);

  openTaskListModal(`📋 오늘의 업무 (${today})`, tasks, "오늘 예정된 태스크가 없습니다", maybeShowModeSelectDialog);
}

// ---------- 사용자 모드 / 뷰어 모드 ----------
// 서버 세션이 없는 구조(Cloudflare Worker가 매 쓰기 요청마다 비밀번호를 검사)라
// "저장된 비밀번호가 있는지"만으로 판단한다 — 틀린 비밀번호는 실제 쓰기 요청이 401을
// 받는 순간 notion-client.js가 알아서 지운다.
async function checkAuthValid() {
  return !!getAuthToken();
}

async function updateModeIndicator() {
  const el = document.getElementById("mode-indicator");
  if (!el) return false;
  const valid = await checkAuthValid();
  el.textContent = valid ? "🔑 사용자 모드" : "👀 뷰어 모드";
  el.classList.toggle("mode-user", valid);
  el.classList.toggle("mode-viewer", !valid);
  el.title = valid
    ? "사용자 모드 — 작성·수정·삭제 가능 (클릭하면 뷰어 모드로 전환)"
    : "뷰어 모드 — 보기만 가능 (클릭하면 비밀번호 입력 후 사용자 모드로 전환)";
  return valid;
}

function initModeIndicator() {
  const el = document.getElementById("mode-indicator");
  if (!el) return;
  el.onclick = async () => {
    const valid = await checkAuthValid();
    if (valid) {
      NC.saveSettings({ ...NC.getSettings(), appSecret: "" });
      showToast("뷰어 모드로 전환되었습니다");
    } else {
      const ok = await NC.promptAppSecret();
      if (ok) showToast("사용자 모드로 전환되었습니다");
    }
    updateModeIndicator();
  };
  updateModeIndicator();
}

// 오늘의 업무 팝업을 닫을 때, 아직 유효한 사용자 모드 세션이 없으면 바로 모드를 고르게 한다.
// 서버가 밤사이 재시작되어 있어도 하루 시작할 때 한 번에 비밀번호를 입력해두면, 이후 태스크를
// 만들거나 수정할 때마다 갑자기 비밀번호 창이 뜨는 일이 없다.
async function maybeShowModeSelectDialog() {
  const valid = await updateModeIndicator();
  if (valid) return;
  openModal(
    `<h3>🔑 모드 선택</h3>
    <p class="muted" style="margin-top:-0.4rem;">비밀번호를 입력하면 작성·수정·삭제가 가능한 사용자 모드로 시작해요. 건너뛰면 보기 전용 뷰어 모드로 시작합니다.</p>
    <div class="modal-actions"><span></span><div class="modal-actions-right">
      <button type="button" class="btn" id="mode-viewer-btn">👀 뷰어 모드로 계속</button>
      <button type="button" class="btn btn-primary" id="mode-user-btn">🔑 사용자 모드로 전환</button>
    </div></div>`,
    (modal) => {
      modal.querySelector("#mode-viewer-btn").onclick = () => closeModal();
      modal.querySelector("#mode-user-btn").onclick = async () => {
        closeModal();
        const ok = await NC.promptAppSecret();
        if (ok) showToast("사용자 모드로 전환되었습니다");
        updateModeIndicator();
      };
    }
  );
}

// ---------- 업무 리마인더 알림 켜기/끄기 (채팅 버튼 바로 위 종 모양 버튼) ----------
function updateNotifFabUI() {
  const fab = document.getElementById("notif-fab");
  if (!fab) return;
  if (!("Notification" in window)) {
    fab.style.display = "none";
    return;
  }
  const enabled = isTaskNotifEnabled();
  fab.textContent = enabled ? "🔔" : "🔕";
  fab.classList.toggle("active", enabled);
  fab.title = enabled ? "업무 리마인더 알림 켜짐 (클릭해서 끄기)" : "업무 리마인더 알림 꺼짐 (클릭해서 켜기)";
}

function initNotifFab() {
  const fab = document.getElementById("notif-fab");
  if (!fab) return;
  fab.addEventListener("click", async () => {
    if (!("Notification" in window)) return;
    if (Notification.permission === "denied") {
      showToast("브라우저에서 알림이 차단되어 있습니다 — 주소창의 자물쇠 아이콘에서 이 사이트 알림을 허용해주세요", true);
      return;
    }
    if (Notification.permission === "default") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        showToast("알림 권한이 허용되지 않았습니다", true);
        updateNotifFabUI();
        return;
      }
      localStorage.setItem(NOTIF_TASKS_ENABLED_KEY, "1");
      showToast("업무 리마인더 알림이 켜졌습니다");
    } else {
      const nowEnabled = !isTaskNotifEnabled();
      localStorage.setItem(NOTIF_TASKS_ENABLED_KEY, nowEnabled ? "1" : "0");
      showToast(nowEnabled ? "업무 리마인더 알림이 켜졌습니다" : "업무 리마인더 알림이 꺼졌습니다");
    }
    updateNotifFabUI();
  });
  updateNotifFabUI();
}

// ---------- 채팅 알림 (채팅창 안 종 모양 버튼으로 별도 켜기/끄기) ----------
function updateChatNotifBtnUI() {
  const btn = document.getElementById("chat-notif-toggle-btn");
  if (!btn) return;
  if (!("Notification" in window)) {
    btn.style.display = "none";
    return;
  }
  const enabled = isChatNotifEnabled();
  btn.textContent = enabled ? "🔔" : "🔕";
  btn.classList.toggle("chat-notif-off", !enabled);
  btn.title = enabled ? "채팅 알림 켜짐 (클릭해서 끄기)" : "채팅 알림 꺼짐 (클릭해서 켜기)";
}

function initChatNotifToggle() {
  const btn = document.getElementById("chat-notif-toggle-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (!("Notification" in window)) return;
    if (Notification.permission === "denied") {
      showToast("브라우저에서 알림이 차단되어 있습니다 — 주소창의 자물쇠 아이콘에서 이 사이트 알림을 허용해주세요", true);
      return;
    }
    if (Notification.permission === "default") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        showToast("알림 권한이 허용되지 않았습니다", true);
        updateChatNotifBtnUI();
        return;
      }
      localStorage.setItem(NOTIF_CHAT_ENABLED_KEY, "1");
      updateNotifFabUI(); // 권한을 처음 허용한 시점이면 업무 리마인더 버튼도 같이 갱신
    } else {
      const nowEnabled = !isChatNotifEnabled();
      localStorage.setItem(NOTIF_CHAT_ENABLED_KEY, nowEnabled ? "1" : "0");
      showToast(nowEnabled ? "채팅 알림이 켜졌습니다" : "채팅 알림이 꺼졌습니다");
    }
    updateChatNotifBtnUI();
  });
  updateChatNotifBtnUI();
}

// 채팅창을 닫아둔 동안에도 새 메시지가 오면 알림을 띄우기 위한 전용 폴링 — 패널이 열려있을 때
// 쓰는 3초 간격 폴링과는 별개로, 훨씬 뜸하게(20초) 돌면서 새 메시지 유무만 확인한다.
let lastNotifiedChatCount = null;
async function backgroundChatNotifPoll() {
  try {
    const data = await api("GET", "api/chat/messages/global");
    if (lastNotifiedChatCount === null) {
      lastNotifiedChatCount = data.messages.length; // 처음 폴은 기준점만 세우고 알림은 안 띄움
    } else if (data.messages.length > lastNotifiedChatCount) {
      const newOnes = data.messages.slice(lastNotifiedChatCount).filter((m) => m.ip !== data.myIp);
      if (newOnes.length && !chatPanelOpen && isChatNotifEnabled()) {
        const last = newOnes[newOnes.length - 1];
        const nick = data.nicknames[last.ip] || last.ip;
        const preview = last.type === "image" ? "사진을 보냈습니다" : last.text;
        new Notification(`💬 ${nick}`, { body: preview, tag: "workhub-chat" });
      }
      lastNotifiedChatCount = data.messages.length;
    }
  } catch {
    // 조용히 실패, 다음 폴링에서 재시도
  } finally {
    setTimeout(backgroundChatNotifPoll, 20000);
  }
}

// ---------- stat card list modals (대시보드 통계 카드 클릭 시) ----------

function openTaskListModal(title, tasks, emptyMessage = "해당하는 태스크가 없습니다", onClose) {
  openModal(
    `<h3>${escapeHtml(title)}</h3>
    <div class="card-list">
      ${
        tasks.length
          ? tasks
              .map(
                (t) => `
        <div class="mini-card stat-list-item" data-task-id="${t.id}">
          <div class="title">${escapeHtml(t.name)}</div>
          <div class="meta" style="margin-top:0.3rem; display:flex; gap:0.3rem; flex-wrap:wrap;">
            ${tag(t.status, "status")} ${tag(t.priority, "priority")}
            ${t.dueDate ? `<span class="tag">~${formatTaskDate(t.dueDate)}</span>` : ""}
            ${allAssigneeTags(t)}
          </div>
          ${taskQuickActionsHtml(t)}
        </div>`
              )
              .join("")
          : `<span class="muted">${escapeHtml(emptyMessage)}</span>`
      }
    </div>
    <div class="modal-actions"><span></span><div class="modal-actions-right"><button type="button" class="btn" id="cancel-btn">닫기</button></div></div>`,
    (modal) => {
      modal.querySelector("#cancel-btn").onclick = closeModal;
      modal.querySelectorAll(".stat-list-item").forEach((el) => {
        el.onclick = () => openTaskModal(state.allTasks.find((t) => t.id === el.dataset.taskId));
      });
      // 모달은 열릴 때 스냅샷으로 그려지고 render()로 다시 그려지는 화면이 아니라서,
      // 빠른 액션으로 상태가 바뀌면 그 카드는 목록에서 직접 지워준다
      attachTaskQuickActionEvents(modal, (taskId) => {
        const card = modal.querySelector(`.stat-list-item[data-task-id="${taskId}"]`);
        card?.remove();
        if (!modal.querySelector(".stat-list-item")) {
          modal.querySelector(".card-list").innerHTML = `<span class="muted">${escapeHtml(emptyMessage)}</span>`;
        }
      });
    },
    "",
    onClose
  );
}

function openProjectListModal(title, projects) {
  openModal(
    `<h3>${escapeHtml(title)}</h3>
    <div class="card-list">
      ${
        projects.length
          ? projects
              .map(
                (p) => `
        <div class="mini-card stat-list-item" data-project-id="${p.id}">
          <div class="title">${escapeHtml(p.name)}</div>
          <div class="meta" style="margin-top:0.4rem; display:flex; gap:0.3rem; flex-wrap:wrap;">
            ${tag(p.status, "status")} ${tag(p.category, "cat")} ${tag(p.priority, "priority")}
            ${p.dueDate ? `<span class="tag">~${p.dueDate}</span>` : ""}
          </div>
        </div>`
              )
              .join("")
          : '<span class="muted">해당하는 프로젝트가 없습니다</span>'
      }
    </div>
    <div class="modal-actions"><span></span><div class="modal-actions-right"><button type="button" class="btn" id="cancel-btn">닫기</button></div></div>`,
    (modal) => {
      modal.querySelector("#cancel-btn").onclick = closeModal;
      modal.querySelectorAll(".stat-list-item").forEach((el) => {
        el.onclick = () => {
          closeModal();
          state.tab = "project-detail";
          state.detailId = el.dataset.projectId;
          render();
        };
      });
    }
  );
}

function openMeetingListModal(title, meetings) {
  openModal(
    `<h3>${escapeHtml(title)}</h3>
    <div class="card-list" id="stat-meeting-list"></div>
    <div class="modal-actions"><span></span><div class="modal-actions-right"><button type="button" class="btn" id="cancel-btn">닫기</button></div></div>`,
    (modal) => {
      modal.querySelector("#cancel-btn").onclick = closeModal;
      const list = modal.querySelector("#stat-meeting-list");
      if (!meetings.length) list.innerHTML = '<span class="muted">회의록이 없습니다</span>';
      else meetings.forEach((m) => list.appendChild(meetingMiniCard(m)));
    }
  );
}

function shiftCalendarMonth(delta) {
  let m = state.calendarMonthIndex + delta;
  let y = state.calendarYear;
  if (m < 0) { m = 11; y -= 1; }
  if (m > 11) { m = 0; y += 1; }
  state.calendarMonthIndex = m;
  state.calendarYear = y;
}

// ---------- tasks ----------

function renderTasks() {
  app.innerHTML = `
    <div class="section-header">
      <h2>태스크</h2>
      <div style="display:flex; gap:0.5rem; align-items:center;">
        <div class="view-toggle">
          <button class="btn btn-sm ${state.taskView === "board" ? "btn-primary" : ""}" id="view-board">보드</button>
          <button class="btn btn-sm ${state.taskView === "list" ? "btn-primary" : ""}" id="view-list">목록</button>
        </div>
        <button class="btn btn-primary btn-sm" id="add-task-btn">+ 태스크 추가</button>
      </div>
    </div>
    <div class="filters">
      <select id="filter-category"><option value="">전체 구분</option>${options(CATEGORY, state.filters.category)}</select>
      <select id="filter-project"><option value="">전체 프로젝트</option>${state.projects.map((p) => `<option value="${p.id}" ${p.id === state.filters.projectId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select>
      <select id="filter-assignee"><option value="">전체 담당자</option>${state.people.map((p) => `<option value="${p.id}" ${p.id === state.filters.assigneeId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select>
    </div>
    <div id="task-content"></div>
  `;

  document.getElementById("view-board").onclick = () => { state.taskView = "board"; renderTasks(); };
  document.getElementById("view-list").onclick = () => { state.taskView = "list"; renderTasks(); };
  document.getElementById("add-task-btn").onclick = () => openTaskModal();

  document.getElementById("filter-category").onchange = (e) => filterTasks("category", e.target.value);
  document.getElementById("filter-project").onchange = (e) => filterTasks("projectId", e.target.value);
  document.getElementById("filter-assignee").onchange = (e) => filterTasks("assigneeId", e.target.value);

  const content = document.getElementById("task-content");
  content.innerHTML = state.taskView === "board" ? boardHtml() : listHtml();

  if (state.taskView === "board") attachBoardEvents();
  else attachListEvents();
}

async function filterTasks(key, value) {
  state.filters[key] = value;
  await reloadTasks();
  renderTasks();
}

// "완료" 컬럼은 끝난 태스크가 계속 쌓이기만 해서 오래된 것까지 다 보이면 목록이 너무 길어짐 —
// 기본으로는 최근에 완료된 것부터 10개만 보여주고, 필요하면 토글로 전체를 볼 수 있게 함.
const COMPLETED_DEFAULT_COUNT = 10;

function boardHtml() {
  const columns = ["할 일", "진행중", "완료"];
  return `<div class="board">${columns
    .map((status) => {
      const all = state.tasks.filter((t) => t.status === status);
      const items =
        status === "완료" && !state.showAllCompleted
          ? [...all].sort((a, b) => new Date(b.lastEditedTime) - new Date(a.lastEditedTime)).slice(0, COMPLETED_DEFAULT_COUNT)
          : all;
      const hiddenCount = all.length - items.length;
      return `<div class="board-col" data-status="${status}">
        <h3><span>${status}</span><span>${items.length}</span></h3>
        ${
          status === "완료"
            ? `<button type="button" class="btn btn-sm board-completed-toggle" id="board-completed-toggle">${
                state.showAllCompleted ? `최근 ${COMPLETED_DEFAULT_COUNT}개만 보기` : `전체 보기${hiddenCount ? ` (+${hiddenCount})` : ""}`
              }</button>`
            : ""
        }
        ${items.map((t) => boardCardHtml(t)).join("")}
      </div>`;
    })
    .join("")}</div>`;
}

function boardCardHtml(t) {
  return `<div class="board-card" draggable="true" data-id="${t.id}">
    <div class="title">${escapeHtml(t.name)}</div>
    <div class="meta">
      ${tag(t.priority, "priority")}
      ${tag(t.category, "cat")}
      ${t.dueDate ? `<span class="tag">~${formatTaskDate(t.dueDate)}</span>` : ""}
      ${t.holidayWork ? `<span class="tag tag-holiday-work">🏢 휴일 근무</span>` : ""}
      ${t.recurrence && t.recurrence !== "없음" ? `<span class="tag tag-recurrence">🔁 ${escapeHtml(t.recurrence)}</span>` : ""}
    </div>
    <div class="meta">${allAssigneeTags(t)}</div>
    ${taskQuickActionsHtml(t)}
  </div>`;
}

function attachBoardEvents() {
  document.querySelectorAll(".board-card").forEach((card) => {
    card.addEventListener("click", () => openTaskModal(state.tasks.find((t) => t.id === card.dataset.id)));
    card.addEventListener("dragstart", (e) => {
      card.classList.add("dragging");
      e.dataTransfer.setData("text/plain", card.dataset.id);
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });
  attachTaskQuickActionEvents(document.querySelector(".board"));
  document.getElementById("board-completed-toggle")?.addEventListener("click", () => {
    state.showAllCompleted = !state.showAllCompleted;
    renderTasks();
  });
  document.querySelectorAll(".board-col").forEach((col) => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("drag-over");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain");
      const newStatus = col.dataset.status;
      try {
        await api("PATCH", `api/tasks/${id}`, { status: newStatus });
        await refreshAfterTaskChange();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}

function listHtml() {
  if (!state.tasks.length) return `<span class="muted">태스크가 없습니다</span>`;
  return `<div class="table-scroll"><table class="data-table">
    <thead><tr><th>이름</th><th>상태</th><th>구분</th><th>우선순위</th><th>마감일</th><th>담당자</th><th>프로젝트</th><th></th></tr></thead>
    <tbody>
      ${state.tasks
        .map(
          (t) => `<tr data-id="${t.id}">
        <td data-label="이름">${t.holidayWork ? '<span title="휴일 근무">🏢 </span>' : ""}${t.recurrence && t.recurrence !== "없음" ? `<span title="반복: ${escapeHtml(t.recurrence)}">🔁 </span>` : ""}${escapeHtml(t.name)}</td>
        <td data-label="상태"><select class="status-select" data-id="${t.id}">${options(TASK_STATUS, t.status)}</select></td>
        <td data-label="구분">${tag(t.category, "cat")}</td>
        <td data-label="우선순위">${tag(t.priority, "priority")}</td>
        <td data-label="마감일">${formatTaskDate(t.dueDate) || "-"}</td>
        <td data-label="담당자">${allAssigneeTags(t)}</td>
        <td data-label="프로젝트">${t.projectIds[0] ? escapeHtml(projectName(t.projectIds[0])) : t.workType ? escapeHtml(t.workType) : "-"}</td>
        <td data-label="">
          <button class="btn btn-sm edit-task">수정</button>
          <button class="btn btn-sm btn-danger del-task">삭제</button>
        </td>
      </tr>`
        )
        .join("")}
    </tbody>
  </table></div>`;
}

function attachListEvents() {
  document.querySelectorAll(".status-select").forEach((sel) => {
    sel.onchange = async () => {
      try {
        await api("PATCH", `api/tasks/${sel.dataset.id}`, { status: sel.value });
        await refreshAfterTaskChange();
      } catch (err) {
        showToast(err.message, true);
      }
    };
  });
  document.querySelectorAll(".edit-task").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.closest("tr").dataset.id;
      openTaskModal(state.tasks.find((t) => t.id === id));
    };
  });
  document.querySelectorAll(".del-task").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.closest("tr").dataset.id;
      if (!confirm("이 태스크를 삭제할까요? (Notion에서도 보관됩니다)")) return;
      try {
        await api("DELETE", `api/tasks/${id}`);
        await refreshAfterTaskChange();
        showToast("삭제되었습니다");
      } catch (err) {
        showToast(err.message, true);
      }
    };
  });
}

// 태스크 폼에서 체크리스트 항목 하나(체크박스+텍스트)를 나타내는 반복 그룹
function checklistItemFormHtml(item, index) {
  return `
    <div class="checklist-item" data-index="${index}">
      <input type="checkbox" class="checklist-item-checked" ${item.checked ? "checked" : ""} />
      <input type="text" class="checklist-item-text" placeholder="체크리스트 항목" value="${escapeHtml(item.text ?? "")}" />
      <button type="button" class="btn btn-sm btn-danger checklist-item-remove" title="삭제">×</button>
    </div>
  `;
}

function checklistItemsListHtml(items) {
  return (items ?? []).map((item, i) => checklistItemFormHtml(item, i)).join("");
}

function openTaskModal(task) {
  const isEdit = !!task;
  const sd = splitDateTime(task?.startDate);
  const dd = splitDateTime(task?.dueDate);
  openModal(
    `<h3>${isEdit ? "태스크 수정" : "새 태스크"}</h3>
    <form id="task-form">
      <div class="task-form-grid">
        <div class="task-form-left">
          <div class="field"><label>이름</label><input name="name" required value="${escapeHtml(task?.name ?? "")}" /></div>
          <div class="row">
            <div class="field"><label>상태</label><select name="status">${options(TASK_STATUS, task?.status ?? "할 일")}</select></div>
            <div class="field"><label>구분</label><select name="category">${options(CATEGORY, task?.category ?? "개인")}</select></div>
            <div class="field"><label>우선순위</label><select name="priority">${options(PRIORITY, task?.priority ?? "보통")}</select></div>
          </div>
          <div class="field" id="progress-field" style="${(task?.status ?? "할 일") === "진행중" ? "" : "display:none;"}">
            <label>진행률 <span class="muted">(%, 업무일지에 표시됨 — 체크리스트가 있으면 자동 계산)</span></label>
            <input type="number" name="progress" min="0" max="100" step="1" value="${task?.progress ?? ""}" />
            <span id="progress-auto-label" class="muted" style="display:none;"></span>
          </div>
          <div class="field">
            <label>시작일</label>
            <div class="datetime-pair">
              <input type="date" name="startDate" value="${sd.date}" />
              <input type="time" name="startTime" value="${sd.time}" />
            </div>
          </div>
          <div class="field">
            <label>마감일</label>
            <div class="datetime-pair">
              <input type="date" name="dueDate" value="${dd.date}" />
              <input type="time" name="dueTime" value="${dd.time}" />
            </div>
          </div>
          <div class="field"><label>반복 <span class="muted">(완료 처리하면 다음 회차가 자동으로 생성됨)</span></label><select name="recurrence">${options(RECURRENCE, task?.recurrence ?? "없음")}</select></div>
          <div class="field">
            <label class="checkbox-label"><input type="checkbox" name="holidayWork" ${task?.holidayWork ? "checked" : ""} /> 공휴일/주말에도 출근 (휴일 근무)</label>
          </div>
          <div class="field"><label>프로젝트</label><select name="projectId"><option value="">연결 안 함</option>${selectableProjectsFor(task?.projectIds?.[0]).map((p) => `<option value="${p.id}" ${task?.projectIds?.[0] === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select></div>
          <div class="field"><label>업무유형 <span class="muted">(특정 프로젝트가 아닌 상시 업무 구분, 선택)</span></label><select name="workType">${options(WORK_TYPE, task?.workType ?? "없음")}</select></div>
          <div class="field"><label>담당자</label>${peopleChecks("assigneeIds", task?.assignees?.map((a) => a.id) ?? [])}</div>
          ${customPersonFieldHtml("customAssigneeIds", task?.customAssignees ?? [])}
        </div>
        <div class="task-form-right">
          <div class="field"><label>진행도 메모</label><textarea name="note" rows="5" placeholder="진행 상황 메모 (선택, 주간 업무일지에도 표시됨)">${escapeHtml(task?.note ?? "")}</textarea></div>
          <div class="field">
            <label>체크리스트 <span class="muted">(선택, 항목을 추가하면 체크 비율로 진행률이 자동 계산되고 업무일지에도 표시됨)</span></label>
            <div id="checklist-items-list">${checklistItemsListHtml(task?.checklist ?? [])}</div>
            <button type="button" class="btn btn-sm" id="checklist-item-add-btn">+ 항목 추가</button>
          </div>
        </div>
      </div>
      <div class="modal-actions">
        ${isEdit ? `<button type="button" class="btn btn-danger" id="delete-task-btn">삭제</button>` : "<span></span>"}
        <div class="modal-actions-right">
          <button type="button" class="btn" id="cancel-btn">취소</button>
          <button type="submit" class="btn btn-primary">${isEdit ? "저장" : "추가"}</button>
        </div>
      </div>
    </form>`,
    (modal) => {
      modal.querySelector("#cancel-btn").onclick = closeModal;
      modal.querySelector("#delete-task-btn")?.addEventListener("click", async () => {
        if (!confirm("이 태스크를 삭제할까요? (Notion에서도 보관됩니다)")) return;
        try {
          await api("DELETE", `api/tasks/${task.id}`);
          closeModal();
          await refreshAfterTaskChange();
          showToast("삭제되었습니다");
        } catch (err) {
          showToast(err.message, true);
        }
      });
      const form = modal.querySelector("#task-form");
      attachCustomPersonInput(modal, form, "customAssigneeIds");
      const progressField = modal.querySelector("#progress-field");
      form.status.onchange = () => {
        progressField.style.display = form.status.value === "진행중" ? "" : "none";
      };

      const checklistListEl = modal.querySelector("#checklist-items-list");
      const progressInput = form.progress;
      const progressAutoLabel = modal.querySelector("#progress-auto-label");
      function currentChecklist() {
        return [...checklistListEl.querySelectorAll(".checklist-item")]
          .map((el) => ({
            text: el.querySelector(".checklist-item-text").value.trim(),
            checked: el.querySelector(".checklist-item-checked").checked,
          }))
          .filter((i) => i.text !== "");
      }
      function updateProgressPreview() {
        const items = currentChecklist();
        if (items.length) {
          const checked = items.filter((i) => i.checked).length;
          const pct = Math.round((checked / items.length) * 100);
          progressInput.style.display = "none";
          progressAutoLabel.style.display = "";
          progressAutoLabel.textContent = `${pct}% (체크리스트 ${checked}/${items.length}개 완료로 자동 계산됨)`;
        } else {
          progressInput.style.display = "";
          progressAutoLabel.style.display = "none";
        }
      }
      function attachChecklistItemEvents(el) {
        el.querySelector(".checklist-item-remove").onclick = () => {
          el.remove();
          updateProgressPreview();
        };
        el.querySelector(".checklist-item-checked").onchange = updateProgressPreview;
        el.querySelector(".checklist-item-text").oninput = updateProgressPreview;
      }
      checklistListEl.querySelectorAll(".checklist-item").forEach(attachChecklistItemEvents);
      modal.querySelector("#checklist-item-add-btn").onclick = () => {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = checklistItemFormHtml({ text: "", checked: false }, checklistListEl.children.length);
        const el = wrapper.firstElementChild;
        checklistListEl.appendChild(el);
        attachChecklistItemEvents(el);
        el.querySelector(".checklist-item-text").focus();
        updateProgressPreview();
      };
      updateProgressPreview();

      form.onsubmit = async (e) => {
        e.preventDefault();
        await withSubmitGuard(e.submitter ?? form.querySelector('button[type="submit"]'), "저장 중...", async () => {
          const checklist = currentChecklist();
          const payload = {
            name: form.name.value,
            status: form.status.value,
            category: form.category.value,
            priority: form.priority.value,
            startDate: combineDateTime(form.startDate.value, form.startTime.value),
            dueDate: combineDateTime(form.dueDate.value, form.dueTime.value),
            projectId: form.projectId.value || null,
            assigneeIds: checkedValues(form, "assigneeIds"),
            customAssigneeNames: checkedValues(form, "customAssigneeIds"),
            note: form.note.value,
            holidayWork: form.holidayWork.checked,
            recurrence: form.recurrence.value,
            progress: checklist.length
              ? Math.round((checklist.filter((i) => i.checked).length / checklist.length) * 100)
              : form.status.value === "진행중" && form.progress.value !== ""
                ? Number(form.progress.value)
                : null,
            workType: form.workType.value === "없음" ? null : form.workType.value,
            checklist,
          };
          try {
            if (isEdit) await api("PATCH", `api/tasks/${task.id}`, payload);
            else await api("POST", "api/tasks", payload);
            closeModal();
            await refreshAfterTaskChange();
            showToast(isEdit ? "수정되었습니다" : "추가되었습니다");
          } catch (err) {
            showToast(err.message, true);
          }
        });
      };
    },
    "modal-task"
  );
}

// ---------- projects ----------

function renderProjects() {
  app.innerHTML = `
    <div class="section-header"><h2>프로젝트</h2><button class="btn btn-primary btn-sm" id="add-project-btn">+ 프로젝트 추가</button></div>
    <div class="card-grid" id="project-list"></div>
  `;
  document.getElementById("add-project-btn").onclick = () => openProjectModal();
  const list = document.getElementById("project-list");
  if (!state.projects.length) {
    list.innerHTML = `<span class="muted">프로젝트가 없습니다</span>`;
    return;
  }
  state.projects.forEach((p) => {
    const card = document.createElement("div");
    card.className = "mini-card";
    card.innerHTML = `
      <div class="title">${escapeHtml(p.name)}</div>
      <div class="meta" style="margin-top:0.4rem; display:flex; gap:0.3rem; flex-wrap:wrap;">
        ${tag(p.status, "status")} ${tag(p.category, "cat")} ${tag(p.priority, "priority")}
        ${p.dueDate ? `<span class="tag">~${p.dueDate}</span>` : ""}
      </div>
    `;
    card.onclick = () => {
      state.tab = "project-detail";
      state.detailId = p.id;
      render();
    };
    list.appendChild(card);
  });
}

async function renderProjectDetail() {
  const project = await api("GET", `api/projects/${state.detailId}`);
  app.innerHTML = `
    <button class="btn btn-sm" id="back-btn">← 프로젝트 목록</button>
    <div class="detail-header">
      <div>
        <h2 style="margin-bottom:0.3rem;">${escapeHtml(project.name)}</h2>
        <div style="display:flex; gap:0.3rem; flex-wrap:wrap;">${tag(project.status, "status")} ${tag(project.category, "cat")} ${tag(project.priority, "priority")}</div>
      </div>
      <div style="display:flex; gap:0.5rem;">
        <button class="btn btn-sm" id="edit-project-btn">수정</button>
        <button class="btn btn-sm btn-danger" id="del-project-btn">삭제</button>
      </div>
    </div>
    <div class="detail-block">
      <h4>설명</h4>
      <div>${project.description ? escapeHtml(project.description).replace(/\n/g, "<br/>") : '<span class="muted">설명 없음</span>'}</div>
    </div>
    <div class="detail-block">
      <h4>기간 / 담당자</h4>
      <div>${formatTaskDate(project.startDate) || "?"} ~ ${formatTaskDate(project.dueDate) || "?"} · ${combinedTags(project.assignees, project.customAssignees)}</div>
    </div>
    <div class="detail-block">
      <h4>관련 태스크 (${project.tasks.length})</h4>
      <div class="card-list" id="project-related-tasks">${project.tasks.map((t) => `<div class="mini-card task-related-item" data-task-id="${t.id}"><div class="title">${escapeHtml(t.name)}</div><div class="meta" style="margin-top:0.3rem;">${tag(t.status, "status")} ${t.dueDate ? `<span class="tag">~${formatTaskDate(t.dueDate)}</span>` : ""}</div>${taskQuickActionsHtml(t)}</div>`).join("") || '<span class="muted">없음</span>'}</div>
    </div>
    <div class="detail-block">
      <h4>관련 회의록 (${project.meetings.length})</h4>
      <div class="card-list">${project.meetings.map((m) => `<div class="mini-card"><div class="title">${escapeHtml(m.title)}</div><div class="meta" style="margin-top:0.3rem;">${m.date ?? "-"} ${tag(m.meetingType, "status")}</div></div>`).join("") || '<span class="muted">없음</span>'}</div>
    </div>
  `;
  document.getElementById("back-btn").onclick = () => {
    state.tab = "projects";
    render();
  };
  document.getElementById("edit-project-btn").onclick = () => openProjectModal(project);
  document.querySelectorAll(".task-related-item").forEach((el) => {
    el.onclick = () => openTaskModal(project.tasks.find((t) => t.id === el.dataset.taskId));
  });
  attachTaskQuickActionEvents(document.getElementById("project-related-tasks"));
  document.getElementById("del-project-btn").onclick = async () => {
    if (!confirm("이 프로젝트를 삭제할까요? (Notion에서도 보관됩니다)")) return;
    try {
      await api("DELETE", `api/projects/${project.id}`);
      state.projects = await api("GET", "api/projects");
      state.tab = "projects";
      render();
      showToast("삭제되었습니다");
    } catch (err) {
      showToast(err.message, true);
    }
  };
}

function openProjectModal(project) {
  const isEdit = !!project;
  openModal(
    `<h3>${isEdit ? "프로젝트 수정" : "새 프로젝트"}</h3>
    <form id="project-form">
      <div class="field"><label>이름</label><input name="name" required value="${escapeHtml(project?.name ?? "")}" /></div>
      <div class="row">
        <div class="field"><label>상태</label><select name="status">${options(PROJECT_STATUS, project?.status ?? "계획")}</select></div>
        <div class="field"><label>구분</label><select name="category">${options(CATEGORY, project?.category ?? "팀")}</select></div>
        <div class="field"><label>우선순위</label><select name="priority">${options(PRIORITY, project?.priority ?? "보통")}</select></div>
      </div>
      <div class="row">
        <div class="field"><label>시작일</label><input type="date" name="startDate" value="${project?.startDate ?? ""}" /></div>
        <div class="field"><label>마감일</label><input type="date" name="dueDate" value="${project?.dueDate ?? ""}" /></div>
      </div>
      <div class="field"><label>설명</label><textarea name="description">${escapeHtml(project?.description ?? "")}</textarea></div>
      <div class="field"><label>담당자</label>${peopleChecks("assigneeIds", project?.assignees?.map((a) => a.id) ?? [])}</div>
      ${customPersonFieldHtml("customAssigneeIds", project?.customAssignees ?? [])}
      <div class="modal-actions">
        <button type="button" class="btn" id="cancel-btn">취소</button>
        <button type="submit" class="btn btn-primary">${isEdit ? "저장" : "추가"}</button>
      </div>
    </form>`,
    (modal) => {
      modal.querySelector("#cancel-btn").onclick = closeModal;
      const form = modal.querySelector("#project-form");
      attachCustomPersonInput(modal, form, "customAssigneeIds");
      form.onsubmit = async (e) => {
        e.preventDefault();
        await withSubmitGuard(e.submitter ?? form.querySelector('button[type="submit"]'), "저장 중...", async () => {
          const payload = {
            name: form.name.value,
            status: form.status.value,
            category: form.category.value,
            priority: form.priority.value,
            startDate: form.startDate.value || null,
            dueDate: form.dueDate.value || null,
            description: form.description.value,
            assigneeIds: checkedValues(form, "assigneeIds"),
            customAssigneeNames: checkedValues(form, "customAssigneeIds"),
          };
          try {
            if (isEdit) await api("PATCH", `api/projects/${project.id}`, payload);
            else await api("POST", "api/projects", payload);
            closeModal();
            state.projects = await api("GET", "api/projects");
            if (isEdit) {
              state.tab = "project-detail";
              state.detailId = project.id;
            } else {
              state.tab = "projects";
            }
            render();
            showToast(isEdit ? "수정되었습니다" : "추가되었습니다");
          } catch (err) {
            showToast(err.message, true);
          }
        });
      };
    }
  );
}

// ---------- meetings ----------

function meetingMiniCard(m) {
  const card = document.createElement("div");
  card.className = "mini-card";
  card.innerHTML = `
    <div class="title">${escapeHtml(m.title)}</div>
    <div class="meta" style="margin-top:0.4rem; display:flex; gap:0.3rem; flex-wrap:wrap;">
      <span class="tag">${m.date ?? "날짜 미정"}</span> ${tag(m.meetingType, "status")} ${combinedTags(m.attendees, m.customAttendees)}
    </div>
  `;
  card.onclick = () => openMeetingDetail(m);
  return card;
}

// 안건 하나마다 논의/결정을 묶어서 탭으로 보여주는 회의록 상세 뷰 (안건 1, 안건 2, ...)
function meetingTabsHtml(content) {
  const items = content.items && content.items.length ? content.items : [{ agenda: "", discussion: "", decision: "" }];
  const tabButtons = items
    .map((_, i) => `<button type="button" class="meeting-tab-btn ${i === 0 ? "active" : ""}" data-tab-index="${i}">안건 ${i + 1}</button>`)
    .join("");
  const tabPanes = items
    .map((item, i) => {
      const steps = [
        { icon: "📌", label: "안건", text: item.agenda },
        { icon: "💬", label: "논의", text: item.discussion },
        { icon: "✅", label: "결정", text: item.decision },
      ];
      return `
        <div class="meeting-tab-pane ${i === 0 ? "active" : ""}" data-tab-pane="${i}">
          <div class="meeting-flow">
            ${steps
              .map(
                (s, si) => `
              ${si > 0 ? `<div class="meeting-flow-arrow">↓</div>` : ""}
              <div class="meeting-flow-step">
                <div class="meeting-flow-label">${s.icon} ${s.label}</div>
                <div class="meeting-flow-text">${s.text ? escapeHtml(s.text).replace(/\n/g, "<br/>") : '<span class="muted">-</span>'}</div>
              </div>`
              )
              .join("")}
          </div>
        </div>`;
    })
    .join("");
  return `<div class="meeting-tabs"><div class="meeting-tab-buttons">${tabButtons}</div>${tabPanes}</div>`;
}

function attachMeetingTabEvents(modal) {
  modal.querySelectorAll(".meeting-tab-btn").forEach((btn) => {
    btn.onclick = () => {
      const idx = btn.dataset.tabIndex;
      modal.querySelectorAll(".meeting-tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tabIndex === idx));
      modal.querySelectorAll(".meeting-tab-pane").forEach((p) => p.classList.toggle("active", p.dataset.tabPane === idx));
    };
  });
}

// 회의록 작성 폼에서 안건 하나(안건/논의/결정)를 나타내는 반복 그룹
function agendaItemFormHtml(item, index) {
  return `
    <div class="agenda-item" data-index="${index}">
      <div class="agenda-item-header">
        <span class="agenda-item-num">안건 ${index + 1}</span>
        <button type="button" class="btn btn-sm btn-danger agenda-item-remove">삭제</button>
      </div>
      <div class="field"><label>📌 안건</label><textarea class="agenda-item-agenda" rows="2">${escapeHtml(item.agenda ?? "")}</textarea></div>
      <div class="field"><label>💬 논의</label><textarea class="agenda-item-discussion" rows="3">${escapeHtml(item.discussion ?? "")}</textarea></div>
      <div class="field"><label>✅ 결정</label><textarea class="agenda-item-decision" rows="3">${escapeHtml(item.decision ?? "")}</textarea></div>
    </div>
  `;
}

function agendaItemsListHtml(items) {
  const list = items && items.length ? items : [{ agenda: "", discussion: "", decision: "" }];
  return list.map((item, i) => agendaItemFormHtml(item, i)).join("");
}

function renderMeetings() {
  app.innerHTML = `
    <div class="section-header"><h2>회의록</h2><button class="btn btn-primary btn-sm" id="add-meeting-btn">+ 회의록 작성</button></div>
    <div class="card-list" id="meeting-list"></div>
  `;
  document.getElementById("add-meeting-btn").onclick = () => openMeetingModal();
  const list = document.getElementById("meeting-list");
  if (!state.meetings.length) {
    list.innerHTML = `<span class="muted">회의록이 없습니다</span>`;
    return;
  }
  state.meetings.forEach((m) => list.appendChild(meetingMiniCard(m)));
}

async function openMeetingDetail(m) {
  openModal(`<h3>${escapeHtml(m.title)}</h3><div class="muted">불러오는 중...</div>`, null, "modal-meeting");
  let content;
  try {
    content = await api("GET", `api/meetings/${m.id}/content`);
  } catch (err) {
    showToast(err.message, true);
    content = { items: [] };
  }
  openModal(
    `<h3>${escapeHtml(m.title)}</h3>
    <div class="muted" style="margin-bottom:0.8rem;">${m.date ?? "-"} · ${tag(m.meetingType, "status")} · ${combinedTags(m.attendees, m.customAttendees)}</div>
    ${meetingTabsHtml(content)}
    <div class="modal-actions">
      <button type="button" class="btn" id="close-btn">닫기</button>
      <button type="button" class="btn" id="edit-meeting-btn">수정</button>
      <button type="button" class="btn btn-danger" id="del-meeting-btn">삭제</button>
    </div>`,
    (modal) => {
      attachMeetingTabEvents(modal);
      modal.querySelector("#close-btn").onclick = closeModal;
      modal.querySelector("#edit-meeting-btn").onclick = () => openMeetingModal(m, content);
      modal.querySelector("#del-meeting-btn").onclick = async () => {
        if (!confirm("이 회의록을 삭제할까요? (Notion에서도 보관됩니다)")) return;
        try {
          await api("DELETE", `api/meetings/${m.id}`);
          state.meetings = await api("GET", "api/meetings");
          closeModal();
          renderMeetings();
          showToast("삭제되었습니다");
        } catch (err) {
          showToast(err.message, true);
        }
      };
    },
    "modal-meeting"
  );
}

function openMeetingModal(meeting, content) {
  const isEdit = !!meeting;
  const c = content ?? { items: [] };
  openModal(
    `<h3>${isEdit ? "회의록 수정" : "새 회의록"}</h3>
    <form id="meeting-form">
      <div class="meeting-form-grid">
        <div class="meeting-form-left">
          <div class="field"><label>제목</label><input name="title" required value="${escapeHtml(meeting?.title ?? "")}" /></div>
          <div class="field"><label>날짜</label><input type="date" name="date" value="${meeting?.date ?? ""}" /></div>
          <div class="field"><label>회의유형</label><select name="meetingType">${options(MEETING_TYPE, meeting?.meetingType ?? "주간회의")}</select></div>
          <div class="field"><label>프로젝트</label><select name="projectId"><option value="">연결 안 함</option>${state.projects.map((p) => `<option value="${p.id}" ${meeting?.projectIds?.[0] === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select></div>
          <div class="field"><label>참석자</label>${peopleChecks("attendeeIds", meeting?.attendees?.map((a) => a.id) ?? [])}</div>
          ${customPersonFieldHtml("customAttendeeIds", meeting?.customAttendees ?? [])}
        </div>
        <div class="meeting-form-right">
          <div class="field">
            <label>안건별 논의/결정 <span class="muted">(여러 안건이 있으면 안건마다 추가하세요)</span></label>
          </div>
          <div id="agenda-items-list">${agendaItemsListHtml(c.items)}</div>
          <button type="button" class="btn btn-sm" id="agenda-item-add-btn">+ 안건 추가</button>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn" id="cancel-btn">취소</button>
        <button type="submit" class="btn btn-primary">${isEdit ? "저장" : "작성"}</button>
      </div>
    </form>`,
    (modal) => {
      modal.querySelector("#cancel-btn").onclick = closeModal;
      const form = modal.querySelector("#meeting-form");
      attachCustomPersonInput(modal, form, "customAttendeeIds");

      const agendaListEl = modal.querySelector("#agenda-items-list");
      function renumberAgendaItems() {
        agendaListEl.querySelectorAll(".agenda-item").forEach((el, i) => {
          el.dataset.index = i;
          el.querySelector(".agenda-item-num").textContent = `안건 ${i + 1}`;
        });
      }
      function attachAgendaItemRemove(el) {
        el.querySelector(".agenda-item-remove").onclick = () => {
          if (agendaListEl.querySelectorAll(".agenda-item").length <= 1) {
            showToast("최소 1개의 안건은 있어야 합니다", true);
            return;
          }
          el.remove();
          renumberAgendaItems();
        };
      }
      agendaListEl.querySelectorAll(".agenda-item").forEach(attachAgendaItemRemove);
      modal.querySelector("#agenda-item-add-btn").onclick = () => {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = agendaItemFormHtml({ agenda: "", discussion: "", decision: "" }, agendaListEl.children.length);
        const el = wrapper.firstElementChild;
        agendaListEl.appendChild(el);
        attachAgendaItemRemove(el);
        renumberAgendaItems();
      };

      form.onsubmit = async (e) => {
        e.preventDefault();
        await withSubmitGuard(e.submitter ?? form.querySelector('button[type="submit"]'), "저장 중...", async () => {
          const items = Array.from(agendaListEl.querySelectorAll(".agenda-item")).map((el) => ({
            agenda: el.querySelector(".agenda-item-agenda").value,
            discussion: el.querySelector(".agenda-item-discussion").value,
            decision: el.querySelector(".agenda-item-decision").value,
          }));
          const payload = {
            title: form.title.value,
            date: form.date.value || null,
            meetingType: form.meetingType.value,
            projectId: form.projectId.value || null,
            attendeeIds: checkedValues(form, "attendeeIds"),
            customAttendeeNames: checkedValues(form, "customAttendeeIds"),
            items,
          };
          try {
            if (isEdit) await api("PATCH", `api/meetings/${meeting.id}`, payload);
            else await api("POST", "api/meetings", payload);
            closeModal();
            state.meetings = await api("GET", "api/meetings");
            renderMeetings();
            showToast(isEdit ? "수정되었습니다" : "작성되었습니다");
          } catch (err) {
            showToast(err.message, true);
          }
        });
      };
    },
    "modal-meeting"
  );
}

// ---------- utilities ----------

// 유틸리티는 딱히 "보는" 화면이 아니라 링크를 골라 미리보기 패널을 여는 용도라, 탭 전환으로
// 지금 보던 화면(대시보드/태스크 등)을 벗어나게 하지 않고 상단 드롭다운으로 바로 고르게 한다.
function buildUtilDropdownMenu() {
  const previewLinks = UTIL_LINKS.filter((l) => !l.noPreview);
  const externalLinks = UTIL_LINKS.filter((l) => l.noPreview);
  const menu = document.getElementById("util-dropdown-menu");
  menu.innerHTML = `
    <div class="util-section-label">미리보기로 바로 보기</div>
    <div class="card-list" id="util-dropdown-list-preview"></div>
    ${
      externalLinks.length
        ? `<div class="util-section-label">새 탭에서 열림 <span class="muted">(사이트 자체 보안 정책상 미리보기를 지원하지 않음)</span></div>
           <div class="card-list" id="util-dropdown-list-external"></div>`
        : ""
    }
  `;
  const renderCard = (link, list) => {
    const card = document.createElement("a");
    card.className = "mini-card util-card";
    card.href = link.url;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.innerHTML = `
      <span class="util-icon">${UTIL_LINK_ICON}</span>
      <span class="title">${escapeHtml(link.label)}</span>
      <span class="util-arrow">↗</span>
    `;
    // 그냥 클릭하면 새 페이지로 넘어가지 않고 떠 있는 미리보기 패널로 보여줌.
    // Ctrl/Cmd/휠클릭 등 "새 탭으로 열기" 의도가 명확한 경우나, iframe 삽입 자체를 막아둔
    // 사이트(noPreview)는 예전처럼 그냥 새 탭으로 연다.
    card.onclick = (e) => {
      if (!link.noPreview) {
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
          closeUtilDropdown();
          return;
        }
        e.preventDefault();
        openUtilPreview(link);
      }
      closeUtilDropdown();
    };
    list.appendChild(card);
  };
  const previewList = document.getElementById("util-dropdown-list-preview");
  previewLinks.forEach((link) => renderCard(link, previewList));
  const externalList = document.getElementById("util-dropdown-list-external");
  if (externalList) externalLinks.forEach((link) => renderCard(link, externalList));
}
buildUtilDropdownMenu();
// 3D 프린트 서버 켜기/끄기는 다른 서버(server.py)의 로컬 파일 스위치라 이 정적 페이지/Notion
// 구조와는 무관해서 뺐다 — 필요하면 3D Print Viewer 링크로 그 페이지에 가서 확인하면 된다.

let utilDropdownOpen = false;
function openUtilDropdown() {
  const btn = document.getElementById("util-dropdown-btn");
  const menu = document.getElementById("util-dropdown-menu");
  const rect = btn.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  menu.classList.remove("hidden");
  btn.classList.add("dropdown-open");
  utilDropdownOpen = true;
}
function closeUtilDropdown() {
  document.getElementById("util-dropdown-menu").classList.add("hidden");
  document.getElementById("util-dropdown-btn").classList.remove("dropdown-open");
  utilDropdownOpen = false;
}
document.getElementById("util-dropdown-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  utilDropdownOpen ? closeUtilDropdown() : openUtilDropdown();
});
document.addEventListener("click", (e) => {
  if (!utilDropdownOpen) return;
  if (document.getElementById("util-dropdown").contains(e.target)) return;
  // 드롭다운 안의 버튼이 로그인 모달을 띄우는 경우, 그 모달에서 비밀번호를 입력/제출하는
  // 클릭까지 "바깥 클릭"으로 취급해 드롭다운이 먼저 닫혀버리면 안 됨
  if (document.getElementById("auth-modal-root").contains(e.target)) return;
  closeUtilDropdown();
});

let utilPreviewOpen = false;
// 패널이 실제로 화면에 떠 있을 때(열림·최소화 아님)만 뒤에 깔린 허브 페이지 스크롤을 잠근다
function setUtilPreviewScrollLock(locked) {
  document.body.classList.toggle("util-preview-scroll-lock", locked);
}
function openUtilPreview(link) {
  document.getElementById("util-preview-title").textContent = link.label;
  document.getElementById("util-preview-open-new").href = link.url;
  document.getElementById("util-preview-restore-label").textContent = link.label;
  document.getElementById("util-preview-iframe").src = link.url;
  document.getElementById("util-preview-panel").classList.remove("hidden", "minimized");
  document.getElementById("util-preview-restore").classList.add("hidden");
  utilPreviewOpen = true;
  setUtilPreviewScrollLock(true);
}
function closeUtilPreview() {
  document.getElementById("util-preview-panel").classList.add("hidden");
  document.getElementById("util-preview-panel").classList.remove("minimized");
  document.getElementById("util-preview-iframe").src = "about:blank"; // 백그라운드에서 계속 로드되지 않게
  document.getElementById("util-preview-restore").classList.add("hidden");
  utilPreviewOpen = false;
  setUtilPreviewScrollLock(false);
}
// 최소화하면 패널은 화면에서만 숨기고 iframe은 그대로 살려둬서(src를 안 건드림), 다른 탭을
// 자유롭게 오가다가 알약 모양 표시를 눌러 로드된 상태 그대로 다시 열 수 있게 한다
function minimizeUtilPreview() {
  document.getElementById("util-preview-panel").classList.add("minimized");
  document.getElementById("util-preview-restore").classList.remove("hidden");
  setUtilPreviewScrollLock(false);
}
function restoreUtilPreview() {
  document.getElementById("util-preview-panel").classList.remove("minimized");
  document.getElementById("util-preview-restore").classList.add("hidden");
  setUtilPreviewScrollLock(true);
}
document.getElementById("util-preview-close").onclick = closeUtilPreview;
document.getElementById("util-preview-minimize").onclick = minimizeUtilPreview;
document.getElementById("util-preview-restore-body").onclick = restoreUtilPreview;
document.getElementById("util-preview-restore-close").onclick = (e) => {
  e.stopPropagation();
  closeUtilPreview();
};
// 새 창에서 열면 기존에 떠 있던 미리보기 패널은 정리해서 중복으로 남지 않게 함
document.getElementById("util-preview-open-new").addEventListener("click", closeUtilPreview);

// ---------- weekly report ----------

function tasksInRange(start, end) {
  return state.allTasks.filter((t) => {
    const r = taskEffRange(t);
    return r && r.start <= end && r.end >= start;
  });
}

function renderReport() {
  app.innerHTML = `
    <div class="section-header">
      <h2>주간 업무일지</h2>
      <div style="display:flex; gap:0.5rem;">
        <button class="btn btn-sm" id="copy-report-btn">📋 복사</button>
        <button class="btn btn-sm" id="save-report-img-btn">🖼 이미지 저장</button>
        <button class="btn btn-sm" id="save-report-pdf-btn">📄 PDF 저장</button>
      </div>
    </div>
    <div class="filters">
      <label class="report-label">팀 이름 <input type="text" id="report-team" value="${escapeHtml(state.reportTeamName)}" /></label>
      <label class="report-label">시작 <input type="date" id="report-start" value="${state.reportStart}" /></label>
      <label class="report-label">종료 <input type="date" id="report-end" value="${state.reportEnd}" /></label>
    </div>
    <div id="report-output"></div>
  `;
  document.getElementById("report-team").onchange = (e) => {
    state.reportTeamName = e.target.value;
    renderReportOutput();
  };
  document.getElementById("report-start").onchange = (e) => {
    state.reportStart = e.target.value;
    renderReportOutput();
  };
  document.getElementById("report-end").onchange = (e) => {
    state.reportEnd = e.target.value;
    renderReportOutput();
  };
  document.getElementById("copy-report-btn").onclick = copyReportToClipboard;
  document.getElementById("save-report-img-btn").onclick = saveReportAsImage;
  document.getElementById("save-report-pdf-btn").onclick = printReportAsPdf;
  renderReportOutput();
}

// DOM 요소를 캡처해서 canvas로 반환한다 (PNG/JPG 등 최종 포맷 변환은 호출부에서 toDataURL로 처리).
// html2canvas 라이브러리를 써봤는데 자체 텍스트 레이아웃 엔진이 한글에서 부정확해서(단어 사이
// 공백이 사라지거나, 폭에 걸려 자동으로 줄바꿈되는 줄들이 겹쳐 보임 — letterRendering·
// foreignObjectRendering 옵션으로도 못 고침) 아예 브라우저 자체 렌더링을 그대로 옮겨 그리는
// 방식으로 직접 구현함: 요소를 SVG <foreignObject>로 감싸서 <img>로 불러온 뒤 canvas에 그린다 —
// 브라우저가 실제로 계산한 레이아웃을 그대로 쓰는 거라 텍스트가 절대 깨지지 않고, 외부 CDN
// 라이브러리도 필요 없다.
// :root {...} 블록에 선언된 CSS 커스텀 프로퍼티(--bg, --surface 등) 이름 전부를 모은다
function getRootVarNames() {
  const names = new Set();
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // 크로스오리진 스타일시트는 읽을 수 없음 — 이 앱에는 해당 없음
    }
    for (const rule of rules) {
      if (rule.selectorText === ":root" && rule.style) {
        for (const prop of rule.style) {
          if (prop.startsWith("--")) names.add(prop);
        }
      }
    }
  }
  return [...names];
}

// 지금 테마와 무관하게 "라이트 모드일 때의" CSS 변수 값들을 계산해서 돌려준다.
// data-theme 속성을 아주 짧게 라이트로 바꿨다가 읽고 즉시 되돌리는데, 이 사이에 await가
// 전혀 없어서(동기 실행) 브라우저가 다시 그릴 틈이 없어 화면에 깜빡임이 보이지 않는다.
function getLightThemeVars() {
  const root = document.documentElement;
  const prevTheme = root.getAttribute("data-theme");
  root.setAttribute("data-theme", "light");
  const computed = getComputedStyle(root);
  const vars = Object.fromEntries(getRootVarNames().map((name) => [name, computed.getPropertyValue(name).trim()]));
  if (prevTheme) root.setAttribute("data-theme", prevTheme);
  else root.removeAttribute("data-theme");
  return vars;
}

async function captureElementToCanvas(el, scale = 2, cssVarOverrides = {}) {
  // scrollWidth/scrollHeight는 html { zoom: 0.9 } 의 영향을 안 받아서(getBoundingClientRect와 달리
  // 확대축소가 반영 안 된 값을 돌려줌) 실제 화면에 보이는 크기보다 약 1/0.9배 크게 나온다.
  // getBoundingClientRect는 zoom이 반영된 실제 시각적 크기를 주므로 이걸 써야 캡처 크기가 맞음.
  const rect = el.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  const css = Array.from(document.styleSheets)
    .flatMap((sheet) => {
      try {
        return Array.from(sheet.cssRules).map((r) => r.cssText);
      } catch {
        return []; // 크로스오리진 스타일시트는 읽을 수 없음 — 이 앱에는 해당 없음
      }
    })
    .join("\n");
  const xhtml = new XMLSerializer().serializeToString(el.cloneNode(true));
  // 배경/글자색은 --bg·--surface 같은 CSS 변수가 :root(다크모드면 :root[data-theme="dark"] 등)에서
  // 정해지는데, foreignObject 안의 콘텐츠는 원래 페이지의 <html data-theme="..."> 와 별개인 자기만의
  // 문서라서 :root 선택자가 기대한 대로 매칭이 안 되고(브라우저마다 다르게 처리), 시스템이 다크 모드를
  // 선호하면 그 미디어쿼리가 그대로 먹어 배경이 검게 나오는 문제가 있었다. 선택자 매칭에 기대는 대신,
  // 원하는 테마의 실제 계산된 CSS 변수 값을 감싸는 요소에 인라인으로 직접 박아넣어 확실하게 만든다.
  const varStyle = Object.entries(cssVarOverrides)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
  // 전체 페이지에 html { zoom: 0.9 } 가 걸려있는데, foreignObject 안쪽은 <html> 요소가 없는
  // 별개의 문서라서 이 규칙이 매칭이 안 돼 zoom이 안 먹는다 — el.scrollWidth/Height는 이미
  // zoom이 적용된(줄어든) 크기라서, 캡처 안쪽도 같은 비율로 줄여야 크기가 서로 맞음.
  const zoom = getComputedStyle(document.documentElement).zoom || "1";
  const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <foreignObject width="100%" height="100%">
      <div xmlns="http://www.w3.org/1999/xhtml" style="margin:0;zoom:${zoom};${varStyle}">
        <style>${css}</style>
        ${xhtml}
      </div>
    </foreignObject>
  </svg>`;
  // blob: URL로 불러오면 크로미움에서 foreignObject 콘텐츠가 있는 SVG를 캔버스로 못 옮기게
  // (tainted canvas) 막아버려서, data: URI로 불러와야 함
  const dataUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgMarkup);
  const img = new Image();
  img.width = width;
  img.height = height;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("이미지를 그리지 못했습니다"));
    img.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

// A4(297x210mm) 세로 비율 — 페이지 하나의 세로 여백을 이 비율로 정해서, 내용이 많아져도
// 페이지를 나눠 저장하고 글씨 크기는 항상 그대로 유지되게 한다.
const A4_HEIGHT_TO_WIDTH_RATIO = 297 / 210;

function elementHeight(el) {
  return el.getBoundingClientRect().height;
}

// 화면에 보이지 않는 곳에 임시로 sheet HTML을 붙였다가, 콜백에서 다 쓰고 나면 치운다.
// 페이지 높이를 재는 것도 실제로 캡처할 페이지들도 항상 이 함수를 통해서만 DOM에 올리는 이유:
// 화면에 떠 있는 라이브 #report-sheet에서 잰 행 높이를, 이렇게 별도로 새로 그린 요소와
// 비교했더니 (원인 불명 — html에 걸린 zoom:0.9의 반올림 오차로 추정) 같은 너비인데도 줄바꿈이
// 미묘하게 달라져서 행 높이가 서로 안 맞는 경우가 있었다. 페이지 나누기 계산에 쓰는 "잰 높이"와
// 실제로 캡처하는 요소를 항상 같은 방식(오프스크린 DOM)으로 통일해서 이 오차를 원천적으로 없앤다.
async function withOffscreenHtml(html, fn) {
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-99999px";
  host.style.top = "0";
  host.innerHTML = html;
  document.body.appendChild(host);
  try {
    return await fn(host.firstElementChild);
  } finally {
    document.body.removeChild(host);
  }
}

// reportRowRecords를 주어진 콘텐츠 너비 기준 한 페이지 분량씩 나눠서, 각 페이지에 들어갈 본문
// HTML 문자열 배열로 돌려준다. 실제로 그려질 때의 항목 높이를 오프스크린에서 재서 계산하므로
// 이미지 저장/PDF 인쇄 양쪽에서 같은 페이지 나누기 로직을 재사용할 수 있다.
async function paginateReportRows(contentWidthPx, contentHeightPx) {
  const fullBodyHtml = buildReportBodyHtml(reportRowRecords, new Set());
  const fullHtml = reportSheetShellHtml({ widthPx: contentWidthPx, bodyHtml: fullBodyHtml, forExport: true });
  const { overhead, combinedHeights } = await withOffscreenHtml(fullHtml, async (el) => {
    const titleEl = el.querySelector(".report-title");
    const periodEl = el.querySelector(".report-period-line");
    const elStyle = getComputedStyle(el);
    const paddingV = parseFloat(elStyle.paddingTop || 0) + parseFloat(elStyle.paddingBottom || 0);
    const groupTitleHeights = [...el.querySelectorAll(".report-group-title")].map(elementHeight);
    const entryHeights = [...el.querySelectorAll(".report-task-entry")].map(elementHeight);
    // 그룹 제목은 그 그룹의 첫 항목과 항상 붙어 있어야 하므로(제목만 페이지 끝에 혼자 남으면
    // 안 됨), 첫 항목의 높이에 그룹 제목 높이를 더해 하나로 취급한다
    const combined = new Array(reportRowRecords.length).fill(0);
    let groupIdx = -1;
    reportRowRecords.forEach((r, i) => {
      if (r.isGroupStart) groupIdx++;
      combined[i] = entryHeights[i] + (r.isGroupStart ? groupTitleHeights[groupIdx] : 0);
    });
    return {
      overhead: elementHeight(titleEl) + elementHeight(periodEl) + paddingV,
      combinedHeights: combined,
    };
  });
  // 실제 한 페이지 분량의 세로 공간(제목·기간 제외)
  const bodyBudget = Math.max(200, contentHeightPx - overhead);

  const pageGroups = [];
  let current = [];
  let currentHeight = 0;
  reportRowRecords.forEach((record, i) => {
    const h = combinedHeights[i];
    // 페이지가 비어있지 않은데 이 항목을 넣으면 한 장 분량을 넘기면 새 페이지로 — 단, 첫 항목부터
    // 넘칠 만큼 길면(예: 메모가 아주 긴 태스크) 어쩔 수 없이 혼자라도 넣는다
    if (current.length && currentHeight + h > bodyBudget) {
      pageGroups.push(current);
      current = [];
      currentHeight = 0;
    }
    current.push(record);
    currentHeight += h;
  });
  if (current.length) pageGroups.push(current);

  // 그룹(프로젝트/업무유형)이 페이지 경계에서 잘리면, 이어지는 페이지에는 "(계속)"을 붙여준다
  const shownGroups = new Set();
  const pageBodyHtmlList = pageGroups.map((pageRecords) => buildReportBodyHtml(pageRecords, shownGroups));
  return { pageBodyHtmlList, totalPages: pageGroups.length };
}

async function saveReportAsImage() {
  const sheet = document.getElementById("report-sheet");
  if (!sheet || !reportRowRecords.length) {
    showToast("저장할 내용이 없습니다", true);
    return;
  }
  const btn = document.getElementById("save-report-img-btn");
  btn.disabled = true;
  btn.textContent = "생성 중...";
  try {
    const pageWidth = sheet.getBoundingClientRect().width;
    const { pageBodyHtmlList, totalPages } = await paginateReportRows(pageWidth, pageWidth * A4_HEIGHT_TO_WIDTH_RATIO);

    const canvases = [];
    for (let p = 0; p < totalPages; p++) {
      const titleSuffix = totalPages > 1 ? ` (${p + 1}/${totalPages})` : "";
      // 마지막 페이지처럼 내용이 얼마 안 남으면 이미지가 짧아져서 세로가 아니라 가로로 넓적하게
      // 나올 수 있어서, 페이지가 여러 장으로 나뉘는 경우엔 항상 A4 한 장 분량 높이를 채우게 한다
      // (내용이 모자란 만큼은 빈 공간으로 남음). 한 장으로 끝나면 기존처럼 내용 높이 그대로 둔다.
      const heightPx = totalPages > 1 ? pageWidth * A4_HEIGHT_TO_WIDTH_RATIO : undefined;
      const pageHtml = reportSheetShellHtml({ titleSuffix, widthPx: pageWidth, heightPx, bodyHtml: pageBodyHtmlList[p], forExport: true });
      const canvas = await withOffscreenHtml(pageHtml, (el) => captureElementToCanvas(el, 2, getLightThemeVars()));
      canvases.push(canvas);
    }

    canvases.forEach((canvas, i) => {
      const suffix = totalPages > 1 ? `_${i + 1}of${totalPages}` : "";
      const link = document.createElement("a");
      link.download = `${state.reportTeamName}_주간업무보고서_${state.reportStart}${suffix}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    });
    if (totalPages > 1) showToast(`내용이 많아 ${totalPages}장으로 나눠 저장했습니다 (다운로드 허용 필요할 수 있음)`);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "🖼 이미지 저장";
  }
}

// PDF는 이미지 저장과 달리 브라우저 자체 인쇄 페이지 나누기를 그대로 쓴다 — 페이지 개수를 미리
// 계산해 강제로 나눌 필요가 없어서(report-task-entry에 break-inside:avoid만 걸어두면 항목이
// 중간에 안 잘리고 알아서 다음 물리 페이지로 넘어감), 매 페이지를 A4 한 장 높이로 강제로 채우다가
// 내용이 적은 페이지에 용지가 낭비되는 문제 자체가 없다. 그냥 전체를 한 번에 흘려보낸다.
// PDF는 화면과 달리 "할일"(아직 시작 안 한) 상태 태스크는 아예 빼고, 메모·체크리스트 같은
// 상세 내용도 뺀다 — 웹 화면과 이미지 저장에서는 그대로 다 보여주고, PDF에서만 타이틀/담당자/
// 기간/진행률 위주로 간결하게 남긴다.
async function printReportAsPdf() {
  const pdfTasks = reportRowRecords.map((r) => r.task).filter((t) => t.status !== "할 일");
  if (!pdfTasks.length) {
    showToast("저장할 내용이 없습니다", true);
    return;
  }
  const btn = document.getElementById("save-report-pdf-btn");
  btn.disabled = true;
  btn.textContent = "생성 중...";
  try {
    const pdfRecords = buildReportRowRecords(pdfTasks);
    const bodyHtml = buildReportBodyHtml(pdfRecords, new Set(), true);
    const root = document.getElementById("print-report-root");
    root.innerHTML = reportSheetShellHtml({ bodyHtml, forExport: true });
    window.addEventListener("afterprint", () => { root.innerHTML = ""; }, { once: true });
    window.print();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "📄 PDF 저장";
  }
}

// 업무일지 항목 하나(태스크 하나)를 다루는 로직 — 화면 표시와 이미지/PDF 저장(페이지 분할)
// 양쪽에서 같은 데이터로 다시 조립할 수 있도록, 마크업 문자열이 아니라 레코드 배열로 먼저 만들어둔다.
// "휴가 및 사내 행사"는 업무 항목이 아니라 개인 연차/공가/경조사 휴무이므로,
// 다른 프로젝트/업무유형들과 섞이지 않게 맨 아래 "휴무일" 항목으로 따로 묶는다.
const LEAVE_PROJECT_NAME = "휴가 및 사내 행사";

// 같은 이름 + 같은 담당자 조합의 태스크가 기간 내에 여러 날짜에 걸쳐 반복되면(예: 매일 진행하는
// 온라인 강의 수강처럼) 보고서에 날짜마다 중복으로 나열되지 않도록 하나로 합친다. 상태·진행률·
// 메모·체크리스트는 가장 최근 날짜의 항목 걸 대표로 쓰고, 날짜들은 __mergedDates에 모아둔다.
function mergeRecurringTasks(tasks) {
  const groups = new Map();
  for (const t of tasks) {
    const assigneeKey = combinedNames(t.assignees, t.customAssignees).slice().sort().join(",");
    const key = `${t.name}␟${assigneeKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const dateOf = (t) => splitDateTime(t.startDate).date || splitDateTime(t.dueDate).date || "";
  const merged = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      merged.push(list[0]);
      continue;
    }
    const sorted = [...list].sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
    const latest = sorted[sorted.length - 1];
    merged.push({
      ...latest,
      __mergedDates: sorted.map((t) => dateOf(t) || "-"),
      __mergedCount: sorted.length,
    });
  }
  return merged;
}

function buildReportRowRecords(tasksIn) {
  const tasks = mergeRecurringTasks(tasksIn);
  const grouped = new Map();
  for (const t of tasks) {
    // 연결된 프로젝트가 있으면 프로젝트명, 없으면 업무유형(상시 반복 업무 구분), 둘 다 없으면 미분류
    const rawProj = t.projectIds[0] ? projectName(t.projectIds[0]) || "미분류" : t.workType || "미분류";
    const proj = rawProj === LEAVE_PROJECT_NAME ? "휴무일" : rawProj;
    if (!grouped.has(proj)) grouped.set(proj, []);
    grouped.get(proj).push(t);
  }
  const groupRank = (name) => (name === "휴무일" ? 2 : name === "미분류" ? 1 : 0);
  const sortedGroups = [...grouped].sort(([a], [b]) => groupRank(a) - groupRank(b));

  const records = [];
  for (const [proj, list] of sortedGroups) {
    list.forEach((t, i) => records.push({ groupName: proj, isGroupStart: i === 0, groupSize: list.length, task: t }));
  }
  return records;
}

function checklistReportHtml(t) {
  if (!t.checklist || !t.checklist.length) return "";
  const items = t.checklist
    .map((i) => `<li>${i.checked ? "☑" : "☐"} ${escapeHtml(i.text)}</li>`)
    .join("");
  return `<ul class="report-checklist">${items}</ul>`;
}

// 태스크 하나를 표의 행이 아니라 자유롭게 흘러가는 항목 블록으로 표시 — 업무명+상태를 한 줄에,
// 그 아래 담당자·기간, 메모, 체크리스트 순으로. 열 너비에 맞춰 줄바꿈을 걱정할 필요가 없어져서
// 표 기반 레이아웃에서 계속 겹치던 페이지 분할/인쇄 폭 문제들이 자연스럽게 해결된다.
// PDF로 저장할 때는(hideDetails) 메모·체크리스트처럼 분량을 많이 잡아먹는 상세 내용은 빼고
// 타이틀/담당자/기간/진행률 위주로만 남긴다 — 화면(웹)과 이미지 저장에서는 그대로 다 보여준다.
function reportTaskEntryHtml(t, hideDetails = false) {
  const dateLine = t.__mergedDates
    ? `${t.__mergedDates.join(", ")} (총 ${t.__mergedCount}회)`
    : `${splitDateTime(t.startDate).date || "-"} ~ ${splitDateTime(t.dueDate).date || "-"}`;
  const progressText =
    t.status === "진행중" && t.progress !== null && t.progress !== undefined ? `<span class="report-task-progress">${t.progress}%</span>` : "";
  // 완료는 업무일지에서 예전부터 "完" 한 글자로 짧게 표시 — 공간 여유가 생겨도 이 관례는 유지
  const statusTag = t.status === "완료" ? `<span class="tag status-완료">完</span>` : tag(t.status, "status");
  return `
    <div class="report-task-entry">
      <div class="report-task-head">
        <span class="report-task-name">${escapeHtml(t.name)}</span>
        ${statusTag}${progressText}
      </div>
      <div class="report-task-meta">${allAssigneeNamesText(t)} · ${dateLine}</div>
      ${!hideDetails && t.note ? `<div class="report-task-note">${escapeHtml(t.note).replace(/\n/g, "<br/>")}</div>` : ""}
      ${!hideDetails ? checklistReportHtml(t) : ""}
    </div>
  `;
}

// continued=true면 이 그룹명이 이전 페이지에서 이미 한 번 나왔다는 뜻 — "(계속)"을 붙여준다
function reportGroupTitleHtml(groupName, continued) {
  return `<h3 class="report-group-title">${escapeHtml(groupName)}${continued ? ` <span class="report-group-continued">(계속)</span>` : ""}</h3>`;
}

// PDF 전용 그룹 블록 — 제목을 가로 막대(별도 한 줄)로 두는 대신 왼쪽에 세로로 눕힌 라벨을 붙여서,
// 제목이 차지하던 세로 공간 자체를 없앤다. 그룹 하나가 페이지 중간에 잘리면 라벨과 항목이
// 어긋나 보이므로 통째로 다음 페이지로 넘어가게 break-inside:avoid를 건다.
function reportGroupVerticalBlockHtml(groupName, continued, itemsHtml) {
  return `<div class="report-group-block-vertical">
    <div class="report-group-vlabel">${escapeHtml(groupName)}${continued ? " (계속)" : ""}</div>
    <div class="report-group-items">${itemsHtml}</div>
  </div>`;
}

// records를 그룹(프로젝트/업무유형)별로 묶어 "그룹 제목 + 업무 항목들" 블록들의 HTML로 만든다.
// shownGroups에 이미 나온 그룹이면 "(계속)"을 붙이고, 다 만든 그룹은 shownGroups에 추가해준다 —
// 페이지 나누기에서 여러 페이지에 걸쳐 호출하며 같은 Set을 넘기면 이어지는 그룹임을 알 수 있다.
// hideDetails(=PDF 저장)일 때는 제목을 가로 막대 대신 왼쪽 세로 라벨로 바꿔서 공간을 아낀다.
function buildReportBodyHtml(records, shownGroups, hideDetails = false) {
  const parts = [];
  let i = 0;
  while (i < records.length) {
    const { groupName } = records[i];
    let count = 1;
    while (i + count < records.length && records[i + count].groupName === groupName) count++;
    const itemsHtml = Array.from({ length: count }, (_, k) => reportTaskEntryHtml(records[i + k].task, hideDetails)).join("");
    if (hideDetails) {
      parts.push(reportGroupVerticalBlockHtml(groupName, shownGroups.has(groupName), itemsHtml));
    } else {
      parts.push(reportGroupTitleHtml(groupName, shownGroups.has(groupName)));
      parts.push(itemsHtml);
    }
    shownGroups.add(groupName);
    i += count;
  }
  return parts.join("");
}

function reportSheetShellHtml({ titleSuffix = "", widthPx, heightPx, bodyHtml, forExport = false }) {
  // widthPx/heightPx는 "실제로 화면에 보이길 원하는" 시각적 크기다. 이 조각은 오프스크린이라도
  // 결국 html { zoom: 0.9 } 가 걸린 라이브 페이지의 일부라서, CSS 값에 그대로 넣으면 zoom이
  // 한 번 더 곱해져(0.9배) 의도한 것보다 작게 렌더링된다 — zoom으로 나눠서 넣어야
  // 실제 렌더링 결과가 지정한 크기와 일치한다.
  // heightPx(min-height)는 페이지 나누기에서 마지막 페이지처럼 내용이 적게 남았을 때도, 이미지가
  // 가로로 넓적하게(landscape) 나오지 않고 항상 A4 세로 비율을 유지하도록 빈 공간을 채워준다.
  const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const cssWidthPx = widthPx ? widthPx / zoom : undefined;
  const cssHeightPx = heightPx ? heightPx / zoom : undefined;
  const sizeStyle = [cssWidthPx ? `width:${cssWidthPx}px` : "", cssHeightPx ? `min-height:${cssHeightPx}px` : ""]
    .filter(Boolean)
    .join(";");
  // 화면에서 보는 글씨 크기는 보고서 이미지/PDF로 저장했을 때 읽기엔 너무 작아서,
  // 저장용으로 캡처할 때만 더 큰 글씨로 덮어쓴다 (화면 표시에는 영향 없음)
  const exportFontStyle = forExport ? `<style>.report-sheet{font-size:1.05rem;}</style>` : "";
  return `<div class="report-sheet"${sizeStyle ? ` style="${sizeStyle}"` : ""}>
    ${exportFontStyle}
    <h2 class="report-title">${escapeHtml(state.reportTeamName)} 주간 업무 보고서${titleSuffix}</h2>
    <div class="report-period-line">${formatDotDate(state.reportStart)} ~ ${formatDotDate(state.reportEnd)}</div>
    ${bodyHtml}
  </div>`;
}

// 이미지/PDF 저장 시 페이지 나누기에 그대로 재사용하므로, 화면 렌더링에 쓴 레코드 배열을 기억해둔다.
let reportRowRecords = [];

function renderReportOutput() {
  const output = document.getElementById("report-output");
  const tasks = tasksInRange(state.reportStart, state.reportEnd);

  if (!tasks.length) {
    output.innerHTML = `<div class="detail-block"><span class="muted">선택한 기간에 해당하는 태스크가 없습니다</span></div>`;
    reportRowRecords = [];
    return;
  }

  reportRowRecords = buildReportRowRecords(tasks);
  const bodyHtml = buildReportBodyHtml(reportRowRecords, new Set());

  output.innerHTML = reportSheetShellHtml({ bodyHtml });
  output.firstElementChild.id = "report-sheet";
}

async function copyReportToClipboard() {
  const sheet = document.getElementById("report-sheet");
  if (!sheet) {
    showToast("복사할 내용이 없습니다", true);
    return;
  }
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      const item = new ClipboardItem({
        "text/html": new Blob([sheet.outerHTML], { type: "text/html" }),
        "text/plain": new Blob([sheet.innerText], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);
      showToast("복사되었습니다 - 메일/노션 등에 붙여넣으세요");
      return;
    }
    throw new Error("clipboard API 없음");
  } catch {
    try {
      const range = document.createRange();
      range.selectNode(sheet);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const ok = document.execCommand("copy");
      selection.removeAllRanges();
      showToast(ok ? "복사되었습니다 - 메일/노션 등에 붙여넣으세요" : "복사에 실패했습니다. 표를 직접 드래그해서 복사해주세요.", !ok);
    } catch (err) {
      showToast("복사에 실패했습니다. 표를 직접 드래그해서 복사해주세요.", true);
    }
  }
}

// ---------- init ----------

(async function init() {
  app.innerHTML = `<div class="muted">불러오는 중...</div>`;
  try {
    await loadAll();
    render();
    initNotifFab();
    initModeIndicator();
    showDailyTaskPopupIfNeeded();
  } catch (err) {
    app.innerHTML = `<div class="detail-block">초기 로딩에 실패했습니다: ${escapeHtml(err.message)}<br/><span class="muted">Notion 연결 설정을 확인하세요.</span></div>`;
  }
})();
