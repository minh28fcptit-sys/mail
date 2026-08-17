/**
 * Toan bo hanh dong chat (gui / sua / xoa / nhom / cam xuc).
 * Dung chung cho Socket.IO va REST -> logic & quyen han chi viet 1 lan.
 * Moi hanh dong tu phat su kien realtime cho cac thanh vien lien quan.
 */
import { emitToUsers } from "./bus.js";
import { uploadImage, uploadAudio, isCloudinaryUrl } from "./media.js";
import { resolveTiktokAudio, isProxyableAudio, isProxyableImage, TiktokError } from "./tiktok.js";
import { pushNewMessage, pushBadge } from "./push.js";
import {
  giftByKey,
  reactionByKey,
  randomGroupAvatar,
  isSafeAvatarUrl,
} from "./assets.js";
import {
  findUserByName,
  addMembers,
  addMessage,
  conversationView,
  createConversation,
  deleteConversation,
  editMessage,
  findDirectConversation,
  getConversationRaw,
  getMessage,
  getUser,
  listMessages,
  markRead,
  removeMember,
  softDeleteMessage,
  toggleReaction,
  totalUnread,
  updateAvatar,
  updateConversation,
  updateProfile,
  publicUser,
  listConversations,
  canPostIn,
  listMessagesPage,
  hasLiveSocket,
} from "./chat-store.js";

class ChatError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export { ChatError };

const uid = (u) => String(u._id || u.id);

async function loadConv(conversationId, user) {
  const conv = await getConversationRaw(conversationId);
  if (!conv || !conv.members.includes(uid(user))) throw new ChatError("Không tìm thấy hội thoại", 404);
  return conv;
}

/** Nhom thong bao bi khoa: chi quan tri he thong duoc thay doi thanh vien */
function requireNotLocked(conv, user) {
  if (conv?.announcement && !user?.isAdmin) {
    throw new ChatError("Nhóm thông báo do quản trị viên quản lý", 403);
  }
}

/** Hoi thoai rieng voi tai khoan quan tri: khong ai duoc nhan tin vao */
async function isDirectWithSystemAdmin(conv, user) {
  if (!conv || conv.isGroup || conv.announcement) return false;
  if (user?.isAdmin) return false;
  for (const id of conv.members || []) {
    if (String(id) === uid(user)) continue;
    const other = await getUser(String(id));
    if (other?.isAdmin) return true;
  }
  return false;
}

function isAdmin(conv, user) {
  if (conv.announcement) return !!user?.isAdmin;
  const admins = (conv.admins || []).map(String);
  /* Nhom khong con quan tri nao -> moi thanh vien deu co quyen quan tri */
  if (!admins.length) return (conv.members || []).map(String).includes(uid(user));
  return admins.includes(uid(user)) || String(conv.createdBy) === uid(user);
}

/** Bao cho tung thanh vien: hoi thoai vua doi + tong so tin chua doc */
async function pushConversation(conv, extraUserIds = []) {
  const ids = Array.from(new Set([...(conv.members || []).map(String), ...extraUserIds.map(String)]));
  const convId = String(conv.id || conv._id);
  /* Nguoi khong online se khong nhan duoc socket -> khong ton query dung view cho ho.
     Ho van thay dung so lieu ngay khi mo lai app (REST /conversations). */
  const live = ids.filter((id) => hasLiveSocket(id));
  await Promise.all(
    live.map(async (id) => {
      const [view, unreadTotal] = await Promise.all([
        conversationView(convId, id).catch(() => null),
        totalUnread(id).catch(() => 0),
      ]);
      emitToUsers([id], "conversation:update", {
        conversationId: convId,
        conversation: view,
        unreadTotal,
        removed: !view,
      });
    })
  );
}

