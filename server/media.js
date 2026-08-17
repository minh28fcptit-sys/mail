/**
 * Kho anh (Cloudinary) — nhieu kho, tu dong chuyen kho khi day.
 *
 * - Anh KHONG luu vao MongoDB. Anh duoc day len Cloudinary, chi luu LINK.
 * - Ho tro nhieu API key (nhieu kho). Khi 1 kho gan/het dung luong hoac
 *   Cloudinary bao vuot han muc -> tu dong nhay sang kho ke tiep.
 * - Co ham kiem tra dung luong THAT bang Admin API /usage cua chinh key do.
 */
import crypto from "node:crypto";

let MediaStore = null;

/* Nguong coi la "day" (%) — con lai duoi 100 de con cho ghi an toan */
const FULL_AT = Number(process.env.CLOUD_FULL_PERCENT || 95);
/* Bao lau thi lam moi so lieu dung luong (ms) */
const USAGE_TTL = Number(process.env.CLOUD_USAGE_TTL_MS || 10 * 60 * 1000);
const MAX_BYTES = Number(process.env.IMAGE_MAX_BYTES || 10 * 1024 * 1024);

export const IMAGE_MAX_BYTES = MAX_BYTES;
const AUDIO_MAX_BYTES = Number(process.env.AUDIO_MAX_BYTES || 9 * 1024 * 1024);
export const AUDIO_MAX_BYTES_PUBLIC = AUDIO_MAX_BYTES;

export class MediaError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ============================================================== Model */
export async function initMediaStore() {
  const mongoose = (await import("mongoose")).default;
  const schema = new mongoose.Schema({
    name: { type: String, default: "Kho Cloudinary" },
    cloudName: String,
    apiKey: String,
    apiSecret: String,
    folder: { type: String, default: "mail-chat" },
    fullPercent: { type: Number, default: FULL_AT },
    enabled: { type: Boolean, default: true },
    priority: { type: Number, default: 100 },
    full: { type: Boolean, default: false },
    lastError: { type: String, default: "" },
    uploads: { type: Number, default: 0 },
    usage: { type: Object, default: null },
    usageAt: { type: Date, default: null },
    createdAt: { type: Date, default: () => new Date() },
  });
  MediaStore = mongoose.models.MediaStore || mongoose.model("MediaStore", schema);
  await MediaStore.init();

  /* Cho phep khai bao san 1 kho bang bien moi truong */
  const envCloud = process.env.CLOUDINARY_CLOUD_NAME;
  const envKey = process.env.CLOUDINARY_API_KEY;
  const envSecret = process.env.CLOUDINARY_API_SECRET;
  if (envCloud && envKey && envSecret) {
    const existed = await MediaStore.findOne({ cloudName: envCloud, apiKey: envKey }).lean();
    if (!existed) {
      await MediaStore.create({
        name: process.env.CLOUDINARY_NAME || `Kho ${envCloud}`,
        cloudName: envCloud,
        apiKey: envKey,
        apiSecret: envSecret,
        folder: process.env.CLOUDINARY_FOLDER || "mail-chat",
        priority: 10,
      });
      console.log("  [media] Đã thêm kho Cloudinary từ .env");
    }
  }
  const n = await MediaStore.countDocuments({ enabled: true });
  console.log(`  [media] Kho ảnh Cloudinary đang bật: ${n}`);
  return n;
}

function db() {
  if (!MediaStore) throw new MediaError("Kho ảnh chưa khởi tạo", 500);
}

/* ===================================================== Cloudinary API */
function signParams(params, apiSecret) {
  const base = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHash("sha1").update(base + apiSecret).digest("hex");
}

const pct = (o) =>
  o && Number(o.limit) > 0 ? Math.min(100, Math.round((Number(o.usage) / Number(o.limit)) * 1000) / 10) : null;

