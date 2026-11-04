# Work Hub — 프로젝트 정리 노트

> 작성일: 2026-11-04 / 이후 작업 시 컨텍스트 복구용. 코드가 바뀌면 이 문서도 같이 갱신할 것.

## 1. 한 줄 요약
시스템팀 업무 관리 웹앱. **빌드 없는 순수 정적 페이지**(HTML/CSS/vanilla JS)를 GitHub Pages(`jungku3135.github.io`)에 올리고,
Notion DB(태스크/프로젝트/회의록)를 **Cloudflare Worker 프록시**를 통해 직접 읽고 쓴다. 자체 서버/DB 없음.
원래 팀용 Express+SQLite 백엔드 `work-hub`의 프론트엔드를 이식한 것(커밋 `acb5e68`).

## 2. 파일 구성 (총 ~5천 줄, 패키지/번들러 없음)
| 파일 | 줄 | 역할 |
|---|---|---|
| `index.html` | 70 | 헤더(탭: 대시보드/태스크/프로젝트/회의록/업무일지/유틸리티▾), 모달 루트, 스크립트 로드 순서 |
| `app.js` | 2847 | UI 전체: 상태(`state`), 렌더링, 모달, 알림, 업무일지 출력 |
| `notion-adapter.js` | 734 | 옛 `api("GET","api/...")` 호출을 받아 Notion 조회/가공/저장으로 변환 (서버 역할 대체) |
| `notion-client.js` | 273 | Notion REST 래퍼 + 프로퍼티 빌더/리더 + 비밀번호(localStorage) 관리 |
| `config.js` | 72 | Notion DB ID 및 속성명/옵션 매핑 (`window.CONFIG`) |
| `style.css` | 780 | 스타일 (다크모드 `data-theme`) |
| `cloudflare-worker/worker.js` | 192 | Notion 프록시 + `/holidays` `/weather` `/auth-check` |
| `cloudflare-worker/wrangler.toml`, `README.md` | | 배포 설정/방법 |

스크립트 로드 순서(중요): `notion-client.js` → `config.js` → `notion-adapter.js` → `app.js`. 전역(`window.NotionClient/NC`, `CONFIG`, `NotionAdapter`)으로 연결됨.

## 3. 아키텍처
```
브라우저(GitHub Pages)
  app.js ──api()──> NotionAdapter.api(method,"api/tasks/..") ──> NotionClient.notionFetch
                                                                    │ (X-App-Secret 헤더)
                                                                    ▼
                                      Cloudflare Worker (work-hub-notion-proxy.work-hub-proxy.workers.dev)
                                        - NOTION_TOKEN을 Secret으로 보관, Notion-Version 2025-09-03
                                        - /v1/* → api.notion.com 중계, /holidays /weather /auth-check
                                                                    ▼
                                                               Notion API
```
- **읽기는 비밀번호 불필요, 쓰기(생성/수정/삭제)만 `X-App-Secret` 필요.** Worker가 경로 패턴으로 구분(`.../query` POST는 읽기).
- 비밀번호는 `localStorage["wh-settings"].appSecret`. 쓰기 시도 시 `authPrompter`(app.js의 모달)가 입력받고 `/auth-check`로 즉시 검증. 401 응답이면 저장값 삭제 + `wh-auth-changed` 이벤트 → 상단 모드 표시 갱신(뷰어/사용자 모드).
- HTTP 헤더는 ISO-8859-1만 가능 → 한글 섞인 비밀번호는 `isHeaderSafe`로 차단.
- Notion data sources API(2025-09-03) 사용: `/data_sources/{id}/query`, 페이지 생성 시 `parent.type="data_source_id"`.

## 4. 데이터 모델 (config.js 기준 Notion 속성명 — 이름 바뀌면 여기만 수정)
- **태스크**: 이름, 상태(할 일/진행중/완료/계획 취소), 구분(개인/팀), 우선순위, 시작일, 마감일, 담당자(people), 프로젝트(relation), 관련 회의록, 텍스트(note), 휴일근무, 반복(없음/매일/매주/매월), 진행률, 업무유형, 체크리스트, 커스텀 담당자
- **프로젝트**: 이름, 상태(계획/진행중/완료/보류), 구분, 우선순위, 시작/마감일, 담당자, 설명, 관련 태스크/회의록, 커스텀 담당자
- **회의록**: 제목, 날짜, 참석자, 회의유형(주간회의/킥오프/리뷰/의사결정/기타), 프로젝트, 관련 태스크, 커스텀 참석자
- DB ID 기본값은 `config.js`의 `DEFAULT_DATA_SOURCES` (팀 work-hub와 동일 데이터소스 공유 → **실제 팀 데이터를 건드림, 쓰기 테스트 주의**).
- `PEOPLE_NAME_OVERRIDES`: Notion 닉네임 → 표시명(정쿠→강정규). `HIDDEN_PEOPLE_NAMES`(app.js): "Notion MCP", "Testonic" 숨김.
- 옵션 목록(`*_OPTIONS`)은 `config.js`에서만 정의하고 `app.js`는 구조분해로 가져다 씀.