/* ------------------------------------------------------------ Tin nhan */
export async function sendMessage(user, { conversationId, type = "text", text = "", key = "", image = null }) {
  const conv = await loadConv(conversationId, user);
  if (await isDirectWithSystemAdmin(conv, user)) {
    throw new ChatError("Tài khoản quản trị không nhận tin nhắn riêng. Vui lòng nhắn tin riêng với người khác hoặc tạo nhóm mới nhé.", 403);
  }
  if (!canPostIn(conv, user)) {
    throw new ChatError("Nhóm thông báo chỉ dành cho quản trị viên. Vui lòng nhắn tin riêng hoặc tạo nhóm mới nhé.", 403);
  }
  const kind = ["text", "gift", "icon", "image"].includes(type) ? type : "text";
  let iconUrl = "";
  let iconKey = "";
  let giftLabel = "";
  const clean = String(text || "").slice(0, 2000).trim();

  if (kind === "gift") {
    const g = giftByKey(key);
    if (!g) throw new ChatError("Quà không hợp lệ");
    ({ url: iconUrl, key: iconKey, label: giftLabel } = g);
  } else if (kind === "icon") {
    const r = reactionByKey(key);
    if (!r) throw new ChatError("Biểu tượng không hợp lệ");
    ({ url: iconUrl, key: iconKey, label: giftLabel } = r);
  } else if (kind === "image") {
    if (!image?.url || !isCloudinaryUrl(image.url)) throw new ChatError("Ảnh không hợp lệ");
  } else if (!clean) {
    throw new ChatError("Tin nhắn trống");
  }

  const saved = await addMessage({
    conversationId: conv.id,
    senderId: uid(user),
    senderName: user.name,
    avatarUrl: user.avatarUrl,
    type: kind,
    text: clean,
    iconUrl,
    iconKey,
    giftLabel,
    imageUrl: kind === "image" ? image.url : "",
    imageWidth: kind === "image" ? image.width : 0,
    imageHeight: kind === "image" ? image.height : 0,
    imagePublicId: kind === "image" ? image.publicId || "" : "",
    imageStore: kind === "image" ? image.storeName || "" : "",
    readBy: [uid(user)],
  });

  emitToUsers(conv.members, "message:new", { message: saved });
  await pushConversation(conv);

  /* Thong bao day + so do tren icon app cho nguoi nhan (khong cho nguoi gui) */
  pushNewMessage({
    recipientIds: conv.members.map(String).filter((id) => id !== uid(user)),
    senderName: user.name,
    groupTitle: conv.isGroup ? conv.title || "Nhóm" : "",
    conversationId: conv.id,
    icon: user.avatarUrl || "",
    body: previewOfMessage(saved),
  }).catch(() => { });

  return saved;
}

/** Doan xem truoc dung trong thong bao day */
function previewOfMessage(m) {
  if (!m) return "Bạn có tin nhắn mới";
  if (m.type === "gift") return `Đã gửi ${m.giftLabel || "một món quà"}`;
  if (m.type === "icon") return "Đã gửi một biểu tượng";
  if (m.type === "image") return m.text ? `🖼️ ${m.text}` : "Đã gửi một ảnh";
  return m.text || "Bạn có tin nhắn mới";
}

export async function editMessageAction(user, { messageId, text }) {
  const m = await getMessage(messageId);
  if (!m) throw new ChatError("Không tìm thấy tin nhắn", 404);
  if (m.senderId !== uid(user)) throw new ChatError("Chỉ sửa được tin nhắn của bạn", 403);
  if (m.deleted) throw new ChatError("Tin nhắn đã bị thu hồi");
  if (m.type !== "text") throw new ChatError("Chỉ sửa được tin nhắn dạng chữ");
  const clean = String(text || "").slice(0, 2000).trim();
  if (!clean) throw new ChatError("Nội dung mới đang trống");

  const conv = await loadConv(m.conversationId, user);
  const updated = await editMessage(messageId, clean);
  emitToUsers(conv.members, "message:update", { message: updated });
  await pushConversation(conv);
  return updated;
}

export async function deleteMessageAction(user, { messageId }) {
  const m = await getMessage(messageId);
  if (!m) throw new ChatError("Không tìm thấy tin nhắn", 404);
  const conv = await loadConv(m.conversationId, user);
  if (m.senderId !== uid(user) && !(conv.isGroup && isAdmin(conv, user))) {
    throw new ChatError("Bạn không có quyền xoá tin nhắn này", 403);
  }
  const updated = await softDeleteMessage(messageId);
  emitToUsers(conv.members, "message:update", { message: updated });
  await pushConversation(conv);
  return updated;
}

