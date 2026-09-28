/* ══════════════════════════════════════════════════════════════
   Notion 직통 어댑터 — app.js(원본 work-hub 프론트엔드)가 기존에 Express 서버에
   보내던 api("GET/POST/PATCH/DELETE", "api/...") 호출을 그대로 받아서, 서버가 하던 일
   (Notion 조회/가공 + SQLite 캐시)을 이 브라우저 안에서 대신 처리한다.

   원본 백엔드(work-hub/src/notion/mappers.ts, db/queries.ts, routes/*.ts)와 최대한
   동일한 로직으로 이식했다. 다만 SQLite가 없으므로:
   - 태스크/프로젝트/회의록 목록은 캐싱 없이 매번 Notion에서 새로 조회한다 (데이터가
     188개 수준이라 충분히 빠르고, "누가 접속하든 항상 최신"이라는 장점도 있다).
   - Notion에는 없는 필드(커스텀 담당자/참석자, 커스텀 인물 목록)는 이 브라우저의
     localStorage에 보관한다 — 원래는 팀 서버의 SQLite에 있던 값이라 기기마다 따로 논다는
     차이는 있지만, Notion 계정이 없는 사람 이름을 자유 입력하는 보조 기능이라 감수한다.
══════════════════════════════════════════════════════════════ */

(function () {
  const NC = window.NotionClient;
  const CFG = window.CONFIG;
  const PROXY_ROOT = "https://work-hub-notion-proxy.work-hub-proxy.workers.dev";

  // ---------- 로컬 보조 저장소 ----------
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
  function setCustomNames(kind, id, names) {
    const local = loadLocal();
    local[kind] = local[kind] || {};
    local[kind][id] = names;
    saveLocal(local);
  }
  function getCustomPeopleList() {
    return loadLocal().customPeople ?? [];
  }
  function addCustomPersonLocal(name) {
    const local = loadLocal();
    local.customPeople = local.customPeople || [];
    if (!local.customPeople.includes(name)) local.customPeople.push(name);
    local.customPeople.sort();
    saveLocal(local);
    return local.customPeople;
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
      customAssignees: getCustomNames("taskAssignees", page.id),
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
      customAssignees: getCustomNames("projectAssignees", page.id),
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
      customAttendees: getCustomNames("meetingAttendees", page.id),
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

  async function fetchAllTasks() {
    return cachedFetch("tasks", async () => {
      const pages = await NC.queryDatabaseAll(CFG.DEFAULT_DATA_SOURCES.tasksDbId);
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
    });
    const task = pageToTask(page);
    if (Array.isArray(payload.customAssigneeNames)) {
      setCustomNames("taskAssignees", task.id, payload.customAssigneeNames);
      task.customAssignees = payload.customAssigneeNames;
    }
    return task;
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
    const page = await NC.createPage(CFG.DEFAULT_DATA_SOURCES.tasksDbId, {
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
    });
    const nextTask = pageToTask(page);
    if (customAssigneeNames.length) setCustomNames("taskAssignees", nextTask.id, customAssigneeNames);
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
    if (Array.isArray(payload.customAssigneeNames)) {
      setCustomNames("taskAssignees", task.id, payload.customAssigneeNames);
      task.customAssignees = payload.customAssigneeNames;
    }

    const becameDone = payload.status === "완료" && existingTask.status !== "완료";
    const recurrenceJustEnabled = (existingTask.recurrence ?? "없음") === "없음" && !!task.recurrence && task.recurrence !== "없음";
    if (task.status === "완료" && task.recurrence && task.recurrence !== "없음" && (becameDone || recurrenceJustEnabled)) {
      await createNextOccurrence(task, existingTask.customAssignees ?? []);
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
    });
    const project = pageToProject(page);
    if (Array.isArray(payload.customAssigneeNames)) {
      setCustomNames("projectAssignees", project.id, payload.customAssigneeNames);
      project.customAssignees = payload.customAssigneeNames;
    }
    return project;
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

    const page = await NC.updatePageProperties(id, properties);
    const project = pageToProject(page);
    if (Array.isArray(payload.customAssigneeNames)) {
      setCustomNames("projectAssignees", project.id, payload.customAssigneeNames);
      project.customAssignees = payload.customAssigneeNames;
    }
    return project;
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
    });
    await NC.appendBlockChildren(page.id, buildMeetingBodyBlocks(content));
    const meeting = pageToMeeting(page);
    if (Array.isArray(payload.customAttendeeNames)) {
      setCustomNames("meetingAttendees", meeting.id, payload.customAttendeeNames);
      meeting.customAttendees = payload.customAttendeeNames;
    }
    return { ...meeting, ...content };
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

    const page = await NC.updatePageProperties(id, properties);

    if (Array.isArray(payload.items)) {
      const existingBlocks = await NC.getBlockChildren(id);
      for (const block of existingBlocks) await NC.deleteBlock(block.id);
      await NC.appendBlockChildren(id, buildMeetingBodyBlocks({ items: payload.items }));
    }

    const meeting = pageToMeeting(page);
    if (Array.isArray(payload.customAttendeeNames)) {
      setCustomNames("meetingAttendees", meeting.id, payload.customAttendeeNames);
      meeting.customAttendees = payload.customAttendeeNames;
    }
    return meeting;
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

  async function handleCustomPeople(method, body) {
    if (method === "GET") return getCustomPeopleList();
    if (method === "POST") {
      const name = String(body?.name ?? "").trim().slice(0, 30);
      if (!name) throw Object.assign(new Error("이름을 입력하세요"), { status: 400 });
      return addCustomPersonLocal(name);
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

  let lastSyncTime = null;
  async function handleSync(method) {
    if (method === "GET") return { lastSyncTime };
    if (method === "POST") {
      const [tasks, projects, meetings] = await Promise.all([fetchAllTasks(), fetchAllProjects(), fetchAllMeetings()]);
      lastSyncTime = new Date().toISOString();
      return { tasks: tasks.length, projects: projects.length, meetings: meetings.length, lastSyncTime };
    }
    throw new Error("지원하지 않는 요청입니다");
  }

  // ---------- 공휴일 / 날씨 (Cloudflare Worker가 공공데이터포털·기상청 키를 대신 들고 프록시) ----------

  const holidayCache = new Map();
  async function fetchHolidays(year) {
    const y = Number(year) || new Date().getFullYear();
    if (!holidayCache.has(y)) {
      try {
        const res = await fetch(`${PROXY_ROOT}/holidays?year=${y}`);
        holidayCache.set(y, res.ok ? await res.json() : []);
      } catch {
        holidayCache.set(y, []);
      }
    }
    return holidayCache.get(y);
  }

  async function fetchWeather() {
    try {
      const res = await fetch(`${PROXY_ROOT}/weather`);
      return res.ok ? res.json() : null;
    } catch {
      return null;
    }
  }

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
