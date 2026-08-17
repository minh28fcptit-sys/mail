/* ==========================================================
   Chatbox REALTIME (Socket.IO + MongoDB) — client
   - Gửi tin: người kia nhận NGAY, thông báo hiện ngay
   - Trạng thái online/offline đổi tức thì (presence)
   - Sửa / xoá tin nhắn, quản lý nhóm, cảm xúc Facebook, quà tặng, emoji
   ========================================================== */
const $ = (s) => document.querySelector(s);
const phone = $("#phone");
const convsEl = $("#convs");
const messagesEl = $("#messages");
const reactPop = $("#reactPop");
const msgMenu = $("#msgMenu");

const TOKEN_KEY = "chat.token";
const USER_KEY = "chat.user";

let token = localStorage.getItem(TOKEN_KEY) || "";
let me = JSON.parse(localStorage.getItem(USER_KEY) || "null");
let ASSETS = { reactions: [], gifts: [], brand: {}, emojis: [], avatars: [], groupAvatars: [] };
let conversations = [];
let messages = [];
let current = null;
let currentConv = null;
let sheetMode = "group";
let selected = new Set();
let users = [];
let editingId = null;
let socket = null;
let pickedGroupAvatar = "";
const typingUsers = new Map(); // convId -> Map(userId -> {name, timer})
let mediaReady = false; // đã cấu hình kho ảnh Cloudinary chưa
let mediaMax = 10 * 1024 * 1024;
const geoCache = { provinces: null, districts: new Map(), wards: new Map() };

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* So tin nhan chua doc: qua 9 thi hien "9+" */
const fmtCount = (n) => (Number(n) > 9 ? "9+" : String(Number(n) || 0));

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", !!err);
  t.classList.add("show");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("show"), 2400);
}

/* -------------------------------------------------------------- REST */
async function api(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { ...opts, headers });
  const d = await res.json().catch(() => ({}));
  if (res.status === 401) {
    signOutLocal();
    throw new Error("Phiên đã hết, hãy đăng nhập lại");
  }
  if (!res.ok) throw new Error(d.error || "Vui lòng mở mục nhắn riêng để tiếp tục !");
  return d;
}
const post = (url, body) => api(url, { method: "POST", body: JSON.stringify(body || {}) });

/* ------------------------------------------------- Socket.IO (realtime) */
function rt(event, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) return reject(new Error("Mất kết nối realtime, đang thử lại…"));
    socket.timeout(12000).emit(event, payload, (err, res) => {
      if (err) return reject(new Error("Máy chủ phản hồi chậm, thử lại nhé"));
      if (!res?.ok) return reject(new Error(res?.error || "Thao tác thất bại"));
      resolve(res.data);
    });
  });
}

function setLive(state, text) {
  const el = $("#storeState");
  el.textContent = text;
  el.className = state; // live | off
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token }, transports: ["websocket", "polling"] });

  socket.on("connect", () => setLive("live", "Realtime Socket.IO · đang kết nối trực tiếp"));
  socket.on("disconnect", () => setLive("off", "Mất kết nối — đang kết nối lại…"));
  socket.on("connect_error", (e) => {
    setLive("off", "Không kết nối được realtime");
    if (/Chưa đăng nhập/i.test(e.message)) signOutLocal();
  });

  socket.on("ready", async (d) => {
    me = { ...me, ...d.user };
    localStorage.setItem(USER_KEY, JSON.stringify(me));
    paintMe();
    await loadConversations();
    if (current) await openThread(current, true);
  });

  /* Tin nhắn mới — CHỈ thêm 1 node vào cuối, không dựng lại cả danh sách */
  socket.on("message:new", (d) => {
    const m = d.message;
    if (m.conversationId === current) {
      if (!messages.some((x) => x.id === m.id)) {
        messages.push(m);
        appendMessageNode(m);
      }
      if (m.senderId !== me?.id) markReadNow();
    }
    if (m.senderId !== me?.id) notify(m);
  });

  /* Sửa / thu hồi / thả cảm xúc — CHỈ thay đúng node có data-id đó */
  socket.on("message:update", (d) => {
    const m = d.message;
    if (m.conversationId !== current) return;
    const i = messages.findIndex((x) => x.id === m.id);
    if (i >= 0) messages[i] = m;
    else return;
    replaceMessageNode(m);
  });

  /* Đã xem — chỉ vẽ lại hàng avatar "đã xem" */
  socket.on("message:read", (d) => {
    if (d.conversationId !== current) return;
    let changed = false;
    for (const m of messages) {
      if (m.senderId === me?.id && !(m.readBy || []).includes(d.userId)) {
        m.readBy = [...(m.readBy || []), d.userId];
        changed = true;
      }
    }
    if (changed) paintSeen();
  });

  /* Danh sách hội thoại tự cập nhật */
  socket.on("conversation:update", (d) => {
    if (d.removed) {
      conversations = conversations.filter((c) => c.id !== d.conversationId);
    } else {
      const conv = { ...d.conversation };
      /* Hoi thoai dang mo & dang xem -> luon coi la da doc */
      if (conv.id === current && !document.hidden) conv.unread = 0;
      const i = conversations.findIndex((c) => c.id === d.conversationId);
      if (i >= 0) conversations[i] = conv;
      else conversations.push(conv);
      if (d.conversationId === current) {
        currentConv = conv;
        paintThreadHeader();
      }
    }
    sortConversations();
    renderConversationsSoon();
  });

  socket.on("conversation:removed", (d) => {
    conversations = conversations.filter((c) => c.id !== d.conversationId);
    renderConversationsSoon();
    if (current === d.conversationId) {
      closeThread();
      toast("Cuộc trò chuyện đã bị xoá hoặc bạn không còn trong nhóm");
    }
  });

  /* Trạng thái hoạt động đổi tức thì */
  /* Một người online/offline: chỉ sửa đúng chấm trạng thái, KHÔNG dựng lại danh sách */
  socket.on("presence:update", ({ userId, online, lastSeen }) => {
    for (const c of conversations) {
      if (!c.isGroup && c.otherId === userId) {
        c.online = online;
        c.lastSeen = lastSeen;
      }
      for (const m of c.members || []) {
        if (m.id === userId) {
          m.online = online;
          m.lastSeen = lastSeen;
        }
      }
    }
    for (const u of users) if (u.id === userId) Object.assign(u, { online, lastSeen });

    patchPresenceDom(userId, online);

    if (currentConv && !currentConv.isGroup && currentConv.otherId === userId) {
      currentConv.online = online;
      currentConv.lastSeen = lastSeen;
      paintThreadHeader();
    }
    if (!$("#sheetWrap").hidden) renderUsersSoon();
  });

  socket.on("typing", ({ conversationId, userId, name, typing }) => {
    if (!typingUsers.has(conversationId)) typingUsers.set(conversationId, new Map());
    const map = typingUsers.get(conversationId);
    const old = map.get(userId);
    if (old?.timer) clearTimeout(old.timer);
    if (typing) {
      map.set(userId, { name, timer: setTimeout(() => { map.delete(userId); paintTyping(); }, 4000) });
    } else map.delete(userId);
    paintTyping();
  });

  socket.on("me:update", (d) => {
    me = { ...me, ...d.user };
    localStorage.setItem(USER_KEY, JSON.stringify(me));
    paintMe();
  });

  /* Ai đó vừa đổi trang cá nhân / tên / ảnh */
  socket.on("profile:update", ({ user }) => {
    if (!user) return;
    for (const c of conversations) {
      for (const m of c.members || []) {
        if (m.id === user.id) Object.assign(m, { name: user.name, avatarUrl: user.avatarUrl });
      }
    }
    for (const m of messages) {
      if (m.senderId === user.id) Object.assign(m, { senderName: user.name, avatarUrl: user.avatarUrl });
    }
    if (currentConv && !currentConv.isGroup && currentConv.otherId === user.id) {
      $("#thTitle").textContent = user.name;
      $("#thAvatar").src = user.avatarUrl;
    }
    if (profileUser && profileUser.id === user.id && !$("#profileWrap").hidden) {
      openProfile(user.id);
    }
    renderConversationsSoon();
    renderMessages(false);
  });

  socket.on("unread:total", () => renderConversationsSoon());
}

/* ------------------------------------------ Thông báo (Notification + âm) */
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g);
    g.connect(audioCtx.destination);
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.08, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    o.start();
    o.stop(audioCtx.currentTime + 0.26);
  } catch { }
}

function previewText(m) {
  if (m.deleted) return "Tin nhắn đã thu hồi";
  if (m.type === "gift") return `Đã gửi ${m.giftLabel || "một món quà"}`;
  if (m.type === "icon") return "Đã gửi một biểu tượng";
  if (m.type === "image") return m.text ? `🖼️ ${m.text}` : "Đã gửi một ảnh";
  if (m.type === "system") return m.text;
  return m.text;
}

function notify(m) {
  const conv = conversations.find((c) => c.id === m.conversationId);
  const title = conv?.isGroup ? `${m.senderName} · ${conv.title}` : m.senderName;
  const body = previewText(m);
  beep();
  if (document.hidden || m.conversationId !== current) {
    toast(`${title}: ${body}`);
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        const n = new Notification(title, { body, icon: m.avatarUrl, tag: m.conversationId });
        n.onclick = () => {
          window.focus();
          openThread(m.conversationId);
          n.close();
        };
      } catch { }
    }
  }
}

$("#bellBtn").addEventListener("click", async () => {
  if (!("Notification" in window)) return toast("Trình duyệt không hỗ trợ thông báo", true);
  await enablePush();
});