export async function reactAction(user, { messageId, key }) {
  const r = reactionByKey(key);
  if (!r) throw new ChatError("Cảm xúc không hợp lệ");
  const m = await getMessage(messageId);
  if (!m) throw new ChatError("Không tìm thấy tin nhắn", 404);
  const conv = await loadConv(m.conversationId, user);
  const updated = await toggleReaction(messageId, {
    key: r.key,
    url: r.url,
    userId: uid(user),
    userName: user.name,
  });
  if (!updated) throw new ChatError("Không tìm thấy tin nhắn", 404);
  emitToUsers(conv.members, "message:update", { message: updated });
  return updated;
}

export async function readAction(user, { conversationId }) {
  const conv = await loadConv(conversationId, user);
  await markRead(conv.id, uid(user));
  emitToUsers(
    conv.members.filter((m) => m !== uid(user)),
    "message:read",
    { conversationId: conv.id, userId: uid(user) }
  );
  const unreadTotal = await totalUnread(uid(user));
  /* Gui lai chinh hoi thoai da doc (unread = 0) cho nguoi doc -> danh sach het in dam */
  const view = await conversationView(conv.id, uid(user)).catch(() => null);
  emitToUsers([uid(user)], "conversation:update", {
    conversationId: String(conv.id),
    conversation: view,
    unreadTotal,
    removed: !view,
  });
  emitToUsers([uid(user)], "unread:total", { unreadTotal });
  /* Dong bo so do tren cac thiet bi khac (app da ghim o man hinh chinh) */
  pushBadge(uid(user)).catch(() => { });
  return { ok: true, unreadTotal };
}

/* ------------------------------------------------------------ Hoi thoai */
export async function createConversationAction(user, { isGroup = false, memberIds = [], title = "", avatarUrl = "" }) {
  const valid = [];
  for (const id of (memberIds || []).map(String)) {
    const u = await getUser(id);
    if (!u || String(u._id) === uid(user) || valid.includes(String(u._id))) continue;
    /* Khong cho nguoi dung thuong mo hoi thoai voi tai khoan quan tri */
    if (u.isAdmin && !user?.isAdmin) {
      throw new ChatError("Tài khoản quản trị không nhận tin nhắn riêng. Vui lòng nhắn tin riêng với người khác hoặc tạo nhóm mới nhé.", 403);
    }
    valid.push(String(u._id));
  }

  if (!isGroup) {
    const other = valid[0];
    if (!other) throw new ChatError("Hãy chọn người để nhắn tin");
    const existing = await findDirectConversation(uid(user), other);
    if (existing) return { id: existing.id, isGroup: false, existed: true };
    const conv = await createConversation({ members: [uid(user), other], createdBy: uid(user) });
    await pushConversation({ ...conv, members: [uid(user), other] });
    return { id: conv.id, isGroup: false };
  }

  const name = String(title || "").trim().slice(0, 40);
  if (name.length < 2) throw new ChatError("Tên nhóm tối thiểu 2 ký tự");
  if (!valid.length) throw new ChatError("Chọn ít nhất 1 thành viên");

  const conv = await createConversation({
    title: name,
    avatarUrl: isSafeAvatarUrl(avatarUrl) ? avatarUrl : randomGroupAvatar(name),
    isGroup: true,
    members: [uid(user), ...valid],
    createdBy: uid(user),
  });
  const full = await getConversationRaw(conv.id);
  const sys = await addMessage({
    conversationId: conv.id,
    senderId: uid(user),
    senderName: user.name,
    avatarUrl: user.avatarUrl,
    type: "system",
    text: `${user.name} đã tạo nhóm “${name}” với ${valid.length + 1} thành viên.`,
    readBy: [uid(user)],
  });
  emitToUsers(full.members, "message:new", { message: sys });
  await pushConversation(full);
  return { id: conv.id, isGroup: true, title: name, avatarUrl: conv.avatarUrl };
}

