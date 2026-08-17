/**
 * Luu tru chat + tai khoan — CHI dung MongoDB (mongoose).
 * Bat buoc co MONGODB_URI (hoac MONGO_URL).
 *
 * Collections: users | conversations | messages
 * Ho tro: sua/xoa tin nhan, quan ly nhom, trang thai online (presence).
 */
import crypto from "node:crypto";
import { randomAvatar, randomGroupAvatar, giftByKey, reactionByKey } from "./assets.js";

const now = () => new Date();
const iso = (d) => (d instanceof Date ? d.toISOString() : d);

export const BOT_NAME = "Trợ lý Mail OTP";
/* Tai khoan quan tri he thong + nhom thong bao ghim tren cung */
export const ADMIN_NAME = (process.env.ADMIN_NAME || "Admin").trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
export const ANNOUNCEMENT_TITLE = (process.env.ANNOUNCEMENT_TITLE || "📢 Thông báo").trim();
export const ONLINE_WINDOW_MS = 60000;

let User = null;
let Conversation = null;
let Message = null;
let connected = false;

/* ============================================== Presence (bo nho trong) */
const liveSockets = new Map(); // userId -> so socket dang mo

export function presenceAdd(userId) {
  const id = String(userId);
  liveSockets.set(id, (liveSockets.get(id) || 0) + 1);
  return liveSockets.get(id);
}
export function presenceRemove(userId) {
  const id = String(userId);
  const n = (liveSockets.get(id) || 1) - 1;
  if (n <= 0) liveSockets.delete(id);
  else liveSockets.set(id, n);
  return Math.max(0, n);
}

/**
 * Trang thai hoat dong = SU THAT DUY NHAT.
 * - Chi coi la online khi dang co socket mo (liveSockets) HOAC co "online: true"
 *   trong DB do tien trinh khac dang giu ket noi va lastSeen con moi.
 * - Khi user thoat, ta ghi online:false vao DB ngay -> tai lai trang KHONG con
 *   thay "dang hoat dong" roi moi tat (loi cu do dua vao cua so 60s lastSeen).
 */
export function isOnline(user) {
  if (!user) return false;
  if (user.isBot) return true;
  const id = String(user._id || user.id || user);
  if (liveSockets.has(id)) return true;
  if (user.online !== true) return false;
  const seen = new Date(user.lastSeen || 0).getTime();
  return Date.now() - seen < ONLINE_WINDOW_MS;
}
export const onlineUserIds = () => [...liveSockets.keys()];
/** Nguoi nay dang mo it nhat 1 socket? (dung de bo qua emit vo ich) */
export const hasLiveSocket = (userId) => liveSockets.has(String(userId));

/** Ghi thang trang thai online vao DB (goi khi socket connect/disconnect). */
export async function setUserOnline(userId, online) {
  db();
  await User.findByIdAndUpdate(userId, { online: !!online, lastSeen: now() }).catch(() => { });
}

/** Server vua khoi dong lai -> khong con ai dang ket noi. */
export async function resetPresence() {
  db();
  liveSockets.clear();
  await User.updateMany({ isBot: { $ne: true } }, { online: false }).catch(() => { });
}