/** Doc dung luong THAT tu Admin API cua chinh API key do */
export async function fetchUsage({ cloudName, apiKey, apiSecret, fullPercent }) {
  if (!cloudName || !apiKey || !apiSecret) throw new MediaError("Thiếu Cloud name / API key / API secret");
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  let res;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/usage`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new MediaError(`Không gọi được Cloudinary: ${e.message}`, 502);
  }
  const raw = await res.text();
  let d = {};
  try {
    d = JSON.parse(raw);
  } catch { }
  if (!res.ok) {
    const msg = d?.error?.message || "";
    /* Key dạng "scoped/limited" của Cloudinary không có quyền đọc Admin API */
    if (res.status === 403 || /missing permissions|not allowed|forbidden/i.test(msg)) {
      const err = new MediaError(
        "API key này không có quyền đọc dung lượng (Admin API). Kho vẫn tải ảnh lên được, " +
        "nhưng muốn xem dung lượng thật thì dùng API key có quyền đọc " +
        "(Cloudinary Console → Settings → API Keys → bật quyền read/Admin API, hoặc dùng key mặc định của tài khoản).",
        403
      );
      err.permission = true;
      throw err;
    }
    throw new MediaError(
      msg || (res.status === 401 ? "API key hoặc API secret không đúng" : `Cloudinary lỗi ${res.status}`),
      res.status === 401 ? 401 : 502
    );
  }

  const usage = {
    plan: d.plan || "",
    lastUpdated: d.last_updated || "",
    credits: {
      usage: d.credits?.usage ?? null,
      limit: d.credits?.limit ?? null,
      percent: d.credits?.used_percent ?? pct(d.credits),
    },
    storage: {
      usage: d.storage?.usage ?? null,
      limit: d.storage?.limit ?? null,
      percent: d.storage?.used_percent ?? pct(d.storage),
    },
    bandwidth: {
      usage: d.bandwidth?.usage ?? null,
      limit: d.bandwidth?.limit ?? null,
      percent: d.bandwidth?.used_percent ?? pct(d.bandwidth),
    },
    transformations: {
      usage: d.transformations?.usage ?? null,
      limit: d.transformations?.limit ?? null,
      percent: d.transformations?.used_percent ?? pct(d.transformations),
    },
    resources: d.resources ?? null,
    derivedResources: d.derived_resources ?? null,
    requests: d.requests ?? null,
  };
  usage.worstPercent = Math.max(
    ...[usage.credits.percent, usage.storage.percent, usage.bandwidth.percent, usage.transformations.percent]
      .map((x) => (typeof x === "number" ? x : 0))
  );
  const threshold = Number(fullPercent) > 0 ? Number(fullPercent) : FULL_AT;
  usage.fullAt = threshold;
  usage.full = usage.worstPercent >= threshold;
  return usage;
}

/**
 * Xac thuc key khi Admin API bi chan quyen doc: goi API ghi (destroy 1 public_id
 * khong ton tai). Key dung -> 200 {result:"not found"}; key sai -> 401.
 */
export async function verifyUploadCredentials({ cloudName, apiKey, apiSecret }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `__probe_${crypto.randomBytes(6).toString("hex")}`;
  const signature = signParams({ public_id: publicId, timestamp }, apiSecret);
  const form = new FormData();
  form.append("api_key", apiKey);
  form.append("public_id", publicId);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);
  let res;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/destroy`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new MediaError(`Không gọi được Cloudinary: ${e.message}`, 502);
  }
  const raw = await res.text();
  let d = {};
  try {
    d = JSON.parse(raw);
  } catch { }
  if (res.ok) return true;
  const msg = d?.error?.message || `Cloudinary lỗi ${res.status}`;
  if (res.status === 401) throw new MediaError("Cloud name / API key / API secret không đúng", 401);
  throw new MediaError(msg, res.status >= 500 ? 502 : 400);
}

/** Kiem tra 1 kho da luu -> ghi lai so lieu vao DB */
export async function checkStore(id) {
  db();
  const s = await MediaStore.findById(id);
  if (!s) throw new MediaError("Không tìm thấy kho ảnh", 404);
  try {
    const usage = await fetchUsage(s);
    s.usage = usage;
    s.usageAt = new Date();
    s.full = !!usage.full;
    s.lastError = "";
    await s.save();
    return publicStore(s.toObject());
  } catch (e) {
    s.lastError = e.message;
    s.usageAt = new Date();
    if (e.permission) {
      /* Khong doc duoc dung luong -> khong coi la day, van cho tai anh */
      s.full = false;
      s.usage = null;
    }
    await s.save();
    throw e;
  }
}

/* ======================================================= CRUD kho anh */
export function publicStore(s) {
  return {
    id: String(s._id),
    name: s.name || "",
    cloudName: s.cloudName || "",
    apiKey: s.apiKey ? `${String(s.apiKey).slice(0, 4)}••••${String(s.apiKey).slice(-3)}` : "",
    apiSecretSet: !!s.apiSecret,
    folder: s.folder || "",
    fullPercent: Number(s.fullPercent ?? FULL_AT),
    enabled: s.enabled !== false,
    priority: Number(s.priority ?? 100),
    full: !!s.full,
    uploads: Number(s.uploads || 0),
    lastError: s.lastError || "",
    usage: s.usage || null,
    usageAt: s.usageAt ? new Date(s.usageAt).toISOString() : null,
    createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : null,
  };
}

