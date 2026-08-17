/**
 * REST cho chat — dung cho lan tai dau tien va lam phuong an du phong
 * khi Socket.IO bi chan. Moi thao doi deu di qua chat-actions.js nen
 * du goi bang REST hay socket thi nguoi khac van nhan realtime.
 */
import express from "express";
import {
  REACTIONS,
  GIFTS,
  BRAND_ICONS,
  EMOJI_GROUPS,
  avatarChoices,
  groupAvatarChoices,
} from "./assets.js";
import {
  ChatError,
  addMembersAction,
  createConversationAction,
  deleteConversationAction,
  deleteMessageAction,
  editMessageAction,
  leaveConversationAction,
  reactAction,
  readAction,
  removeMemberAction,
  sendMessage,
  threadPayload,
  updateAvatarAction,
  updateConversationAction,
  profileAction,
  updateProfileAction,
  sendImageAction,
  uploadUserImageAction,
  removePhotoAction,
  setMusicAction,
  removeMusicAction,
} from "./chat-actions.js";
import { hasUsableStore, IMAGE_MAX_BYTES } from "./media.js";
import { isProxyableAudio, isProxyableImage, streamAudio, streamImage } from "./tiktok.js";
import { publicKey as pushPublicKey, pushEnabled, subscribe as pushSubscribe, unsubscribe as pushUnsubscribe, deviceCount, PushError } from "./push.js";
import { provinces, districts, wards } from "./geo.js";
import {
  storeMode,
  publicUser,
  verifyPass,
  createUser,
  findUserByName,
  issueToken,
  revokeToken,
  userByToken,
  touchUser,
  listUsers,
  getBot,
  createConversation,
  addMessage,
  listConversations,
  totalUnread,
  onlineUserIds,
} from "./chat-store.js";

export const chatRouter = express.Router();

/* --------------------------------------------------------- Xac thuc */
function bearer(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  return String(req.headers["x-chat-token"] || "").trim();
}

async function requireAuth(req, res, next) {
  const token = bearer(req);
  const u = await userByToken(token);
  if (!u) return res.status(401).json({ error: "Chưa đăng nhập" });
  req.user = u;
  req.token = token;
  req.uid = String(u._id);
  touchUser(req.uid).catch(() => { });
  next();
}

/** Bao boc action: tra loi JSON + ma loi dung */
const run = (fn) => async (req, res) => {
  try {
    res.json((await fn(req)) ?? { ok: true });
  } catch (e) {
    res.status(e instanceof ChatError ? e.status : 500).json({ error: e.message });
  }
};

const nameOk = (n) => /^[\p{L}\p{N} ._-]{2,24}$/u.test(n);

/* Tao / dang nhap tai khoan: chi can TEN + MAT KHAU */
chatRouter.post(
  "/auth/register",
  run(async (req) => {
    const name = String(req.body?.name || "").trim().replace(/\s+/g, " ");
    const password = String(req.body?.password || "");
    if (!nameOk(name)) throw new ChatError("Tên 2–24 ký tự, không dùng ký tự đặc biệt");
    if (password.length < 4) throw new ChatError("Mật khẩu tối thiểu 4 ký tự");
    if (await findUserByName(name)) throw new ChatError("Tên này đã có người dùng, hãy đăng nhập", 409);

    const user = await createUser({ name, password });
    const token = await issueToken(user._id);

    const bot = await getBot();
    const conv = await createConversation({
      members: [String(user._id), String(bot._id)],
      createdBy: String(bot._id),
    });
    await addMessage({
      conversationId: conv.id,
      senderId: String(bot._id),
      senderName: bot.name,
      avatarUrl: bot.avatarUrl,
      text: `Chào ${name}! \n Tài khoản đã tạo xong. Bấm ✚ để tạo nhóm hoặc nhắn riêng. `,
    });
    await addMessage({
      conversationId: conv.id,
      senderId: String(bot._id),
      senderName: bot.name,
      avatarUrl: bot.avatarUrl,
      text: `Hãy nhấn chia sẻ -> thêm vào màn hình chính -> đặt tên và ấn "thêm. `,
    });
    await addMessage({
      conversationId: conv.id,
      senderId: String(bot._id),
      senderName: bot.name,
      avatarUrl: bot.avatarUrl,
      text: `Sau đó quay về màn hình chính vào app ấn vào nút thông báo cạnh nút "đăng xuất" để nhận thông báo tin nhắn từ bạn bè.`,
    });

    return { token, user: publicUser(user) };
  })
);

