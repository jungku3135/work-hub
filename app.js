/* 개인 Work Hub — 순수 정적 페이지, 브라우저에서 Notion API 직접 호출 */
const NC = window.NotionClient;
const CFG = window.CONFIG;

const state = {
  tab: "tasks",
  settings: NC.getSettings(),
  tasks: [],
  projects: [],
  meetings: [],
  reportStart: defaultWeekRange().start,
  reportEnd: defaultWeekRange().end,
};

const app = document.getElementById("app");
const modalRoot = document.getElementById("modal-root");
const toastEl = document.getElementById("toast");

function defaultWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { start: fmt(monday), end: fmt(friday) };
}

function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  toastEl.classList.toggle("toast-error", isError);
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.add("hidden"), 2800);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- modal ----------
function openModal(html, onMount) {
  modalRoot.innerHTML = `<div class="modal">${html}</div>`;
  modalRoot.classList.remove("hidden");
  onMount?.(modalRoot.querySelector(".modal"));
  modalRoot.onclick = (e) => { if (e.target === modalRoot) closeModal(); };
}
function closeModal() {
  modalRoot.classList.add("hidden");
  modalRoot.innerHTML = "";
}

// ---------- settings ----------
function renderSettings() {
  const s = state.settings;
  const D = CFG.DEFAULT_DATA_SOURCES;
  app.innerHTML = `
    <div class="settings-box">
      <h2>⚙ 연결 설정</h2>
      <p>기존 시스템팀 work-hub와 같은 비밀번호를 입력하세요. 진짜 Notion 토큰은 브라우저에 저장되지 않고, Cloudflare Worker 프록시가 서버 쪽에서만 들고 있습니다.</p>
      <div class="field"><label>비밀번호 (기존 work-hub와 동일)</label><input type="password" id="s-secret" value="${escapeHtml(s.appSecret || "")}" /></div>
      <div class="field"><label>태스크 데이터소스 ID</label><input type="text" id="s-tasks" value="${escapeHtml(s.tasksDbId || D.tasksDbId)}" /></div>
      <div class="field"><label>프로젝트 데이터소스 ID (선택)</label><input type="text" id="s-projects" value="${escapeHtml(s.projectsDbId || D.projectsDbId)}" /></div>
      <div class="field"><label>회의록 데이터소스 ID (선택)</label><input type="text" id="s-meetings" value="${escapeHtml(s.meetingsDbId || D.meetingsDbId)}" /></div>
      <div class="field"><label>팀 이름 (업무일지 제목에 표시)</label><input type="text" id="s-teamname" value="${escapeHtml(s.teamName || "시스템팀")}" /></div>
      <div class="field"><label>공휴일 API 키 (data.go.kr, 선택)</label><input type="text" id="s-holidaykey" value="${escapeHtml(s.holidayApiKey || "")}" /></div>
      <div class="field"><label>기상청 초단기실황 API 키 (선택, 날씨 온도 정확도용)</label><input type="text" id="s-kmakey" value="${escapeHtml(s.kmaApiKey || "")}" /></div>
      <div class="modal-actions">
        <span class="muted" id="s-status"></span>
        <div class="modal-actions-right">
          <button class="btn" id="s-test">연결 테스트</button>
          <button class="btn btn-primary" id="s-save">저장</button>
        </div>
      </div>
    </div>`;
  document.getElementById("s-save").onclick = () => {
    const newSettings = {
      appSecret: document.getElementById("s-secret").value.trim(),
      tasksDbId: document.getElementById("s-tasks").value.trim(),
      projectsDbId: document.getElementById("s-projects").value.trim(),
      meetingsDbId: document.getElementById("s-meetings").value.trim(),
      teamName: document.getElementById("s-teamname").value.trim(),
      holidayApiKey: document.getElementById("s-holidaykey").value.trim(),
      kmaApiKey: document.getElementById("s-kmakey").value.trim(),
    };
    NC.saveSettings(newSettings);
    state.settings = newSettings;
    showToast("설정이 저장되었습니다");
    if (newSettings.appSecret && newSettings.tasksDbId) { state.tab = "tasks"; loadAllAndRender(); }
  };
  document.getElementById("s-test").onclick = async () => {
    const statusEl = document.getElementById("s-status");
    statusEl.textContent = "확인 중...";
    const tmp = {
      appSecret: document.getElementById("s-secret").value.trim(),
      tasksDbId: document.getElementById("s-tasks").value.trim(),
    };
    const prev = NC.getSettings();
    NC.saveSettings(tmp);
    try {
      await NC.queryDatabaseAll(tmp.tasksDbId, { page_size: 1 });
      statusEl.textContent = "✅ 연결 성공";
    } catch (e) {
      statusEl.textContent = `❌ 실패: ${e.message}`;
    } finally {
      NC.saveSettings(prev);
    }
  };
}