/* ------------------------------------------------ Ngày giờ (giờ Việt Nam) */
const VN = { timeZone: "Asia/Ho_Chi_Minh" };
const fmtTime = (d) => new Date(d).toLocaleTimeString("vi-VN", { ...VN, hour: "2-digit", minute: "2-digit" });
const fmtFull = (d) =>
  new Date(d).toLocaleString("vi-VN", { ...VN, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const dayKey = (d) => new Date(d).toLocaleDateString("vi-VN", VN);

function dayLabel(d) {
  const k = dayKey(d);
  if (k === dayKey(Date.now())) return "Hôm nay";
  if (k === dayKey(Date.now() - 86400000)) return "Hôm qua";
  return new Date(d).toLocaleDateString("vi-VN", { ...VN, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
}
function shortWhen(d) {
  if (!d) return "";
  const diff = Date.now() - new Date(d).getTime();
  if (diff < 60000) return "vừa xong";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} phút`;
  if (dayKey(d) === dayKey(Date.now())) return fmtTime(d);
  if (dayKey(d) === dayKey(Date.now() - 86400000)) return "Hôm qua";
  return new Date(d).toLocaleDateString("vi-VN", { ...VN, day: "2-digit", month: "2-digit" });
}

/* ================================================== ĐĂNG NHẬP / ĐĂNG KÝ */
function showAuth(show) {
  $("#auth").hidden = !show;
  if (show) setTimeout(() => $("#authName").focus(), 120);
}
function signOutLocal() {
  token = "";
  me = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  if (socket) socket.disconnect();
  socket = null;
  conversations = [];
  convsEl.innerHTML = "";
  phone.classList.remove("open");
  $("#meBar").hidden = true;
  showAuth(true);
}
function saveSession(d) {
  token = d.token;
  me = d.user;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(me));
}
function paintMe() {
  if (!me) return;
  $("#meBar").hidden = false;
  $("#meAvatar").src = me.avatarUrl || "";
  $("#meName").textContent = me.name;
  $("#meStore").textContent = "MongoDB · realtime Socket.IO";
}

$("#authName").addEventListener("blur", async () => {
  const name = $("#authName").value.trim();
  if (!name) return;
  try {
    const d = await fetch(`/api/chat/auth/exists?name=${encodeURIComponent(name)}`).then((r) => r.json());
    $("#authTitle").textContent = d.exists ? "Đăng nhập" : "Tạo tài khoản";
    $("#authSub").textContent = d.exists
      ? "Tên này đã tồn tại — nhập đúng mật khẩu đã tạo."
      : "Tên chưa ai dùng — nhập mật khẩu để tạo tài khoản mới.";
    $("#authSubmit").textContent = d.exists ? "Đăng nhập" : "Tạo tài khoản";
  } catch { }
});

$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#authName").value.trim();
  const password = $("#authPass").value;
  const err = $("#authErr");
  err.hidden = true;
  $("#authSubmit").disabled = true;
  try {
    const ex = await fetch(`/api/chat/auth/exists?name=${encodeURIComponent(name)}`).then((r) => r.json());
    const d = ex.exists
      ? await post("/api/chat/auth/login", { name, password })
      : await post("/api/chat/auth/register", { name, password });
    saveSession(d);
    $("#authPass").value = "";
    showAuth(false);
    paintMe();
    connectSocket();
    toast(`Xin chào ${me.name}!`);
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  } finally {
    $("#authSubmit").disabled = false;
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  try {
    await post("/api/chat/auth/logout");
  } catch { }
  signOutLocal();
});

/* ============================================================ Hội thoại */
function sortConversations() {
  conversations.sort((a, b) => {
    if (!!b.announcement !== !!a.announcement) return b.announcement ? 1 : -1;
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
}

function renderConversations() {
  const q = ($("#search").value || "").trim().toLowerCase();
  const list = conversations.filter((c) => !q || (c.title || "").toLowerCase().includes(q));

  const total = conversations.reduce((s, c) => s + (c.unread || 0), 0);
  const badge = $("#badgeTotal");
  badge.hidden = total === 0;
  badge.textContent = fmtCount(total);
  document.title = total ? `(${fmtCount(total)}) Tin nhắn — Mail OTP` : "Tin nhắn — Mail OTP";
  setAppBadge(total);

  if (!list.length) {
    convsEl.innerHTML = `<div class="chat-empty">Chưa có cuộc trò chuyện. Bấm ✚ để tạo nhóm hoặc nhắn riêng.</div>`;
    return;
  }

  convsEl.innerHTML = list
    .map((c) => {
      const who = c.last ? (c.last.fromMe ? "Bạn: " : c.isGroup ? `${c.last.senderName}: ` : "") : "";
      const prev = c.last
        ? `${esc(who)}${c.last.iconUrl ? `<img src="${esc(c.last.iconUrl)}" alt="" />` : ""}<span>${esc(c.last.preview || "")}</span>`
        : `<span>Bắt đầu trò chuyện</span>`;
      return `<button class="conv ${c.unread ? "unread" : ""} ${c.id === current ? "active" : ""}" data-id="${esc(c.id)}" data-other="${esc(c.otherId || "")}" type="button">
        <span class="avatar-wrap">
          <img class="avatar" src="${esc(c.avatarUrl)}" alt="" loading="lazy" />
          ${c.isGroup ? '<i class="grp" title="Nhóm"></i>' : c.online ? '<i class="dot-online"></i>' : '<i class="dot-off"></i>'}
        </span>
        <span class="conv-mid">
          <span class="conv-name">${esc(c.title)}${c.announcement ? ' <i class="ann-tag">Thông báo</i>' : c.isGroup ? ` <small>· ${c.memberCount} người</small>` : ""}</span>
          <span class="conv-prev">${prev}</span>
        </span>
        <span class="conv-right">
          <span class="conv-time" title="${c.last ? esc(fmtFull(c.last.createdAt)) : ""}">${c.last ? esc(shortWhen(c.last.createdAt)) : ""}</span>
          <span class="badge ${c.unread ? "" : "ghost"}">${fmtCount(c.unread)}</span>
        </span>
      </button>`;
    })
    .join("");
}

/* Gắn MỘT lần cho cả danh sách (event delegation) — không gắn lại mỗi lần render */
convsEl.addEventListener("click", (e) => {
  const b = e.target.closest(".conv");
  if (b?.dataset.id) openThread(b.dataset.id);
});

/* Gom nhiều yêu cầu render vào 1 khung hình -> không render dồn dập */
let convRenderPending = false;
function renderConversationsSoon() {
  if (convRenderPending) return;
  convRenderPending = true;
  requestAnimationFrame(() => {
    convRenderPending = false;
    renderConversations();
  });
}

/** Một người vừa online/offline: chỉ đổi đúng chấm trong hàng của họ */
function patchPresenceDom(userId, online) {
  if (!userId) return;
  const row = convsEl.querySelector(`.conv[data-other="${CSS.escape(userId)}"]`);
  if (!row) return;
  const dot = row.querySelector(".dot-online, .dot-off");
  if (dot) dot.className = online ? "dot-online" : "dot-off";
}

async function loadConversations() {
  try {
    const d = socket?.connected ? await rt("conversations:list") : await api("/api/chat/conversations");
    conversations = d.items;
    if (current && !document.hidden) conversations = conversations.map((c) => (c.id === current ? { ...c, unread: 0 } : c));
    sortConversations();
    renderConversations();
  } catch (e) {
    convsEl.innerHTML = `<div class="chat-empty">${esc(e.message)}</div>`;
  }
}

/* ============================================================= Tin nhắn */
function reactionsHtml(m) {
  const rx = (m.reactions || []).reduce((acc, r) => {
    acc[r.key] = acc[r.key] || { url: r.url, n: 0, who: [] };
    acc[r.key].n++;
    acc[r.key].who.push(r.userName || "");
    return acc;
  }, {});
  const keys = Object.keys(rx);
  if (!keys.length) return "";
  return `<div class="reactions" title="${esc(keys.map((k) => rx[k].who.filter(Boolean).join(", ")).join(" · "))}">${keys
    .map((k) => `<img src="${esc(rx[k].url)}" alt="${esc(k)}" />`)
    .join("")}<span>${keys.reduce((s, k) => s + rx[k].n, 0)}</span></div>`;
}

/** Ai đã xem tới tin nhắn nào (kiểu Messenger: avatar nhỏ ở tin cuối họ đã đọc) */
function seenMap() {
  const map = new Map(); // messageId -> [{id,name,avatarUrl}]
  if (!currentConv || !me) return map;
  const readers = (currentConv.members || []).filter((m) => m.id !== me.id);
  for (const r of readers) {
    let target = null;
    for (const m of messages) {
      if (m.type === "system") continue;
      if ((m.readBy || []).includes(r.id)) target = m;
    }
    if (!target) continue;
    if (!map.has(target.id)) map.set(target.id, []);
    map.get(target.id).push(r);
  }
  return map;
}

function seenHtml(list) {
  if (!list?.length) return "";
  const shown = list.slice(0, 5);
  return `<div class="seen-row" title="${esc(list.map((u) => u.name).join(", "))} đã xem">
    ${shown
      .map(
        (u) =>
          `<img class="seen-ava" src="${esc(u.avatarUrl)}" alt="${esc(u.name)}" loading="lazy" data-profile="${esc(u.id)}" />`
      )
      .join("")}
    ${list.length > shown.length ? `<span class="seen-more">+${list.length - shown.length}</span>` : ""}
  </div>`;
}

/* ==========================================================================
   DANH SÁCH TIN NHẮN — dựng DOM tăng dần
   - message:new     -> chỉ thêm 1 node
   - message:update  -> chỉ thay node có data-id đó
   - message:read    -> chỉ vẽ lại hàng "đã xem"
   - toàn bộ thao tác (bấm ảnh, avatar, ⋯, giữ lâu, chuột phải, nháy đúp)
     dùng CHUNG một bộ listener gắn trên #messages (event delegation)
   ========================================================================== */
const PAGE_SIZE = 40;          // số tin tải mỗi lần (mở hội thoại + tải thêm)
let hasMoreMessages = false;   // còn tin cũ trên máy chủ?
let loadingOlder = false;
const KEEP_MAX = 400;          // giữ tối đa ngần này tin trong bộ nhớ/DOM

const atBottom = (slack = 120) =>
  messagesEl.scrollTop + messagesEl.clientHeight > messagesEl.scrollHeight - slack;

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function bubbleHtml(m, mine) {
  if (m.deleted) return `<div class="bubble removed">Tin nhắn đã được thu hồi</div>`;
  if (m.type === "gift") {
    return `<div class="bubble gift"><img src="${esc(m.iconUrl)}" alt="" loading="lazy" decoding="async" />
      <span><b>${esc(m.giftLabel || "Quà tặng")}</b><small>${mine ? "Bạn đã gửi một món quà" : "Đã gửi một món quà"}</small></span></div>`;
  }
  if (m.type === "image") {
    const ratio = m.imageWidth && m.imageHeight ? `${m.imageWidth} / ${m.imageHeight}` : "";
    return `<div class="bubble photo">
      <img class="msg-img" src="${esc(thumbUrl(m.imageUrl))}" alt="Ảnh đã gửi" loading="lazy" decoding="async"
           data-img="${esc(m.imageUrl)}" ${ratio ? `style="aspect-ratio:${ratio}"` : ""} />
      ${m.text ? `<div class="cap">${esc(m.text)}</div>` : ""}
    </div>`;
  }
  if (m.type === "icon") {
    return `<div class="bubble icon-only"><img src="${esc(m.iconUrl)}" alt="${esc(m.giftLabel)}" loading="lazy" decoding="async" /></div>`;
  }
  return `<div class="bubble">${esc(m.text)}</div>`;
}

/** HTML của đúng MỘT tin nhắn (không kèm vạch ngày, không kèm hàng "đã xem") */
function messageHtml(m) {
  const day = dayKey(m.createdAt);
  if (m.type === "system") {
    return `<div class="sys" data-id="${esc(m.id)}" data-day="${esc(day)}">${esc(m.text)} <span>· ${esc(fmtTime(m.createdAt))}</span></div>`;
  }
  const mine = me && m.senderId === me.id;
  const nameTag = !mine && currentConv?.isGroup ? `<div class="sender">${esc(m.senderName)}</div>` : "";
  const editedTag = m.edited && !m.deleted ? ` · <i>đã sửa</i>` : "";
  const dots = m.deleted
    ? ""
    : `<button class="msg-dots" type="button" data-dots="${esc(m.id)}" aria-label="Tuỳ chọn tin nhắn" title="Sửa · Thu hồi">⋯</button>`;

  return `<div class="row ${mine ? "me" : ""}" data-id="${esc(m.id)}" data-day="${esc(day)}">
    <img class="avatar sm click" src="${esc(m.avatarUrl)}" alt="${esc(m.senderName)}" loading="lazy" decoding="async" data-profile="${esc(m.senderId)}" title="Xem trang cá nhân" />
    <div class="bubble-wrap">
      ${nameTag}
      <div class="bubble-line">${bubbleHtml(m, mine)}${dots}</div>
      ${reactionsHtml(m)}
      <div class="meta-time" title="${esc(fmtFull(m.createdAt))}">${esc(fmtTime(m.createdAt))}${editedTag}</div>
    </div>
  </div>`;
}

const daySepHtml = (m) => `<div class="day-sep" data-day="${esc(dayKey(m.createdAt))}">${esc(dayLabel(m.createdAt))}</div>`;

/** HTML của một dãy tin nhắn liên tiếp (tự chèn vạch ngày khi đổi ngày) */
function listHtml(items, prevDay = "") {
  let last = prevDay;
  let out = "";
  for (const m of items) {
    const k = dayKey(m.createdAt);
    if (k !== last) {
      out += daySepHtml(m);
      last = k;
    }
    out += messageHtml(m);
  }
  return out;
}

/** Dựng lại toàn bộ — CHỈ dùng khi mở hội thoại hoặc đổi hội thoại */
function renderMessages(scroll = true) {
  const stick = scroll || atBottom();
  if (!messages.length) {
    messagesEl.innerHTML = `<div class="chat-empty">Chưa có tin nhắn. Gửi lời chào nhé!</div>`;
    return;
  }
  messagesEl.innerHTML =
    (hasMoreMessages ? `<div class="load-more" id="loadMore">Kéo lên để xem tin cũ hơn</div>` : "") +
    listHtml(messages);
  paintSeen();
  if (stick) scrollToBottom();
}

/** Thêm đúng 1 tin vào cuối */
function appendMessageNode(m) {
  const stick = atBottom();
  if (!messagesEl.querySelector(".row, .sys")) return renderMessages(true);

  const lastEl = messagesEl.querySelector(".row:last-of-type, .sys:last-of-type");
  const prevDay = [...messagesEl.querySelectorAll("[data-day]")].pop()?.dataset.day || "";
  messagesEl.insertAdjacentHTML("beforeend", listHtml([m], prevDay));
  void lastEl;
  paintSeen();
  trimOldMessages();
  if (stick || m.senderId === me?.id) scrollToBottom();
}

/** Thay đúng 1 node theo data-id */
function replaceMessageNode(m) {
  const el = messagesEl.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
  if (!el) return;
  const stick = atBottom();
  el.insertAdjacentHTML("beforebegin", messageHtml(m));
  el.remove();
  paintSeen();
  if (stick) scrollToBottom();
}

/** Chèn tin cũ lên đầu, GIỮ NGUYÊN vị trí đang đọc */
function prependMessages(items) {
  if (!items.length) return;
  const beforeH = messagesEl.scrollHeight;
  const beforeTop = messagesEl.scrollTop;

  const firstEl = messagesEl.querySelector(".row, .sys");
  const html = listHtml(items);
  const anchor = messagesEl.querySelector("#loadMore");
  if (anchor) anchor.insertAdjacentHTML("afterend", html);
  else messagesEl.insertAdjacentHTML("afterbegin", html);

  /* Bỏ vạch ngày bị trùng ở chỗ nối */
  if (firstEl) {
    const sep = firstEl.previousElementSibling;
    if (sep?.classList.contains("day-sep") && sep.dataset.day === firstEl.dataset.day) {
      const prevRow = sep.previousElementSibling;
      if (prevRow && prevRow.dataset.day === firstEl.dataset.day) sep.remove();
    }
  }
  paintSeen();
  /* Bù đúng phần chiều cao vừa thêm -> màn hình không nhảy */
  messagesEl.scrollTop = beforeTop + (messagesEl.scrollHeight - beforeH);
}

/** Không giữ hàng nghìn tin trong bộ nhớ: cắt bớt phần cũ khi đang ở cuối */
function trimOldMessages() {
  if (messages.length <= KEEP_MAX || !atBottom(200)) return;
  const drop = messages.length - KEEP_MAX;
  const removed = messages.splice(0, drop);
  for (const m of removed) messagesEl.querySelector(`[data-id="${CSS.escape(m.id)}"]`)?.remove();
  /* Xoá vạch ngày mồ côi ở đầu danh sách */
  while (messagesEl.firstElementChild?.classList.contains("day-sep")) messagesEl.firstElementChild.remove();
  hasMoreMessages = true;
}

/** Vẽ lại các hàng avatar "đã xem" (rất ít node) */
function paintSeen() {
  messagesEl.querySelectorAll(".seen-row").forEach((el) => el.remove());
  const seen = seenMap();
  if (!seen.size) return;
  for (const [id, list] of seen) {
    const wrap = messagesEl.querySelector(`.row[data-id="${CSS.escape(id)}"] .bubble-wrap`);
    if (wrap) wrap.insertAdjacentHTML("beforeend", seenHtml(list));
  }
}

/* ------------------------- Tải thêm tin cũ (cursor) ------------------------- */
async function loadOlderMessages() {
  if (loadingOlder || !hasMoreMessages || !current || !messages.length) return;
  loadingOlder = true;
  const tip = messagesEl.querySelector("#loadMore");
  if (tip) tip.textContent = "Đang tải tin nhắn cũ…";
  const before = messages[0].id;
  const convAtStart = current;
  try {
    const d = socket?.connected
      ? await rt("messages:more", { conversationId: current, before, limit: 40 })
      : await api(`/api/chat/conversations/${current}/messages?limit=40&before=${encodeURIComponent(before)}`);
    if (convAtStart !== current) return;
    const items = (d.items || []).filter((m) => !messages.some((x) => x.id === m.id));
    messages = [...items, ...messages];
    hasMoreMessages = !!d.hasMore;
    prependMessages(items);
    if (!hasMoreMessages) messagesEl.querySelector("#loadMore")?.remove();
    else if (messagesEl.querySelector("#loadMore")) messagesEl.querySelector("#loadMore").textContent = "Kéo lên để xem tin cũ hơn";
  } catch (e) {
    const t2 = messagesEl.querySelector("#loadMore");
    if (t2) t2.textContent = "Không tải được tin cũ, thử lại";
  } finally {
    loadingOlder = false;
  }
}

messagesEl.addEventListener(
  "scroll",
  () => {
    if (messagesEl.scrollTop < 80) loadOlderMessages();
  },
  { passive: true }
);

/* ==================== MỘT bộ listener duy nhất cho mọi tin nhắn ==================== */
let pressTimer = null;
let pressedLong = false;

function clearPress() {
  clearTimeout(pressTimer);
  pressTimer = null;
}

messagesEl.addEventListener("click", (ev) => {
  if (pressedLong) {
    pressedLong = false;
    ev.preventDefault();
    return;
  }
  const dots = ev.target.closest("[data-dots]");
  if (dots) {
    ev.preventDefault();
    ev.stopPropagation();
    return showMsgMenu(dots.dataset.dots, dots);
  }
  const img = ev.target.closest("[data-img]");
  if (img) {
    ev.stopPropagation();
    const list = messages.filter((m) => m.type === "image" && m.imageUrl && !m.deleted).map((m) => m.imageUrl);
    return openLightbox(list, Math.max(0, list.indexOf(img.dataset.img)));
  }
  const prof = ev.target.closest("[data-profile]");
  if (prof) {
    ev.stopPropagation();
    return openProfile(prof.dataset.profile);
  }
});

/* Máy tính: chuột phải hoặc nháy đúp = thả cảm xúc (giữ nguyên như cũ) */
const reactFromEvent = (ev) => {
  const bubble = ev.target.closest(".bubble");
  const row = bubble?.closest(".row");
  if (!bubble || !row) return;
  ev.preventDefault();
  showReactPop(row.dataset.id, bubble);
};
messagesEl.addEventListener("contextmenu", reactFromEvent);
messagesEl.addEventListener("dblclick", reactFromEvent);

/* Điện thoại + chuột: GIỮ ~420ms = thả cảm xúc */
messagesEl.addEventListener(
  "pointerdown",
  (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    const bubble = ev.target.closest(".bubble");
    const row = bubble?.closest(".row");
    if (!bubble || !row) return;
    pressedLong = false;
    clearPress();
    pressTimer = setTimeout(() => {
      pressedLong = true;
      if (ev.pointerType !== "mouse" && navigator.vibrate) navigator.vibrate(12);
      showReactPop(row.dataset.id, bubble);
    }, 420);
  },
  { passive: true }
);
["pointerup", "pointercancel", "pointerleave", "pointermove"].forEach((e) =>
  messagesEl.addEventListener(e, clearPress, { passive: true })
);

/* -------------------------------------------- Menu tin nhắn (sửa / xoá) */
function placeFloating(el, anchor) {
  el.hidden = false;
  const b = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, b.left))}px`;
  el.style.top = `${Math.max(8, b.top - h - 8)}px`;
}

function showMsgMenu(messageId, anchor) {
  const m = messages.find((x) => x.id === messageId);
  if (!m || m.deleted) return;
  const mine = m.senderId === me?.id;
  const readOnly = currentConv?.canPost === false;
  const canDelete = !readOnly && (mine || (currentConv?.isGroup && currentConv?.isAdmin));
  const items = [
    ...(mine && !readOnly && m.type === "text" ? [{ act: "edit", label: "✏️ Sửa tin nhắn" }] : []),
    ...(m.type === "text" ? [{ act: "copy", label: "📋 Sao chép" }] : []),
    ...(canDelete ? [{ act: "delete", label: mine ? "↩️ Thu hồi tin nhắn" : "🗑️ Xoá tin nhắn này", danger: true }] : []),
  ];

  msgMenu.innerHTML = items
    .map((i) => `<button type="button" class="${i.danger ? "danger" : ""}" data-act="${i.act}">${i.label}</button>`)
    .join("");
  placeFloating(msgMenu, anchor);

  msgMenu.querySelectorAll("button").forEach((btn) =>
    btn.addEventListener("click", async () => {
      msgMenu.hidden = true;
      const act = btn.dataset.act;

      if (act === "copy") {
        try {
          await navigator.clipboard.writeText(m.text);
          toast("Đã sao chép");
        } catch {
          toast("Không sao chép được", true);
        }
        return;
      }
      if (act === "edit") return startEdit(m);
      if (act === "delete") {
        if (!confirm("Thu hồi tin nhắn này?")) return;
        try {
          await rt("message:delete", { messageId });
        } catch (e) {
          try {
            await api(`/api/chat/messages/${messageId}`, { method: "DELETE" });
          } catch (e2) {
            toast(e2.message, true);
          }
        }
      }
    })
  );
}

let reactPopOpenedAt = 0;

function showReactPop(messageId, anchor) {
  reactPop.dataset.messageId = messageId;
  reactPop.innerHTML = ASSETS.reactions
    .map((r) => `<button type="button" data-key="${esc(r.key)}" title="${esc(r.label)}"><img src="${esc(r.url)}" alt="${esc(r.label)}" /></button>`)
    .join("");
  placeFloating(reactPop, anchor);
  reactPopOpenedAt = Date.now();
  reactPop.querySelectorAll("button").forEach((btn) =>
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      /* Giữ bảng cảm xúc mở: chỉ đóng khi bấm ra vùng trắng bên ngoài */
      try {
        await rt("message:react", { messageId, key: btn.dataset.key });
      } catch {
        try {
          await post(`/api/chat/messages/${messageId}/reaction`, { key: btn.dataset.key });
        } catch (e) {
          toast(e.message, true);
        }
      }
    })
  );
}

document.addEventListener("click", (e) => {
  if (!reactPop.hidden && !reactPop.contains(e.target) && Date.now() - reactPopOpenedAt > 300) reactPop.hidden = true;
  if (!msgMenu.hidden && !msgMenu.contains(e.target)) msgMenu.hidden = true;
});


function startEdit(m) {
  editingId = m.id;
  const input = $("#input");
  input.value = m.text;
  input.focus();
  $("#editHint").hidden = false;
}
function cancelEdit() {
  editingId = null;
  $("#input").value = "";
  $("#editHint").hidden = true;
}
$("#editCancel").addEventListener("click", cancelEdit);

/* ============================================================ Mở thread */
function paintTyping() {
  const map = typingUsers.get(current);
  const names = map ? [...map.values()].map((v) => v.name) : [];
  $("#typing").hidden = !names.length;
  $("#typingWho").textContent = names.length ? `${names.join(", ")} đang nhập…` : "";
}

function threadPeerId() {
  const c = currentConv;
  if (!c || c.isGroup) return "";
  return c.otherId || (c.members || []).map((m) => m.id).find((id) => id !== me?.id) || "";
}

/* Nhóm thông báo: ẩn ô soạn tin, chỉ cho xem + thả cảm xúc */
function applyComposerLock() {
  const locked = !!currentConv && currentConv.canPost === false;
  const composer = $("#composer");
  const note = $("#lockedNote");
  if (note) {
    note.textContent = currentConv?.adminDirect
      ? "🔒 Tài khoản quản trị không nhận tin nhắn riêng — Vui lòng nhắn tin riêng với người khác hoặc tạo nhóm mới để trò chuyện nhé."
      : "🔒 Chỉ quản trị viên được đăng tin trong nhóm này — Vui lòng nhắn tin riêng hoặc tạo nhóm mới để trò chuyện nhé.";
  }
  if (composer) composer.hidden = locked;
  if (note) note.hidden = !locked;
  const fbBar = document.querySelector(".fb-bar");
  if (fbBar) fbBar.hidden = locked;
  if (locked) {
    $("#giftTray").hidden = true;
    $("#emojiTray").hidden = true;
    cancelEdit();
  }
}

function paintThreadHeader() {
  if (!currentConv) return;
  $("#thAvatar").src = currentConv.avatarUrl || "";
  $("#thTitle").textContent = currentConv.title || "—";
  $("#thDot").hidden = currentConv.isGroup || !currentConv.online;
  applyComposerLock();
  $("#thState").textContent = currentConv.adminDirect
    ? "Tài khoản quản trị · không nhận tin nhắn riêng"
    : currentConv.announcement
      ? "Nhóm thông báo · chỉ quản trị viên đăng tin"
      : currentConv.isGroup
        ? `${currentConv.memberCount} thành viên · ${currentConv.members.map((m) => m.name).join(", ")}`
        : currentConv.online
          ? "Đang hoạt động"
          : currentConv.lastSeen
            ? `Hoạt động ${shortWhen(currentConv.lastSeen)} trước`
            : "Ngoại tuyến";
}

/* Xoa dam ngay tren giao dien (khong doi server phan hoi) */
function clearUnreadLocal(id) {
  if (!id) return;
  let changed = false;
  conversations = conversations.map((c) => {
    if (c.id === id && (c.unread || 0) !== 0) {
      changed = true;
      return { ...c, unread: 0 };
    }
    return c;
  });
  if (currentConv && currentConv.id === id) currentConv = { ...currentConv, unread: 0 };
  if (changed) renderConversations();
}

async function markReadNow() {
  const id = current;
  clearUnreadLocal(id);
  try {
    await rt("conversation:read", { conversationId: id });
  } catch {
    try {
      await post(`/api/chat/conversations/${id}/read`);
    } catch { }
  }
  clearUnreadLocal(id);
}

async function openThread(id, silent = false) {
  current = id;
  currentConv = conversations.find((x) => x.id === id) || null;
  clearUnreadLocal(id);
  paintThreadHeader();
  phone.classList.add("open");
  $("#paneThread").setAttribute("aria-hidden", "false");
  cancelEdit();
  if (!silent) messagesEl.innerHTML = `<div class="skel-row"></div><div class="skel-row" style="opacity:.6"></div>`;

  try {
    /* Chỉ tải 40 tin mới nhất; tin cũ tải thêm khi kéo lên đầu */
    const d = socket?.connected
      ? await rt("conversation:open", { conversationId: id, limit: PAGE_SIZE })
      : await api(`/api/chat/conversations/${id}/messages?limit=${PAGE_SIZE}`);
    if (current !== id) return;
    currentConv = d.conversation || currentConv;
    messages = d.items || [];
    hasMoreMessages = !!d.hasMore;
    loadingOlder = false;
    paintThreadHeader();
    renderMessages();
    paintTyping();
    await markReadNow();
  } catch (e) {
    messagesEl.innerHTML = `<div class="chat-empty">${esc(e.message)}</div>`;
  }
}

function closeThread() {
  phone.classList.remove("open");
  $("#paneThread").setAttribute("aria-hidden", "true");
  current = null;
  currentConv = null;
  messages = [];
  hasMoreMessages = false;
  messagesEl.innerHTML = "";     /* giải phóng node DOM cũ */
  renderConversations();
}
/* Bam avatar / ten o dau khung chat 1-1 -> xem trang ca nhan (online hay offline deu duoc) */
["#thAvatar", "#thTitle"].forEach((sel) =>
  $(sel).addEventListener("click", () => {
    const id = threadPeerId();
    if (id) openProfile(id);
  })
);

$("#backBtn").addEventListener("click", closeThread);
let searchTimer = null;
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderConversations, 200);
});