export async function listStores() {
  db();
  const rows = await MediaStore.find().sort({ priority: 1, createdAt: 1 }).lean();
  return rows.map(publicStore);
}

export async function createStore(body = {}) {
  db();
  const cloudName = String(body.cloudName || "").trim();
  const apiKey = String(body.apiKey || "").trim();
  const apiSecret = String(body.apiSecret || "").trim();
  if (!cloudName || !apiKey || !apiSecret) throw new MediaError("Cần đủ Cloud name, API key và API secret");
  if (await MediaStore.findOne({ cloudName, apiKey })) throw new MediaError("Kho này đã được thêm", 409);

  let usage = null;
  let note = "";
  try {
    usage = await fetchUsage({ cloudName, apiKey, apiSecret, fullPercent: body.fullPercent });
  } catch (e) {
    if (!e.permission) throw new MediaError(`Không xác thực được kho: ${e.message}`, e.status || 400);
    /* Key khong co quyen doc Admin API: van chap nhan neu key ghi duoc */
    await verifyUploadCredentials({ cloudName, apiKey, apiSecret });
    note = e.message;
  }

  const s = await MediaStore.create({
    name: String(body.name || `Kho ${cloudName}`).trim().slice(0, 60),
    cloudName,
    apiKey,
    apiSecret,
    folder: String(body.folder || "mail-chat").trim().slice(0, 60),
    fullPercent: Math.min(100, Math.max(10, Number(body.fullPercent) || FULL_AT)),
    enabled: body.enabled !== false,
    priority: Number(body.priority) || 100,
    usage,
    usageAt: new Date(),
    full: !!usage?.full,
    lastError: note,
  });
  return publicStore(s.toObject());
}

export async function updateStore(id, body = {}) {
  db();
  const set = {};
  if (typeof body.name === "string") set.name = body.name.trim().slice(0, 60);
  if (typeof body.folder === "string") set.folder = body.folder.trim().slice(0, 60);
  if (typeof body.enabled === "boolean") set.enabled = body.enabled;
  if (body.fullPercent !== undefined) {
    set.fullPercent = Math.min(100, Math.max(10, Number(body.fullPercent) || FULL_AT));
  }
  if (body.priority !== undefined) set.priority = Number(body.priority) || 100;
  if (typeof body.apiSecret === "string" && body.apiSecret.trim() && !body.apiSecret.includes("•")) {
    set.apiSecret = body.apiSecret.trim();
  }
  if (typeof body.apiKey === "string" && body.apiKey.trim() && !body.apiKey.includes("•")) {
    set.apiKey = body.apiKey.trim();
  }
  if (typeof body.cloudName === "string" && body.cloudName.trim()) set.cloudName = body.cloudName.trim();
  if (body.resetFull) set.full = false;
  if (!Object.keys(set).length) throw new MediaError("Không có gì để cập nhật");
  const s = await MediaStore.findByIdAndUpdate(id, set, { new: true }).lean();
  if (!s) throw new MediaError("Không tìm thấy kho ảnh", 404);
  return publicStore(s);
}

export async function deleteStore(id) {
  db();
  const s = await MediaStore.findByIdAndDelete(id);
  if (!s) throw new MediaError("Không tìm thấy kho ảnh", 404);
  return { ok: true };
}

export async function hasUsableStore() {
  if (!MediaStore) return false;
  return (await MediaStore.countDocuments({ enabled: true })) > 0;
}

/* ========================================================== Upload */
/** Danh sach kho uu tien: kho chua day truoc, kho da day de cuoi (thu lai) */
async function candidateStores() {
  db();
  const rows = await MediaStore.find({ enabled: true }).sort({ priority: 1, createdAt: 1 });
  if (!rows.length) throw new MediaError("Chưa cấu hình kho ảnh Cloudinary. Vào trang quản trị → Kho ảnh để thêm.", 503);

  const fresh = [];
  for (const s of rows) {
    const stale = !s.usageAt || Date.now() - new Date(s.usageAt).getTime() > USAGE_TTL;
    if (stale) {
      try {
        const usage = await fetchUsage(s);
        s.usage = usage;
        s.usageAt = new Date();
        s.full = !!usage.full;
        s.lastError = "";
        await s.save();
      } catch (e) {
        s.lastError = e.message;
        s.usageAt = new Date();
        await s.save().catch(() => { });
      }
    }
    fresh.push(s);
  }
  /* Kho chua day len truoc, kho day xuong duoi (van thu de khong mat anh) */
  return [...fresh.filter((s) => !s.full), ...fresh.filter((s) => s.full)];
}