chatRouter.post(
  "/auth/login",
  run(async (req) => {
    const name = String(req.body?.name || "").trim();
    const password = String(req.body?.password || "");
    const u = await findUserByName(name);
    if (!u || u.isBot) throw new ChatError("Tài khoản không tồn tại", 404);
    if (!verifyPass(password, u.salt, u.passHash)) throw new ChatError("Mật khẩu không đúng", 401);
    return { token: await issueToken(u._id), user: publicUser(u) };
  })
);

chatRouter.get("/auth/me", requireAuth, (req, res) =>
  res.json({ user: publicUser(req.user), store: storeMode(), realtime: "socket.io" })
);

chatRouter.post(
  "/auth/logout",
  requireAuth,
  run(async (req) => {
    await revokeToken(req.token);
    return { ok: true };
  })
);

chatRouter.get("/auth/exists", async (req, res) => {
  const u = await findUserByName(String(req.query.name || ""));
  res.json({ exists: !!u && !u.isBot });
});

/* ------------------------------------------------------------ Assets */
chatRouter.get("/assets", (req, res) => {
  res.json({
    reactions: REACTIONS,
    gifts: GIFTS,
    brand: BRAND_ICONS,
    emojis: EMOJI_GROUPS,
    avatars: avatarChoices("mail-chat", 24),
    groupAvatars: groupAvatarChoices("mail-group", 12),
    store: storeMode(),
    realtime: "socket.io",
  });
});

/* ------------------------------------------------------------- Anh */
chatRouter.get("/media/status", async (req, res) => {
  res.json({ ready: await hasUsableStore().catch(() => false), maxBytes: IMAGE_MAX_BYTES });
});

/* Gui anh vao hoi thoai: anh len Cloudinary, MongoDB chi luu link */
chatRouter.post(
  "/conversations/:id/image",
  requireAuth,
  run((req) => sendImageAction(req.user, { ...(req.body || {}), conversationId: req.params.id }))
);

/* Tai anh len cho avatar hoac album trang ca nhan */
chatRouter.post(
  "/me/upload",
  requireAuth,
  run((req) => uploadUserImageAction(req.user, req.body || {}))
);

chatRouter.delete(
  "/me/photo",
  requireAuth,
  run((req) => removePhotoAction(req.user, { url: req.query.url || req.body?.url || "" }))
);

/* ---------------------------------------------- Nhac trang ca nhan */
chatRouter.post(
  "/me/music",
  requireAuth,
  run((req) => setMusicAction(req.user, req.body || {}))
);

chatRouter.delete(
  "/me/music",
  requireAuth,
  run((req) => removeMusicAction(req.user))
);

/* Phat lai am thanh TikTok qua server (tranh bi chan hotlink tren dien thoai) */
chatRouter.get("/media/audio", async (req, res) => {
  const src = String(req.query.src || "");
  if (!isProxyableAudio(src)) return res.status(400).json({ error: "Nguồn âm thanh không hợp lệ" });
  try {
    await streamAudio(src, res);
  } catch (e) {
    if (!res.headersSent) res.status(e.status || 502).json({ error: e.message || "Không tải được âm thanh" });
    else res.end();
  }
});

/* Anh bia dia nhac qua proxy (mot so CDN chan hotlink) */
chatRouter.get("/media/cover", async (req, res) => {
  const src = String(req.query.src || "");
  if (!isProxyableImage(src)) return res.status(400).json({ error: "Nguồn ảnh không hợp lệ" });
  try {
    await streamImage(src, res);
  } catch (e) {
    if (!res.headersSent) res.status(e.status || 502).json({ error: e.message || "Không tải được ảnh" });
    else res.end();
  }
});

/* ------------------------------------------------- Danh muc dia chi */
chatRouter.get(
  "/geo/provinces",
  run(() => provinces())
);
chatRouter.get(
  "/geo/districts/:provinceCode",
  run((req) => districts(req.params.provinceCode))
);
chatRouter.get(
  "/geo/wards/:districtCode",
  run((req) => wards(req.params.districtCode))
);

/* ------------------------------------------------------- Nguoi dung */
chatRouter.get(
  "/users",
  requireAuth,
  run(async (req) => {
    /* Tim kiem + gioi han ngay tren MongoDB (mac dinh 100 nguoi) */
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const items = await listUsers(req.uid, { includeAdmin: !!req.user?.isAdmin, q, limit });
    return { items, online: onlineUserIds() };
  })
);