/* ============================================================ Gửi tin */
async function send(payload) {
  if (!current) return;
  if (currentConv?.canPost === false) {
    toast("Chỉ quản trị viên được đăng tin. Vui lòng nhắn tin riêng hoặc tạo nhóm mới nhé.", true);
    return;
  }
  try {
    await rt("message:send", { ...payload, conversationId: current });
  } catch {
    try {
      const saved = await post(`/api/chat/conversations/${current}/messages`, payload);
      if (!messages.some((m) => m.id === saved.id)) {
        messages.push(saved);
        appendMessageNode(saved);
      }
    } catch (e) {
      toast(e.message, true);
    }
  }
}

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#input");
  const text = input.value.trim();
  if (!text) return;
  if (editingId) {
    const messageId = editingId;
    cancelEdit();
    try {
      await rt("message:edit", { messageId, text });
    } catch {
      try {
        await api(`/api/chat/messages/${messageId}`, { method: "PATCH", body: JSON.stringify({ text }) });
      } catch (e2) {
        toast(e2.message, true);
      }
    }
    return;
  }
  input.value = "";
  sendTyping(false);
  send({ type: "text", text });
});

let typingTimer = null;
let lastTypingSent = 0;
let typingOn = false;
function sendTyping(on) {
  if (!socket?.connected || !current) return;
  /* Chống spam: chỉ báo "đang gõ" tối đa 1 lần / 1,2 giây */
  if (on && typingOn && Date.now() - lastTypingSent < 1200) return;
  if (!on && !typingOn) return;
  typingOn = on;
  lastTypingSent = Date.now();
  socket.emit("typing", { conversationId: current, typing: on });
}
$("#input").addEventListener("input", () => {
  sendTyping(true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => sendTyping(false), 1800);
});

