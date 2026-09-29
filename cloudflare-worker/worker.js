/* Notion API 프록시 — 진짜 Notion 토큰은 여기(Cloudflare Worker의 Secret)에만 있고,
   GitHub Pages 프론트엔드는 이 Worker 주소로만 요청을 보낸다.
   기존 work-hub와 동일하게: 조회(읽기)는 누구나 비밀번호 없이 되고, 생성/수정/삭제(쓰기)만
   비밀번호(X-App-Secret)를 요구한다. Notion의 "쿼리" 엔드포인트는 필터/정렬 때문에 POST를
   쓰지만 실질은 읽기라서, 경로 패턴으로 읽기/쓰기를 구분한다(HTTP 메서드만으로는 구분 안 됨). */

function isReadOnlyRequest(method, pathname) {
  if (method === "GET" || method === "HEAD") return true;
  // /data_sources/{id}/query, /databases/{id}/query (구버전 호환) 는 POST지만 조회임
  if (method === "POST" && /\/(data_sources|databases)\/[^/]+\/query$/.test(pathname)) return true;
  return false;
}

// 공공데이터포털/기상청 API 키도 Notion 토큰과 마찬가지로 브라우저에 두면 안 되는 값이라
// 이 Worker가 대신 들고 있다가 프론트엔드 요청을 받아서 대신 호출해준다 (팀 work-hub의
// src/holidays.ts, src/weather.ts와 동일한 로직).
const HOLIDAY_API_BASE = "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo";
const KMA_NCST_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst";
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast?latitude=37.3219&longitude=126.8309&current=temperature_2m,weather_code,is_day&timezone=Asia%2FSeoul";
const KMA_NX = 57;
const KMA_NY = 121;

async function fetchMonthHolidays(serviceKey, year, month) {
  const url = new URL(HOLIDAY_API_BASE);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("solYear", String(year));
  url.searchParams.set("solMonth", String(month).padStart(2, "0"));
  url.searchParams.set("numOfRows", "50");
  url.searchParams.set("_type", "json");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`공휴일 API 응답 오류: ${res.status}`);
  const json = await res.json();
  const header = json?.response?.header;
  if (header?.resultCode !== "00") throw new Error(`공휴일 API 오류: ${header?.resultMsg ?? "알 수 없는 오류"}`);
  const rawItems = json?.response?.body?.items?.item;
  const items = !rawItems ? [] : Array.isArray(rawItems) ? rawItems : [rawItems];
  return items
    .filter((it) => it.isHoliday === "Y")
    .map((it) => {
      const s = String(it.locdate);
      return { date: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, name: String(it.dateName) };
    });
}

async function handleHolidays(url, env) {
  const year = Number(url.searchParams.get("year")) || new Date().getFullYear();
  const serviceKey = env.HOLIDAY_API_KEY;
  if (!serviceKey) return jsonResponse([], env);
  try {
    const monthResults = await Promise.all(Array.from({ length: 12 }, (_, i) => fetchMonthHolidays(serviceKey, year, i + 1)));
    return jsonResponse(monthResults.flat().sort((a, b) => a.date.localeCompare(b.date)), env);
  } catch (err) {
    return jsonResponse([], env);
  }
}

function kstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function kmaBaseDateTime() {
  const t = kstNow();
  if (t.getUTCMinutes() < 40) t.setUTCHours(t.getUTCHours() - 1);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const d = String(t.getUTCDate()).padStart(2, "0");
  const h = String(t.getUTCHours()).padStart(2, "0");
  return { baseDate: `${y}${m}${d}`, baseTime: `${h}00` };
}

async function fetchKmaTemp(env) {
  const serviceKey = env.KMA_API_KEY || env.HOLIDAY_API_KEY;
  if (!serviceKey) return null;
  try {
    const { baseDate, baseTime } = kmaBaseDateTime();
    const url = new URL(KMA_NCST_URL);
    url.searchParams.set("serviceKey", serviceKey);
    url.searchParams.set("numOfRows", "10");
    url.searchParams.set("pageNo", "1");
    url.searchParams.set("dataType", "JSON");
    url.searchParams.set("base_date", baseDate);
    url.searchParams.set("base_time", baseTime);
    url.searchParams.set("nx", String(KMA_NX));
    url.searchParams.set("ny", String(KMA_NY));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`기상청 API 응답 오류: ${res.status}`);
    const json = await res.json();
    const header = json?.response?.header;
    if (header?.resultCode !== "00") throw new Error(`기상청 API 오류: ${header?.resultMsg}`);
    const rawItems = json?.response?.body?.items?.item;
    const items = !rawItems ? [] : Array.isArray(rawItems) ? rawItems : [rawItems];
    const t1h = items.find((it) => it.category === "T1H");
    return t1h ? parseFloat(t1h.obsrValue) : null;
  } catch {
    return null;
  }
}

function categorizeWeather(code) {
  if (code === 0) return { category: "clear", label: "맑음" };
  if (code === 1 || code === 2) return { category: "partly-cloudy", label: "구름 조금" };
  if (code === 3) return { category: "cloudy", label: "흐림" };
  if (code === 45 || code === 48) return { category: "fog", label: "안개" };
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { category: "rain", label: "비" };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { category: "snow", label: "눈" };
  if ([95, 96, 99].includes(code)) return { category: "thunder", label: "천둥번개" };
  return { category: "cloudy", label: "흐림" };
}

async function handleWeather(env) {
  try {
    const [res, kmaTemp] = await Promise.all([fetch(OPEN_METEO_URL), fetchKmaTemp(env)]);
    if (!res.ok) throw new Error(`날씨 API 응답 오류: ${res.status}`);
    const json = await res.json();
    const current = json?.current;
    if (!current) throw new Error("날씨 API 응답에 current 데이터 없음");
    const { category, label } = categorizeWeather(current.weather_code);
    return jsonResponse(
      {
        location: "안산",
        temp: Math.round(kmaTemp ?? current.temperature_2m),
        weatherCode: current.weather_code,
        category,
        label,
        isDay: current.is_day === 1,
      },
      env
    );
  } catch (err) {
    return jsonResponse(null, env);
  }
}

function jsonResponse(data, env) {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...corsHeaders(env) } });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(env) });

    const url = new URL(request.url);
    if (url.pathname === "/holidays") return handleHolidays(url, env);
    if (url.pathname === "/weather") return handleWeather(env);

    if (!isReadOnlyRequest(request.method, url.pathname)) {
      const appSecret = request.headers.get("X-App-Secret");
      if (!env.APP_SECRET || appSecret !== env.APP_SECRET) {
        return new Response(JSON.stringify({ message: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders(env) },
        });
      }
    }

    const notionUrl = `https://api.notion.com${url.pathname}${url.search}`;

    const headers = new Headers();
    headers.set("Authorization", `Bearer ${env.NOTION_TOKEN}`);
    headers.set("Notion-Version", "2025-09-03"); // data sources API (팀 work-hub와 동일 버전)
    headers.set("Content-Type", "application/json");

    const notionRes = await fetch(notionUrl, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text(),
    });

    const resHeaders = new Headers(notionRes.headers);
    Object.entries(corsHeaders(env)).forEach(([k, v]) => resHeaders.set(k, v));
    resHeaders.delete("content-encoding"); // Workers가 다시 압축하므로 원본 인코딩 헤더는 제거

    return new Response(notionRes.body, { status: notionRes.status, headers: resHeaders });
  },
};

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Secret",
  };
}