async function uploadToStore(store, { buffer, mime, filename, folder, resourceType = "image" }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { folder: folder || store.folder || "mail-chat", timestamp };
  const signature = signParams(params, store.apiSecret);

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime || "image/jpeg" }), filename || "image.jpg");
  form.append("api_key", store.apiKey);
  form.append("timestamp", String(timestamp));
  form.append("folder", params.folder);
  form.append("signature", signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(store.cloudName)}/${resourceType}/upload`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  const raw = await res.text();
  let d = {};
  try {
    d = JSON.parse(raw);
  } catch { }
  if (!res.ok) {
    const msg = d?.error?.message || `Cloudinary lỗi ${res.status}`;
    const quota = res.status === 420 || res.status === 403 || /quota|limit|storage|exceed/i.test(msg);
    const err = new MediaError(msg, res.status);
    err.quota = quota;
    throw err;
  }
  return {
    url: d.secure_url,
    publicId: d.public_id,
    width: d.width || 0,
    height: d.height || 0,
    bytes: d.bytes || 0,
    format: d.format || "",
  };
}

/**
 * Day anh len kho kha dung. Kho nay day/loi -> tu dong thu kho ke tiep.
 * Tra ve { url, publicId, width, height, bytes, storeId, storeName }.
 */
export async function uploadImage({ buffer, mime, filename, folder }) {
  if (!buffer?.length) throw new MediaError("Ảnh trống");
  if (buffer.length > MAX_BYTES) {
    throw new MediaError(`Ảnh quá lớn (tối đa ${Math.round(MAX_BYTES / 1024 / 1024)}MB)`, 413);
  }
  if (mime && !/^image\/(jpeg|png|webp|gif|avif|bmp|heic|heif)$/i.test(mime)) {
    throw new MediaError("Chỉ nhận tệp ảnh");
  }

  const stores = await candidateStores();
  const errors = [];
  for (const store of stores) {
    try {
      const out = await uploadToStore(store, { buffer, mime, filename, folder });
      store.uploads = Number(store.uploads || 0) + 1;
      store.lastError = "";
      await store.save().catch(() => { });
      return { ...out, storeId: String(store._id), storeName: store.name || store.cloudName };
    } catch (e) {
      errors.push(`${store.name || store.cloudName}: ${e.message}`);
      if (e.quota) {
        store.full = true;
        store.usageAt = new Date();
      }
      store.lastError = e.message;
      await store.save().catch(() => { });
      /* Kho day hoac loi -> thu kho tiep theo */
    }
  }
  throw new MediaError(`Tất cả kho ảnh đều không nhận được ảnh. ${errors.join(" | ")}`, 507);
}

/**
 * Day file nhac (mp3/m4a/…) len kho Cloudinary duoi resource_type=video.
 * Tra ve { url, publicId, bytes, format, storeId, storeName }.
 */
export async function uploadAudio({ buffer, mime, filename }) {
  if (!buffer?.length) throw new MediaError("Tệp nhạc trống");
  if (buffer.length > AUDIO_MAX_BYTES) {
    throw new MediaError(`Tệp nhạc quá lớn (tối đa ${Math.round(AUDIO_MAX_BYTES / 1024 / 1024)}MB)`, 413);
  }
  if (mime && !/^(audio|video)\//i.test(mime)) throw new MediaError("Chỉ nhận tệp âm thanh");

  const stores = await candidateStores();
  const errors = [];
  for (const store of stores) {
    try {
      const out = await uploadToStore(store, {
        buffer,
        mime: mime || "audio/mpeg",
        filename: filename || "nhac.mp3",
        folder: (store.folder || "mail-chat") + "/music",
        resourceType: "video",
      });
      store.uploads = Number(store.uploads || 0) + 1;
      store.lastError = "";
      await store.save().catch(() => { });
      return { ...out, storeId: String(store._id), storeName: store.name || store.cloudName };
    } catch (e) {
      errors.push(`${store.name || store.cloudName}: ${e.message}`);
      if (e.quota) {
        store.full = true;
        store.usageAt = new Date();
      }
      store.lastError = e.message;
      await store.save().catch(() => { });
    }
  }
  throw new MediaError(`Không tải được nhạc lên kho. ${errors.join(" | ")}`, 507);
}

/** Chi cho phep luu link anh do chinh Cloudinary tra ve */
export const isCloudinaryUrl = (u = "") => /^https:\/\/res\.cloudinary\.com\/[\w-]+\//.test(String(u));