// ---------- tasks: read/write mapping ----------
function pageToTask(page) {
  const p = page.properties;
  const TP = CFG.TASK_PROPS;
  let checklist = [];
  try { checklist = JSON.parse(NC.readRichText(p[TP.checklist]) || "[]"); } catch {}
  return {
    id: page.id,
    name: NC.readTitle(p[TP.name]),
    status: NC.readSelect(p[TP.status]),
    category: NC.readSelect(p[TP.category]),
    priority: NC.readSelect(p[TP.priority]),
    startDate: NC.readDate(p[TP.startDate]),
    dueDate: NC.readDate(p[TP.dueDate]),
    assignees: NC.readPeople(p[TP.assignees]),
    projectIds: NC.readRelation(p[TP.project]),
    note: NC.readRichText(p[TP.note]),
    holidayWork: NC.readCheckbox(p[TP.holidayWork]),
    recurrence: NC.readSelect(p[TP.recurrence]),
    progress: NC.readNumber(p[TP.progress]),
    workType: NC.readSelect(p[TP.workType]),
    checklist,
  };
}

function checklistProgress(checklist) {
  if (!checklist.length) return null;
  return Math.round((checklist.filter((i) => i.checked).length / checklist.length) * 100);
}

async function loadAllAndRender() {
  if (!NC.hasValidSettings()) { state.tab = "settings"; render(); return; }
  app.innerHTML = `<div class="muted" style="padding:2rem;">불러오는 중...</div>`;
  try {
    const taskPages = await NC.queryDatabaseAll(state.settings.tasksDbId);
    state.tasks = taskPages.map(pageToTask);
    if (state.settings.projectsDbId) {
      const projPages = await NC.queryDatabaseAll(state.settings.projectsDbId);
      state.projects = projPages.map(pageToProject);
    }
    if (state.settings.meetingsDbId) {
      const meetPages = await NC.queryDatabaseAll(state.settings.meetingsDbId, {
        sorts: [{ property: CFG.MEETING_PROPS.date, direction: "descending" }],
      });
      state.meetings = meetPages.map(pageToMeeting);
    }
    initWeather();
    render();
  } catch (e) {
    app.innerHTML = `<div class="settings-box"><h2>불러오기 실패</h2><p>${escapeHtml(e.message)}</p><button class="btn btn-primary" onclick="state.tab='settings';render()">설정으로 이동</button></div>`;
  }
}

function projectName(id) {
  return state.projects.find((p) => p.id === id)?.name;
}

function allAssigneeNamesText(t) {
  return (t.assignees || []).map((a) => a.name).join(", ") || "-";
}

