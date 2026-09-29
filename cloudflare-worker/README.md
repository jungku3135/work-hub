# work-hub-notion-proxy (Cloudflare Worker)

GitHub Pages 프론트엔드(`notion-adapter.js`)가 Notion에 직접 접속하면 진짜 Notion 토큰이
브라우저에 그대로 노출되므로, 이 Worker가 토큰을 Secret으로 대신 들고 있다가 요청을
중계한다. 조회(GET, 그리고 `.../query` POST)는 누구나 가능하고, 생성·수정·삭제는
`X-App-Secret` 헤더가 맞아야 통과된다. 공휴일/날씨(공공데이터포털·기상청 API 키)도
같은 이유로 이 Worker가 대신 요청해준다.

배포된 주소: `https://work-hub-notion-proxy.work-hub-proxy.workers.dev`

## 배포 방법

```bash
npm install --no-save wrangler
CLOUDFLARE_API_TOKEN=<Workers Scripts:Edit 권한 토큰> npx wrangler deploy
```

## Secret 설정 (최초 1회, 또는 값이 바뀔 때)

```bash
CLOUDFLARE_API_TOKEN=<토큰> npx wrangler secret put NOTION_TOKEN
CLOUDFLARE_API_TOKEN=<토큰> npx wrangler secret put APP_SECRET       # work-hub 공용 비밀번호
CLOUDFLARE_API_TOKEN=<토큰> npx wrangler secret put HOLIDAY_API_KEY  # 공공데이터포털
CLOUDFLARE_API_TOKEN=<토큰> npx wrangler secret put KMA_API_KEY      # 기상청
```

`wrangler.toml`의 `ALLOWED_ORIGIN`은 CORS 허용 출처(GitHub Pages 주소)다.