$("#giftBtn").addEventListener("click", () => {
  $("#emojiTray").hidden = true;
  $("#giftTray").hidden = !$("#giftTray").hidden;
});
$("#emojiBtn").addEventListener("click", () => {
  $("#giftTray").hidden = true;
  $("#emojiTray").hidden = !$("#emojiTray").hidden;
});

/* ============================================ Sheet tạo nhóm / nhắn riêng */
function renderUsers() {
  const q = ($("#userSearch").value || "").trim().toLowerCase();
  const list = users.filter((u) => !q || u.name.toLowerCase().includes(q));
  if (!list.length) {
    $("#userList").innerHTML = `<div class="chat-empty sm">Không có người dùng phù hợp.</div>`;
    return;
  }
  $("#userList").innerHTML = list
    .map(
      (u) => `<button class="user ${selected.has(u.id) ? "on" : ""}" data-id="${esc(u.id)}" type="button">
      <span class="avatar-wrap click" data-profile="${esc(u.id)}" title="Xem trang cá nhân"><img class="avatar sm" src="${esc(u.avatarUrl)}" alt="" />${u.online ? '<i class="dot-online"></i>' : '<i class="dot-off"></i>'}</span>
      <span class="u-name">${esc(u.name)}<small>${u.online ? "Đang hoạt động" : u.lastSeen ? `Hoạt động ${shortWhen(u.lastSeen)} trước` : "Ngoại tuyến"}</small></span>
      <span class="tick">${selected.has(u.id) ? "✓" : ""}</span>
    </button>`
    )
    .join("");
}

/* Gắn MỘT lần cho cả danh sách người dùng */
$("#userList").addEventListener("click", (e) => {
  const prof = e.target.closest("[data-profile]");
  if (prof) {
    e.stopPropagation();
    return openProfile(prof.dataset.profile);
  }
  const b = e.target.closest(".user");
  if (!b) return;
  const id = b.dataset.id;
  if (sheetMode === "direct") selected = new Set([id]);
  else if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  renderUsersSoon();
});

let userRenderPending = false;
function renderUsersSoon() {
  if (userRenderPending) return;
  userRenderPending = true;
  requestAnimationFrame(() => {
    userRenderPending = false;
    renderUsers();
  });
}

let userExclude = new Set();
async function fetchUsers(excludeIds = []) {
  userExclude = new Set(excludeIds.map(String));
  return await refetchUsers("");
}