chatRouter.get(
  "/users/:id/profile",
  requireAuth,
  run((req) => profileAction(req.user, { userId: req.params.id }))
);

chatRouter.put(
  "/me/profile",
  requireAuth,
  run((req) => updateProfileAction(req.user, req.body || {}))
);

chatRouter.put(
  "/me/avatar",
  requireAuth,
  run((req) => updateAvatarAction(req.user, { avatarUrl: req.body?.avatarUrl }))
);

/* ------------------------------------------------------- Hoi thoai */
chatRouter.get(
  "/conversations",
  requireAuth,
  run(async (req) => {
    const items = await listConversations(req.uid);
    return { me: req.uid, items, unreadTotal: items.reduce((s, c) => s + c.unread, 0), online: onlineUserIds() };
  })
);

/* ------------------------------------------------- Thong bao day (iOS/PWA) */
chatRouter.get("/push/config", (req, res) =>
  res.json({ enabled: pushEnabled(), publicKey: pushPublicKey() })
);

chatRouter.post(
  "/push/subscribe",
  requireAuth,
  run(async (req) => {
    await pushSubscribe(req.uid, req.body?.subscription || req.body || {}, {
      ua: req.headers["user-agent"] || "",
      standalone: !!req.body?.standalone,
    });
    return { ok: true, devices: await deviceCount(req.uid) };
  })
);

chatRouter.post(
  "/push/unsubscribe",
  requireAuth,
  run(async (req) => {
    await pushUnsubscribe(req.body?.endpoint || "");
    return { ok: true, devices: await deviceCount(req.uid) };
  })
);

chatRouter.get(
  "/unread",
  requireAuth,
  run(async (req) => ({ unreadTotal: await totalUnread(req.uid) }))
);

chatRouter.post(
  "/conversations",
  requireAuth,
  run((req) => createConversationAction(req.user, req.body || {}))
);

chatRouter.get(
  "/conversations/:id/messages",
  requireAuth,
  run(async (req) => {
    /* Phan trang: GET ...?limit=40&before=<messageId> (cursor, khong dung offset).
       Khong co "before" = mo hoi thoai -> danh dau da doc nhu truoc. */
    const before = String(req.query.before || "");
    const limit = Number(req.query.limit) || 40;
    if (!before) await readAction(req.user, { conversationId: req.params.id }).catch(() => { });
    return await threadPayload(req.user, req.params.id, { read: false, limit, before });
  })
);

chatRouter.post(
  "/conversations/:id/messages",
  requireAuth,
  run((req) => sendMessage(req.user, { ...(req.body || {}), conversationId: req.params.id }))
);

chatRouter.post(
  "/conversations/:id/read",
  requireAuth,
  run((req) => readAction(req.user, { conversationId: req.params.id }))
);

chatRouter.patch(
  "/conversations/:id",
  requireAuth,
  run((req) => updateConversationAction(req.user, { ...(req.body || {}), conversationId: req.params.id }))
);

chatRouter.delete(
  "/conversations/:id",
  requireAuth,
  run((req) => deleteConversationAction(req.user, { conversationId: req.params.id }))
);

chatRouter.post(
  "/conversations/:id/leave",
  requireAuth,
  run((req) => leaveConversationAction(req.user, { conversationId: req.params.id }))
);

chatRouter.post(
  "/conversations/:id/members",
  requireAuth,
  run((req) => addMembersAction(req.user, { conversationId: req.params.id, memberIds: req.body?.memberIds || [] }))
);

chatRouter.delete(
  "/conversations/:id/members/:userId",
  requireAuth,
  run((req) => removeMemberAction(req.user, { conversationId: req.params.id, userId: req.params.userId }))
);

/* --------------------------------------------------------- Tin nhan */
chatRouter.patch(
  "/messages/:id",
  requireAuth,
  run((req) => editMessageAction(req.user, { messageId: req.params.id, text: req.body?.text }))
);

chatRouter.delete(
  "/messages/:id",
  requireAuth,
  run((req) => deleteMessageAction(req.user, { messageId: req.params.id }))
);

chatRouter.post(
  "/messages/:id/reaction",
  requireAuth,
  run((req) => reactAction(req.user, { messageId: req.params.id, key: req.body?.key }))
);
