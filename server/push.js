/**
 * Thong bao day (Web Push) + so do tren icon app (Badging API).
 *
 * - Hoat dong tren iPhone/iPad khi web da duoc "Them vao man hinh chinh"
 *   (iOS 16.4+). Trong Safari thuong iOS KHONG cho web push.
 * - Bat buoc chay tren HTTPS (tru localhost).
 * - Khoa VAPID luu trong config.json (hoac bien moi truong VAPID_*).
 * - Subscription luu trong MongoDB, moi thiet bi 1 ban ghi.
 */
import webpush from "web-push";
import { readConfig, writeConfig } from "./store.js";
import { totalUnread, getUser } from "./chat-store.js";

let Sub = null;

export class PushError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/* --------------------------------------------------------- Khoa VAPID */
function readKeys() {
  const cfg = readConfig();
  const p = cfg.push || {};
  return {
    publicKey: process.env.VAPID_PUBLIC_KEY || p.publicKey || "",
    privateKey: process.env.VAPID_PRIVATE_KEY || p.privateKey || "",
    subject: process.env.VAPID_SUBJECT || p.subject || "mailto:admin@example.com",
  };
}

function applyKeys() {
  const k = readKeys();
  if (!k.publicKey || !k.privateKey) return null;
  const subject = /^(mailto:|https?:\/\/)/.test(k.subject) ? k.subject : `mailto:${k.subject}`;
  try {
    webpush.setVapidDetails(subject, k.publicKey, k.privateKey);
    return { ...k, subject };
  } catch (e) {
    console.warn(`  [push] Khoá VAPID không hợp lệ: ${e.message}`);
    return null;
  }
}

export function pushEnabled() {
  const k = readKeys();
  return !!(k.publicKey && k.privateKey);
}

export function publicKey() {
  return readKeys().publicKey;
}

/** Tao cap khoa VAPID moi (moi subscription cu se bi xoa vi khong con hop le) */
export async function generateKeys(subject = "") {
  const { publicKey: pub, privateKey: priv } = webpush.generateVAPIDKeys();
  const cfg = readConfig();
  const next = {
    ...cfg,
    push: {
      publicKey: pub,
      privateKey: priv,
      subject: subject || cfg.push?.subject || "mailto:admin@example.com",
    },
  };
  writeConfig(next);
  applyKeys();
  if (Sub) await Sub.deleteMany({}).catch(() => { });
  return { publicKey: pub, subject: next.push.subject, cleared: true };
}

export async function saveSubject(subject) {
  const cfg = readConfig();
  const next = { ...cfg, push: { ...(cfg.push || {}), subject: String(subject || "").trim() } };
  writeConfig(next);
  applyKeys();
  return { subject: next.push.subject };
}

/* --------------------------------------------------------------- Model */
export async function initPush() {
  const mongoose = (await import("mongoose")).default;
  const schema = new mongoose.Schema({
    userId: { type: String, index: true },
    endpoint: { type: String, unique: true },
    p256dh: String,
    auth: String,
    ua: { type: String, default: "" },
    standalone: { type: Boolean, default: false },
    createdAt: { type: Date, default: () => new Date() },
    lastOkAt: { type: Date, default: null },
    fails: { type: Number, default: 0 },
  });
  Sub = mongoose.models.PushSub || mongoose.model("PushSub", schema);
  await Sub.init();
  const ok = !!applyKeys();
  const n = await Sub.countDocuments({});
  console.log(`  [push] Thông báo đẩy: ${ok ? "đã có khoá VAPID" : "CHƯA có khoá VAPID"} · thiết bị đã bật: ${n}`);
  return ok;
}

