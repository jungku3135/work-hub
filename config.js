/* 태스크/프로젝트/회의록 속성 이름 매핑 — 팀 work-hub와 같은 스키마를 기본값으로 쓴다.
   Notion 데이터베이스의 속성 이름이 다르면 이 파일만 고치면 된다. */

// 전역 const 이름이 다른 스크립트와 겹치지 않도록 IIFE로 감싸고 window.CONFIG로만 내보낸다
(function () {
// Cloudflare Worker(Notion 프록시) 주소 — notion-client.js / notion-adapter.js가 공통으로 사용
const PROXY_ROOT = "https://work-hub-notion-proxy.work-hub-proxy.workers.dev";

// 기존 시스템팀 work-hub가 쓰던 것과 동일한 데이터소스 ID (설정 화면 기본값으로 쓰임)
const DEFAULT_DATA_SOURCES = {
  tasksDbId: "8981083f-4ed7-4122-90c0-f0f3bfe34d1d",
  projectsDbId: "4cbfb1fc-ba86-44b1-9fd1-2931f1d7afc2",
  meetingsDbId: "c63162f4-1bf0-4d3c-859c-48ec3c708d3b",
};

const TASK_PROPS = {
  name: "이름",
  status: "상태",
  category: "구분",
  priority: "우선순위",
  startDate: "시작일",
  dueDate: "마감일",
  assignees: "담당자",
  project: "프로젝트",
  meetings: "관련 회의록",
  note: "텍스트",
  holidayWork: "휴일근무",
  recurrence: "반복",
  progress: "진행률",
  workType: "업무유형",
  checklist: "체크리스트",
  customAssignees: "커스텀 담당자", // Notion 계정 없는 담당자 이름 (쉼표 구분 텍스트)
};

const TASK_STATUS_OPTIONS = ["할 일", "진행중", "완료", "계획 취소"];
const CATEGORY_OPTIONS = ["개인", "팀"];
const PRIORITY_OPTIONS = ["높음", "보통", "낮음"];
const RECURRENCE_OPTIONS = ["없음", "매일", "매주", "매월"];
const WORK_TYPE_OPTIONS = ["없음", "제품 개발/개선", "타부서 업무지원", "집진기 점검", "제품 설치", "사장님 지시", "상무님 지시", "휴가 및 사내 행사"];

const PROJECT_PROPS = {
  name: "이름",
  status: "상태",
  category: "구분",
  priority: "우선순위",
  startDate: "시작일",
  dueDate: "마감일",
  assignees: "담당자",
  description: "설명",
  tasks: "관련 태스크",
  meetings: "관련 회의록",
  customAssignees: "커스텀 담당자",
};

const PROJECT_STATUS_OPTIONS = ["계획", "진행중", "완료", "보류"];

const MEETING_PROPS = {
  title: "제목",
  date: "날짜",
  attendees: "참석자",
  meetingType: "회의유형",
  project: "프로젝트",
  tasks: "관련 태스크",
  customAttendees: "커스텀 참석자",
};

const MEETING_TYPE_OPTIONS = ["주간회의", "킥오프", "리뷰", "의사결정", "기타"];

// Notion 워크스페이스 닉네임을 화면 표시용 이름으로 바꿔주는 매핑 (팀 work-hub와 동일)
const PEOPLE_NAME_OVERRIDES = { 정쿠: "강정규" };

// 담당자 선택 목록에서 숨길 Notion 연동 계정
const HIDDEN_PEOPLE_NAMES = ["Notion MCP", "Testonic"];

window.CONFIG = {
  PROXY_ROOT,
  DEFAULT_DATA_SOURCES,
  TASK_PROPS, TASK_STATUS_OPTIONS, CATEGORY_OPTIONS, PRIORITY_OPTIONS, RECURRENCE_OPTIONS, WORK_TYPE_OPTIONS,
  PROJECT_PROPS, PROJECT_STATUS_OPTIONS,
  MEETING_PROPS, MEETING_TYPE_OPTIONS,
  PEOPLE_NAME_OVERRIDES, HIDDEN_PEOPLE_NAMES,
};
})();