export async function addMembersAction(user, { conversationId, memberIds = [] }) {
  const conv = await loadConv(conversationId, user);
  requireNotLocked(conv, user);
  if (!conv.isGroup) throw new ChatError("Chỉ nhóm mới thêm được thành viên");
  const valid = [];
  const names = [];
  for (const id of memberIds.map(String)) {
    const u = await getUser(id);
    if (u?.isAdmin && !user?.isAdmin) {
      throw new ChatError("Không thể thêm tài khoản quản trị vào hội thoại", 403);
    }
    if (u && !conv.members.includes(String(u._id))) {
      valid.push(String(u._id));
      names.push(u.name);
    }
  }
  if (!valid.length) throw new ChatError("Không có thành viên mới");
  await addMembers(conv.id, valid);
  const full = await getConversationRaw(conv.id);
  const sys = await addMessage({
    conversationId: conv.id,
    senderId: uid(user),
    senderName: user.name,
    avatarUrl: user.avatarUrl,
    type: "system",
    text: `${user.name} đã thêm ${names.join(", ")} vào nhóm.`,
    readBy: [uid(user)],
  });
  emitToUsers(full.members, "message:new", { message: sys });
  await pushConversation(full);
  return { ok: true, members: full.members };
}

export async function removeMemberAction(user, { conversationId, userId }) {
  const conv = await loadConv(conversationId, user);
  requireNotLocked(conv, user);
  if (!conv.isGroup) throw new ChatError("Chỉ nhóm mới xoá được thành viên");
  if (!isAdmin(conv, user)) throw new ChatError("Chỉ quản trị nhóm mới xoá được thành viên", 403);
  const target = String(userId || "");
  if (target === uid(user)) throw new ChatError("Dùng 'Rời nhóm' để tự rời khỏi nhóm");
  if (!conv.members.includes(target)) throw new ChatError("Người này không ở trong nhóm");

  const victim = await getUser(target);
  await removeMember(conv.id, target);
  const full = await getConversationRaw(conv.id);
  const sys = await addMessage({
    conversationId: conv.id,
    senderId: uid(user),
    senderName: user.name,
    avatarUrl: user.avatarUrl,
    type: "system",
    text: `${user.name} đã xoá ${victim?.name || "một thành viên"} khỏi nhóm.`,
    readBy: [uid(user)],
  });
  emitToUsers(full.members, "message:new", { message: sys });
  await pushConversation(full, [target]);
  emitToUsers([target], "conversation:removed", { conversationId: conv.id });
  return { ok: true };
}

export async function leaveConversationAction(user, { conversationId }) {
  const conv = await loadConv(conversationId, user);
  if (conv.announcement) throw new ChatError("Không thể rời nhóm thông báo chung", 403);
  if (!conv.isGroup) throw new ChatError("Chỉ rời được nhóm");
  await removeMember(conv.id, uid(user));
  const full = await getConversationRaw(conv.id);
  if (!full || !full.members.length) {
    await deleteConversation(conv.id);
    emitToUsers([uid(user)], "conversation:removed", { conversationId: conv.id });
    return { ok: true, deleted: true };
  }
  const sys = await addMessage({
    conversationId: conv.id,
    senderId: uid(user),
    senderName: user.name,
    avatarUrl: user.avatarUrl,
    type: "system",
    text: `${user.name} đã rời nhóm.`,
  });
  emitToUsers(full.members, "message:new", { message: sys });
  await pushConversation(full, [uid(user)]);
  emitToUsers([uid(user)], "conversation:removed", { conversationId: conv.id });
  return { ok: true };
}