/* -------------------------------------------------------- Subscription */
export async function subscribe(userId, sub, meta = {}) {
  if (!Sub) throw new PushError("Chưa khởi tạo thông báo đẩy", 500);
  if (!pushEnabled()) throw new PushError("Máy chủ chưa bật thông báo đẩy (thiếu khoá VAPID)", 503);
  const endpoint = String(sub?.endpoint || "");
  const p256dh = String(sub?.keys?.p256dh || "");
  const auth = String(sub?.keys?.auth || "");
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) throw new PushError("Dữ liệu đăng ký thông báo không hợp lệ");
  await Sub.findOneAndUpdate(
    { endpoint },
    {
      userId: String(userId),
      endpoint,
      p256dh,
      auth,
      ua: String(meta.ua || "").slice(0, 200),
      standalone: !!meta.standalone,
      fails: 0,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return { ok: true };
}

export async function unsubscribe(endpoint) {
  if (!Sub) return { ok: true };
  await Sub.deleteOne({ endpoint: String(endpoint || "") }).catch(() => { });
  return { ok: true };
}

export async function deviceCount(userId) {
  if (!Sub) return 0;
  return await Sub.countDocuments(userId ? { userId: String(userId) } : {});
}

/* ---------------------------------------------------------- Gui thong bao */
async function sendRaw(row, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify(payload),
      { TTL: 3600, urgency: "high" }
    );
    await Sub.updateOne({ _id: row._id }, { lastOkAt: new Date(), fails: 0 }).catch(() => { });
    return true;
  } catch (e) {
    const code = e?.statusCode || 0;
    /* 404/410 = thiet bi da xoa app hoac huy dang ky -> bo han */
    if (code === 404 || code === 410) await Sub.deleteOne({ _id: row._id }).catch(() => { });
    else await Sub.updateOne({ _id: row._id }, { $inc: { fails: 1 } }).catch(() => { });
    return false;
  }
}

/** Gui cho tat ca thiet bi cua 1 nguoi dung */
export async function sendToUser(userId, payload) {
  if (!Sub || !pushEnabled()) return 0;
  const rows = await Sub.find({ userId: String(userId) }).lean();
  if (!rows.length) return 0;
  const res = await Promise.all(rows.map((r) => sendRaw(r, payload)));
  return res.filter(Boolean).length;
}

/**
 * Co tin nhan moi -> day thong bao + so do (badge) cho tung nguoi nhan.
 * Badge = tong so tin nhan CHUA DOC that su cua nguoi do.
 */
export async function pushNewMessage({ recipientIds = [], senderName = "", conversationId = "", body = "", groupTitle = "", icon = "" }) {
  if (!pushEnabled()) return;
  for (const id of recipientIds) {
    try {
      const u = await getUser(id);
      if (!u || u.isBot) continue;
      const unreadTotal = await totalUnread(id).catch(() => 0);
      await sendToUser(id, {
        kind: "message",
        title: groupTitle ? `${senderName} · ${groupTitle}` : senderName || "Tin nhắn mới",
        body: String(body || "Bạn có tin nhắn mới").slice(0, 160),
        icon: icon || "/icons/icon-192.png",
        conversationId: String(conversationId),
        unreadTotal,
        url: `/chat?c=${encodeURIComponent(String(conversationId))}`,
      });
    } catch { }
  }
}

/** Chi cap nhat lai so do tren icon (khong hien thong bao) */
export async function pushBadge(userId) {
  if (!pushEnabled()) return;
  const unreadTotal = await totalUnread(userId).catch(() => 0);
  await sendToUser(userId, { kind: "badge", unreadTotal, silent: true });
}

export async function pushStatus() {
  const k = readKeys();
  return {
    configured: !!(k.publicKey && k.privateKey),
    publicKey: k.publicKey,
    subject: k.subject,
    fromEnv: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
    devices: await deviceCount(),
  };
}

/** Gui thong bao thu cho toan bo thiet bi (nut "Gui thu" trong trang quan tri) */
export async function sendTest() {
  if (!Sub) throw new PushError("Chưa khởi tạo thông báo đẩy", 500);
  if (!pushEnabled()) throw new PushError("Chưa có khoá VAPID", 400);
  const rows = await Sub.find({}).lean();
  if (!rows.length) throw new PushError("Chưa có thiết bị nào bật thông báo");
  const payload = {
    kind: "test",
    title: "Thử thông báo",
    body: "Nếu bạn thấy tin này thì thông báo đẩy đã hoạt động 🎉",
    icon: "/icons/icon-192.png",
    unreadTotal: 1,
    url: "/chat",
  };
  const res = await Promise.all(rows.map((r) => sendRaw(r, payload)));
  return { sent: res.filter(Boolean).length, total: rows.length };
}
