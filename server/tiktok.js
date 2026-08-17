/**
 * Lay am thanh + anh bia tu mot link TikTok.
 *
 * Ho tro moi kieu link "sao chep lien ket":
 *  - Dien thoai:  https://vt.tiktok.com/ZSVYwFGVp/   (hoac vm.tiktok.com, /t/xxx)
 *  - May tinh:    https://www.tiktok.com/@user/video/123?is_from_webapp=1&sender_device=pc
 *  - Link anh (photo), link /v/, link co chu xung quanh… deu nhan duoc.
 *
 * Cach lay nhac (thu lan luot, nguon nao ra truoc thi dung):
 *  1) Doc thang trang TikTok (du lieu SSR trong trang) — khong phu thuoc ben thu 3
 *  2) API cong khai tikwm (GET + POST, co thu lai khi bi gioi han toc do)
 *  3) API di dong aweme theo id video
 */

const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const UA = UA_MOBILE;

export class TiktokError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const HOST_RE = /^([\w-]+\.)*(tiktok\.com|douyin\.com)$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tim link TikTok dau tien trong mot doan van ban bat ky */
export function extractTiktokUrl(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return "";
  const candidates = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
  if (/tiktok\.com/i.test(text)) {
    const bare = text.match(/(?:[\w-]+\.)*tiktok\.com\/[^\s<>"']*/gi) || [];
    for (const b of bare) candidates.push("https://" + b.replace(/^https?:\/\//i, ""));
  }
  for (const c of candidates) {
    try {
      const u = new URL(c.replace(/[),.]+$/, ""));
      if (HOST_RE.test(u.hostname)) return u.toString();
    } catch { }
  }
  return "";
}

export const isTiktokUrl = (u = "") => !!extractTiktokUrl(u);

const isShortLink = (u) => {
  try {
    const { hostname, pathname } = new URL(u);
    if (/^(vt|vm)\.tiktok\.com$/i.test(hostname)) return true;
    if (/^\/t\//i.test(pathname)) return true;
    // m.tiktok.com chi la link ngan khi chua co /video/ hoac /photo/
    if (/^m\.tiktok\.com$/i.test(hostname) && !/\/(video|photo)\/\d+/i.test(pathname)) return true;
    return false;
  } catch {
    return false;
  }
};

/** Mo link rut gon thanh link day du (theo chuyen huong) */
async function expandShortLink(url) {
  // 1) Theo chuyen huong tu dong
  for (const method of ["HEAD", "GET"]) {
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        headers: {
          "User-Agent": UA_MOBILE,
          Accept: "text/html,application/xhtml+xml,*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(15000),
      });
      if (res.url && !isShortLink(res.url) && /tiktok\.com/i.test(res.url)) return res.url;
      // 2) Mot so truong hop link that nam trong noi dung trang
      if (method === "GET") {
        const html = await res.text().catch(() => "");
        const m =
          /https:\/\/www\.tiktok\.com\/@[\w.\-]+\/(?:video|photo)\/\d+/i.exec(html) ||
          /"(?:canonical|shareUrl|url)":"(https:\\?\/\\?\/www\.tiktok\.com[^"]+)"/i.exec(html);
        if (m) return (m[1] || m[0]).replace(/\\\//g, "/");
      }
    } catch { }
  }
  // 3) Khong theo chuyen huong -> doc header Location
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": UA_MOBILE, Accept: "*/*" },
      signal: AbortSignal.timeout(12000),
    });
    const loc = res.headers.get("location");
    if (loc && /tiktok\.com/i.test(loc)) return loc;
  } catch { }
  return url;
}

/** Bo cac tham so theo doi (is_from_webapp, sender_device, _t, _r…) */
function cleanUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    u.protocol = "https:";
    u.hostname = u.hostname.replace(/^m\./i, "www.").replace(/^tiktok\.com$/i, "www.tiktok.com");
    if (/^tiktok\.com$/i.test(u.hostname)) u.hostname = "www.tiktok.com";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return url;
  }
}

/** Chuan hoa link nguoi dung dan vao -> link video day du, sach tham so */
export async function normalizeTiktokUrl(raw) {
  const found = extractTiktokUrl(raw);
  if (!found) throw new TiktokError("Link TikTok chưa đúng, hãy dán lại");
  let full = isShortLink(found) ? await expandShortLink(found) : found;
  if (isShortLink(full)) full = await expandShortLink(full); // chuoi 2 lan rut gon
  return { url: cleanUrl(full), original: found };
}

/** Lay id video neu co (dung cho mot so nguon du phong) */
function videoId(url) {
  const m =
    /\/(?:video|photo|v)\/(\d{6,})/.exec(url) ||
    /[?&](?:item_id|aweme_id|video_id)=(\d{6,})/.exec(url) ||
    /\/(\d{15,})/.exec(url);
  return m ? m[1] : "";
}

