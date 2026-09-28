/* 태스크/프로젝트/회의록 속성 이름 매핑 — 팀 work-hub와 같은 스키마를 기본값으로 쓴다.
   개인 Notion 데이터베이스의 속성 이름이 다르면 이 파일만 고치면 된다. */
const TASK_PROPS = {
  name: "이름",
  status: "상태",
  category: "구분",
  priority: "우선순위",
  startDate: "시작일",
  dueDate: "마감일",
  assignees: "담당자",
  project: "프로젝트",
  note: "텍스트",
  holidayWork: "휴일근무",
  recurrence: "반복",
  progress: "진행률",
  workType: "업무유형",
  checklist: "체크리스트",
};

const TASK_STATUS_OPTIONS = ["할 일", "진행중", "완료", "계획 취소"];
const PRIORITY_OPTIONS = ["높음", "보통", "낮음"];
const RECURRENCE_OPTIONS = ["없음", "매일", "매주", "매월"];
const WORK_TYPE_OPTIONS = ["제품 개발/개선", "타부서 업무지원", "집진기 점검", "제품 설치", "휴가 및 사내 행사"];

const PROJECT_PROPS = {
  name: "이름",
  status: "상태",
  category: "구분",
  priority: "우선순위",
  startDate: "시작일",
  dueDate: "마감일",
  assignees: "담당자",
  description: "설명",
};

const PROJECT_STATUS_OPTIONS = ["계획", "진행중", "완료", "보류"];

const MEETING_PROPS = {
  title: "제목",
  date: "날짜",
  attendees: "참석자",
  meetingType: "회의유형",
  project: "프로젝트",
};

const MEETING_TYPE_OPTIONS = ["주간회의", "킥오프", "리뷰", "의사결정", "기타"];

// 홀리데이/날씨 위젯 설정 — 필요하면 좌표를 자신의 지역으로 바꾸면 된다 (기본값: 안산)
const WEATHER_LAT = 37.3;
const WEATHER_LON = 126.8;
const KMA_NX = 57;
const KMA_NY = 121;

window.CONFIG = {
  TASK_PROPS, TASK_STATUS_OPTIONS, PRIORITY_OPTIONS, RECURRENCE_OPTIONS, WORK_TYPE_OPTIONS,
  PROJECT_PROPS, PROJECT_STATUS_OPTIONS,
  MEETING_PROPS, MEETING_TYPE_OPTIONS,
  WEATHER_LAT, WEATHER_LON, KMA_NX, KMA_NY,
};