export async function updateConversationAction(user, { conversationId, title, avatarUrl, pinned }) {
  const conv = await loadConv(conversationId, user);
  if (conv.announcement && !user.isAdmin) throw new ChatError("Chỉ quản trị viên mới sửa được nhóm thông báo", 403);
  const patch = {};
  if (typeof title === "string") {
    if (!conv.isGroup) throw new ChatError("Chỉ đổi được tên nhóm");
    if (!isAdmin(conv, user)) throw new ChatError("Chỉ quản trị nhóm mới đổi tên", 403);
    const name = title.trim().slice(0, 40);
    if (name.length < 2) throw new ChatError("Tên nhóm tối thiểu 2 ký tự");
    patch.title = name;
  }
  if (typeof avatarUrl === "string" && avatarUrl) {
    if (!conv.isGroup) throw new ChatError("Chỉ đổi được ảnh nhóm");
    if (!isAdmin(conv, user)) throw new ChatError("Chỉ quản trị nhóm mới đổi ảnh", 403);
    if (!isSafeAvatarUrl(avatarUrl)) throw new ChatError("Ảnh không hợp lệ");
    patch.avatarUrl = avatarUrl;
  }
  if (typeof pinned === "boolean") patch.pinned = pinned;
  if (!Object.keys(patch).length) throw new ChatError("Không có gì để cập nhật");

  await updateConversation(conv.id, patch);
  const full = await getConversationRaw(conv.id);
  if (patch.title || patch.avatarUrl) {
    const sys = await addMessage({
      conversationId: conv.id,
      senderId: uid(user),
      senderName: user.name,
      avatarUrl: user.avatarUrl,
      type: "system",
      text: patch.title
        ? `${user.name} đã đổi tên nhóm thành “${patch.title}”.`
        : `${user.name} đã đổi ảnh nhóm.`,
      readBy: [uid(user)],
    });
    emitToUsers(full.members, "message:new", { message: sys });
  }
  await pushConversation(full);
  return { ok: true };
}

export async function deleteConversationAction(user, { conversationId }) {
  const conv = await loadConv(conversationId, user);
  if (conv.announcement) throw new ChatError("Không thể xoá nhóm thông báo chung", 403);
  if (conv.isGroup && !isAdmin(conv, user)) throw new ChatError("Chỉ quản trị nhóm mới xoá được nhóm", 403);
  const members = [...conv.members];
  await deleteConversation(conv.id);
  emitToUsers(members, "conversation:removed", { conversationId: conv.id });
  for (const id of members) {
    emitToUsers([id], "unread:total", { unreadTotal: await totalUnread(id).catch(() => 0) });
  }
  return { ok: true };
}

/* ------------------------------------------------------------- Ca nhan */
export async function updateAvatarAction(user, { avatarUrl }) {
  if (!isSafeAvatarUrl(avatarUrl)) throw new ChatError("Ảnh đại diện không hợp lệ");
  const updated = await updateAvatar(uid(user), avatarUrl);
  if (!updated) throw new ChatError("Không cập nhật được ảnh", 404);
  emitToUsers([uid(user)], "me:update", { user: updated });
  return updated;
}

/** Doi ten / doi anh: cap nhat lai moi hoi thoai cua nguoi do (chay song song) */
async function pushAllConversations(userId) {
  const convs = await listConversations(userId).catch(() => []);
  await Promise.all(
    convs.map(async (c) => {
      const full = await getConversationRaw(c.id);
      if (full) await pushConversation(full);
    })
  );
}

/** Nguoi dung trong cung hoi thoai voi user -> de bao ho biet ho so vua doi */
async function contactIds(userId) {
  const convs = await listConversations(userId).catch(() => []);
  const ids = new Set();
  for (const c of convs) for (const m of c.members || []) ids.add(String(m.id));
  ids.delete(String(userId));
  return [...ids];
}

/** Xem trang ca nhan cua mot nguoi */
export async function profileAction(user, { userId }) {
  const target = await getUser(userId || uid(user));
  if (!target) throw new ChatError("Không tìm thấy người dùng", 404);
  const p = publicUser(target);
  let conversationId = "";
  if (String(target._id) !== uid(user) && !target.isBot) {
    const direct = await findDirectConversation(uid(user), String(target._id));
    conversationId = direct?.id || "";
  }
  return { user: p, isMe: String(target._id) === uid(user), conversationId };
}

