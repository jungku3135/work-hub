/* ══════════════════════════════════════════════════════════════
   Notion 직통 어댑터 — app.js(원본 work-hub 프론트엔드)가 기존에 Express 서버에
   보내던 api("GET/POST/PATCH/DELETE", "api/...") 호출을 그대로 받아서, 서버가 하던 일
   (Notion 조회/가공 + SQLite 캐시)을 이 브라우저 안에서 대신 처리한다.

   원본 백엔드(work-hub/src/notion/mappers.ts, db/queries.ts, routes/*.ts)와 최대한
   동일한 로직으로 이식했다. 다만 SQLite가 없으므로:
   - 태스크/프로젝트/회의록 목록은 캐싱 없이 매번 Notion에서 새로 조회한다 (데이터가
     188개 수준이라 충분히 빠르고, "누가 접속하든 항상 최신"이라는 장점도 있다).
   - 커스텀 담당자/참석자(Notion 계정 없는 인원)는 원래 팀 서버의 SQLite에 있던 값이라,
     각 DB의 텍스트 속성("커스텀 담당자"/"커스텀 참석자", 쉼표 구분)에 저장해서 누가 어느
     기기로 접속하든 똑같이 보이게 한다. 커스텀 인물 목록은 별도 저장 없이 이 값들을 모아서 만든다.
     (예전 버전이 이 브라우저 localStorage에만 넣어둔 값은 읽기 폴백 + Notion으로 1회 이전한다.)
══════════════════════════════════════════════════════════════ */