## 5. 핵심 동작/특이 로직
- **저장 방식의 트릭**
  - 체크리스트: JSON을 rich_text(1900자 단위 청크)에 저장, 진행률은 체크 비율로 자동 계산.
  - 회의록 본문: 페이지 블록에 `{items:[{agenda,discussion,decision}...]}` JSON을 paragraph로 저장. 구버전(📌 안건/💬 논의내용/✅ 결정사항 헤딩) 파싱 폴백 있음. 수정 시 기존 블록 전부 삭제 후 재작성.
  - 커스텀 담당자/참석자(Notion 계정 없는 사람): 텍스트 속성에 쉼표 구분 저장 → 모든 기기에서 동일하게 보임. 커스텀 인물 목록은 3개 DB에서 모아 생성. 예전 localStorage(`wh-local-extra`) 값은 읽기 폴백 + 비밀번호 있을 때 Notion으로 1회 이전(`migrateLegacyCustomNames`).
- **반복 태스크**: 상태가 "완료"로 바뀌거나 반복이 새로 켜진 완료 태스크 → 다음 회차 자동 생성(체크리스트 초기화). "매일"은 주말/공휴일 건너뜀(공휴일은 Worker `/holidays`).
- **캐싱**: 목록 10초 메모리 캐시 + single-flight(`cachedFetch`). 태스크/프로젝트/회의록 쓰기 시 전체 무효화. 공휴일은 연도별 Promise 캐시, 날씨 5분 캐시. 어댑터 로드 시점에 공휴일/날씨 미리 요청.
- **자동 동기화**: 30초마다 체크, 마지막 로드 후 5분 경과 시 `POST api/sync`→`loadAll`. 탭이 hidden이거나 모달 열려 있으면 건너뜀. "마지막 동기화" 시각 = 태스크 목록을 실제로 받아온 시각.
- **대시보드**: 플립 시계 + 날씨 위젯(안산, 기상청 기온+Open-Meteo 상태), 오늘/이번주 마감 카운트, 진행중 프로젝트 수, 최근 회의 5개, 달력(공휴일·기간 바), 오늘 할 일.
- **알림**: 브라우저 Notification. 마감 30분 전 리마인더(`REMINDER_LEAD_MINUTES`), 하루 1회 오늘 태스크 팝업. 🔔 FAB로 on/off.
- **태스크 화면**: 보드/리스트 뷰, 필터(구분/프로젝트/담당자), 완료 항목 기본 10개만, 카드의 ▶/✓ 빠른 상태 변경(한 단계씩만).
- **업무일지(report)**: 기간 선택, 프로젝트별 그룹 표, 반복 태스크 병합(`mergeRecurringTasks`), 이미지 저장(canvas 직접 캡처, 라이트 테마 변수 강제)/PDF 인쇄/클립보드 복사, 페이지 분할(`paginateReportRows`). "휴가 및 사내 행사" 프로젝트는 별도 취급.
  - 2026-11-04 개편: **일일/주간 분리** + **담당자 필터**(`state.reportMode/reportAssignee`). 일일은 "일일 업무 계획서" 양식(작성일자·부서명·근무유형·성명 / 전일 진행 결과 8행 / 금일 업무 계획 8행 / 기타) 화면 렌더(`dailySheetHtml`). 전일 = 직전 영업일(주말·공휴일 제외).
  - **엑셀 출력(완료)**: `templates/daily-plan-template.xlsx`(원본 xlsx의 한 시트를 값만 비워 무압축 zip으로 저장)를 fetch → `sheet1.xml` 셀(D9/F9/D10/F10, 전일 D13:D20·F13:F20, 금일 D21:D28·F21:F28)과 시트명(`yy.mm.dd`)만 치환 → 무압축 zip으로 재조립(`buildDailyReportXlsx`, 외부 라이브러리 없음). 담당자 선택 필수, 8건 초과는 마지막 칸에 이어 적음. 양식(로고·병합·열/행 크기)을 바꾸려면 Excel에서 템플릿 파일을 고쳐 무압축으로 다시 저장해야 함(Excel로 저장하면 압축되어 `readStoredZip`이 실패 → 압축 해제 지원 추가 필요).