function tag(text, kind) {
  if (!text) return `<span class="muted">-</span>`;
  const cls = kind ? `tag ${kind}-${text.replace(/\s/g, ".")}` : "tag";
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

// ---------- tasks view ----------
function renderTasks() {
  app.innerHTML = `
    <div class="section-header">
      <h2>태스크</h2>
      <button class="btn btn-primary" id="new-task-btn">+ 새 태스크</button>
    </div>
    <div class="filters">
      <select id="f-status"><option value="">전체 상태</option>${CFG.TASK_STATUS_OPTIONS.map((s) => `<option>${s}</option>`).join("")}</select>
    </div>
    <div class="card-list" id="task-list"></div>`;
  document.getElementById("new-task-btn").onclick = () => openTaskModal(null);
  document.getElementById("f-status").onchange = (e) => renderTaskList(e.target.value);
  renderTaskList("");
}

function renderTaskList(statusFilter) {
  const list = document.getElementById("task-list");
  const tasks = [...state.tasks]
    .filter((t) => !statusFilter || t.status === statusFilter)
    .sort((a, b) => (a.status === "완료") - (b.status === "완료") || (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
  if (!tasks.length) { list.innerHTML = `<span class="muted">태스크가 없습니다</span>`; return; }
  list.innerHTML = tasks.map((t) => taskCardHtml(t)).join("");
  list.querySelectorAll(".task-card").forEach((card) => {
    card.onclick = (e) => {
      if (e.target.closest(".quick-btn")) return;
      openTaskModal(state.tasks.find((t) => t.id === card.dataset.id));
    };
  });
  attachQuickActions(list);
}

function taskCardHtml(t) {
  const progress = t.status === "진행중" ? (t.progress ?? checklistProgress(t.checklist)) : null;
  const statusTag = t.status === "완료" ? `<span class="tag status-완료">完</span>` : tag(t.status, "status");
  let quick = "";
  if (t.status === "할 일") quick = `<div class="quick-actions"><button class="quick-btn" data-id="${t.id}" data-status="진행중" title="진행중으로">▶</button></div>`;
  else if (t.status === "진행중") quick = `<div class="quick-actions"><button class="quick-btn" data-id="${t.id}" data-status="완료" title="완료 처리">✓</button></div>`;
  return `
    <div class="task-card" data-id="${t.id}">
      ${quick}
      <div class="title">${escapeHtml(t.name)}</div>
      <div class="meta">
        ${statusTag} ${tag(t.priority, "priority")}
        <span>${allAssigneeNamesText(t)}</span>
        <span>${t.startDate || "-"} ~ ${t.dueDate || "-"}</span>
        ${t.projectIds[0] ? `<span>${escapeHtml(projectName(t.projectIds[0]) || "")}</span>` : ""}
      </div>
      ${progress !== null ? `<div class="progress-bar"><div style="width:${progress}%"></div></div>` : ""}
    </div>`;
}

function attachQuickActions(root) {
  root.querySelectorAll(".quick-btn").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const t = state.tasks.find((x) => x.id === btn.dataset.id);
      await setTaskStatus(t, btn.dataset.status);
      renderTaskList(document.getElementById("f-status")?.value || "");
    };
  });
}

async function setTaskStatus(t, newStatus) {
  try {
    await NC.updatePageProperties(t.id, { [CFG.TASK_PROPS.status]: NC.buildSelect(newStatus) });
    t.status = newStatus;
    if (newStatus === "완료" && t.recurrence && t.recurrence !== "없음") {
      await createNextOccurrence(t);
    }
    showToast("상태가 변경되었습니다");
  } catch (e) {
    showToast(e.message, true);
  }
}

// ---------- 반복 태스크: 완료 시 다음 회차 생성 (매일 반복은 주말/공휴일 건너뜀) ----------
function addInterval(dateStr, interval) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (interval === "매일") d.setUTCDate(d.getUTCDate() + 1);
  else if (interval === "매주") d.setUTCDate(d.getUTCDate() + 7);
  else if (interval === "매월") d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}
function isWeekend(dateStr) {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}
async function skipWeekendsAndHolidays(dateStr) {
  let d = dateStr;
  let year = Number(d.slice(0, 4));
  let holidays = await getHolidays(year);
  while (isWeekend(d) || holidays.has(d)) {
    d = addInterval(d, "매일");
    const y = Number(d.slice(0, 4));
    if (y !== year) { year = y; holidays = await getHolidays(year); }
  }
  return d;
}
async function createNextOccurrence(t) {
  let nextStart = t.startDate ? addInterval(t.startDate, t.recurrence) : null;
  let nextDue = t.dueDate ? addInterval(t.dueDate, t.recurrence) : null;
  if (!nextStart && !nextDue) return;
  if (t.recurrence === "매일") {
    if (nextStart) nextStart = await skipWeekendsAndHolidays(nextStart);
    if (nextDue) nextDue = await skipWeekendsAndHolidays(nextDue);
  }
  const TP = CFG.TASK_PROPS;
  const nextChecklist = (t.checklist || []).map((i) => ({ ...i, checked: false }));
  await NC.createPage(state.settings.tasksDbId, {
    [TP.name]: NC.buildTitle(t.name),
    [TP.status]: NC.buildSelect("할 일"),
    [TP.category]: NC.buildSelect(t.category),
    [TP.priority]: NC.buildSelect(t.priority),
    [TP.startDate]: NC.buildDate(nextStart),
    [TP.dueDate]: NC.buildDate(nextDue),
    [TP.assignees]: NC.buildPeople(t.assignees.map((a) => a.id)),
    [TP.project]: NC.buildRelation(t.projectIds),
    [TP.note]: NC.buildRichText(""),
    [TP.holidayWork]: NC.buildCheckbox(false),
    [TP.recurrence]: NC.buildSelect(t.recurrence),
    [TP.progress]: NC.buildNumber(nextChecklist.length ? 0 : null),
    [TP.workType]: NC.buildSelect(t.workType),
    [TP.checklist]: NC.buildRichText(JSON.stringify(nextChecklist)),
  });
}