async function jsonFetch(url, ms = 15000, init = {}) {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        "User-Agent": UA_DESKTOP,
        Accept: "application/json,text/plain,*/*",
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(ms),
    });
    const text = await res.text();
    try {
      return { ok: res.ok, status: res.status, data: JSON.parse(text) };
    } catch {
      return { ok: false, status: res.status, data: null };
    }
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

async function oembed(url) {
  try {
    const { ok, data } = await jsonFetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
    if (ok && data) {
      return {
        title: data.title || "",
        author: data.author_name || "",
        covers: [data.thumbnail_url].filter(Boolean),
      };
    }
  } catch { }
  return { title: "", author: "", covers: [] };
}

const httpUrl = (x) => (typeof x === "string" && /^https?:\/\//i.test(x) ? x : "");

const pickAudio = (d) =>
  httpUrl(d?.music) ||
  httpUrl(d?.music_info?.play) ||
  httpUrl(d?.play_url) ||
  httpUrl(d?.musicUrl) ||
  "";

const coversOf = (d) =>
  [
    d?.cover,
    d?.origin_cover,
    d?.ai_dynamic_cover,
    d?.dynamic_cover,
    d?.music_info?.cover,
    d?.music_info?.cover_large,
    d?.author?.avatar,
  ].filter((x) => typeof x === "string" && /^https?:\/\//i.test(x));

/* ---------------------------------------------- Nguon 1: doc thang trang */

function firstUrl(v) {
  if (!v) return "";
  if (typeof v === "string") return httpUrl(v);
  if (Array.isArray(v)) {
    for (const x of v) {
      const u = firstUrl(x);
      if (u) return u;
    }
  }
  if (typeof v === "object") return firstUrl(v.url_list || v.urlList || v.url || v.playUrl || v.play_url);
  return "";
}

function itemFromScope(scope) {
  if (!scope || typeof scope !== "object") return null;
  return (
    scope["webapp.video-detail"]?.itemInfo?.itemStruct ||
    scope["webapp.reflow.video.detail"]?.itemInfo?.itemStruct ||
    null
  );
}

async function fromTiktokPage(url) {
  for (const ua of [UA_MOBILE, UA_DESKTOP]) {
    let html = "";
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://www.tiktok.com/",
        },
        signal: AbortSignal.timeout(20000),
      });
      html = await res.text();
    } catch {
      continue;
    }
    if (!html) continue;

    let item = null;
    const blocks = [
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i,
      /<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i,
    ];
    for (const re of blocks) {
      const m = re.exec(html);
      if (!m) continue;
      try {
        const json = JSON.parse(m[1]);
        item =
          itemFromScope(json.__DEFAULT_SCOPE__) ||
          itemFromScope(json) ||
          (json.ItemModule ? Object.values(json.ItemModule)[0] : null);
      } catch { }
      if (item) break;
    }

    if (item) {
      const music = item.music || {};
      const audio = firstUrl(music.playUrl) || firstUrl(music.play_url);
      if (audio) {
        const covers = [
          firstUrl(music.coverLarge),
          firstUrl(music.coverMedium),
          firstUrl(music.cover_large),
          firstUrl(item.video?.cover),
          firstUrl(item.video?.originCover),
          firstUrl(item.video?.dynamicCover),
        ].filter(Boolean);
        return {
          url: audio,
          title: music.title || item.desc || "",
          author: music.authorName || item.author?.nickname || "",
          covers,
        };
      }
    }

    // Du phong: bat link nhac trong ma nguon trang
    const raw = html.replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
    const m2 =
      /https:\/\/[^"'\\ ]*mime_type=audio_mpeg[^"'\\ ]*/i.exec(raw) ||
      /"playUrl":"(https:\/\/[^"]+)"/i.exec(raw);
    const found = m2 ? (m2[1] || m2[0]) : "";
    if (found) return { url: found, title: "", author: "", covers: [] };
  }
  return null;
}

/* ------------------------------------------------------ Nguon 2: tikwm */

function fromTikwmData(d) {
  const music = pickAudio(d);
  if (!music) return null;
  return {
    url: music,
    title: d.music_info?.title || d.title || "",
    author: d.music_info?.author || d.author?.nickname || "",
    covers: coversOf(d),
  };
}

async function tikwm(url) {
  const targets = [
    `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=0`,
    `https://tikwm.com/api/?url=${encodeURIComponent(url)}`,
  ];
  for (const t of targets) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data } = await jsonFetch(t);
      const got = fromTikwmData(data?.data);
      if (got) return got;
      // code = -1 thuong la "Free Api Limit" -> cho mot chut roi thu lai
      if (data && data.code === -1) await sleep(1200);
      else break;
    }
  }
  // Thu bang POST (dang form) — endpoint nay it bi gioi han hon
  const { data } = await jsonFetch("https://www.tikwm.com/api/", 15000, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ url, hd: "0" }).toString(),
  });
  return fromTikwmData(data?.data);
}