- **유틸리티 드롭다운**: `UTIL_LINKS`(app.js 상단)에 링크 목록. iframe 미리보기 패널(최소화/새 창), `noPreview: true`는 새 탭(X-Frame-Options / Mixed Content 때문). 현재: 모뎀 설치 현황·집진기 점검 구글 시트, AIR MAX 대시보드/점검 대시보드, 3D Print Viewer(`https://192.168.0.76:8080/`), Web Mail.
- 테마: `localStorage["workhub-theme"]`, 미설정이면 OS 설정 따름.

## 6. localStorage 키
`wh-settings`(비밀번호 등), `wh-local-extra`(레거시 커스텀 인물), `workhub-theme`, `workhub-notif-tasks-enabled`, `workhub-notif-chat-enabled`, `workhub-daily-popup-shown-date`, `workhub-notified-*`(리마인더 중복 방지).

## 7. 배포/운영
- 프론트: `main` 브랜치 push → GitHub Pages. 빌드 없음, 로컬 확인은 정적 서버(예: `npx serve`)로 `index.html` 열기. (Worker CORS는 `ALLOWED_ORIGIN=https://jungku3135.github.io` 한정 → **로컬 origin에서는 CORS로 막힐 수 있음**, 테스트 시 wrangler.toml 변수 확인.)
- Worker: `cloudflare-worker/`에서 `npx wrangler deploy`(Workers Scripts:Edit 토큰). Secret: `NOTION_TOKEN`, `APP_SECRET`, `HOLIDAY_API_KEY`, `KMA_API_KEY`. 프록시 URL은 `notion-client.js`와 `notion-adapter.js`에 **각각 하드코딩**(`PROXY_ROOT`).
- 테스트/린트/CI 없음.

## 8. 알려진 잔재 / 주의점 (후속 정리 후보)
1. ~~채팅 잔재 / 상수·프록시 주소 중복~~ → 정리 완료. 옵션 목록·`PROXY_ROOT`·숨김 인물은 `config.js`가 단일 출처이고, 스크립트 로드 순서는 `config.js` → `notion-client.js` → `notion-adapter.js` → `app.js`. (`config.js`는 IIFE로 감싸 `window.CONFIG`로만 노출)
2. `config.js`에 DB ID 하드코딩(설정 화면은 제거됨, `hasValidSettings`는 항상 true).
3. 알림 FAB는 `.fab.notif-fab` 클래스 사용 (예전 `.chat-fab` 이름 변경됨).
4. 커스텀 인물 "등록만 하고 미사용" 상태는 localStorage(`customPeople`)에만 있어 다른 기기에 안 보임(사용되는 순간 Notion에 남음).
5. 3D Print Viewer 주소가 사설 IP + https(`192.168.0.76:8080`) — 사내망에서만 동작.
6. 회의록 수정 시 블록 전체 삭제 후 재생성 → 중간 실패 시 본문 유실 가능.
7. 실데이터(팀 Notion) 직결이라 개발 중 쓰기 동작은 반드시 주의.

## 9. 커밋 이력 요약 (최근 → 과거, 총 19개)
3D print 주소 변경 → 동기화 시각 자동 갱신 수정 → 5분 자동 새로고침 → 커스텀 담당자 Notion 저장 → 비밀번호 즉시 검증 → 한글 비밀번호 로딩 실패 수정 → Worker 소스 저장소 포함 → 공휴일/날씨 병렬 프리페치 → single-flight/10초 캐시 → 채팅 제거 후 오류 수정 → 원본 프론트엔드 이식(`acb5e68`) → 이전: from-scratch 1차 버전·대시보드·읽기/쓰기 분리·Worker 프록시 도입.

## 9-1. 디자인 (2026-11-04 리디자인, gettakecontrol.app 참고)
- 백업: 브랜치 `backup/pre-redesign` / 태그 `backup-pre-redesign-2026-11-04` (리디자인 이전 상태, 되돌릴 때 사용).
- 토큰은 `style.css` 상단 `:root`(라이트) + 다크 2곳(`@media prefers-color-scheme` / `[data-theme=dark]`, 값 동일하게 유지). 검정 `--accent`(주 버튼/활성 탭), 주황 `--brand`(포인트), `--shadow-float`, `--ease-out`(cubic-bezier(.22,1,.36,1)), `--radius-xl`(32px), `--border-soft`.
- 모션: 화면(탭/상세)이 바뀔 때만 `playViewEnter()`(app.js)가 카드/패널에 `.reveal`(14px 상승, 70ms 간격)을 붙임. 모달/드롭다운/탭 전환/호버 모두 같은 감속 곡선. `prefers-reduced-motion`이면 꺼짐.
- 상단 바는 `backdrop-filter: blur(12px)` 알약. 표·달력은 밀도 유지(모서리/호버만 변경). 업무일지 출력물(xlsx/이미지/PDF)은 디자인과 무관.