// ---------- task modal ----------
function checklistEditorHtml(checklist) {
  return checklist.map((item, i) => `
    <div class="checklist-row" data-idx="${i}">
      <input type="checkbox" class="cl-checked" ${item.checked ? "checked" : ""} />
      <input type="text" class="cl-text" value="${escapeHtml(item.text)}" />
      <button type="button" class="btn btn-sm btn-ghost cl-remove">✕</button>
    </div>`).join("");
}

function openTaskModal(t) {
  const isNew = !t;
  const checklist = t ? [...t.checklist] : [];
  openModal(`
    <h3>${isNew ? "새 태스크" : "태스크 수정"}</h3>
    <form id="task-form">
      <div class="field"><label>이름</label><input type="text" name="name" value="${escapeHtml(t?.name || "")}" required /></div>
      <div class="field-row">
        <div class="field"><label>상태</label><select name="status">${CFG.TASK_STATUS_OPTIONS.map((s) => `<option ${t?.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
        <div class="field"><label>우선순위</label><select name="priority"><option value="">-</option>${CFG.PRIORITY_OPTIONS.map((s) => `<option ${t?.priority === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>시작일</label><input type="date" name="startDate" value="${t?.startDate || ""}" /></div>
        <div class="field"><label>마감일</label><input type="date" name="dueDate" value="${t?.dueDate || ""}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>업무유형</label><select name="workType"><option value="">-</option>${CFG.WORK_TYPE_OPTIONS.map((s) => `<option ${t?.workType === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
        <div class="field"><label>프로젝트</label><select name="projectId"><option value="">-</option>${state.projects.map((p) => `<option value="${p.id}" ${t?.projectIds?.[0] === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>반복</label><select name="recurrence">${CFG.RECURRENCE_OPTIONS.map((s) => `<option ${t?.recurrence === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
        <div class="field"><label>담당자 이름(쉼표로 구분)</label><input type="text" name="assigneeNames" value="${(t?.assignees || []).map((a) => a.name).join(", ")}" placeholder="Notion 유저ID 매핑 전엔 참고용" /></div>
      </div>
      <div class="field"><label>메모</label><textarea name="note">${escapeHtml(t?.note || "")}</textarea></div>
      <div class="field">
        <label>체크리스트</label>
        <div class="checklist-editor" id="cl-editor">${checklistEditorHtml(checklist)}</div>
        <button type="button" class="btn btn-sm" id="cl-add">+ 항목 추가</button>
      </div>
      <div class="modal-actions">
        <span>${!isNew ? `<button type="button" class="btn btn-danger btn-sm" id="task-delete">삭제</button>` : ""}</span>
        <div class="modal-actions-right">
          <button type="button" class="btn" id="task-cancel">취소</button>
          <button type="submit" class="btn btn-primary">저장</button>
        </div>
      </div>
    </form>`, (modal) => {
    modal.querySelector("#task-cancel").onclick = closeModal;
    modal.querySelector("#cl-add").onclick = () => {
      const editor = modal.querySelector("#cl-editor");
      const div = document.createElement("div");
      div.className = "checklist-row";
      div.innerHTML = `<input type="checkbox" class="cl-checked" /><input type="text" class="cl-text" /><button type="button" class="btn btn-sm btn-ghost cl-remove">✕</button>`;
      editor.appendChild(div);
      div.querySelector(".cl-remove").onclick = () => div.remove();
    };
    modal.querySelectorAll(".cl-remove").forEach((btn) => { btn.onclick = () => btn.closest(".checklist-row").remove(); });
    if (!isNew) modal.querySelector("#task-delete").onclick = async () => {
      if (!confirm("정말 삭제할까요?")) return;
      await NC.archivePage(t.id);
      state.tasks = state.tasks.filter((x) => x.id !== t.id);
      closeModal(); renderTaskList("");
      showToast("삭제되었습니다");
    };
    modal.querySelector("#task-form").onsubmit = async (e) => {
      e.preventDefault();
      const form = e.target;
      const checklist = [...modal.querySelectorAll(".checklist-row")].map((row) => ({
        text: row.querySelector(".cl-text").value.trim(),
        checked: row.querySelector(".cl-checked").checked,
      })).filter((i) => i.text);
      const TP = CFG.TASK_PROPS;
      const progress = checklist.length ? checklistProgress(checklist) : null;
      const assigneeNames = form.assigneeNames.value.split(",").map((s) => s.trim()).filter(Boolean);
      const properties = {
        [TP.name]: NC.buildTitle(form.name.value),
        [TP.status]: NC.buildSelect(form.status.value),
        [TP.priority]: NC.buildSelect(form.priority.value),
        [TP.startDate]: NC.buildDate(form.startDate.value),
        [TP.dueDate]: NC.buildDate(form.dueDate.value),
        [TP.workType]: NC.buildSelect(form.workType.value),
        [TP.project]: NC.buildRelation(form.projectId.value ? [form.projectId.value] : []),
        [TP.recurrence]: NC.buildSelect(form.recurrence.value),
        [TP.note]: NC.buildRichText(form.note.value),
        [TP.checklist]: NC.buildRichText(JSON.stringify(checklist)),
        [TP.progress]: NC.buildNumber(progress),
      };
      try {
        if (isNew) {
          const page = await NC.createPage(state.settings.tasksDbId, properties);
          state.tasks.push(pageToTask(page));
        } else {
          const becameDone = t.status !== "완료" && form.status.value === "완료";
          await NC.updatePageProperties(t.id, properties);
          Object.assign(t, { name: form.name.value, status: form.status.value, priority: form.priority.value,
            startDate: form.startDate.value, dueDate: form.dueDate.value, workType: form.workType.value,
            recurrence: form.recurrence.value, note: form.note.value, checklist, progress });
          if (becameDone && t.recurrence !== "없음") await createNextOccurrence(t);
        }
        closeModal(); renderTaskList(""); showToast("저장되었습니다");
      } catch (err) { showToast(err.message, true); }
    };
  });
}

// ---------- projects ----------
function pageToProject(page) {
  const p = page.properties; const PP = CFG.PROJECT_PROPS;
  return {
    id: page.id, name: NC.readTitle(p[PP.name]), status: NC.readSelect(p[PP.status]),
    priority: NC.readSelect(p[PP.priority]), startDate: NC.readDate(p[PP.startDate]), dueDate: NC.readDate(p[PP.dueDate]),
    description: NC.readRichText(p[PP.description]),
  };
}
function renderProjects() {
  app.innerHTML = `
    <div class="section-header"><h2>프로젝트</h2><button class="btn btn-primary" id="new-project-btn">+ 새 프로젝트</button></div>
    <div class="card-list">${state.projects.map((p) => `
      <div class="task-card" data-id="${p.id}">
        <div class="title">${escapeHtml(p.name)}</div>
        <div class="meta">${tag(p.status, "status")} ${tag(p.priority, "priority")} <span>${p.startDate || "-"} ~ ${p.dueDate || "-"}</span></div>
      </div>`).join("") || `<span class="muted">프로젝트가 없습니다</span>`}</div>`;
  document.getElementById("new-project-btn").onclick = () => openProjectModal(null);
  app.querySelectorAll(".task-card").forEach((card) => {
    card.onclick = () => openProjectModal(state.projects.find((p) => p.id === card.dataset.id));
  });
}
function openProjectModal(p) {
  const isNew = !p;
  openModal(`
    <h3>${isNew ? "새 프로젝트" : "프로젝트 수정"}</h3>
    <form id="project-form">
      <div class="field"><label>이름</label><input type="text" name="name" value="${escapeHtml(p?.name || "")}" required /></div>
      <div class="field-row">
        <div class="field"><label>상태</label><select name="status">${CFG.PROJECT_STATUS_OPTIONS.map((s) => `<option ${p?.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
        <div class="field"><label>우선순위</label><select name="priority"><option value="">-</option>${CFG.PRIORITY_OPTIONS.map((s) => `<option ${p?.priority === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>시작일</label><input type="date" name="startDate" value="${p?.startDate || ""}" /></div>
        <div class="field"><label>마감일</label><input type="date" name="dueDate" value="${p?.dueDate || ""}" /></div>
      </div>
      <div class="field"><label>설명</label><textarea name="description">${escapeHtml(p?.description || "")}</textarea></div>
      <div class="modal-actions">
        <span>${!isNew ? `<button type="button" class="btn btn-danger btn-sm" id="project-delete">삭제</button>` : ""}</span>
        <div class="modal-actions-right"><button type="button" class="btn" id="project-cancel">취소</button><button type="submit" class="btn btn-primary">저장</button></div>
      </div>
    </form>`, (modal) => {
    modal.querySelector("#project-cancel").onclick = closeModal;
    if (!isNew) modal.querySelector("#project-delete").onclick = async () => {
      if (!confirm("정말 삭제할까요?")) return;
      await NC.archivePage(p.id);
      state.projects = state.projects.filter((x) => x.id !== p.id);
      closeModal(); renderProjects(); showToast("삭제되었습니다");
    };
    modal.querySelector("#project-form").onsubmit = async (e) => {
      e.preventDefault();
      const form = e.target; const PP = CFG.PROJECT_PROPS;
      const properties = {
        [PP.name]: NC.buildTitle(form.name.value), [PP.status]: NC.buildSelect(form.status.value),
        [PP.priority]: NC.buildSelect(form.priority.value), [PP.startDate]: NC.buildDate(form.startDate.value),
        [PP.dueDate]: NC.buildDate(form.dueDate.value), [PP.description]: NC.buildRichText(form.description.value),
      };
      try {
        if (isNew) { const page = await NC.createPage(state.settings.projectsDbId, properties); state.projects.push(pageToProject(page)); }
        else { await NC.updatePageProperties(p.id, properties); Object.assign(p, { name: form.name.value, status: form.status.value, priority: form.priority.value, startDate: form.startDate.value, dueDate: form.dueDate.value, description: form.description.value }); }
        closeModal(); renderProjects(); showToast("저장되었습니다");
      } catch (err) { showToast(err.message, true); }
    };
  });
}

// ---------- meetings ----------
function pageToMeeting(page) {
  const p = page.properties; const MP = CFG.MEETING_PROPS;
  return { id: page.id, title: NC.readTitle(p[MP.title]), date: NC.readDate(p[MP.date]), meetingType: NC.readSelect(p[MP.meetingType]), projectIds: NC.readRelation(p[MP.project]) };
}
function renderMeetings() {
  app.innerHTML = `
    <div class="section-header"><h2>회의록</h2><button class="btn btn-primary" id="new-meeting-btn">+ 새 회의록</button></div>
    <div class="card-list">${state.meetings.map((m) => `
      <div class="task-card" data-id="${m.id}">
        <div class="title">${escapeHtml(m.title)}</div>
        <div class="meta">${tag(m.meetingType, "cat")} <span>${m.date || "-"}</span></div>
      </div>`).join("") || `<span class="muted">회의록이 없습니다</span>`}</div>`;
  document.getElementById("new-meeting-btn").onclick = () => openMeetingModal(null);
  app.querySelectorAll(".task-card").forEach((card) => card.onclick = () => openMeetingModal(state.meetings.find((m) => m.id === card.dataset.id)));
}
function openMeetingModal(m) {
  const isNew = !m;
  openModal(`
    <h3>${isNew ? "새 회의록" : "회의록 수정"}</h3>
    <form id="meeting-form">
      <div class="field"><label>제목</label><input type="text" name="title" value="${escapeHtml(m?.title || "")}" required /></div>
      <div class="field-row">
        <div class="field"><label>날짜</label><input type="date" name="date" value="${m?.date || ""}" /></div>
        <div class="field"><label>회의유형</label><select name="meetingType">${CFG.MEETING_TYPE_OPTIONS.map((s) => `<option ${m?.meetingType === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      </div>
      <div class="modal-actions">
        <span>${!isNew ? `<button type="button" class="btn btn-danger btn-sm" id="meeting-delete">삭제</button>` : ""}</span>
        <div class="modal-actions-right"><button type="button" class="btn" id="meeting-cancel">취소</button><button type="submit" class="btn btn-primary">저장</button></div>
      </div>
    </form>`, (modal) => {
    modal.querySelector("#meeting-cancel").onclick = closeModal;
    if (!isNew) modal.querySelector("#meeting-delete").onclick = async () => {
      if (!confirm("정말 삭제할까요?")) return;
      await NC.archivePage(m.id);
      state.meetings = state.meetings.filter((x) => x.id !== m.id);
      closeModal(); renderMeetings(); showToast("삭제되었습니다");
    };
    modal.querySelector("#meeting-form").onsubmit = async (e) => {
      e.preventDefault();
      const form = e.target; const MP = CFG.MEETING_PROPS;
      const properties = { [MP.title]: NC.buildTitle(form.title.value), [MP.date]: NC.buildDate(form.date.value), [MP.meetingType]: NC.buildSelect(form.meetingType.value) };
      try {
        if (isNew) { const page = await NC.createPage(state.settings.meetingsDbId, properties); state.meetings.push(pageToMeeting(page)); }
        else { await NC.updatePageProperties(m.id, properties); Object.assign(m, { title: form.title.value, date: form.date.value, meetingType: form.meetingType.value }); }
        closeModal(); renderMeetings(); showToast("저장되었습니다");
      } catch (err) { showToast(err.message, true); }
    };
  });
}

// ---------- weekly report ----------
const LEAVE_WORK_TYPE = "휴가 및 사내 행사";
function tasksInRange(start, end) {
  return state.tasks.filter((t) => {
    const s = t.startDate || t.dueDate; const e = t.dueDate || t.startDate;
    if (!s && !e) return false;
    return s <= end && e >= start;
  });
}
function mergeRecurringTasks(tasks) {
  const groups = new Map();
  for (const t of tasks) {
    const key = `${t.name}␟${(t.assignees.map((a) => a.name).sort().join(","))}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const merged = [];
  for (const list of groups.values()) {
    if (list.length === 1) { merged.push(list[0]); continue; }
    const sorted = [...list].sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));
    const latest = sorted[sorted.length - 1];
    merged.push({ ...latest, __mergedDates: sorted.map((t) => t.startDate || "-"), __mergedCount: sorted.length });
  }
  return merged;
}
function buildReportRecords(tasksIn) {
  const tasks = mergeRecurringTasks(tasksIn);
  const grouped = new Map();
  for (const t of tasks) {
    const raw = t.projectIds[0] ? (projectName(t.projectIds[0]) || "미분류") : (t.workType || "미분류");
    const proj = raw === LEAVE_WORK_TYPE ? "휴무일" : raw;
    if (!grouped.has(proj)) grouped.set(proj, []);
    grouped.get(proj).push(t);
  }
  const rank = (n) => (n === "휴무일" ? 2 : n === "미분류" ? 1 : 0);
  return [...grouped].sort(([a], [b]) => rank(a) - rank(b));
}
function reportEntryHtml(t) {
  const dateLine = t.__mergedDates ? `${t.__mergedDates.join(", ")} (총 ${t.__mergedCount}회)` : `${t.startDate || "-"} ~ ${t.dueDate || "-"}`;
  const statusTag = t.status === "완료" ? `<span class="tag status-완료">完</span>` : tag(t.status, "status");
  const progress = t.status === "진행중" && t.progress !== null ? `<span>${t.progress}%</span>` : "";
  return `<div class="report-task-entry">
    <div class="report-task-head"><span class="report-task-name">${escapeHtml(t.name)}</span>${statusTag}${progress}</div>
    <div class="report-task-meta">${allAssigneeNamesText(t)} · ${dateLine}</div>
  </div>`;
}
function renderReport() {
  app.innerHTML = `
    <div class="section-header"><h2>업무일지</h2><button class="btn btn-sm" id="copy-report-btn">📋 복사</button></div>
    <div class="filters">
      <label>시작 <input type="date" id="r-start" value="${state.reportStart}" /></label>
      <label>종료 <input type="date" id="r-end" value="${state.reportEnd}" /></label>
    </div>
    <div id="report-output"></div>`;
  document.getElementById("r-start").onchange = (e) => { state.reportStart = e.target.value; renderReportOutput(); };
  document.getElementById("r-end").onchange = (e) => { state.reportEnd = e.target.value; renderReportOutput(); };
  document.getElementById("copy-report-btn").onclick = async () => {
    const sheet = document.getElementById("report-sheet");
    if (!sheet) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([sheet.outerHTML], { type: "text/html" }), "text/plain": new Blob([sheet.innerText], { type: "text/plain" }) })]);
      showToast("복사되었습니다");
    } catch { showToast("복사에 실패했습니다", true); }
  };
  renderReportOutput();
}
function renderReportOutput() {
  const output = document.getElementById("report-output");
  const tasks = tasksInRange(state.reportStart, state.reportEnd);
  if (!tasks.length) { output.innerHTML = `<span class="muted">해당 기간에 태스크가 없습니다</span>`; return; }
  const records = buildReportRecords(tasks);
  const body = records.map(([name, list]) => `<h3 class="report-group-title">${escapeHtml(name)}</h3>${list.map(reportEntryHtml).join("")}`).join("");
  output.innerHTML = `<div class="report-sheet" id="report-sheet">
    <div class="report-title">${escapeHtml(state.settings.teamName || "업무")} 주간 업무 보고서</div>
    <div class="report-period-line">${state.reportStart} ~ ${state.reportEnd}</div>
    ${body}
  </div>`;
}

// ---------- weather (Open-Meteo + KMA 하이브리드) ----------
async function getHolidays(year) {
  const key = `wh-holidays-${year}`;
  const cached = sessionStorage.getItem(key);
  if (cached) return new Set(JSON.parse(cached));
  try {
    const monthResults = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const month = String(i + 1).padStart(2, "0");
      const url = new URL("https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo");
      url.searchParams.set("serviceKey", state.settings.holidayApiKey || "");
      url.searchParams.set("solYear", String(year));
      url.searchParams.set("solMonth", month);
      url.searchParams.set("numOfRows", "50");
      url.searchParams.set("_type", "json");
      const res = await fetch(url);
      if (!res.ok) return [];
      const json = await res.json();
      const items = json?.response?.body?.items?.item;
      const arr = !items ? [] : Array.isArray(items) ? items : [items];
      return arr.filter((it) => it.isHoliday === "Y").map((it) => { const s = String(it.locdate); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; });
    }));
    const dates = monthResults.flat();
    sessionStorage.setItem(key, JSON.stringify(dates));
    return new Set(dates);
  } catch { return new Set(); }
}
function kstNow() { return new Date(Date.now() + 9 * 60 * 60 * 1000); }
function kmaBaseDateTime() {
  const now = kstNow();
  let h = now.getUTCHours(); let d = new Date(now);
  if (now.getUTCMinutes() < 40) { h -= 1; if (h < 0) { h = 23; d.setUTCDate(d.getUTCDate() - 1); } }
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, "0"), day = String(d.getUTCDate()).padStart(2, "0");
  return { base_date: `${y}${m}${day}`, base_time: `${String(h).padStart(2, "0")}00` };
}
async function fetchKmaTemp() {
  const key = state.settings.kmaApiKey;
  if (!key) return null;
  try {
    const { base_date, base_time } = kmaBaseDateTime();
    const url = new URL("https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst");
    url.searchParams.set("serviceKey", key);
    url.searchParams.set("numOfRows", "10"); url.searchParams.set("dataType", "JSON");
    url.searchParams.set("base_date", base_date); url.searchParams.set("base_time", base_time);
    url.searchParams.set("nx", CFG.KMA_NX); url.searchParams.set("ny", CFG.KMA_NY);
    const res = await fetch(url);
    const json = await res.json();
    const items = json?.response?.body?.items?.item || [];
    const t1h = items.find((i) => i.category === "T1H");
    return t1h ? Number(t1h.obsrValue) : null;
  } catch { return null; }
}
async function initWeather() {
  const box = document.getElementById("weather-box");
  try {
    const [omRes, kmaTemp] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${CFG.WEATHER_LAT}&longitude=${CFG.WEATHER_LON}&current=temperature_2m,weather_code`).then((r) => r.json()),
      fetchKmaTemp(),
    ]);
    const temp = Math.round(kmaTemp ?? omRes.current.temperature_2m);
    box.textContent = `🌡 ${temp}°C`;
  } catch { box.textContent = ""; }
}

// ---------- tab routing ----------
function render() {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  if (state.tab === "settings") return renderSettings();
  if (!NC.hasValidSettings()) { state.tab = "settings"; return renderSettings(); }
  if (state.tab === "tasks") return renderTasks();
  if (state.tab === "projects") return renderProjects();
  if (state.tab === "meetings") return renderMeetings();
  if (state.tab === "report") return renderReport();
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => { state.tab = btn.dataset.tab; render(); });
});

// ---------- init ----------
(async function init() {
  if (!NC.hasValidSettings()) { state.tab = "settings"; render(); return; }
  await loadAllAndRender();
})();