/** Tìm người dùng ngay trên máy chủ (giới hạn 100) — không tải toàn bộ user */
async function refetchUsers(q = "") {
  const d = await api(`/api/chat/users?limit=100${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  users = d.items.filter((u) => !userExclude.has(u.id));
  renderUsers();
}

function openSheetShell(title, submitLabel) {
  $("#sheetTitle").textContent = title;
  $("#sheetSubmit").textContent = submitLabel;
  $("#sheetWrap").hidden = false;
  requestAnimationFrame(() => $("#sheetWrap").classList.add("show"));
}

async function openSheet(mode) {
  sheetMode = mode;
  selected = new Set();
  pickedGroupAvatar = "";
  $("#groupNameField").hidden = mode !== "group";
  $("#groupAvaPick").hidden = mode !== "group";
  $("#groupName").value = "";
  $("#userSearch").value = "";
  openSheetShell(mode === "group" ? "Tạo nhóm mới" : "Nhắn riêng", mode === "group" ? "Tạo nhóm" : "Mở trò chuyện");
  if (mode === "group") renderGroupAvatars();
  $("#userList").innerHTML = `<div class="skel-row"></div>`;
  try {
    await fetchUsers();
  } catch (e) {
    $("#userList").innerHTML = `<div class="chat-empty sm">${esc(e.message)}</div>`;
  }
}

function renderGroupAvatars() {
  const box = $("#groupAvaPick");
  box.innerHTML = ASSETS.groupAvatars
    .map((a) => `<button type="button" data-url="${esc(a.url)}" class="${pickedGroupAvatar === a.url ? "on" : ""}"><img src="${esc(a.url)}" alt="" loading="lazy" /></button>`)
    .join("");
  box.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      pickedGroupAvatar = b.dataset.url;
      renderGroupAvatars();
    })
  );
}

function closeSheet() {
  $("#sheetWrap").classList.remove("show");
  setTimeout(() => ($("#sheetWrap").hidden = true), 220);
}
$("#newBtn").addEventListener("click", () => openSheet("group"));
$("#quickGroup").addEventListener("click", () => openSheet("group"));
$("#quickDirect").addEventListener("click", () => openSheet("direct"));
$("#sheetClose").addEventListener("click", closeSheet);
$("#sheetWrap").addEventListener("click", (e) => {
  if (e.target === $("#sheetWrap")) closeSheet();
});
let userSearchTimer = null;
$("#userSearch").addEventListener("input", () => {
  renderUsersSoon();                       /* lọc ngay trong danh sách đang có */
  clearTimeout(userSearchTimer);           /* rồi hỏi máy chủ sau 250ms */
  userSearchTimer = setTimeout(() => {
    refetchUsers(($("#userSearch").value || "").trim()).catch(() => { });
  }, 250);
});

async function callAction(event, restCall, payload) {
  try {
    return await rt(event, payload);
  } catch {
    return await restCall();
  }
}

$("#sheetSubmit").addEventListener("click", async () => {
  const memberIds = [...selected];
  try {
    if (sheetMode === "add") {
      if (!memberIds.length) return toast("Chọn ít nhất 1 người", true);
      await callAction(
        "conversation:members:add",
        () => post(`/api/chat/conversations/${current}/members`, { memberIds }),
        { conversationId: current, memberIds }
      );
      closeSheet();
      toast("Đã thêm thành viên");
      return;
    }
    if (!memberIds.length) return toast("Chọn ít nhất 1 người", true);
    if (sheetMode === "group") {
      const title = $("#groupName").value.trim();
      if (title.length < 2) return toast("Nhập tên nhóm", true);
      const d = await callAction(
        "conversation:create",
        () => post("/api/chat/conversations", { isGroup: true, title, memberIds, avatarUrl: pickedGroupAvatar }),
        { isGroup: true, title, memberIds, avatarUrl: pickedGroupAvatar }
      );
      closeSheet();
      await loadConversations();
      openThread(d.id);
      toast("Đã tạo nhóm thành công");
    } else {
      const d = await callAction(
        "conversation:create",
        () => post("/api/chat/conversations", { isGroup: false, memberIds }),
        { isGroup: false, memberIds }
      );
      closeSheet();
      await loadConversations();
      openThread(d.id);
    }
  } catch (e) {
    toast(e.message, true);
  }
});

/* ================================================= Quản lý hội thoại/nhóm */
function closeInfo() {
  $("#infoWrap").classList.remove("show");
  setTimeout(() => ($("#infoWrap").hidden = true), 220);
}
$("#infoClose").addEventListener("click", closeInfo);
$("#infoWrap").addEventListener("click", (e) => {
  if (e.target === $("#infoWrap")) closeInfo();
});

$("#infoBtn").addEventListener("click", () => {
  if (!currentConv) return;
  const c = currentConv;
  $("#infoTitle").textContent = c.isGroup ? "Quản lý nhóm" : "Cuộc trò chuyện";
  $("#infoBody").innerHTML = `
    <div class="info-head">
      <img class="avatar" src="${esc(c.avatarUrl)}" alt="" />
      <div><b>${esc(c.title)}</b><small>${c.isGroup ? `${c.memberCount} thành viên` : c.online ? "Đang hoạt động" : "Ngoại tuyến"}</small></div>
    </div>
    ${c.announcement && !c.isAdmin
      ? `<p class="auth-sub">Nhóm thông báo chung do quản trị viên quản lý. Bạn chỉ có thể xem và thả cảm xúc — vui lòng nhắn tin riêng hoặc tạo nhóm mới để trò chuyện nhé.</p>
           <div class="member-list" id="memberList"></div>`
      : c.isGroup
        ? `<label class="field"><span>Tên nhóm</span><input id="infoName" maxlength="40" value="${esc(c.title)}" /></label>
           <div class="ava-pick" id="infoAvaPick"></div>
           <div class="row-btns">
             <button class="btn-primary" id="saveGroup" type="button">Lưu thay đổi</button>
             <button class="quick" id="addMemberBtn2" type="button">Thêm thành viên</button>
           </div>
           <div class="member-list" id="memberList"></div>
           <div class="row-btns">
             ${c.announcement ? "" : `<button class="quick danger" id="leaveGroup" type="button">Rời nhóm</button>`}
             ${c.isAdmin && !c.announcement ? `<button class="quick danger" id="deleteConv" type="button">Xoá nhóm</button>` : ""}
           </div>`
        : `<div class="row-btns"><button class="quick danger" id="deleteConv" type="button">Xoá cuộc trò chuyện</button></div>`
    }`;
  $("#infoWrap").hidden = false;
  requestAnimationFrame(() => $("#infoWrap").classList.add("show"));

  if (c.isGroup) {
    let pickedAva = "";
    const box = $("#infoAvaPick");
    const paint = () => {
      if (!box) return;
      box.innerHTML = ASSETS.groupAvatars
        .map((a) => `<button type="button" data-url="${esc(a.url)}" class="${pickedAva === a.url ? "on" : ""}"><img src="${esc(a.url)}" alt="" loading="lazy" /></button>`)
        .join("");
      box.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", () => {
          pickedAva = b.dataset.url;
          paint();
        })
      );
    };
    paint();

    $("#memberList").innerHTML = c.members
      .map(
        (m) => `<div class="member">
          <span class="avatar-wrap click" data-profile="${esc(m.id)}" title="Xem trang cá nhân"><img class="avatar sm" src="${esc(m.avatarUrl)}" alt="" />${m.online ? '<i class="dot-online"></i>' : '<i class="dot-off"></i>'}</span>
          <span class="u-name click" data-profile="${esc(m.id)}">${esc(m.name)}${m.id === me?.id ? " (bạn)" : ""}<small>${c.admins.includes(m.id) ? "Quản trị nhóm" : m.online ? "Đang hoạt động" : "Ngoại tuyến"}</small></span>
          ${c.isAdmin && m.id !== me?.id ? `<button class="kick" data-id="${esc(m.id)}" type="button" title="Xoá khỏi nhóm">✕</button>` : ""}
        </div>`
      )
      .join("");

    $("#memberList")
      .querySelectorAll("[data-profile]")
      .forEach((el) =>
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          openProfile(el.dataset.profile);
        })
      );

    $("#memberList")
      .querySelectorAll(".kick")
      .forEach((b) =>
        b.addEventListener("click", async () => {
          if (!confirm("Xoá thành viên này khỏi nhóm?")) return;
          try {
            await callAction(
              "conversation:member:remove",
              () => api(`/api/chat/conversations/${c.id}/members/${b.dataset.id}`, { method: "DELETE" }),
              { conversationId: c.id, userId: b.dataset.id }
            );
            closeInfo();
            toast("Đã xoá thành viên");
          } catch (e) {
            toast(e.message, true);
          }
        })
      );

    $("#saveGroup")?.addEventListener("click", async () => {
      const title = ($("#infoName")?.value || "").trim();
      try {
        await callAction(
          "conversation:update",
          () => api(`/api/chat/conversations/${c.id}`, { method: "PATCH", body: JSON.stringify({ title, avatarUrl: pickedAva }) }),
          { conversationId: c.id, title, ...(pickedAva ? { avatarUrl: pickedAva } : {}) }
        );
        closeInfo();
        toast("Đã cập nhật nhóm");
      } catch (e) {
        toast(e.message, true);
      }
    });

    $("#addMemberBtn2")?.addEventListener("click", async () => {
      closeInfo();
      sheetMode = "add";
      selected = new Set();
      $("#groupNameField").hidden = true;
      $("#groupAvaPick").hidden = true;
      $("#userSearch").value = "";
      openSheetShell("Thêm thành viên", "Thêm vào nhóm");
      try {
        await fetchUsers(c.members.map((m) => m.id));
      } catch (e) {
        toast(e.message, true);
      }
    });

    $("#leaveGroup")?.addEventListener("click", async () => {
      if (!confirm("Rời khỏi nhóm này?")) return;
      try {
        await callAction("conversation:leave", () => post(`/api/chat/conversations/${c.id}/leave`), { conversationId: c.id });
        closeInfo();
        closeThread();
        toast("Đã rời nhóm");
      } catch (e) {
        toast(e.message, true);
      }
    });
  }

  const del = $("#deleteConv");
  if (del)
    del.addEventListener("click", async () => {
      if (!confirm("Xoá vĩnh viễn cuộc trò chuyện này (cả tin nhắn)?")) return;
      try {
        await callAction("conversation:delete", () => api(`/api/chat/conversations/${c.id}`, { method: "DELETE" }), {
          conversationId: c.id,
        });
        closeInfo();
        closeThread();
        toast("Đã xoá cuộc trò chuyện");
      } catch (e) {
        toast(e.message, true);
      }
    });
});

/* ============================================== TRANG CÁ NHÂN (profile) */
let profileUser = null;

function ageFrom(birthday) {
  if (!birthday) return "";
  const d = new Date(birthday);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const before = now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate());
  if (before) a--;
  return a >= 0 && a < 130 ? `${a} tuổi` : "";
}
function isBirthdayToday(b) {
  if (!b) return false;
  const d = new Date(b);
  const n = new Date();
  return !Number.isNaN(d.getTime()) && d.getDate() === n.getDate() && d.getMonth() === n.getMonth();
}

function closeProfile() {
  stopMusic();
  $("#profileWrap").classList.remove("show");
  setTimeout(() => ($("#profileWrap").hidden = true), 220);
}
$("#profileClose").addEventListener("click", closeProfile);
$("#profileWrap").addEventListener("click", (e) => {
  if (e.target === $("#profileWrap")) closeProfile();
});

async function openProfile(userId) {
  if (!userId || !me) return;
  msgMenu.hidden = true;
  reactPop.hidden = true;
  $("#profileWrap").hidden = false;
  requestAnimationFrame(() => $("#profileWrap").classList.add("show"));
  $("#profileBody").innerHTML = `<div class="skel-row"></div><div class="skel-row" style="opacity:.6"></div>`;
  /* Xem duoc trang ca nhan du nguoi do dang online hay offline:
     uu tien realtime, neu loi/mat ket noi thi goi API thuong. */
  try {
    let d = null;
    if (socket?.connected) {
      try {
        d = await rt("user:profile", { userId });
      } catch {
        d = null;
      }
    }
    if (!d) d = await api(`/api/chat/users/${userId}/profile`);
    profileUser = d.user;
    paintProfile(d);
  } catch (e) {
    $("#profileBody").innerHTML = `<div class="chat-empty sm">${esc(e.message)}</div>`;
  }
}

function labelOr(v) {
  const t = (v ?? "").toString().trim();
  return t ? esc(t) : '<span class="empty">Không có</span>';
}

function row(ic, label, value, extra = "") {
  const t = (value ?? "").toString().trim();
  return `<div class="prof-row"><span class="ic">${ic}</span><div>
    <small>${esc(label)}</small>
    <p${t ? "" : ' class="empty"'}>${t ? esc(t) : "Không có"}</p>${extra}
  </div></div>`;
}

function fullAddress(u) {
  return [u.addressLine, u.ward, u.district, u.province].map((x) => (x || "").trim()).filter(Boolean).join(", ");
}

function timeAgo(v) {
  if (!v) return "";
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "vài giây trước";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} ngày trước`;
  return new Date(t).toLocaleDateString("vi-VN");
}

function fmtBirthday(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const age = Math.floor((Date.now() - d.getTime()) / 31557600000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}${age >= 0 && age < 130 ? ` · ${age} tuổi` : ""
    }`;
}

const GENDERS = { male: "Nam", female: "Nữ", other: "Khác" };
const RELATIONS = { single: "Độc thân", dating: "Đang hẹn hò", married: "Đã kết hôn", secret: "Chỉ là lốp dự phòng 😔" };


/* ------------------------------------------- Nhạc trang cá nhân (đĩa quay) */
let musicAudio = null;      // thẻ <audio> dùng chung
let musicPlayingFor = "";   // id người đang phát nhạc

function musicSrc(m) {
  if (!m?.url) return "";
  return m.proxy ? `/api/chat/media/audio?src=${encodeURIComponent(m.url)}` : m.url;
}

/* Ảnh cho đĩa quay: LẤY MỘT ẢNH BẤT KỲ (ảnh bìa video / ảnh trong album),
   KHÔNG dùng ảnh đại diện của tài khoản. */
function musicCoverSrc(m, u) {
  const pool = []
    .concat(Array.isArray(m?.covers) ? m.covers : [])
    .concat(m?.cover ? [m.cover] : [])
    .filter(Boolean);
  let pick = pool.length ? pool[Math.floor(Math.random() * pool.length)] : "";

  if (!pick) {
    const photos = (u?.photos || []).filter((p) => p && p !== u.avatarUrl);
    if (photos.length) pick = photos[Math.floor(Math.random() * photos.length)];
  }
  if (!pick) return "";
  return m?.coverProxy || /tiktokcdn|tiktokv|tikwm/i.test(pick)
    ? `/api/chat/media/cover?src=${encodeURIComponent(pick)}`
    : pick;
}

function stopMusic() {
  if (musicAudio) {
    musicAudio.pause();
    musicAudio.currentTime = 0;
  }
  musicPlayingFor = "";
  document.querySelectorAll(".music-disc").forEach((d) => d.classList.remove("playing"));
  const ic = $("#musicPlayIcon");
  if (ic) ic.textContent = "▶";
}

function musicSectionHtml(u, mine) {
  const m = u.music;
  const cover = musicCoverSrc(m, u);
  const player = m
    ? `<div class="prof-music">
        <div class="music-disc${cover ? "" : " no-cover"}" id="musicDisc" role="button" tabindex="0" aria-label="Phát hoặc dừng nhạc">
          ${cover ? `<img src="${esc(cover)}" alt="Ảnh bìa bản nhạc" loading="lazy" referrerpolicy="no-referrer" />` : `<span class="disc-art" aria-hidden="true"></span>`}
          <span class="music-play" id="musicPlayIcon">▶</span>
        </div>
        <div class="music-meta">
          <b>${esc(m.title || "Nhạc cá nhân")}</b>
          <small>${esc(m.author || (m.source === "tiktok" ? "Âm thanh TikTok" : "Nhạc từ máy"))}</small>
          ${mine
      ? `<div class="music-actions">
                  <button class="btn-ghost" id="musicEditBtn" type="button">Đổi nhạc</button>
                  <button class="btn-ghost" id="musicDelBtn" type="button">Gỡ nhạc</button>
                </div>`
      : ""}
        </div>
      </div>`
    : mine
      ? `<div class="music-actions"><button class="btn-ghost" id="musicAddBtn" type="button">＋ Thêm nhạc</button></div>`
      : `<p class="hint-sm">Chưa có nhạc.</p>`;

  const panel = mine
    ? `<div class="music-panel" id="musicPanel" hidden>
        <label class="field"><span>Dán link TikTok</span>
          <input id="musicLink" type="text" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false"
                 placeholder="vt.tiktok.com/... hoặc tiktok.com/@user/video/..." />
        </label>
        <p class="hint-sm">Dán được cả link sao chép trên điện thoại (vt.tiktok.com/…) lẫn trên máy tính (có ?is_from_webapp=1…), kể cả khi dính chữ xung quanh.</p>
        <button class="btn-primary" id="musicSaveBtn" type="button">Lấy nhạc & lưu</button>
        <button class="btn-ghost" id="musicFileBtn" type="button">Hoặc chọn nhạc từ máy</button>
        <p class="hint-sm">Mẹo: nếu link TikTok không lấy được tiếng, bạn có thể chọn tệp nhạc trong máy (mp3, m4a…).</p>
      </div>`
    : "";

  return player + panel;
}

function bindMusicSection(u, mine) {
  stopMusic();
  const disc = $("#musicDisc");
  const m = u.music;

  if (disc && m?.url) {
    const toggle = () => {
      if (!musicAudio) {
        musicAudio = new Audio();
        musicAudio.preload = "none";
        musicAudio.loop = true;
        musicAudio.addEventListener("error", () => {
          stopMusic();
          toast("Không phát được bản nhạc này", true);
        });
      }
      if (musicPlayingFor === u.id && !musicAudio.paused) {
        stopMusic();
        return;
      }
      musicAudio.src = musicSrc(m);
      musicAudio
        .play()
        .then(() => {
          musicPlayingFor = u.id;
          disc.classList.add("playing");
          const ic = $("#musicPlayIcon");
          if (ic) ic.textContent = "❚❚";
        })
        .catch(() => toast("Không phát được bản nhạc này", true));
    };
    disc.addEventListener("click", toggle);
    disc.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
  }

  if (!mine) return;

  const panel = $("#musicPanel");
  const openPanel = () => {
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) $("#musicLink")?.focus();
  };
  $("#musicAddBtn")?.addEventListener("click", openPanel);
  $("#musicEditBtn")?.addEventListener("click", openPanel);

  $("#musicSaveBtn")?.addEventListener("click", async () => {
    const link = ($("#musicLink")?.value || "").trim();
    if (!link) return toast("Hãy dán link TikTok", true);
    if (!/tiktok\.com/i.test(link)) return toast("Chưa thấy link TikTok trong nội dung bạn dán", true);
    const btn = $("#musicSaveBtn");
    btn.disabled = true;
    btn.textContent = "Đang lấy nhạc…";
    try {
      await api("/api/chat/me/music", { method: "POST", body: JSON.stringify({ tiktokUrl: link }) });
      toast("Đã lưu nhạc");
      stopMusic();
      openProfile(me.id);
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
      btn.textContent = "Lấy nhạc & lưu";
    }
  });

  $("#musicFileBtn")?.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 9 * 1024 * 1024) return toast("Tệp nhạc tối đa 9MB", true);
      toast("Đang tải nhạc lên…");
      try {
        const dataUrl = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = () => rej(new Error("Không đọc được tệp"));
          fr.readAsDataURL(file);
        });
        await api("/api/chat/me/music", {
          method: "POST",
          body: JSON.stringify({ dataUrl, filename: file.name }),
        });
        toast("Đã lưu nhạc");
        stopMusic();
        openProfile(me.id);
      } catch (e) {
        toast(e.message, true);
      }
    };
    input.click();
  });

  $("#musicDelBtn")?.addEventListener("click", async () => {
    if (!confirm("Gỡ nhạc khỏi trang cá nhân?")) return;
    try {
      await api("/api/chat/me/music", { method: "DELETE" });
      stopMusic();
      toast("Đã gỡ nhạc");
      openProfile(me.id);
    } catch (e) {
      toast(e.message, true);
    }
  });
}

function paintProfile(d) {
  const u = d.user || {};
  const mine = u.id === me?.id;
  const photos = Array.isArray(u.photos) ? u.photos : [];
  const hobbies = Array.isArray(u.hobbies) ? u.hobbies.filter(Boolean) : [];

  $("#profileTitle").textContent = mine ? "Trang cá nhân của tôi" : `Trang cá nhân · ${u.name || ""}`;

  $("#profileBody").innerHTML = `
    <div class="prof-head">
      <img class="avatar lg" id="profAvatar" src="${esc(u.avatarUrl || "")}" alt="Ảnh đại diện của ${esc(u.name || "")}" />
      <b>${esc(u.name || "")}</b>
      <small>${u.online ? "Đang hoạt động" : u.lastSeen ? `Hoạt động ${timeAgo(u.lastSeen)}` : "Không rõ"}</small>
      <small>Tham gia ${u.createdAt ? new Date(u.createdAt).toLocaleDateString("vi-VN") : "—"}</small>
      ${mine ? `<button class="btn-ghost" id="profAvaBtn" type="button">Đổi ảnh đại diện</button>` : ""}
    </div>

    <div class="prof-sec">Nhạc cá nhân</div>
    ${musicSectionHtml(u, mine)}

    <div class="prof-sec">Thông tin cá nhân</div>
    <div class="prof-rows">
      ${row("🎂", "Ngày tháng năm sinh", fmtBirthday(u.birthday))}
      ${row("⚧", "Giới tính", GENDERS[u.gender] || "")}
      ${row("💞", "Tình trạng quan hệ", RELATIONS[u.relationship] || "")}
      ${row("📍", "Nơi sống", fullAddress(u))}
      ${row("💼", "Công việc", u.job)}
      ${row("🎓", "Học tại", u.school)}
      ${row("📞", "Số điện thoại", mine ? u.phone : u.phone ? "Chỉ chủ tài khoản xem được" : "")}
      ${row("✨", "Sở thích", hobbies.join(", "))}
      ${row("📝", "Ghi chú bản thân", u.note)}
      ${row("💬", "Giới thiệu", u.bio)}
    </div>

    <div class="prof-sec">Album ảnh (${photos.length})</div>
    <div class="photo-grid" id="profPhotos">
      ${photos
      .map(
        (url, k) => `<div class="photo-cell">
            <img src="${esc(thumbUrl(url))}" alt="Ảnh ${k + 1} của ${esc(u.name || "")}" loading="lazy" data-photo="${esc(url)}" />
            ${mine ? `<button class="photo-del" type="button" data-del="${esc(url)}" aria-label="Xoá ảnh">✕</button>` : ""}
          </div>`
      )
      .join("")}
      ${mine ? `<div class="photo-add" id="photoAdd" role="button" tabindex="0" title="Thêm ảnh">＋</div>` : ""}
    </div>
    ${!photos.length && !mine ? `<p class="hint-sm">Không có ảnh nào.</p>` : ""}

    ${mine
      ? `<form class="prof-form" id="profForm">
            <div class="prof-sec">Sửa thông tin</div>
            <div class="grid-2">
              <label class="field"><span>Ngày sinh</span><input type="date" id="pfBirthday" value="${esc(
        (u.birthday || "").slice(0, 10)
      )}" /></label>
              <label class="field"><span>Giới tính</span><select id="pfGender">
                <option value="">— Không chọn —</option>
                ${Object.entries(GENDERS)
        .map(([k, v]) => `<option value="${k}"${u.gender === k ? " selected" : ""}>${v}</option>`)
        .join("")}
              </select></label>
            </div>
            <div class="grid-2">
              <label class="field"><span>Tỉnh / Thành phố</span><select id="pfProvince"><option value="">— Chọn —</option></select></label>
              <label class="field"><span>Quận / Huyện</span><select id="pfDistrict" disabled><option value="">— Chọn —</option></select></label>
            </div>
            <div class="grid-2">
              <label class="field"><span>Phường / Xã</span><select id="pfWard" disabled><option value="">— Chọn —</option></select></label>
              <label class="field"><span>Số nhà, đường, thôn…</span><input id="pfAddress" maxlength="160" value="${esc(u.addressLine || "")}" /></label>
            </div>
            <div class="grid-2">
              <label class="field"><span>Công việc</span><input id="pfJob" maxlength="80" value="${esc(u.job || "")}" /></label>
              <label class="field"><span>Học tại</span><input id="pfSchool" maxlength="80" value="${esc(u.school || "")}" /></label>
            </div>
            <div class="grid-2">
              <label class="field"><span>Số điện thoại</span><input id="pfPhone" maxlength="20" value="${esc(u.phone || "")}" /></label>
              <label class="field"><span>Tình trạng quan hệ</span><select id="pfRelationship">
                <option value="">— Không chọn —</option>
                ${Object.entries(RELATIONS)
        .map(([k, v]) => `<option value="${k}"${u.relationship === k ? " selected" : ""}>${v}</option>`)
        .join("")}
              </select></label>
            </div>
            <label class="field"><span>Sở thích (cách nhau bằng dấu phẩy)</span><input id="pfHobbies" maxlength="200" value="${esc(
          hobbies.join(", ")
        )}" /></label>
            <label class="field"><span>Ghi chú bản thân</span><textarea id="pfNote" rows="3" maxlength="500">${esc(u.note || "")}</textarea></label>
            <label class="field"><span>Giới thiệu ngắn</span><textarea id="pfBio" rows="2" maxlength="300">${esc(u.bio || "")}</textarea></label>
            <button class="btn-primary" type="submit">Lưu thay đổi</button>
          </form>`
      : `<button class="btn-primary" id="profMsgBtn" type="button">Gửi tin nhắn</button>`
    }
  `;

  /* Xem ảnh album ngay trong web */
  const album = photos.slice();
  $("#profileBody")
    .querySelectorAll("[data-photo]")
    .forEach((el) => el.addEventListener("click", () => openLightbox(album, album.indexOf(el.dataset.photo))));

  bindMusicSection(u, mine);

  if (mine) {
    $("#profAvaBtn")?.addEventListener("click", openAvatarPicker);
    $("#photoAdd")?.addEventListener("click", pickProfilePhotos);
    $("#profileBody")
      .querySelectorAll("[data-del]")
      .forEach((b) =>
        b.addEventListener("click", async () => {
          if (!confirm("Xoá ảnh này khỏi album?")) return;
          try {
            await callAction(
              "me:photo:remove",
              () => api("/api/chat/me/photo?url=" + encodeURIComponent(b.dataset.del), { method: "DELETE" }),
              { url: b.dataset.del }
            );
            toast("Đã xoá ảnh");
            openProfile(me.id);
          } catch (e) {
            toast(e.message, true);
          }
        })
      );

    initGeoSelects(u);

    $("#profForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const sel = (id) => $(id).selectedOptions[0];
      const patch = {
        birthday: $("#pfBirthday").value || null,
        gender: $("#pfGender").value,
        relationship: $("#pfRelationship").value,
        province: sel("#pfProvince")?.dataset.name || "",
        district: sel("#pfDistrict")?.dataset.name || "",
        ward: sel("#pfWard")?.dataset.name || "",
        addressLine: $("#pfAddress").value.trim(),
        job: $("#pfJob").value.trim(),
        school: $("#pfSchool").value.trim(),
        phone: $("#pfPhone").value.trim(),
        hobbies: $("#pfHobbies")
          .value.split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 20),
        note: $("#pfNote").value.trim(),
        bio: $("#pfBio").value.trim(),
      };
      try {
        await callAction("me:profile", () => api("/api/chat/me/profile", { method: "PUT", body: JSON.stringify(patch) }), patch);
        toast("Đã lưu trang cá nhân");
        openProfile(me.id);
      } catch (e2) {
        toast(e2.message, true);
      }
    });
  } else {
    $("#profMsgBtn")?.addEventListener("click", async () => {
      closeProfile();
      try {
        const d2 = await post("/api/chat/conversations/direct", { userId: u.id });
        await refreshConversations();
        openThread(d2.conversation.id);
      } catch (e) {
        toast(e.message, true);
      }
    });
  }
}

/* ---------------------- Chọn xã / huyện / tỉnh (dữ liệu hành chính VN) */
async function geo(url, key, store) {
  if (store && store.has(key)) return store.get(key);
  const data = await fetch(url).then((r) => r.json());
  const items = data.items || [];
  if (store) store.set(key, items);
  return items;
}

function fillSelect(el, items, selectedName, placeholder) {
  el.innerHTML =
    `<option value="">${placeholder}</option>` +
    items
      .map(
        (it) =>
          `<option value="${esc(String(it.code))}" data-name="${esc(it.name)}"${it.name === selectedName ? " selected" : ""}>${esc(
            it.name
          )}</option>`
      )
      .join("");
  el.disabled = !items.length;
}

async function initGeoSelects(u) {
  const pv = $("#pfProvince"), ds = $("#pfDistrict"), wd = $("#pfWard");
  if (!pv) return;
  try {
    geoCache.provinces = geoCache.provinces || (await geo("/api/chat/geo/provinces")).slice();
    fillSelect(pv, geoCache.provinces, u.province || "", "— Chọn tỉnh / thành —");

    const loadDistricts = async (keepName) => {
      const code = pv.value;
      if (!code) return fillSelect(ds, [], "", "— Chọn quận / huyện —"), fillSelect(wd, [], "", "— Chọn phường / xã —");
      fillSelect(ds, await geo(`/api/chat/geo/districts/${encodeURIComponent(code)}`, code, geoCache.districts), keepName || "", "— Chọn quận / huyện —");
    };
    const loadWards = async (keepName) => {
      const code = ds.value;
      if (!code) return fillSelect(wd, [], "", "— Chọn phường / xã —");
      fillSelect(wd, await geo(`/api/chat/geo/wards/${encodeURIComponent(code)}`, code, geoCache.wards), keepName || "", "— Chọn phường / xã —");
    };

    pv.addEventListener("change", () => loadDistricts().then(() => loadWards()));
    ds.addEventListener("change", () => loadWards());

    if (pv.value) {
      await loadDistricts(u.district || "");
      if (ds.value) await loadWards(u.ward || "");
    }
  } catch {
    /* Mất mạng: vẫn cho nhập địa chỉ tự do ở ô "Số nhà, đường, thôn…" */
  }
}

/* ============================================ Ảnh: nén, tải lên, xem ảnh */
function thumbUrl(url) {
  /* Cloudinary: xin bản nhẹ hơn cho danh sách, bấm vào mới tải bản gốc */
  return typeof url === "string" && url.includes("/image/upload/")
    ? url.replace("/image/upload/", "/image/upload/f_auto,q_auto,w_720/")
    : url;
}

function compressImage(file, maxSide = 1800, quality = 0.86) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("Không đọc được ảnh"));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Ảnh không hợp lệ"));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: cv.toDataURL("image/jpeg", quality), width: w, height: h });
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

async function prepareFiles(files) {
  const out = [];
  for (const f of files) {
    if (!f.type.startsWith("image/")) {
      toast(`"${f.name}" không phải ảnh`, true);
      continue;
    }
    try {
      out.push(await compressImage(f));
    } catch (e) {
      toast(e.message, true);
    }
  }
  return out;
}

/* Gửi ảnh vào cuộc trò chuyện đang mở */
async function sendImages(files) {
  if (!current) return toast("Hãy mở một cuộc trò chuyện trước", true);
  const items = await prepareFiles(files);
  if (!items.length) return;
  const caption = $("#input").value.trim();
  $("#input").value = "";
  for (let k = 0; k < items.length; k++) {
    try {
      await api(`/api/chat/conversations/${current}/image`, {
        method: "POST",
        body: JSON.stringify({ dataUrl: items[k].dataUrl, caption: k === 0 ? caption : "" }),
      });
    } catch (e) {
      toast(e.message || "Tải ảnh thất bại", true);
      break;
    }
  }
}

/* Thêm ảnh vào album trang cá nhân */
async function pickProfilePhotos() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.onchange = async () => {
    const items = await prepareFiles([...input.files]);
    if (!items.length) return;
    toast("Đang tải ảnh lên kho…");
    for (const it of items) {
      try {
        await api("/api/chat/me/upload", { method: "POST", body: JSON.stringify({ dataUrl: it.dataUrl, purpose: "photo" }) });
      } catch (e) {
        toast(e.message || "Tải ảnh thất bại", true);
        break;
      }
    }
    openProfile(me.id);
  };
  input.click();
}

/* ---- Khung xem ảnh: luôn mở trong web, không bao giờ mở tab khác ---- */
let lbList = [];
let lbIndex = 0;

function showLb() {
  $("#lbImg").src = lbList[lbIndex] || "";
  lbResetZoom();
  $("#lbCount").textContent = lbList.length > 1 ? `${lbIndex + 1} / ${lbList.length}` : "";
  const many = lbList.length > 1;
  $("#lbPrev").hidden = !many;
  $("#lbNext").hidden = !many;
}

function openLightbox(list, index = 0) {
  lbList = (Array.isArray(list) ? list : [list]).filter(Boolean);
  if (!lbList.length) return;
  lbIndex = Math.min(Math.max(index, 0), lbList.length - 1);
  showLb();
  $("#lightbox").hidden = false;
  requestAnimationFrame(() => $("#lightbox").classList.add("show"));
}

function closeLightbox() {
  $("#lightbox").classList.remove("show");
  setTimeout(() => {
    $("#lightbox").hidden = true;
    $("#lbImg").src = "";
  }, 180);
}

function stepLb(n) {
  if (lbList.length < 2) return;
  lbIndex = (lbIndex + n + lbList.length) % lbList.length;
  showLb();
}

$("#lbClose").addEventListener("click", closeLightbox);
$("#lbPrev").addEventListener("click", () => stepLb(-1));
$("#lbNext").addEventListener("click", () => stepLb(1));
$("#lightbox").addEventListener("click", (e) => {
  if (lbJustPanned) return;
  if (e.target.id === "lightbox") closeLightbox();
});
document.addEventListener("keydown", (e) => {
  if ($("#lightbox").hidden) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowLeft") stepLb(-1);
  if (e.key === "ArrowRight") stepLb(1);
});

/* Nút gửi ảnh ở khung soạn tin + dán ảnh từ clipboard */
$("#photoBtn").addEventListener("click", () => {
  if (!mediaReady) return toast("Chưa cấu hình kho ảnh — nhờ quản trị thêm API key Cloudinary", true);
  $("#photoInput").click();
});
$("#photoInput").addEventListener("change", async () => {
  const files = [...$("#photoInput").files];
  $("#photoInput").value = "";
  await sendImages(files);
});
$("#input").addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  e.preventDefault();
  sendImages(files);
});

/* ------------------------------------------------ Đổi ảnh đại diện của tôi */
function openAvatarPicker() {
  const box = $("#avaPick");
  box.innerHTML = ASSETS.avatars
    .map((a) => `<button type="button" data-url="${esc(a.url)}"><img src="${esc(a.url)}" alt="" loading="lazy" /></button>`)
    .join("");
  box.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await callAction("me:avatar", () => api("/api/chat/me/avatar", { method: "PUT", body: JSON.stringify({ avatarUrl: b.dataset.url }) }), {
          avatarUrl: b.dataset.url,
        });
        me = { ...me, avatarUrl: b.dataset.url };
        localStorage.setItem(USER_KEY, JSON.stringify(me));
        paintMe();
        $("#avaWrap").classList.remove("show");
        setTimeout(() => ($("#avaWrap").hidden = true), 200);
        toast("Đã đổi ảnh đại diện");
      } catch (e) {
        toast(e.message, true);
      }
    })
  );
  $("#avaWrap").hidden = false;
  requestAnimationFrame(() => $("#avaWrap").classList.add("show"));
}

/* Bấm avatar của mình = mở trang cá nhân (trong đó có nút đổi ảnh) */
$("#meAvatarBtn").addEventListener("click", () => openProfile(me?.id));
$("#meEditBtn").addEventListener("click", () => openProfile(me?.id));

/* Bấm avatar trong khung chat: 1-1 thì mở profile người kia, nhóm thì mở quản lý */
$("#thAvatar").addEventListener("click", () => {
  if (!currentConv) return;
  if (currentConv.isGroup) $("#infoBtn").click();
  else if (currentConv.otherId) openProfile(currentConv.otherId);
});

$("#avaClose").addEventListener("click", () => {
  $("#avaWrap").classList.remove("show");
  setTimeout(() => ($("#avaWrap").hidden = true), 200);
});

/* ================================================================ Boot */
async function loadAssets() {
  ASSETS = await fetch("/api/chat/assets").then((r) => r.json());

  $("#fbIcon").src = ASSETS.brand.facebook || "";
  $("#authLogo").src = ASSETS.brand.messenger || "";
  $("#fbIcons").innerHTML = ASSETS.reactions
    .map((r) => `<button type="button" class="fb-i" data-key="${esc(r.key)}" title="${esc(r.label)}"><img src="${esc(r.url)}" alt="${esc(r.label)}" /></button>`)
    .join("");
  $("#fbIcons")
    .querySelectorAll(".fb-i")
    .forEach((b) => b.addEventListener("click", () => send({ type: "icon", key: b.dataset.key })));

  $("#giftIcon").src = ASSETS.gifts[0]?.url || "";
  $("#giftTray").innerHTML = ASSETS.gifts
    .map((g) => `<button type="button" data-key="${esc(g.key)}" title="${esc(g.label)}"><img src="${esc(g.url)}" alt="${esc(g.label)}" /><span>${esc(g.label)}</span></button>`)
    .join("");
  $("#giftTray")
    .querySelectorAll("button")
    .forEach((b) =>
      b.addEventListener("click", () => {
        $("#giftTray").hidden = true;
        send({ type: "gift", key: b.dataset.key });
      })
    );

  $("#emojiTray").innerHTML = ASSETS.emojis
    .map(
      (g) => `<div class="emoji-group"><b>${esc(g.name)}</b><div>${g.items
        .map((e) => `<button type="button" class="emo">${e}</button>`)
        .join("")}</div></div>`
    )
    .join("");
  $("#emojiTray")
    .querySelectorAll(".emo")
    .forEach((b) =>
      b.addEventListener("click", () => {
        const input = $("#input");
        input.value += b.textContent;
        input.focus();
      })
    );
}

async function loadMediaStatus() {
  try {
    const d = await fetch("/api/chat/media/status").then((r) => r.json());
    mediaReady = !!d.ready;
    mediaMax = d.maxBytes || mediaMax;
  } catch {
    mediaReady = false;
  }
  $("#photoBtn").title = mediaReady ? "Gửi ảnh" : "Chưa cấu hình kho ảnh";
}

/* Tải ảnh đại diện từ thiết bị (ảnh lên Cloudinary, MongoDB lưu link) */
$("#avaUploadBtn").addEventListener("click", () => {
  if (!mediaReady) return toast("Chưa cấu hình kho ảnh — nhờ quản trị thêm API key Cloudinary", true);
  $("#avaUploadInput").click();
});
$("#avaUploadInput").addEventListener("change", async () => {
  const file = $("#avaUploadInput").files[0];
  $("#avaUploadInput").value = "";
  if (!file) return;
  if (!file.type.startsWith("image/")) return toast("Tệp này không phải ảnh", true);
  let dataUrl = "";
  try {
    dataUrl = await cropAvatar(file); // kéo & zoom chọn vùng đẹp
  } catch (e) {
    return toast(e.message || "Không đọc được ảnh", true);
  }
  if (!dataUrl) return; // người dùng bấm huỷ
  try {
    const it = { dataUrl };
    toast("Đang tải ảnh lên kho…");
    const d = await api("/api/chat/me/upload", { method: "POST", body: JSON.stringify({ dataUrl: it.dataUrl, purpose: "avatar" }) });
    me = { ...me, avatarUrl: d.user?.avatarUrl || me.avatarUrl };
    localStorage.setItem(USER_KEY, JSON.stringify(me));
    paintMe();
    $("#avaWrap").classList.remove("show");
    setTimeout(() => ($("#avaWrap").hidden = true), 200);
    toast("Đã đổi ảnh đại diện");
    if (!$("#profileWrap").hidden) openProfile(me.id);
  } catch (e) {
    toast(e.message, true);
  }
});


/* ====================================================== THÔNG BÁO ĐẨY (PWA)
   Trên iPhone: mở web trong Safari → Chia sẻ → "Thêm vào Màn hình chính",
   mở app vừa ghim rồi bấm 🔔 để bật. iOS 16.4+ mới hỗ trợ, và bắt buộc HTTPS.
   Số tin chưa đọc hiện thành số đỏ trên icon app (hơn 9 thì trong web ghi 9+). */
let swReg = null;
let pushCfg = { enabled: false, publicKey: "" };

const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

/** Số đỏ trên icon app (Badging API) */
async function setAppBadge(total) {
  const n = Number(total) || 0;
  try {
    if (n > 0 && navigator.setAppBadge) await navigator.setAppBadge(n);
    else if (navigator.clearAppBadge) await navigator.clearAppBadge();
  } catch { }
  try {
    swReg?.active?.postMessage({ type: "badge", count: n });
  } catch { }
}

function urlB64ToUint8(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function registerSW() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    swReg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    navigator.serviceWorker.addEventListener("message", (e) => {
      const m = e.data || {};
      if (m.type === "open" && m.url) {
        const c = new URL(m.url, location.origin).searchParams.get("c");
        if (c) openThread(c);
      }
      if (m.type === "push") loadConversations().catch(() => { });
    });
    return swReg;
  } catch (e) {
    console.warn("SW lỗi:", e);
    return null;
  }
}

async function loadPushConfig() {
  try {
    pushCfg = await api("/api/chat/push/config");
  } catch {
    pushCfg = { enabled: false, publicKey: "" };
  }
  paintBell();
}

function paintBell() {
  const b = $("#bellBtn");
  if (!b) return;
  const on = Notification?.permission === "granted";
  b.classList.toggle("on", on);
  b.title = on
    ? "Thông báo đang bật — số tin chưa đọc hiện trên icon app"
    : "Bật thông báo (ghim web ra màn hình chính trước nếu dùng iPhone)";
}

/** Đăng ký nhận thông báo đẩy cho thiết bị này */
async function enablePush({ silent = false } = {}) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    if (!silent) {
      toast(
        isIOS() && !isStandalone()
          ? "iPhone: bấm Chia sẻ → “Thêm vào Màn hình chính”, mở app đó rồi bật lại thông báo"
          : "Trình duyệt này không hỗ trợ thông báo đẩy",
        true
      );
    }
    return false;
  }
  if (!pushCfg.enabled || !pushCfg.publicKey) {
    if (!silent) toast("Máy chủ chưa bật thông báo đẩy (quản trị cần tạo khoá VAPID)", true);
    return false;
  }
  const reg = swReg || (await registerSW());
  if (!reg) return false;

  if (Notification.permission !== "granted") {
    const p = await Notification.requestPermission();
    if (p !== "granted") {
      if (!silent) toast("Bạn đã từ chối thông báo", true);
      paintBell();
      return false;
    }
  }

  try {
    let sub = await reg.pushManager.getSubscription();
    const key = urlB64ToUint8(pushCfg.publicKey);
    if (sub) {
      const same =
        sub.options?.applicationServerKey &&
        new Uint8Array(sub.options.applicationServerKey).toString() === key.toString();
      if (!same) {
        await sub.unsubscribe().catch(() => { });
        sub = null;
      }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api("/api/chat/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ subscription: sub.toJSON(), standalone: isStandalone() }),
    });
    if (!silent) toast("Đã bật thông báo — số tin chưa đọc sẽ hiện trên icon app");
    paintBell();
    return true;
  } catch (e) {
    if (!silent) toast(`Không bật được thông báo: ${e.message}`, true);
    return false;
  }
}

/* Mở đúng hội thoại khi bấm vào thông báo (?c=<id>) */
function openFromQuery() {
  const c = new URLSearchParams(location.search).get("c");
  if (c) setTimeout(() => openThread(c).catch(() => { }), 400);
}

/* Việc không gấp: chạy khi trình duyệt rảnh -> không chặn luồng chính lúc mở app */
const whenIdle = (fn) =>
  "requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 2500 }) : setTimeout(fn, 300);

async function boot() {
  /* 1) Chưa đăng nhập -> hiện ngay màn hình đăng nhập, không chờ gì cả */
  if (!token) {
    showAuth(true);
    loadAssets().catch(() => { });
    whenIdle(() => {
      loadMediaStatus();
      registerSW().then(loadPushConfig);
    });
    return;
  }

  /* 2) Đã đăng nhập -> ưu tiên: xác thực + nối realtime + tải danh sách hội thoại */
  const assetsReady = loadAssets().catch(() => { });
  try {
    const d = await api("/api/chat/auth/me");
    me = d.user;
    localStorage.setItem(USER_KEY, JSON.stringify(me));
  } catch {
    return;
  }
  showAuth(false);
  paintMe();
  connectSocket();
  openFromQuery();

  /* 3) Phần còn lại (kho ảnh, service worker, thông báo đẩy) làm sau */
  whenIdle(async () => {
    await assetsReady;
    await loadMediaStatus();
    await registerSW();
    await loadPushConfig();
    if ("Notification" in window) {
      if (Notification.permission === "granted") enablePush({ silent: true });
      else if (Notification.permission === "default" && !isIOS()) {
        setTimeout(() => enablePush({ silent: true }), 1500);
      }
    }
    paintBell();
  });
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && current) markReadNow();
});

boot();


/* ==========================================================================
   KÉO + ZOOM ẢNH TRONG KHUNG XEM ẢNH (lightbox)
   - Cuộn chuột / chụm 2 ngón để phóng to thu nhỏ (neo tại điểm con trỏ)
   - Kéo để di chuyển khi đã phóng to, bấm đúp để về cỡ gốc
   ========================================================================== */
const LB_MIN = 1;
const LB_MAX = 6;
let lbZoom = 1;
let lbX = 0;
let lbY = 0;
let lbJustPanned = false;

function lbApply() {
  const img = $("#lbImg");
  img.style.transform = `translate(${lbX}px, ${lbY}px) scale(${lbZoom})`;
  img.style.cursor = lbZoom > 1 ? "grab" : "zoom-in";
}

function lbClampPan() {
  const img = $("#lbImg");
  const w = img.clientWidth * lbZoom;
  const h = img.clientHeight * lbZoom;
  const maxX = Math.max(0, (w - Math.min(w, window.innerWidth)) / 2);
  const maxY = Math.max(0, (h - Math.min(h, window.innerHeight)) / 2);
  lbX = Math.min(maxX, Math.max(-maxX, lbX));
  lbY = Math.min(maxY, Math.max(-maxY, lbY));
}

function lbResetZoom() {
  lbZoom = 1;
  lbX = 0;
  lbY = 0;
  lbApply();
}

/** Phóng to/thu nhỏ quanh một điểm trên màn hình (giữ nguyên điểm đó) */
function lbZoomAt(next, clientX, clientY) {
  const target = Math.min(LB_MAX, Math.max(LB_MIN, next));
  const img = $("#lbImg");
  const r = img.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const px = (clientX ?? cx) - cx;
  const py = (clientY ?? cy) - cy;
  const k = target / lbZoom;
  lbX = px - (px - lbX) * k;
  lbY = py - (py - lbY) * k;
  lbZoom = target;
  lbClampPan();
  lbApply();
}

(function initLbGestures() {
  const box = $("#lightbox");
  const img = $("#lbImg");

  box.addEventListener(
    "wheel",
    (e) => {
      if (box.hidden) return;
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      lbZoomAt(lbZoom * Math.exp(-dy * 0.0018), e.clientX, e.clientY);
    },
    { passive: false }
  );

  const pts = new Map();
  let startDist = 0;
  let startZoom = 1;
  let last = null;
  let moved = 0;

  const mid = () => {
    const a = [...pts.values()];
    return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 };
  };
  const dist = () => {
    const a = [...pts.values()];
    return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
  };

  img.addEventListener("pointerdown", (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    img.setPointerCapture?.(e.pointerId);
    moved = 0;
    if (pts.size === 2) {
      startDist = dist();
      startZoom = lbZoom;
    } else {
      last = { x: e.clientX, y: e.clientY };
    }
  });

  img.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const m = mid();
      const d = dist();
      if (startDist > 0) lbZoomAt(startZoom * (d / startDist), m.x, m.y);
      moved = 99;
      return;
    }
    if (!last || lbZoom <= 1) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };
    moved += Math.abs(dx) + Math.abs(dy);
    lbX += dx;
    lbY += dy;
    lbClampPan();
    lbApply();
  });

  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) startDist = 0;
    last = null;
    if (moved > 6) {
      lbJustPanned = true;
      setTimeout(() => (lbJustPanned = false), 60);
    }
  };
  img.addEventListener("pointerup", up);
  img.addEventListener("pointercancel", up);

  img.addEventListener("dblclick", (e) => {
    if (lbZoom > 1) lbResetZoom();
    else lbZoomAt(2.5, e.clientX, e.clientY);
  });

  $("#lbZoomIn").addEventListener("click", () => lbZoomAt(lbZoom * 1.4));
  $("#lbZoomOut").addEventListener("click", () => lbZoomAt(lbZoom / 1.4));
  $("#lbZoomReset").addEventListener("click", lbResetZoom);
})();

/* ==========================================================================
   CẮT ẢNH ĐẠI DIỆN: kéo để chọn vị trí, cuộn/chụm để phóng to
   Trả về dataUrl ảnh vuông 512x512 (hoặc "" nếu người dùng huỷ)
   ========================================================================== */
function cropAvatar(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("Không đọc được ảnh"));
    fr.onload = () => {
      const src = new Image();
      src.onerror = () => reject(new Error("Ảnh không hợp lệ"));
      src.onload = () => startCrop(src, resolve);
      src.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

function startCrop(src, done) {
  const wrap = $("#cropWrap");
  const stage = $("#cropStage");
  const img = $("#cropImg");
  const range = $("#cropRange");

  const MIN = 1;
  const MAX = 4;
  let scale = 1; // hệ số phóng thêm so với cỡ vừa khít
  let tx = 0;
  let ty = 0;
  let base = 1; // cỡ để ảnh phủ kín khung vuông
  let V = 1; // cạnh khung vuông (px)

  img.src = src.src;
  wrap.hidden = false;
  requestAnimationFrame(() => wrap.classList.add("show"));

  function measure() {
    V = stage.clientWidth || 300;
    base = V / Math.min(src.width, src.height);
    img.style.width = src.width * base + "px";
    img.style.height = src.height * base + "px";
    img.style.marginLeft = -(src.width * base) / 2 + "px";
    img.style.marginTop = -(src.height * base) / 2 + "px";
  }

  function clamp() {
    const w = src.width * base * scale;
    const h = src.height * base * scale;
    const mx = Math.max(0, (w - V) / 2);
    const my = Math.max(0, (h - V) / 2);
    tx = Math.min(mx, Math.max(-mx, tx));
    ty = Math.min(my, Math.max(-my, ty));
  }

  function apply() {
    clamp();
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    range.value = String(scale);
  }

  /** Phóng to quanh 1 điểm trên khung (giữ điểm đó đứng yên) */
  function zoomAt(next, clientX, clientY) {
    const target = Math.min(MAX, Math.max(MIN, next));
    const r = stage.getBoundingClientRect();
    const px = (clientX ?? r.left + r.width / 2) - (r.left + r.width / 2);
    const py = (clientY ?? r.top + r.height / 2) - (r.top + r.height / 2);
    const k = target / scale;
    tx = px - (px - tx) * k;
    ty = py - (py - ty) * k;
    scale = target;
    apply();
  }

  measure();
  apply();

  const onWheel = (e) => {
    e.preventDefault();
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
    zoomAt(scale * Math.exp(-dy * 0.0018), e.clientX, e.clientY);
  };
  stage.addEventListener("wheel", onWheel, { passive: false });

  const pts = new Map();
  let startDist = 0;
  let startScale = 1;
  let last = null;

  const onDown = (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.setPointerCapture?.(e.pointerId);
    stage.classList.add("dragging");
    if (pts.size === 2) {
      const a = [...pts.values()];
      startDist = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
      startScale = scale;
    } else last = { x: e.clientX, y: e.clientY };
  };
  const onMove = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const a = [...pts.values()];
    if (pts.size === 2) {
      const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
      const m = { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 };
      if (startDist > 0) zoomAt(startScale * (d / startDist), m.x, m.y);
      return;
    }
    if (!last) return;
    tx += e.clientX - last.x;
    ty += e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };
    apply();
  };
  const onUp = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) startDist = 0;
    if (!pts.size) stage.classList.remove("dragging");
    last = null;
  };
  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onUp);

  const onRange = () => zoomAt(parseFloat(range.value));
  range.addEventListener("input", onRange);

  const zin = () => zoomAt(scale * 1.25);
  const zout = () => zoomAt(scale / 1.25);
  const reset = () => {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  };
  $("#cropIn").addEventListener("click", zin);
  $("#cropOut").addEventListener("click", zout);
  $("#cropReset").addEventListener("click", reset);

  const onResize = () => {
    const s = scale;
    measure();
    scale = s;
    apply();
  };
  window.addEventListener("resize", onResize);

  function cleanup() {
    stage.removeEventListener("wheel", onWheel);
    stage.removeEventListener("pointerdown", onDown);
    stage.removeEventListener("pointermove", onMove);
    stage.removeEventListener("pointerup", onUp);
    stage.removeEventListener("pointercancel", onUp);
    range.removeEventListener("input", onRange);
    $("#cropIn").removeEventListener("click", zin);
    $("#cropOut").removeEventListener("click", zout);
    $("#cropReset").removeEventListener("click", reset);
    $("#cropSave").removeEventListener("click", save);
    $("#cropCancel").removeEventListener("click", cancel);
    wrap.removeEventListener("click", onBackdrop);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("keydown", onKey);
    wrap.classList.remove("show");
    setTimeout(() => {
      wrap.hidden = true;
      img.removeAttribute("src");
    }, 200);
  }

  function save() {
    const OUT = 512;
    const view = V / (base * scale); // cạnh vùng cắt tính theo pixel ảnh gốc
    const cx = src.width / 2 - tx / (base * scale);
    const cy = src.height / 2 - ty / (base * scale);
    const sx = Math.max(0, Math.min(src.width - view, cx - view / 2));
    const sy = Math.max(0, Math.min(src.height - view, cy - view / 2));
    const cv = document.createElement("canvas");
    cv.width = OUT;
    cv.height = OUT;
    const ctx = cv.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, sx, sy, view, view, 0, 0, OUT, OUT);
    const url = cv.toDataURL("image/jpeg", 0.9);
    cleanup();
    done(url);
  }

  function cancel() {
    cleanup();
    done("");
  }

  function onBackdrop(e) {
    if (e.target === wrap) cancel();
  }
  function onKey(e) {
    if (e.key === "Escape") cancel();
  }

  $("#cropSave").addEventListener("click", save);
  $("#cropCancel").addEventListener("click", cancel);
  wrap.addEventListener("click", onBackdrop);
  document.addEventListener("keydown", onKey);
}