/* ================================================================= Mongo */
export async function initChatStore() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URL || "";
  if (!uri) {
    throw new Error(
      "Thiếu MONGODB_URI. Chat lưu trực tiếp vào MongoDB nên bắt buộc phải có connection string.\n" +
      '  Ví dụ: MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net" npm start\n' +
      "  hoặc tạo file .env ở gốc dự án (xem .env.example)."
    );
  }

  const mongoose = (await import("mongoose")).default;
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, {
    dbName: process.env.MONGODB_DB || "mail_chat",
    serverSelectionTimeoutMS: Number(process.env.MONGODB_TIMEOUT_MS || 15000),
  });

  const UserSchema = new mongoose.Schema({
    name: String,
    nameLower: { type: String, index: true, unique: true },
    passHash: String,
    salt: String,
    avatarUrl: String,
    isBot: { type: Boolean, default: false },
    isAdmin: { type: Boolean, default: false },
    tokens: { type: [String], default: [], index: true },
    online: { type: Boolean, default: false },
    createdAt: { type: Date, default: now },
    lastSeen: { type: Date, default: now },
    /* --- Trang ca nhan --- */
    bio: { type: String, default: "" },
    birthday: { type: String, default: "" }, // YYYY-MM-DD
    gender: { type: String, default: "" }, // male | female | other | ""
    hobbies: { type: [String], default: [] },
    location: { type: String, default: "" },
    note: { type: String, default: "" },
    /* Noi song: chon theo Tinh/Thanh - Quan/Huyen - Phuong/Xa */
    province: { type: String, default: "" },
    district: { type: String, default: "" },
    ward: { type: String, default: "" },
    addressLine: { type: String, default: "" },
    phone: { type: String, default: "" },
    job: { type: String, default: "" },
    school: { type: String, default: "" },
    relationship: { type: String, default: "" },
    photos: { type: [String], default: [] },
    /* Nhac ca nhan: lay tu TikTok hoac tai tu may */
    music: {
      type: new mongoose.Schema(
        {
          url: { type: String, default: "" },      // link phat truc tiep
          title: { type: String, default: "" },
          author: { type: String, default: "" },
          cover: { type: String, default: "" },
          source: { type: String, default: "" },   // tiktok | upload
          sourceUrl: { type: String, default: "" },// link TikTok goc
          proxy: { type: Boolean, default: false },// phat qua proxy cua server
        },
        { _id: false }
      ),
      default: null,
    },
  });

  const ReactionSchema = new mongoose.Schema(
    { key: String, url: String, userId: String, userName: String, at: { type: Date, default: now } },
    { _id: false }
  );

  const MessageSchema = new mongoose.Schema({
    conversationId: { type: String },
    senderId: String,
    senderName: String,
    avatarUrl: String,
    type: { type: String, default: "text" }, // text | image | gift | icon | system
    text: { type: String, default: "" },
    iconUrl: { type: String, default: "" },
    iconKey: { type: String, default: "" },
    giftLabel: { type: String, default: "" },
    /* Anh: chi luu LINK Cloudinary, khong luu file trong MongoDB */
    imageUrl: { type: String, default: "" },
    imageWidth: { type: Number, default: 0 },
    imageHeight: { type: Number, default: 0 },
    imagePublicId: { type: String, default: "" },
    imageStore: { type: String, default: "" },
    reactions: { type: [ReactionSchema], default: [] },
    readBy: { type: [String], default: [] },
    editedAt: { type: Date, default: null },
    deleted: { type: Boolean, default: false },
    createdAt: { type: Date, default: now },
  });

  /* Chi so THUC SU can:
     - (conversationId, createdAt, _id): phan trang tin nhan + lay tin cuoi cung.
     - (conversationId, senderId, readBy): dem so tin chua doc.
     - (members, updatedAt): danh sach hoi thoai cua mot nguoi.   */
  MessageSchema.index({ conversationId: 1, createdAt: -1, _id: -1 });
  MessageSchema.index({ conversationId: 1, senderId: 1, readBy: 1 });

  const ConversationSchema = new mongoose.Schema({
    title: String,
    avatarUrl: String,
    isGroup: { type: Boolean, default: false },
    members: { type: [String], default: [] },
    admins: { type: [String], default: [] },
    createdBy: String,
    /* Nhom thong bao: chi quan tri duoc nhan, moi nguoi chi doc + tha cam xuc */
    announcement: { type: Boolean, default: false },
    pinned: { type: Boolean, default: false },
    updatedAt: { type: Date, default: now },
  });

  ConversationSchema.index({ members: 1, updatedAt: -1 });

  User = mongoose.models.User || mongoose.model("User", UserSchema);
  Conversation = mongoose.models.Conversation || mongoose.model("Conversation", ConversationSchema);
  Message = mongoose.models.Message || mongoose.model("Message", MessageSchema);

  await Promise.all([User.init(), Conversation.init(), Message.init()]);

  connected = true;
  console.log(`  [chat] MongoDB đã kết nối (db: ${mongoose.connection.name})`);

  mongoose.connection.on("disconnected", () => {
    connected = false;
    console.log("  [chat] MongoDB mất kết nối, đang thử kết nối lại…");
  });
  mongoose.connection.on("connected", () => {
    connected = true;
  });

  await ensureBot();
  await ensureAnnouncementConversation();
  return "mongo";
}