(function () {
  const NC = window.NotionClient;
  const CFG = window.CONFIG;
  const PROXY_ROOT = "https://work-hub-notion-proxy.work-hub-proxy.workers.dev";

  // ---------- 커스텀 담당자/참석자 (Notion 텍스트 속성에 쉼표 구분으로 저장) ----------

  function readCustomNames(prop, legacyKind, pageId) {
    const names = NC.readRichText(prop)
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    // 아직 Notion으로 이전되지 않은 예전 localStorage 값이 있으면 그거라도 보여준다
    return names.length ? names : getCustomNames(legacyKind, pageId);
  }
  function buildCustomNames(names) {
    return NC.buildRichText((names ?? []).map((n) => String(n).trim()).filter(Boolean).join(", "));
  }

  // ---------- 예전 버전이 쓰던 로컬 보조 저장소 (이전용으로만 남겨둠) ----------
  const LOCAL_KEY = "wh-local-extra";

  function loadLocal() {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}");
    } catch {
      return {};
    }
  }
  function saveLocal(data) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
  }
  function getCustomNames(kind, id) {
    return loadLocal()[kind]?.[id] ?? [];
  }
  // 이 항목의 커스텀 이름을 Notion에 새로 저장했으면 예전 로컬 값은 더 이상 폴백으로 쓰면 안 된다
  function dropLegacyNames(kind, id) {
    const local = loadLocal();
    if (!local[kind]?.[id]) return;
    delete local[kind][id];
    saveLocal(local);
  }
  // 이름만 먼저 등록해두고 아직 어느 항목에도 안 쓴 경우를 위한 목록 (쓰이는 순간부터는 Notion에 남는다)
  function getPendingCustomPeople() {
    return loadLocal().customPeople ?? [];
  }
  function addPendingCustomPerson(name) {
    const local = loadLocal();
    local.customPeople = local.customPeople || [];
    if (!local.customPeople.includes(name)) local.customPeople.push(name);
    saveLocal(local);
  }

  // 예전 버전이 localStorage에만 넣어둔 커스텀 담당자/참석자를 Notion 속성으로 옮긴다.
  // 쓰기 권한(저장된 비밀번호)이 이미 있을 때만 조용히 실행 — 비밀번호 창을 띄우지는 않는다.
  const LEGACY_KINDS = [
    { kind: "taskAssignees", prop: () => CFG.TASK_PROPS.customAssignees },
    { kind: "projectAssignees", prop: () => CFG.PROJECT_PROPS.customAssignees },
    { kind: "meetingAttendees", prop: () => CFG.MEETING_PROPS.customAttendees },
  ];
  async function migrateLegacyCustomNames() {
    const { appSecret } = NC.getSettings();
    if (!appSecret || !NC.isHeaderSafe(appSecret)) return;
    const local = loadLocal();
    let migrated = false;
    for (const { kind, prop } of LEGACY_KINDS) {
      for (const [pageId, names] of Object.entries(local[kind] ?? {})) {
        try {
          if (names?.length) {
            const page = await NC.getPage(pageId);
            // Notion 쪽에 이미 값이 있으면(다른 기기에서 먼저 저장됨) 그쪽을 우선한다
            if (!page.archived && !page.in_trash && !NC.readRichText(page.properties[prop()]).trim()) {
              await NC.updatePageProperties(pageId, { [prop()]: buildCustomNames(names) });
              migrated = true;
            }
          }
          delete local[kind][pageId];
          saveLocal(local);
        } catch (err) {
          // 404(삭제된 페이지)면 버리고, 그 외(네트워크/권한)는 다음 접속 때 다시 시도
          if (err.status === 404) {
            delete local[kind][pageId];
            saveLocal(local);
          } else if (err.status === 401) {
            return;
          }
        }
      }
    }
    if (migrated) invalidateListCache();
  }

  // ---------- Notion 페이지 -> 평범한 JS 객체 매핑 (팀 work-hub의 notion/mappers.ts와 동일) ----------

  function displayName(name) {
    return CFG.PEOPLE_NAME_OVERRIDES[name] ?? name;
  }
  function readPeopleDisplay(prop) {
    return (prop?.people || []).map((p) => ({ id: p.id, name: displayName(p.name ?? "(이름 없음)") }));
  }
  function getChecklist(prop) {
    const raw = NC.readRichText(prop);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  function checklistProgress(items) {
    const checked = items.filter((i) => i.checked).length;
    return Math.round((checked / items.length) * 100);
  }
  function buildChecklistProp(items) {
    if (!items?.length) return { rich_text: [] };
    const chunks = NC.chunkString(JSON.stringify(items), 1900);
    return { rich_text: chunks.map((c) => ({ text: { content: c } })) };
  }

  function pageToTask(page) {
    const P = CFG.TASK_PROPS;
    const props = page.properties;
    return {
      id: page.id,
      name: NC.readTitle(props[P.name]) || "(제목 없음)",
      status: NC.readSelect(props[P.status]),
      category: NC.readSelect(props[P.category]),
      priority: NC.readSelect(props[P.priority]),
      startDate: NC.readDate(props[P.startDate]),
      dueDate: NC.readDate(props[P.dueDate]),
      assignees: readPeopleDisplay(props[P.assignees]),
      customAssignees: readCustomNames(props[P.customAssignees], "taskAssignees", page.id),
      projectIds: NC.readRelation(props[P.project]),
      note: NC.readRichText(props[P.note]),
      holidayWork: NC.readCheckbox(props[P.holidayWork]),
      recurrence: NC.readSelect(props[P.recurrence]),
      progress: NC.readNumber(props[P.progress]),
      workType: NC.readSelect(props[P.workType]),
      checklist: getChecklist(props[P.checklist]),
      lastEditedTime: page.last_edited_time,
      url: page.url,
    };
  }

  function pageToProject(page) {
    const P = CFG.PROJECT_PROPS;
    const props = page.properties;
    return {
      id: page.id,
      name: NC.readTitle(props[P.name]) || "(제목 없음)",
      status: NC.readSelect(props[P.status]),
      category: NC.readSelect(props[P.category]),
      priority: NC.readSelect(props[P.priority]),
      startDate: NC.readDate(props[P.startDate]),
      dueDate: NC.readDate(props[P.dueDate]),
      assignees: readPeopleDisplay(props[P.assignees]),
      customAssignees: readCustomNames(props[P.customAssignees], "projectAssignees", page.id),
      description: NC.readRichText(props[P.description]),
      lastEditedTime: page.last_edited_time,
      url: page.url,
    };
  }

  function pageToMeeting(page) {
    const P = CFG.MEETING_PROPS;
    const props = page.properties;
    return {
      id: page.id,
      title: NC.readTitle(props[P.title]) || "(제목 없음)",
      date: NC.readDate(props[P.date]),
      attendees: readPeopleDisplay(props[P.attendees]),
      customAttendees: readCustomNames(props[P.customAttendees], "meetingAttendees", page.id),
      meetingType: NC.readSelect(props[P.meetingType]),
      projectIds: NC.readRelation(props[P.project]),
      taskIds: NC.readRelation(props[P.tasks]),
      lastEditedTime: page.last_edited_time,
      url: page.url,
    };
  }

  // ---------- 정렬 (db/queries.ts의 ORDER BY와 동일한 의미: 날짜 없는 항목은 맨 뒤) ----------
  function sortByAsc(list, key) {
    return [...list].sort((a, b) => {
      if (a[key] == null && b[key] == null) return 0;
      if (a[key] == null) return 1;
      if (b[key] == null) return -1;
      return a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
    });
  }
  function sortByDesc(list, key) {
    return [...list].sort((a, b) => {
      if (a[key] == null && b[key] == null) return 0;
      if (a[key] == null) return 1;
      if (b[key] == null) return -1;
      return a[key] < b[key] ? 1 : a[key] > b[key] ? -1 : 0;
    });
  }

  // 서버 캐시(SQLite)가 없다 보니 화면 하나 그릴 때마다 Notion을 페이지네이션까지 새로 돌면
  // 눈에 띄게 느려진다(프로젝트 상세를 열 때마다 태스크 188개를 처음부터 다시 받아오는 식).
  // 짧게(10초)만 메모리에 캐싱해서 "탭 왔다갔다"는 즉시 반응하게 하고, 실제로 뭔가 쓰기가
  // 일어나면(태스크/프로젝트/회의록 생성·수정·삭제) 캐시를 바로 비워서 항상 최신 데이터를 본다.
  const LIST_CACHE_TTL_MS = 10000;
  const listCache = { tasks: null, projects: null, meetings: null };

  function invalidateListCache() {
    listCache.tasks = null;
    listCache.projects = null;
    listCache.meetings = null;
  }

  // 첫 로딩 때 app.js가 api/tasks와 api/dashboard(내부적으로 태스크 전체가 또 필요함)를
  // 동시에(Promise.all) 요청하는데, 그냥 캐시만 있으면 "아직 아무것도 없음"인 이 순간엔
  // 서로 캐시를 못 보고 Notion에 똑같은 걸 두 번 따로 물어보게 된다. 진행 중인 요청 자체를
  // 캐시해두면(single-flight) 나중에 온 쪽은 새로 요청하지 않고 먼저 간 요청을 같이 기다린다.
  async function cachedFetch(key, fetcher) {
    const entry = listCache[key];
    if (entry?.promise) return entry.promise;
    if (entry && Date.now() - entry.time < LIST_CACHE_TTL_MS) return entry.data;
    const promise = fetcher()
      .then((data) => {
        listCache[key] = { data, time: Date.now() };
        return data;
      })
      .catch((err) => {
        listCache[key] = null; // 실패하면 캐시에 안 남겨서 다음 시도 때 다시 받아오게 함
        throw err;
      });
    listCache[key] = { promise };
    return promise;
  }

  // "마지막 동기화" = 이 브라우저가 Notion에서 태스크 목록을 실제로 마지막으로 받아온 시각
  // (첫 로딩, 수동 동기화, 자동 새로고침, 저장 후 재조회 모두 포함)
  let lastSyncTime = null;

  async function fetchAllTasks() {
    return cachedFetch("tasks", async () => {
      const pages = await NC.queryDatabaseAll(CFG.DEFAULT_DATA_SOURCES.tasksDbId);
      lastSyncTime = new Date().toISOString();
      return sortByAsc(pages.map(pageToTask), "dueDate");
    });
  }
  async function fetchAllProjects() {
    return cachedFetch("projects", async () => {
      const pages = await NC.queryDatabaseAll(CFG.DEFAULT_DATA_SOURCES.projectsDbId);
      return sortByAsc(pages.map(pageToProject), "dueDate");
    });
  }
  async function fetchAllMeetings() {
    return cachedFetch("meetings", async () => {
      const pages = await NC.queryDatabaseAll(CFG.DEFAULT_DATA_SOURCES.meetingsDbId);
      return sortByDesc(pages.map(pageToMeeting), "date");
    });
  }

  // ---------- 태스크 ----------

  async function createTask(payload) {
    const P = CFG.TASK_PROPS;
    const checklist = Array.isArray(payload.checklist) ? payload.checklist : [];
    const finalProgress = checklist.length ? checklistProgress(checklist) : payload.progress;
    const page = await NC.createPage(CFG.DEFAULT_DATA_SOURCES.tasksDbId, {
      [P.name]: NC.buildTitle(payload.name),
      [P.status]: NC.buildSelect(payload.status ?? "할 일"),
      [P.category]: NC.buildSelect(payload.category),
      [P.priority]: NC.buildSelect(payload.priority),
      [P.startDate]: NC.buildDate(payload.startDate),
      [P.dueDate]: NC.buildDate(payload.dueDate),
      [P.assignees]: NC.buildPeople(payload.assigneeIds ?? []),
      [P.project]: NC.buildRelation(payload.projectId ? [payload.projectId] : []),
      [P.note]: NC.buildRichText(payload.note ?? ""),
      [P.holidayWork]: NC.buildCheckbox(payload.holidayWork),
      [P.recurrence]: NC.buildSelect(payload.recurrence ?? "없음"),
      [P.progress]: NC.buildNumber(finalProgress),
      [P.workType]: NC.buildSelect(payload.workType),
      [P.checklist]: buildChecklistProp(checklist),
      [P.customAssignees]: buildCustomNames(payload.customAssigneeNames),
    });
    return pageToTask(page);
  }

  // 반복 태스크가 "완료"로 바뀔 때 다음 회차를 자동 생성 — 팀 백엔드 routes/tasks.ts와 동일 로직
  function addInterval(dateStr, interval) {
    const hasTime = dateStr.includes("T");
    const d = new Date(dateStr);
    if (interval === "매일") d.setUTCDate(d.getUTCDate() + 1);
    else if (interval === "매주") d.setUTCDate(d.getUTCDate() + 7);
    else if (interval === "매월") d.setUTCMonth(d.getUTCMonth() + 1);
    if (hasTime) return d.toISOString();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function dateOnlyPart(dateStr) {
    return dateStr.slice(0, 10);
  }
  function isWeekendDate(dateStr) {
    const day = new Date(`${dateOnlyPart(dateStr)}T00:00:00Z`).getUTCDay();
    return day === 0 || day === 6;
  }
  async function skipWeekendsAndHolidays(dateStr) {
    let d = dateStr;
    let year = Number(dateOnlyPart(d).slice(0, 4));
    let holidaySet = new Set((await fetchHolidays(year)).map((h) => h.date));
    while (isWeekendDate(d) || holidaySet.has(dateOnlyPart(d))) {
      d = addInterval(d, "매일");
      const y = Number(dateOnlyPart(d).slice(0, 4));
      if (y !== year) {
        year = y;
        holidaySet = new Set((await fetchHolidays(year)).map((h) => h.date));
      }
    }
    return d;
  }
  async function createNextOccurrence(task, customAssigneeNames) {
    let nextStart = task.startDate ? addInterval(task.startDate, task.recurrence) : null;
    let nextDue = task.dueDate ? addInterval(task.dueDate, task.recurrence) : null;
    if (!nextStart && !nextDue) return;
    if (task.recurrence === "매일") {
      if (nextStart) nextStart = await skipWeekendsAndHolidays(nextStart);
      if (nextDue) nextDue = await skipWeekendsAndHolidays(nextDue);
    }
    const nextChecklist = (task.checklist ?? []).map((i) => ({ ...i, checked: false }));
    const P = CFG.TASK_PROPS;
    await NC.createPage(CFG.DEFAULT_DATA_SOURCES.tasksDbId, {
      [P.name]: NC.buildTitle(task.name),
      [P.status]: NC.buildSelect("할 일"),
      [P.category]: NC.buildSelect(task.category),
      [P.priority]: NC.buildSelect(task.priority),
      [P.startDate]: NC.buildDate(nextStart),
      [P.dueDate]: NC.buildDate(nextDue),
      [P.assignees]: NC.buildPeople(task.assignees.map((a) => a.id)),
      [P.project]: NC.buildRelation(task.projectIds),
      [P.note]: NC.buildRichText(""),
      [P.holidayWork]: NC.buildCheckbox(false),
      [P.recurrence]: NC.buildSelect(task.recurrence),
      [P.progress]: NC.buildNumber(nextChecklist.length ? 0 : null),
      [P.workType]: NC.buildSelect(task.workType),
      [P.checklist]: buildChecklistProp(nextChecklist),
      [P.customAssignees]: buildCustomNames(customAssigneeNames),
    });
  }

  async function updateTask(id, payload) {
    const P = CFG.TASK_PROPS;
    const existingTask = pageToTask(await NC.getPage(id));
    const properties = {};
    if (payload.name !== undefined) properties[P.name] = NC.buildTitle(payload.name);
    if (payload.status !== undefined) properties[P.status] = NC.buildSelect(payload.status);
    if (payload.category !== undefined) properties[P.category] = NC.buildSelect(payload.category);
    if (payload.priority !== undefined) properties[P.priority] = NC.buildSelect(payload.priority);
    if (payload.startDate !== undefined) properties[P.startDate] = NC.buildDate(payload.startDate);
    if (payload.dueDate !== undefined) properties[P.dueDate] = NC.buildDate(payload.dueDate);
    if (payload.assigneeIds !== undefined) properties[P.assignees] = NC.buildPeople(payload.assigneeIds);
    if (Array.isArray(payload.customAssigneeNames)) {
      dropLegacyNames("taskAssignees", id);
      properties[P.customAssignees] = buildCustomNames(payload.customAssigneeNames);
    }
    if (payload.projectId !== undefined) properties[P.project] = NC.buildRelation(payload.projectId ? [payload.projectId] : []);
    if (payload.note !== undefined) properties[P.note] = NC.buildRichText(payload.note);
    if (payload.holidayWork !== undefined) properties[P.holidayWork] = NC.buildCheckbox(payload.holidayWork);
    if (payload.recurrence !== undefined) properties[P.recurrence] = NC.buildSelect(payload.recurrence);
    if (payload.workType !== undefined) properties[P.workType] = NC.buildSelect(payload.workType);
    if (payload.checklist !== undefined) {
      const items = Array.isArray(payload.checklist) ? payload.checklist : [];
      properties[P.checklist] = buildChecklistProp(items);
      if (items.length) properties[P.progress] = NC.buildNumber(checklistProgress(items));
      else if (payload.progress !== undefined) properties[P.progress] = NC.buildNumber(payload.progress);
    } else if (payload.progress !== undefined) {
      properties[P.progress] = NC.buildNumber(payload.progress);
    }

    const page = await NC.updatePageProperties(id, properties);
    const task = pageToTask(page);

    const becameDone = payload.status === "완료" && existingTask.status !== "완료";
    const recurrenceJustEnabled = (existingTask.recurrence ?? "없음") === "없음" && !!task.recurrence && task.recurrence !== "없음";
    if (task.status === "완료" && task.recurrence && task.recurrence !== "없음" && (becameDone || recurrenceJustEnabled)) {
      await createNextOccurrence(task, task.customAssignees ?? []);
    }
    return task;
  }

  async function handleTasks(method, id, sub, params, body) {
    if (method === "GET" && !id) {
      const tasks = await fetchAllTasks();
      const category = params.get("category");
      const projectId = params.get("projectId");
      const assigneeId = params.get("assigneeId");
      return tasks
        .filter((t) => !category || t.category === category)
        .filter((t) => !projectId || t.projectIds.includes(projectId))
        .filter((t) => !assigneeId || t.assignees.some((a) => a.id === assigneeId));
    }
    if (method === "GET" && id) {
      const task = pageToTask(await NC.getPage(id));
      return task;
    }
    if (method === "POST") return createTask(body);
    if (method === "PATCH") return updateTask(id, body);
    if (method === "DELETE") {
      await NC.archivePage(id);
      return null;
    }
    throw new Error("지원하지 않는 요청입니다");
  }

  // ---------- 프로젝트 ----------

  async function createProject(payload) {
    const P = CFG.PROJECT_PROPS;
    const page = await NC.createPage(CFG.DEFAULT_DATA_SOURCES.projectsDbId, {
      [P.name]: NC.buildTitle(payload.name),
      [P.status]: NC.buildSelect(payload.status ?? "계획"),
      [P.category]: NC.buildSelect(payload.category),
      [P.priority]: NC.buildSelect(payload.priority),
      [P.startDate]: NC.buildDate(payload.startDate),
      [P.dueDate]: NC.buildDate(payload.dueDate),
      [P.assignees]: NC.buildPeople(payload.assigneeIds ?? []),
      [P.description]: NC.buildRichText(payload.description ?? ""),
      [P.customAssignees]: buildCustomNames(payload.customAssigneeNames),
    });
    return pageToProject(page);
  }

  async function updateProject(id, payload) {
    const P = CFG.PROJECT_PROPS;
    const properties = {};
    if (payload.name !== undefined) properties[P.name] = NC.buildTitle(payload.name);
    if (payload.status !== undefined) properties[P.status] = NC.buildSelect(payload.status);
    if (payload.category !== undefined) properties[P.category] = NC.buildSelect(payload.category);
    if (payload.priority !== undefined) properties[P.priority] = NC.buildSelect(payload.priority);
    if (payload.startDate !== undefined) properties[P.startDate] = NC.buildDate(payload.startDate);
    if (payload.dueDate !== undefined) properties[P.dueDate] = NC.buildDate(payload.dueDate);
    if (payload.assigneeIds !== undefined) properties[P.assignees] = NC.buildPeople(payload.assigneeIds);
    if (payload.description !== undefined) properties[P.description] = NC.buildRichText(payload.description);
    if (Array.isArray(payload.customAssigneeNames)) {
      dropLegacyNames("projectAssignees", id);
      properties[P.customAssignees] = buildCustomNames(payload.customAssigneeNames);
    }

    const page = await NC.updatePageProperties(id, properties);
    return pageToProject(page);
  }

  async function handleProjects(method, id, params, body) {
    if (method === "GET" && !id) {
      const projects = await fetchAllProjects();
      const category = params.get("category");
      return projects.filter((p) => !category || p.category === category);
    }
    if (method === "GET" && id) {
      const project = pageToProject(await NC.getPage(id));
      const [tasks, meetings] = await Promise.all([fetchAllTasks(), fetchAllMeetings()]);
      return {
        ...project,
        tasks: tasks.filter((t) => t.projectIds.includes(id)),
        meetings: meetings.filter((m) => m.projectIds.includes(id)),
      };
    }
    if (method === "POST") return createProject(body);
    if (method === "PATCH") return updateProject(id, body);
    if (method === "DELETE") {
      await NC.archivePage(id);
      return null;
    }
    throw new Error("지원하지 않는 요청입니다");
  }

  // ---------- 회의록 ----------

  function buildMeetingBodyBlocks(content) {
    const json = JSON.stringify(content);
    const chunks = NC.chunkString(json, 1900);
    return [{ object: "block", type: "paragraph", paragraph: { rich_text: chunks.map((c) => ({ type: "text", text: { content: c } })) } }];
  }
  function blockPlainText(block) {
    const richText = block[block.type]?.rich_text ?? [];
    return richText.map((t) => t.plain_text ?? t.text?.content ?? "").join("");
  }
  const LEGACY_HEADING_TO_KEY = { "📌 안건": "agenda", "💬 논의내용": "discussion", "✅ 결정사항": "decision" };
  function parseLegacyMeetingBlocks(blocks) {
    const item = { agenda: "", discussion: "", decision: "" };
    let currentKey = null;
    let matchedAnyHeading = false;
    for (const block of blocks) {
      if (block.type === "heading_1" || block.type === "heading_2" || block.type === "heading_3") {
        const key = LEGACY_HEADING_TO_KEY[blockPlainText(block).trim()];
        currentKey = key ?? null;
        if (key) matchedAnyHeading = true;
        continue;
      }
      if (currentKey) {
        const text = blockPlainText(block);
        if (text) item[currentKey] = item[currentKey] ? `${item[currentKey]}\n${text}` : text;
      }
    }
    return matchedAnyHeading ? { items: [item] } : null;
  }
  function parseMeetingBodyBlocks(blocks) {
    for (const block of blocks) {
      try {
        const parsed = JSON.parse(blockPlainText(block));
        if (parsed && Array.isArray(parsed.items)) return parsed;
      } catch {
        // JSON이 아닌 블록 — 다음 블록 또는 레거시 파서로 계속
      }
    }
    return parseLegacyMeetingBlocks(blocks) ?? { items: [] };
  }
  async function getMeetingContent(id) {
    const blocks = await NC.getBlockChildren(id);
    return parseMeetingBodyBlocks(blocks);
  }

  async function createMeeting(payload) {
    const P = CFG.MEETING_PROPS;
    const content = { items: Array.isArray(payload.items) ? payload.items : [] };
    const page = await NC.createPage(CFG.DEFAULT_DATA_SOURCES.meetingsDbId, {
      [P.title]: NC.buildTitle(payload.title),
      [P.date]: NC.buildDate(payload.date),
      [P.attendees]: NC.buildPeople(payload.attendeeIds ?? []),
      [P.meetingType]: NC.buildSelect(payload.meetingType),
      [P.project]: NC.buildRelation(payload.projectId ? [payload.projectId] : []),
      [P.tasks]: NC.buildRelation(payload.taskIds ?? []),
      [P.customAttendees]: buildCustomNames(payload.customAttendeeNames),
    });
    await NC.appendBlockChildren(page.id, buildMeetingBodyBlocks(content));
    return { ...pageToMeeting(page), ...content };
  }

  async function updateMeeting(id, payload) {
    const P = CFG.MEETING_PROPS;
    const properties = {};
    if (payload.title !== undefined) properties[P.title] = NC.buildTitle(payload.title);
    if (payload.date !== undefined) properties[P.date] = NC.buildDate(payload.date);
    if (payload.attendeeIds !== undefined) properties[P.attendees] = NC.buildPeople(payload.attendeeIds);
    if (payload.meetingType !== undefined) properties[P.meetingType] = NC.buildSelect(payload.meetingType);
    if (payload.projectId !== undefined) properties[P.project] = NC.buildRelation(payload.projectId ? [payload.projectId] : []);
    if (payload.taskIds !== undefined) properties[P.tasks] = NC.buildRelation(payload.taskIds);
    if (Array.isArray(payload.customAttendeeNames)) {
      dropLegacyNames("meetingAttendees", id);
      properties[P.customAttendees] = buildCustomNames(payload.customAttendeeNames);
    }

    const page = await NC.updatePageProperties(id, properties);

    if (Array.isArray(payload.items)) {
      const existingBlocks = await NC.getBlockChildren(id);
      for (const block of existingBlocks) await NC.deleteBlock(block.id);
      await NC.appendBlockChildren(id, buildMeetingBodyBlocks({ items: payload.items }));
    }

    return pageToMeeting(page);
  }

  async function handleMeetings(method, id, sub, body) {
    if (method === "GET" && !id) return fetchAllMeetings();
    if (method === "GET" && id && sub === "content") return getMeetingContent(id);
    if (method === "GET" && id) return pageToMeeting(await NC.getPage(id));
    if (method === "POST") return createMeeting(body);
    if (method === "PATCH") return updateMeeting(id, body);
    if (method === "DELETE") {
      await NC.archivePage(id);
      return null;
    }
    throw new Error("지원하지 않는 요청입니다");
  }

  // ---------- 사람 (Notion 워크스페이스 멤버) ----------

  let peopleCache = null;
  async function listPeople() {
    if (peopleCache) return peopleCache;
    const users = await NC.listUsers();
    peopleCache = users.filter((u) => u.type === "person").map((u) => ({ id: u.id, name: displayName(u.name ?? "(이름 없음)") }));
    return peopleCache;
  }

  // ---------- 커스텀 인물(Notion 계정 없는 담당자) ----------

  // 태스크/프로젝트/회의록에 실제로 쓰인 커스텀 이름 전체 + 이 브라우저에서 방금 등록만 해둔 이름
  async function listCustomPeople() {
    const [tasks, projects, meetings] = await Promise.all([fetchAllTasks(), fetchAllProjects(), fetchAllMeetings()]);
    const names = new Set(getPendingCustomPeople());
    tasks.forEach((t) => t.customAssignees.forEach((n) => names.add(n)));
    projects.forEach((p) => p.customAssignees.forEach((n) => names.add(n)));
    meetings.forEach((m) => m.customAttendees.forEach((n) => names.add(n)));
    return [...names].sort((a, b) => a.localeCompare(b, "ko"));
  }

  async function handleCustomPeople(method, body) {
    if (method === "GET") return listCustomPeople();
    if (method === "POST") {
      const name = String(body?.name ?? "").replace(/,/g, " ").trim().slice(0, 30);
      if (!name) throw Object.assign(new Error("이름을 입력하세요"), { status: 400 });
      addPendingCustomPerson(name);
      return listCustomPeople();
    }
    throw new Error("지원하지 않는 요청입니다");
  }

  // ---------- 대시보드 요약 ----------

  function dateOnly(v) {
    return v ? v.slice(0, 10) : null;
  }
  async function computeDashboard() {
    const [tasks, projects, meetings] = await Promise.all([fetchAllTasks(), fetchAllProjects(), fetchAllMeetings()]);
    const today = window.todayISO ? window.todayISO() : new Date().toISOString().slice(0, 10);
    const weekEnd = window.addDaysISO ? window.addDaysISO(today, 7) : today;
    const todayTaskCount = tasks.filter((t) => dateOnly(t.dueDate) === today && t.status !== "완료").length;
    const weekTaskCount = tasks.filter((t) => {
      const d = dateOnly(t.dueDate);
      return d && d >= today && d <= weekEnd && t.status !== "완료";
    }).length;
    const activeProjectCount = projects.filter((p) => p.status === "진행중").length;
    return { todayTaskCount, weekTaskCount, activeProjectCount, recentMeetings: meetings.slice(0, 5) };
  }

  // ---------- 동기화 (원본은 SQLite 캐시를 Notion과 맞추는 개념이지만, 여기선 매번 직접
  // 조회하므로 "마지막 동기화 시각"은 그냥 이 브라우저가 마지막으로 데이터를 불러온 시각이다) ----------

  async function handleSync(method) {
    if (method === "GET") {
      // 첫 로딩 때는 태스크 조회와 동시에 불리므로, 진행 중인 조회가 끝난 뒤의 시각을 돌려준다
      // (single-flight 캐시라 추가 요청은 생기지 않는다)
      await fetchAllTasks().catch(() => {});
      return { lastSyncTime };
    }
    if (method === "POST") {
      invalidateListCache(); // "동기화"는 10초 캐시와 무관하게 항상 Notion에서 새로 받아온다
      const [tasks, projects, meetings] = await Promise.all([fetchAllTasks(), fetchAllProjects(), fetchAllMeetings()]);
      return { tasks: tasks.length, projects: projects.length, meetings: meetings.length, lastSyncTime };
    }
    throw new Error("지원하지 않는 요청입니다");
  }

  // ---------- 공휴일 / 날씨 (Cloudflare Worker가 공공데이터포털·기상청 키를 대신 들고 프록시) ----------

  const holidayCache = new Map(); // year -> Promise<holidays[]> (single-flight — 값 자체를 캐싱)
  function fetchHolidays(year) {
    const y = Number(year) || new Date().getFullYear();
    if (!holidayCache.has(y)) {
      holidayCache.set(
        y,
        fetch(`${PROXY_ROOT}/holidays?year=${y}`)
          .then((res) => (res.ok ? res.json() : []))
          .catch(() => [])
      );
    }
    return holidayCache.get(y);
  }

  // 날씨는 몇 분 안에는 다시 바뀔 일이 없으므로 짧게(5분) 캐싱 — 대시보드를 여러 번 왔다갔다
  // 해도 매번 새로 조회하지 않는다.
  const WEATHER_CACHE_TTL_MS = 5 * 60 * 1000;
  let weatherCache = null; // { promise, time }
  function fetchWeather() {
    if (weatherCache && Date.now() - weatherCache.time < WEATHER_CACHE_TTL_MS) return weatherCache.promise;
    const promise = fetch(`${PROXY_ROOT}/weather`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    weatherCache = { promise, time: Date.now() };
    return promise;
  }

  // 대시보드가 렌더링될 때(ensureHolidays)/날씨 위젯이 뜰 때 그제서야 불러오기 시작하면
  // 태스크/프로젝트 등을 다 받아온 "뒤에" 순차적으로 또 기다리게 된다 — 이 어댑터가 로드되는
  // 시점에 바로(병렬로) 미리 요청해둬서, 실제로 필요해지는 시점엔 이미 캐시돼 있게 한다.
  fetchHolidays(new Date().getFullYear());
  fetchWeather();
  migrateLegacyCustomNames().catch(() => {});

  // ---------- 라우팅 ----------

  async function api(method, url, body) {
    const [pathPart, queryPart] = url.split("?");
    const segments = pathPart.split("/").filter(Boolean); // ["api", "tasks", ":id", ":sub"]
    const params = new URLSearchParams(queryPart || "");
    const resource = segments[1];
    const id = segments[2];
    const sub = segments[3];

    // 태스크/프로젝트/회의록에 뭔가 쓰기가 일어나면(서로 관계로 얽혀 있어서 셋 다) 목록
    // 캐시를 비워 다음 조회부터 바로 최신 상태를 받아오게 한다.
    if (method !== "GET" && ["tasks", "projects", "meetings"].includes(resource)) {
      invalidateListCache();
    }

    switch (resource) {
      case "tasks":
        return handleTasks(method, id, sub, params, body);
      case "projects":
        return handleProjects(method, id, params, body);
      case "meetings":
        return handleMeetings(method, id, sub, body);
      case "people":
        return listPeople();
      case "custom-people":
        return handleCustomPeople(method, body);
      case "dashboard":
        return computeDashboard();
      case "sync":
        return handleSync(method);
      case "holidays":
        return fetchHolidays(params.get("year"));
      case "weather":
        return fetchWeather();
      default:
        throw new Error(`알 수 없는 API 경로: ${url}`);
    }
  }

  window.NotionAdapter = { api };
})();