/** Cap nhat trang ca nhan cua chinh minh */
export async function updateProfileAction(user, patch = {}) {
  if (typeof patch.name === "string" && patch.name.trim()) {
    const name = patch.name.trim().replace(/\s+/g, " ");
    if (!/^[\p{L}\p{N} ._-]{2,24}$/u.test(name)) throw new ChatError("Tên 2–24 ký tự, không dùng ký tự đặc biệt");
    const dup = await findUserByName(name);
    if (dup && String(dup._id) !== uid(user)) throw new ChatError("Tên này đã có người dùng", 409);
  }
  if (typeof patch.birthday === "string" && patch.birthday) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.birthday)) throw new ChatError("Ngày sinh chưa đúng định dạng");
    const t = new Date(patch.birthday).getTime();
    if (Number.isNaN(t) || t > Date.now()) throw new ChatError("Ngày sinh không hợp lệ");
  }
  if (typeof patch.gender === "string" && patch.gender && !["male", "female", "other"].includes(patch.gender)) {
    throw new ChatError("Giới tính không hợp lệ");
  }
  if (typeof patch.phone === "string" && patch.phone.trim() && !/^[\d\s+().-]{8,20}$/.test(patch.phone.trim())) {
    throw new ChatError("Số điện thoại chưa hợp lệ");
  }
  if (Array.isArray(patch.photos) && patch.photos.some((u) => u && !isCloudinaryUrl(u))) {
    throw new ChatError("Ảnh không hợp lệ");
  }
  const updated = await updateProfile(uid(user), patch);
  if (!updated) throw new ChatError("Không có gì để cập nhật");

  emitToUsers([uid(user)], "me:update", { user: updated });
  emitToUsers(await contactIds(uid(user)), "profile:update", { user: updated });
  /* Ten doi -> tieu de hoi thoai 1-1 cua nguoi khac cung phai doi */
  await pushAllConversations(uid(user));
  return updated;
}

/* --------------------------------------------------------------- Anh */
/**
 * Nhan anh base64 tu trinh duyet -> day len Cloudinary (tu chuyen kho khi day)
 * -> luu LINK vao MongoDB duoi dang tin nhan anh.
 */
export async function sendImageAction(user, { conversationId, dataUrl = "", filename = "", caption = "" }) {
  const conv = await loadConv(conversationId, user);
  const m = /^data:(image\/[a-z.+-]+);base64,(.+)$/i.exec(String(dataUrl || "").trim());
  if (!m) throw new ChatError("Ảnh không đọc được, hãy chọn lại");
  const buffer = Buffer.from(m[2], "base64");

  let up;
  try {
    up = await uploadImage({ buffer, mime: m[1], filename: filename || "anh.jpg" });
  } catch (e) {
    throw new ChatError(e.message, e.status || 400);
  }

  return await sendMessage(user, {
    conversationId: conv.id,
    type: "image",
    text: String(caption || "").slice(0, 500),
    image: up,
  });
}

/** Tai anh len de lam anh dai dien hoac anh trong trang ca nhan */
export async function uploadUserImageAction(user, { dataUrl = "", filename = "", purpose = "photo" }) {
  const m = /^data:(image\/[a-z.+-]+);base64,(.+)$/i.exec(String(dataUrl || "").trim());
  if (!m) throw new ChatError("Ảnh không đọc được, hãy chọn lại");
  const buffer = Buffer.from(m[2], "base64");
  let up;
  try {
    up = await uploadImage({ buffer, mime: m[1], filename: filename || "anh.jpg" });
  } catch (e) {
    throw new ChatError(e.message, e.status || 400);
  }
  if (purpose === "avatar") {
    const updated = await updateAvatar(uid(user), up.url);
    emitToUsers([uid(user)], "me:update", { user: updated });
    emitToUsers(await contactIds(uid(user)), "profile:update", { user: updated });
    await pushAllConversations(uid(user));
    return { image: up, user: updated };
  }
  if (purpose === "photo") {
    const target = await getUser(uid(user));
    const photos = [up.url, ...(target?.photos || [])].slice(0, 12);
    const updated = await updateProfile(uid(user), { photos });
    emitToUsers([uid(user)], "me:update", { user: updated });
    emitToUsers(await contactIds(uid(user)), "profile:update", { user: updated });
    return { image: up, user: updated };
  }
  return { image: up };
}