/* ------------------------------------------- Nguon 3: API theo id video */

async function fromAwemeApi(id) {
  if (!id) return null;
  const endpoints = [
    `https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id=${id}&version_code=2613&app_name=musical_ly&channel=App&device_platform=android&aid=1988`,
    `https://api22-normal-c-useast2a.tiktokv.com/aweme/v1/feed/?aweme_id=${id}&version_code=2613&app_name=musical_ly&channel=App&device_platform=android&aid=1988`,
  ];
  for (const e of endpoints) {
    const { data } = await jsonFetch(e, 15000, { headers: { "User-Agent": "okhttp/3.10.0.1" } });
    const aw = data?.aweme_list?.find((a) => String(a.aweme_id) === String(id)) || data?.aweme_list?.[0];
    if (!aw) continue;
    const audio = firstUrl(aw.music?.play_url) || firstUrl(aw.music?.playUrl);
    if (!audio) continue;
    return {
      url: audio,
      title: aw.music?.title || aw.desc || "",
      author: aw.music?.author || aw.author?.nickname || "",
      covers: [
        firstUrl(aw.music?.cover_large),
        firstUrl(aw.music?.cover_medium),
        firstUrl(aw.video?.cover),
        firstUrl(aw.video?.origin_cover),
      ].filter(Boolean),
    };
  }
  return null;
}

/* Cac nguon doc link nhac (thu lan luot) */
const PROVIDERS = [
  (url) => fromTiktokPage(url),
  (url) => tikwm(url),
  (url) => {
    const id = videoId(url);
    return id ? tikwm(`https://www.tiktok.com/@i/video/${id}`) : null;
  },
  (url) => fromAwemeApi(videoId(url)),
];

const rand = (arr) => (arr.length ? arr[Math.floor(Math.random() * arr.length)] : "");

/**
 * Tra ve { url, title, author, cover, covers, pageUrl } cua ban nhac trong video TikTok.
 * `cover` la MOT anh bat ky trong so anh lay duoc (khong dung anh dai dien tai khoan cua nguoi dung).
 */
export async function resolveTiktokAudio(rawUrl) {
  const { url, original } = await normalizeTiktokUrl(rawUrl);
  const meta = await oembed(url);

  const tries = [url];
  if (original && original !== url) tries.push(original);
  const id = videoId(url) || videoId(original);
  if (id && !tries.some((t) => t.includes(`/video/${id}`))) tries.push(`https://www.tiktok.com/@i/video/${id}`);

  for (const target of tries) {
    for (const p of PROVIDERS) {
      let got = null;
      try {
        got = await p(target);
      } catch { }
      if (got?.url && /^https?:\/\//i.test(got.url)) {
        const covers = [...new Set([...(got.covers || []), ...meta.covers])].filter(Boolean);
        return {
          url: got.url,
          title: got.title || meta.title || "Nhạc TikTok",
          author: got.author || meta.author || "",
          cover: rand(covers),
          covers,
          pageUrl: url,
        };
      }
    }
  }

  throw new TiktokError(
    "Không lấy được âm thanh từ link này. Bạn hãy thử lại hoặc tải nhạc từ máy.",
    502
  );
}

const CDN_RE =
  /^https:\/\/([\w-]+\.)*(tiktokcdn[\w-]*\.com|tiktokcdn[\w-]*\.net|tiktokv\.com|tiktokv\.us|tiktokvcdn\.com|ttwstatic\.com|tikwm\.com|byteoversea\.com|muscdn\.com|musical\.ly|bytecdn\.cn|ibytedtos\.com|akamaized\.net|tiktok\.com)\//i;

/** Cho phep phat lai qua proxy cua server (tranh chan hotlink tren dien thoai) */
export const isProxyableAudio = (u = "") => CDN_RE.test(String(u));

/** Anh bia cung co the bi chan hotlink -> cho phep proxy */
export const isProxyableImage = (u = "") => CDN_RE.test(String(u));

/** Chuyen tiep mot tai nguyen (audio/anh) tu CDN TikTok ve trinh duyet */
export async function streamRemote(src, res, fallbackType = "audio/mpeg") {
  const upstream = await fetch(src, {
    headers: { "User-Agent": UA, Referer: "https://www.tiktok.com/", Accept: "*/*" },
    signal: AbortSignal.timeout(20000),
  });
  if (!upstream.ok || !upstream.body) throw new TiktokError("Không tải được nội dung", 502);
  res.setHeader("Content-Type", upstream.headers.get("content-type") || fallbackType);
  const len = upstream.headers.get("content-length");
  if (len) res.setHeader("Content-Length", len);
  res.setHeader("Cache-Control", "public, max-age=86400");
  const reader = upstream.body.getReader();
  for (; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

export const streamAudio = (src, res) => streamRemote(src, res, "audio/mpeg");
export const streamImage = (src, res) => streamRemote(src, res, "image/jpeg");