## 9-5. 로딩/대기 표시 · 검색
- 요청이 250ms 넘게 걸리면 화면 맨 위에 진행 막대(`#busy-bar`, `api()` 래퍼가 in-flight 수를 셈). 버튼은 `withSubmitGuard`가 스피너(`.is-loading`)+문구, 태스크 빠른 변경 같은 작은 원형 버튼은 스피너만.
- 첫 로딩·프로젝트 상세·회의록 상세는 스켈레톤(`skeletonHtml`), 로딩 실패는 안내 + `다시 시도`(`boot()` 재실행, 기술적 오류는 "자세히 보기"에 숨김).
- 태스크/프로젝트/회의록 목록 상단 검색창(`state.search`, `matchesQuery`: 공백으로 나눈 단어가 모두 포함되면 일치). 입력 시 목록만 다시 그림.

## 9-4. 배율 (zoom 제거)
- 예전 `html { zoom: 0.9 }`는 제거. 대신 `html { font-size: 90% }`(1rem = 14.4px)이고 style.css의 px 값은 전부 rem(=px/16)으로 변환(1px 테두리·미디어쿼리 제외). 같은 화면 크기를 유지하면서 zoom 부작용(확장 프로그램 오버레이 드래그 한계, getBoundingClientRect 어긋남)을 없앰.
- 새 CSS를 쓸 땐 **px 대신 rem**(예: 15px → 0.9375rem)을 써야 화면 비율이 유지됨. 달력 막대 같은 JS 계산 값도 `px/16 rem`으로 출력.
- 인쇄(`@media print`)에서는 루트 글자 크기를 100%로 되돌려 예전과 같은 인쇄 크기를 유지.

## 9-3. 로딩 최적화 (스냅샷)
- 병목: 태스크가 ~250건이라 Notion 100건씩 3번 순차 조회(~2초) + 공휴일 12회 호출(~1초). 첫 방문 대시보드 표시 ~2.0~2.5초.
- `notion-adapter.js`: 직전에 받은 태스크/프로젝트/회의록/사람 목록을 `localStorage["wh-snapshot-v1"]`(7일)에 저장 → 다음 방문 때 즉시 그리고(재방문 ~0.2초), 뒤에서 진짜 데이터를 받아 달라졌으면 `wh-data-refreshed` 이벤트 → `app.js`가 조용히 다시 그림(모달/폼이 열려 있으면 건너뜀). 내용이 같으면 `wh-sync-time`으로 동기화 시각 라벨만 갱신.
- 스냅샷은 페이지를 연 직후 1회만 사용. 쓰기 후 재조회·수동 동기화는 항상 진짜 데이터를 기다림. 공휴일은 `wh-holidays-<year>`에 30일 저장.
- 스냅샷에 문제가 생기면 브라우저에서 `localStorage.removeItem("wh-snapshot-v1")`.

## 9-2. 아이콘
- 이모지는 전부 **Lucide**(ISC) 인라인 SVG로 교체. `icons.js`의 `ICONS` 맵 + `icon(name)` 헬퍼(템플릿 문자열에서 `${icon("pin")}`), 정적 HTML은 `<span data-icon="house"></span>`(자동 치환). `currentColor`라 테마/버튼 색을 따라가고, width/height 속성이 박혀 있어 이미지·PDF 저장에서도 유지됨.
- 새 아이콘 추가: https://lucide.dev 에서 이름 확인 → `https://unpkg.com/lucide-static@latest/icons/<이름>.svg` 의 내부 path들을 `ICONS`에 추가.
- 날씨 위젯도 Lucide(`sun/moon/cloud-*`)로 교체, CSS 도형 애니메이션은 제거(부드러운 위아래 움직임만 유지).
- 남겨둔 이모지: OS 알림 제목 ⏰(이미지 불가), `notion-adapter.js`의 옛 회의록 헤딩 매칭 문자열(데이터 호환).

## 10. 작업 시 팁
- 속성명/옵션 변경 → `config.js` (+ app.js 상수도 확인).
- 새 API 라우트 → `notion-adapter.js`의 `api()` switch에 추가, 쓰기면 캐시 무효화 대상 확인.
- 새 유틸리티 링크 → `app.js` `UTIL_LINKS`.
- Worker 수정 시 프론트 재배포와 별개로 `wrangler deploy` 필요.
- 커밋 메시지는 한국어 `feat:/fix:/perf:` 형식 사용 중.