/* -------------------------------------------------------------- Nhac */
/**
 * Dat nhac cho trang ca nhan.
 * - tiktokUrl: boc am thanh tu video TikTok
 * - dataUrl  : tep nhac chon tu may (base64) -> day len kho Cloudinary
 */
export async function setMusicAction(user, { tiktokUrl = "", dataUrl = "", filename = "", title = "" } = {}) {
  let music = null;

  if (String(tiktokUrl || "").trim()) {
    let got;
    try {
      got = await resolveTiktokAudio(tiktokUrl);
    } catch (e) {
      throw new ChatError(e.message, e instanceof TiktokError ? e.status : 400);
    }
    music = {
      url: got.url,
      title: title.trim() || got.title || "Nhạc TikTok",
      author: got.author || "",
      // Anh dia quay: mot anh bat ky lay tu video/ban nhac, KHONG dung anh dai dien tai khoan
      cover: got.cover || "",
      covers: (got.covers || []).slice(0, 6),
      coverProxy: isProxyableImage(got.cover || ""),
      source: "tiktok",
      sourceUrl: got.pageUrl || String(tiktokUrl).trim(),
      proxy: isProxyableAudio(got.url),
    };
  } else {
    const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/i.exec(String(dataUrl || "").trim());
    if (!m) throw new ChatError("Chưa chọn được tệp nhạc");
    if (!/^(audio|video)\//i.test(m[1])) throw new ChatError("Chỉ nhận tệp âm thanh");
    const buffer = Buffer.from(m[2], "base64");
    let up;
    try {
      up = await uploadAudio({ buffer, mime: m[1], filename: filename || "nhac.mp3" });
    } catch (e) {
      throw new ChatError(e.message, e.status || 400);
    }
    music = {
      url: up.url,
      title: title.trim() || (filename || "Nhạc của tôi").replace(/\.[^.]+$/, ""),
      author: "",
      cover: "",
      covers: [],
      coverProxy: false,
      source: "upload",
      sourceUrl: "",
      proxy: false,
    };
  }

  const updated = await updateProfile(uid(user), { music });
  if (!updated) throw new ChatError("Không lưu được nhạc");
  emitToUsers([uid(user)], "me:update", { user: updated });
  emitToUsers(await contactIds(uid(user)), "profile:update", { user: updated });
  return updated;
}

/** Go nhac khoi trang ca nhan */
export async function removeMusicAction(user) {
  const updated = await updateProfile(uid(user), { music: null });
  if (!updated) throw new ChatError("Không có nhạc để gỡ");
  emitToUsers([uid(user)], "me:update", { user: updated });
  emitToUsers(await contactIds(uid(user)), "profile:update", { user: updated });
  return updated;
}

/** Xoa 1 anh khoi album trang ca nhan */
export async function removePhotoAction(user, { url = "" }) {
  const target = await getUser(uid(user));
  const photos = (target?.photos || []).filter((p) => p !== url);
  const updated = await updateProfile(uid(user), { photos });
  if (!updated) throw new ChatError("Không tìm thấy ảnh");
  emitToUsers([uid(user)], "me:update", { user: updated });
  emitToUsers(await contactIds(uid(user)), "profile:update", { user: updated });
  return updated;
}

/* --------------------------------------------------------------- Khac */
/**
 * Mo hoi thoai: chi tai "limit" tin MOI NHAT (mac dinh 40) thay vi 300 tin.
 * Truyen "before" de tai tiep trang tin cu hon (khong tra ve conversation nua).
 */
export async function threadPayload(user, conversationId, { read = true, limit = 40, before = "" } = {}) {
  const conv = await loadConv(conversationId, user);
  /* Danh dau da doc TRUOC khi dung du lieu -> tra ve unread = 0 ngay lap tuc */
  if (read && !before) await markRead(conv.id, uid(user)).catch(() => { });

  const page = await listMessagesPage(conv.id, { limit, before });
  if (before) return { conversationId: conv.id, items: page.items, hasMore: page.hasMore };

  return {
    conversation: await conversationView(conv.id, uid(user)),
    items: page.items,
    hasMore: page.hasMore,
  };
}