export const storeMode = () => (connected ? "mongo" : "mongo-offline");

function db() {
  if (!User) throw new Error("Chat store chưa khởi tạo (MongoDB).");
}

/* ============================================================ Mat khau */
function hashPass(password, salt = crypto.randomBytes(16).toString("hex")) {
  const passHash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, passHash };
}
function verifyPass(password, salt, passHash) {
  if (!salt || !passHash) return false;
  const a = Buffer.from(crypto.scryptSync(String(password), salt, 64).toString("hex"));
  const b = Buffer.from(passHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const newToken = () => crypto.randomBytes(32).toString("hex");

/* ============================================================== Users */
const publicUser = (u) => ({
  id: String(u._id),
  name: u.name,
  avatarUrl: u.avatarUrl,
  isBot: !!u.isBot,
  isAdmin: !!u.isAdmin,
  online: isOnline(u),
  lastSeen: iso(u.lastSeen || null),
  createdAt: iso(u.createdAt || null),
  bio: u.bio || "",
  birthday: u.birthday || "",
  gender: u.gender || "",
  hobbies: Array.isArray(u.hobbies) ? u.hobbies : [],
  location: u.location || "",
  note: u.note || "",
  province: u.province || "",
  district: u.district || "",
  ward: u.ward || "",
  addressLine: u.addressLine || "",
  phone: u.phone || "",
  job: u.job || "",
  school: u.school || "",
  relationship: u.relationship || "",
  photos: Array.isArray(u.photos) ? u.photos : [],
  music: u.music && u.music.url
    ? {
      url: u.music.url,
      title: u.music.title || "",
      author: u.music.author || "",
      cover: u.music.cover || "",
      source: u.music.source || "",
      sourceUrl: u.music.sourceUrl || "",
      proxy: !!u.music.proxy,
    }
    : null,
});

export async function findUserByName(name) {
  db();
  const key = String(name || "").trim().toLowerCase();
  if (!key) return null;
  return await User.findOne({ nameLower: key }).lean();
}

export async function getUser(id) {
  db();
  if (!id) return null;
  try {
    return await User.findById(id).lean();
  } catch {
    return null;
  }
}

export async function createUser({ name, password, isBot = false }) {
  db();
  const clean = String(name || "").trim().replace(/\s+/g, " ");
  const { salt, passHash } = isBot ? { salt: "", passHash: "" } : hashPass(password);
  const saved = await User.create({
    name: clean,
    nameLower: clean.toLowerCase(),
    salt,
    passHash,
    avatarUrl: randomAvatar(clean),
    isBot,
    tokens: [],
    createdAt: now(),
    lastSeen: now(),
  });
  if (!isBot) {
    await Conversation.updateOne(
      { announcement: true },
      { $addToSet: { members: String(saved._id) } }
    ).catch(() => { });
  }
  return saved.toObject();
}

export async function updateAvatar(userId, avatarUrl) {
  db();
  const u = await User.findByIdAndUpdate(userId, { avatarUrl }, { new: true }).lean();
  if (!u) return null;
  await Message.updateMany({ senderId: String(userId) }, { avatarUrl });
  return publicUser(u);
}

/** Cap nhat trang ca nhan (ngay sinh, so thich, ghi chu, ...). */
export async function updateProfile(userId, patch) {
  db();
  const set = {};
  if (typeof patch.bio === "string") set.bio = patch.bio.slice(0, 300);
  if (typeof patch.note === "string") set.note = patch.note.slice(0, 300);
  if (typeof patch.location === "string") set.location = patch.location.slice(0, 160);
  for (const k of ["province", "district", "ward"]) {
    if (typeof patch[k] === "string") set[k] = patch[k].slice(0, 60);
  }
  if (typeof patch.addressLine === "string") set.addressLine = patch.addressLine.slice(0, 80);
  if (typeof patch.phone === "string") set.phone = patch.phone.slice(0, 20);
  if (typeof patch.job === "string") set.job = patch.job.slice(0, 60);
  if (typeof patch.school === "string") set.school = patch.school.slice(0, 80);
  if (typeof patch.relationship === "string") set.relationship = patch.relationship.slice(0, 20);
  if (Array.isArray(patch.photos)) set.photos = patch.photos.filter((x) => typeof x === "string").slice(0, 12);
  /* Noi song hien thi = Xa, Huyen, Tinh (bo phan trong) */
  if (["province", "district", "ward", "addressLine"].some((k) => typeof patch[k] === "string")) {
    const parts = [
      set.addressLine ?? patch.addressLine,
      set.ward ?? patch.ward,
      set.district ?? patch.district,
      set.province ?? patch.province,
    ]
      .map((x) => String(x || "").trim())
      .filter(Boolean);
    if (parts.length) set.location = parts.join(", ").slice(0, 160);
  }
  if (patch.music === null) set.music = null;
  else if (patch.music && typeof patch.music === "object" && patch.music.url) {
    const m = patch.music;
    set.music = {
      url: String(m.url).slice(0, 800),
      title: String(m.title || "").slice(0, 120),
      author: String(m.author || "").slice(0, 80),
      cover: String(m.cover || "").slice(0, 800),
      source: String(m.source || "").slice(0, 20),
      sourceUrl: String(m.sourceUrl || "").slice(0, 500),
      proxy: !!m.proxy,
    };
  }
  if (typeof patch.birthday === "string") set.birthday = patch.birthday.slice(0, 10);
  if (typeof patch.gender === "string") set.gender = patch.gender.slice(0, 10);
  if (Array.isArray(patch.hobbies)) {
    set.hobbies = patch.hobbies
      .map((h) => String(h).trim().slice(0, 30))
      .filter(Boolean)
      .slice(0, 12);
  }
  if (typeof patch.name === "string" && patch.name.trim()) {
    const clean = patch.name.trim().replace(/\s+/g, " ").slice(0, 24);
    set.name = clean;
    set.nameLower = clean.toLowerCase();
  }
  if (!Object.keys(set).length) return null;
  const u = await User.findByIdAndUpdate(userId, set, { new: true }).lean();
  if (!u) return null;
  if (set.name) await Message.updateMany({ senderId: String(userId) }, { senderName: set.name });
  return publicUser(u);
}

export async function issueToken(userId) {
  db();
  const token = newToken();
  const u = await User.findByIdAndUpdate(
    userId,
    { $push: { tokens: { $each: [token], $slice: -20 } }, lastSeen: now() },
    { new: true }
  );
  return u ? token : null;
}

export async function revokeToken(token) {
  db();
  if (!token) return;
  await User.updateMany({ tokens: token }, { $pull: { tokens: token } });
}

export async function userByToken(token) {
  db();
  if (!token) return null;
  return await User.findOne({ tokens: token }).lean();
}

export async function touchUser(userId) {
  db();
  await User.findByIdAndUpdate(userId, { lastSeen: now() });
}

export async function listUsers(exceptId, { includeAdmin = false, q = "", limit = 0 } = {}) {
  db();
  /* Loc ngay trong MongoDB (nameLower da co index) thay vi tai toan bo roi loc o Node */
  const where = { _id: { $ne: exceptId } };
  if (!includeAdmin) where.isAdmin = { $ne: true };
  const key = String(q || "").trim().toLowerCase();
  if (key) where.nameLower = { $regex: key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") };
  let query = User.find(where).sort({ name: 1 });
  if (limit > 0) query = query.limit(limit);
  const rows = await query.lean();
  return rows.map(publicUser);
}

async function ensureBot() {
  let bot = await findUserByName(BOT_NAME);
  if (!bot) bot = await createUser({ name: BOT_NAME, password: newToken(), isBot: true });
  return bot;
}

export async function getBot() {
  return await ensureBot();
}

/* ================================================ Quan tri + Thong bao */
async function ensureAdmin() {
  let admin = await findUserByName(ADMIN_NAME);
  if (!admin) admin = await createUser({ name: ADMIN_NAME, password: ADMIN_PASSWORD });
  const patch = { isAdmin: true };
  if (process.env.ADMIN_PASSWORD) Object.assign(patch, hashPass(ADMIN_PASSWORD));
  await User.findByIdAndUpdate(admin._id, patch).catch(() => { });
  return await User.findById(admin._id).lean();
}

export async function getAdminUser() {
  db();
  return await User.findOne({ isAdmin: true }).lean();
}

/** Nhom thong bao: tat ca nguoi dung deu la thanh vien, chi admin duoc nhan. */
export async function ensureAnnouncementConversation() {
  db();
  const admin = await ensureAdmin();
  const adminId = String(admin._id);
  const everyone = (await User.find({ isBot: { $ne: true } }, { _id: 1 }).lean()).map((u) => String(u._id));

  let conv = await Conversation.findOne({ announcement: true }).lean();
  if (!conv) {
    const created = await Conversation.create({
      title: ANNOUNCEMENT_TITLE,
      avatarUrl: randomGroupAvatar(ANNOUNCEMENT_TITLE),
      isGroup: true,
      announcement: true,
      members: everyone,
      admins: [adminId],
      createdBy: adminId,
      pinned: true,
      updatedAt: now(),
    });
    conv = created.toObject();
    await Message.create({
      conversationId: String(conv._id),
      senderId: adminId,
      senderName: admin.name,
      avatarUrl: admin.avatarUrl,
      type: "system",
      text: "Đây là nhóm thông báo chung. Chỉ quản trị viên được đăng tin; mọi người có thể xem và thả cảm xúc.",
      createdAt: now(),
    });
  } else {
    await Conversation.updateOne(
      { _id: conv._id },
      {
        $addToSet: { members: { $each: everyone }, admins: adminId },
        $set: { pinned: true, isGroup: true },
      }
    );
    conv = await Conversation.findById(conv._id).lean();
  }
  return { ...conv, id: String(conv._id) };
}

export async function getAnnouncementConversation() {
  db();
  const c = await Conversation.findOne({ announcement: true }).lean();
  return c ? { ...c, id: String(c._id) } : null;
}

/** Ai duoc dang tin trong hoi thoai nay? */
export function canPostIn(conv, user) {
  if (!conv?.announcement) return true;
  return !!(user && (user.isAdmin || user.isBot));
}

/* ====================================================== Conversations */
export async function createConversation({ title = "", avatarUrl = "", isGroup = false, members = [], createdBy = "" }) {
  db();
  const uniq = Array.from(new Set(members.map(String)));
  const doc = {
    title,
    avatarUrl: avatarUrl || (isGroup ? randomGroupAvatar(title) : ""),
    isGroup: !!isGroup,
    members: uniq,
    admins: createdBy ? [String(createdBy)] : [],
    createdBy: String(createdBy || ""),
    pinned: false,
    updatedAt: now(),
  };
  const saved = await Conversation.create(doc);
  return { id: String(saved._id), ...doc, updatedAt: iso(doc.updatedAt) };
}

export async function findDirectConversation(a, b) {
  db();
  const pair = [String(a), String(b)];
  const c = await Conversation.findOne({ isGroup: false, members: { $all: pair, $size: 2 } }).lean();
  return c ? { id: String(c._id), ...c } : null;
}

export async function getConversationRaw(id) {
  db();
  try {
    const c = await Conversation.findById(id).lean();
    return c ? { ...c, id: String(c._id) } : null;
  } catch {
    return null;
  }
}

export async function addMembers(conversationId, userIds) {
  db();
  const ids = userIds.map(String);
  const c = await Conversation.findByIdAndUpdate(conversationId, { $addToSet: { members: { $each: ids } } });
  return !!c;
}

export async function removeMember(conversationId, userId) {
  db();
  const c = await Conversation.findByIdAndUpdate(
    conversationId,
    { $pull: { members: String(userId), admins: String(userId) } },
    { new: true }
  ).lean();
  return c ? { ...c, id: String(c._id) } : null;
}

export async function updateConversation(conversationId, patch) {
  db();
  const set = {};
  if (typeof patch.title === "string") set.title = patch.title;
  if (typeof patch.avatarUrl === "string" && patch.avatarUrl) set.avatarUrl = patch.avatarUrl;
  if (typeof patch.pinned === "boolean") set.pinned = patch.pinned;
  if (!Object.keys(set).length) return null;
  const c = await Conversation.findByIdAndUpdate(conversationId, set, { new: true }).lean();
  return c ? { ...c, id: String(c._id) } : null;
}

export async function deleteConversation(conversationId) {
  db();
  await Message.deleteMany({ conversationId: String(conversationId) });
  await Conversation.findByIdAndDelete(conversationId);
  return true;
}

/* =========================================================== Messages */
export async function addMessage(m) {
  db();
  const asset = m.iconUrl ? null : giftByKey(m.iconKey) || reactionByKey(m.iconKey);
  const doc = {
    conversationId: String(m.conversationId),
    senderId: String(m.senderId || ""),
    senderName: m.senderName || "",
    avatarUrl: m.avatarUrl || "",
    type: m.type || "text",
    text: m.text || "",
    iconUrl: m.iconUrl || asset?.url || "",
    iconKey: m.iconKey || "",
    giftLabel: m.giftLabel || asset?.label || "",
    imageUrl: m.imageUrl || "",
    imageWidth: Number(m.imageWidth || 0),
    imageHeight: Number(m.imageHeight || 0),
    imagePublicId: m.imagePublicId || "",
    imageStore: m.imageStore || "",
    reactions: [],
    readBy: m.readBy || [],
    editedAt: null,
    deleted: false,
    createdAt: m.createdAt ? new Date(m.createdAt) : now(),
  };
  const saved = await Message.create(doc);
  await Conversation.findByIdAndUpdate(doc.conversationId, { updatedAt: doc.createdAt });
  return serializeMessage(saved.toObject());
}

function serializeMessage(m) {
  return {
    id: String(m._id),
    conversationId: String(m.conversationId),
    senderId: String(m.senderId),
    senderName: m.senderName,
    avatarUrl: m.avatarUrl,
    type: m.type,
    text: m.deleted ? "" : m.text,
    iconUrl: m.deleted ? "" : m.iconUrl,
    iconKey: m.deleted ? "" : m.iconKey,
    giftLabel: m.deleted ? "" : m.giftLabel,
    imageUrl: m.deleted ? "" : m.imageUrl || "",
    imageWidth: m.imageWidth || 0,
    imageHeight: m.imageHeight || 0,
    reactions: (m.reactions || []).map((r) => ({ ...r, at: iso(r.at) })),
    readBy: m.readBy || [],
    edited: !!m.editedAt,
    editedAt: iso(m.editedAt || null),
    deleted: !!m.deleted,
    createdAt: iso(m.createdAt),
  };
}

export async function getMessage(id) {
  db();
  try {
    const m = await Message.findById(id).lean();
    return m ? serializeMessage(m) : null;
  } catch {
    return null;
  }
}

/**
 * Lay tin nhan theo con tro (cursor) — KHONG dung offset.
 * - Mac dinh tra ve "limit" tin MOI NHAT, sap xep tang dan theo thoi gian.
 * - Truyen "before" = id tin nhan cu nhat dang hien -> lay tiep trang cu hon.
 * Tra ve { items, hasMore } de client biet con tin cu hay khong.
 */
export async function listMessagesPage(conversationId, { limit = 40, before = "" } = {}) {
  db();
  const take = Math.min(Math.max(Number(limit) || 40, 1), 200);
  const where = { conversationId: String(conversationId) };

  if (before) {
    const anchor = await Message.findById(before).select({ createdAt: 1 }).lean().catch(() => null);
    if (anchor) {
      where.$or = [
        { createdAt: { $lt: anchor.createdAt } },
        { createdAt: anchor.createdAt, _id: { $lt: anchor._id } },
      ];
    }
  }

  /* Lay them 1 ban ghi de biet con trang cu hay khong (khong can count) */
  const rows = await Message.find(where)
    .sort({ createdAt: -1, _id: -1 })
    .limit(take + 1)
    .lean();

  const hasMore = rows.length > take;
  if (hasMore) rows.pop();
  rows.reverse();
  return { items: rows.map(serializeMessage), hasMore };
}

/** Tuong thich nguoc: van tra ve MANG tin nhan (moi nhat, tang dan theo thoi gian). */
export async function listMessages(conversationId, limit = 300) {
  const { items } = await listMessagesPage(conversationId, { limit });
  return items;
}

export async function editMessage(messageId, text) {
  db();
  try {
    const m = await Message.findByIdAndUpdate(
      messageId,
      { text: String(text).slice(0, 2000), editedAt: now() },
      { new: true }
    ).lean();
    return m ? serializeMessage(m) : null;
  } catch {
    return null;
  }
}

/** Xoa mem: giu vet "tin nhan da bi thu hoi" */
export async function softDeleteMessage(messageId) {
  db();
  try {
    const m = await Message.findByIdAndUpdate(
      messageId,
      { deleted: true, text: "", iconUrl: "", iconKey: "", giftLabel: "", imageUrl: "", imagePublicId: "", reactions: [] },
      { new: true }
    ).lean();
    return m ? serializeMessage(m) : null;
  } catch {
    return null;
  }
}

export async function markRead(conversationId, userId) {
  db();
  await Message.updateMany(
    { conversationId: String(conversationId), senderId: { $ne: String(userId) }, readBy: { $ne: String(userId) } },
    { $addToSet: { readBy: String(userId) } }
  );
  return true;
}

export async function toggleReaction(messageId, { key, url, userId, userName }) {
  db();
  let doc = null;
  try {
    doc = await Message.findById(messageId);
  } catch {
    return null;
  }
  if (!doc || doc.deleted) return null;
  const i = doc.reactions.findIndex((r) => r.userId === String(userId));
  const entry = { key, url, userId: String(userId), userName: userName || "", at: now() };
  if (i >= 0 && doc.reactions[i].key === key) doc.reactions.splice(i, 1);
  else if (i >= 0) doc.reactions[i] = entry;
  else doc.reactions.push(entry);
  await doc.save();
  return serializeMessage(doc.toObject());
}

/* ================================================== Conversation views */
function previewOf(last) {
  if (!last) return "";
  if (last.deleted) return "Tin nhắn đã bị thu hồi";
  if (last.type === "gift") return `Đã gửi ${last.giftLabel || "một món quà"}`;
  if (last.type === "icon") return "Đã gửi một biểu tượng";
  if (last.type === "image") return "Đã gửi một ảnh";
  return last.text;
}

/** Nap nhieu user 1 lan (tranh N+1 getUser trong vong lap) */
async function usersMap(ids) {
  db();
  const uniq = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!uniq.length) return new Map();
  const valid = uniq.filter((id) => /^[a-f\d]{24}$/i.test(id));
  if (!valid.length) return new Map();
  const rows = await User.find({ _id: { $in: valid } }).lean();
  return new Map(rows.map((u) => [String(u._id), u]));
}

/**
 * Dung view tu du lieu DA CO san (khong query them) — nho vay
 * listConversations chi can 4 query cho toan bo danh sach.
 */
function buildViewSync(c, userId, { last = null, unread = 0, users = new Map() } = {}) {
  const meId = String(userId);
  const viewer = users.get(meId) || null;

  let title = c.title;
  let avatarUrl = c.avatarUrl;
  let online = false;
  let otherId = "";
  let lastSeen = null;
  let adminDirect = false;

  if (!c.isGroup) {
    otherId = (c.members || []).find((m) => String(m) !== meId) || "";
    const other = users.get(String(otherId)) || null;
    adminDirect = !!other?.isAdmin && !viewer?.isAdmin;
    title = other?.name || c.title || "Người dùng";
    avatarUrl = other?.avatarUrl || c.avatarUrl;
    online = isOnline(other);
    lastSeen = iso(other?.lastSeen || null);
  }

  const members = [];
  for (const id of c.members || []) {
    const u = users.get(String(id));
    if (u) members.push(publicUser(u));
  }

  return {
    id: c.id,
    title,
    avatarUrl,
    isGroup: !!c.isGroup,
    online,
    lastSeen,
    otherId,
    createdBy: String(c.createdBy || ""),
    announcement: !!c.announcement,
    adminDirect,
    canPost: !adminDirect && (!c.announcement || !!viewer?.isAdmin),
    admins: (c.admins || []).map(String),
    isAdmin: (c.admins || []).map(String).includes(meId),
    pinned: !!c.pinned,
    memberCount: (c.members || []).length,
    members,
    unread,
    updatedAt: iso(c.updatedAt),
    last: last
      ? {
        id: last.id,
        preview: previewOf(last),
        fromMe: last.senderId === meId,
        senderName: last.senderName,
        iconUrl: last.iconUrl || "",
        createdAt: last.createdAt,
      }
      : null,
  };
}

/** Tin nhan cuoi cung cua 1 hoi thoai — dung index (conversationId, createdAt) */
async function lastMessageOf(conversationId) {
  const m = await Message.find({ conversationId: String(conversationId) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(1)
    .lean();
  return m[0] ? serializeMessage(m[0]) : null;
}

/** So tin chua doc cua 1 hoi thoai — countDocuments, khong tai tin nhan */
async function unreadOf(conversationId, userId) {
  return await Message.countDocuments({
    conversationId: String(conversationId),
    senderId: { $ne: String(userId) },
    readBy: { $ne: String(userId) },
  });
}

export async function conversationView(conversationId, userId) {
  db();
  const c = await getConversationRaw(conversationId);
  if (!c || !c.members.includes(String(userId))) return null;
  const [last, unread, users] = await Promise.all([
    lastMessageOf(c.id),
    unreadOf(c.id, userId),
    usersMap([String(userId), ...(c.members || [])]),
  ]);
  return buildViewSync(c, userId, { last, unread, users });
}

/**
 * TRUOC: N hoi thoai -> N * (300 tin nhan + nhieu getUser).
 * NAY:   1 query hoi thoai + 1 aggregate tin cuoi + 1 aggregate unread + 1 query user.
 */
export async function listConversations(userId) {
  db();
  const meId = String(userId);
  const rows = await Conversation.find({ members: meId })
    .sort({ announcement: -1, pinned: -1, updatedAt: -1 })
    .lean();
  if (!rows.length) return [];

  const ids = rows.map((r) => String(r._id));

  const [lastRows, unreadRows, users] = await Promise.all([
    Message.aggregate([
      { $match: { conversationId: { $in: ids } } },
      { $sort: { conversationId: 1, createdAt: -1, _id: -1 } },
      { $group: { _id: "$conversationId", doc: { $first: "$$ROOT" } } },
    ]),
    Message.aggregate([
      { $match: { conversationId: { $in: ids }, senderId: { $ne: meId }, readBy: { $ne: meId } } },
      { $group: { _id: "$conversationId", n: { $sum: 1 } } },
    ]),
    usersMap([meId, ...rows.flatMap((r) => r.members || [])]),
  ]);

  const lastMap = new Map(lastRows.map((r) => [String(r._id), serializeMessage(r.doc)]));
  const unreadMap = new Map(unreadRows.map((r) => [String(r._id), r.n]));

  return rows.map((r) =>
    buildViewSync({ ...r, id: String(r._id) }, meId, {
      last: lastMap.get(String(r._id)) || null,
      unread: unreadMap.get(String(r._id)) || 0,
      users,
    })
  );
}

/** Huy hieu tin chua doc: 2 query nho, khong dung lai listConversations nua. */
export async function totalUnread(userId) {
  db();
  const meId = String(userId);
  const ids = (await Conversation.find({ members: meId }, { _id: 1 }).lean()).map((c) => String(c._id));
  if (!ids.length) return 0;
  return await Message.countDocuments({
    conversationId: { $in: ids },
    senderId: { $ne: meId },
    readBy: { $ne: meId },
  });
}

export { verifyPass, hashPass, publicUser, serializeMessage };
