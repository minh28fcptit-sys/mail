/**
 * Realtime bang Socket.IO.
 * - Xac thuc bang token chat (giong REST) ngay o handshake.
 * - Moi user co 1 room rieng: u:<userId> -> gui tin la nguoi kia nhan NGAY.
 * - Presence: online/offline phat cho tat ca (dot xanh doi tuc thi).
 * - Ho tro: gui / sua / xoa tin, cam xuc, dang go, quan ly nhom.
 */
import { Server } from "socket.io";
import { setRealtimeSink } from "./bus.js";
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
  removePhotoAction,
} from "./chat-actions.js";
import {
  getConversationRaw,
  listConversations,
  onlineUserIds,
  presenceAdd,
  presenceRemove,
  publicUser,
  setUserOnline,
  touchUser,
  totalUnread,
  userByToken,
} from "./chat-store.js";

const room = (userId) => `u:${String(userId)}`;

export function initRealtime(httpServer) {
  const io = new Server(httpServer, {
    path: "/socket.io",
    serveClient: true,
    pingInterval: 20000,
    pingTimeout: 20000,
    maxHttpBufferSize: 1e6,
    cors: { origin: true, credentials: true },
  });

  /* Cac module khac phat su kien qua bus -> day sang socket */
  setRealtimeSink((ids, event, data) => {
    for (const id of ids) io.to(room(id)).emit(event, data);
  });

  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers["x-chat-token"] ||
        String(socket.handshake.query?.token || "");
      const user = await userByToken(String(token || "").trim());
      if (!user) return next(new Error("Chưa đăng nhập"));
      socket.data.user = user;
      socket.data.uid = String(user._id);
      next();
    } catch (e) {
      next(new Error(e.message || "Lỗi xác thực"));
    }
  });

  io.on("connection", async (socket) => {
    const uid = socket.data.uid;
    socket.join(room(uid));

    const first = presenceAdd(uid) === 1;
    await setUserOnline(uid, true).catch(() => { });
    if (first) io.emit("presence:update", { userId: uid, online: true, lastSeen: new Date().toISOString() });

    socket.emit("ready", {
      user: publicUser(socket.data.user),
      online: onlineUserIds(),
      serverTime: new Date().toISOString(),
    });

    /* Bam nhe de lastSeen luon moi */
    const beat = setInterval(() => touchUser(uid).catch(() => { }), 30000);

    const ok = (cb, data) => typeof cb === "function" && cb({ ok: true, data });
    const fail = (cb, e) =>
      typeof cb === "function" &&
      cb({ ok: false, error: e instanceof ChatError ? e.message : e?.message || "Lỗi không xác định" });

    const handle = (event, fn) =>
      socket.on(event, async (payload = {}, cb) => {
        try {
          ok(cb, await fn(payload || {}));
        } catch (e) {
          fail(cb, e);
        }
      });

    const me = () => socket.data.user;

    handle("conversations:list", async () => {
      const items = await listConversations(uid);
      return { me: uid, items, unreadTotal: items.reduce((s, c) => s + c.unread, 0), online: onlineUserIds() };
    });
    handle("conversation:open", async (p) => {
      await readAction(me(), { conversationId: p.conversationId });
      return await threadPayload(me(), p.conversationId, { read: false, limit: Number(p.limit) || 40 });
    });
    /* Keo len dau khung chat -> tai them tin cu (cursor pagination) */
    handle("messages:more", (p) =>
      threadPayload(me(), p.conversationId, {
        read: false,
        limit: Number(p.limit) || 40,
        before: String(p.before || ""),
      })
    );
    handle("message:send", (p) => sendMessage(me(), p));
    handle("message:edit", (p) => editMessageAction(me(), p));
    handle("message:delete", (p) => deleteMessageAction(me(), p));
    handle("message:react", (p) => reactAction(me(), p));
    handle("conversation:read", (p) => readAction(me(), p));
    handle("conversation:create", (p) => createConversationAction(me(), p));
    handle("conversation:members:add", (p) => addMembersAction(me(), p));
    handle("conversation:member:remove", (p) => removeMemberAction(me(), p));
    handle("conversation:update", (p) => updateConversationAction(me(), p));
    handle("conversation:leave", (p) => leaveConversationAction(me(), p));
    handle("conversation:delete", (p) => deleteConversationAction(me(), p));
    handle("me:avatar", async (p) => {
      const updated = await updateAvatarAction(me(), p);
      socket.data.user = { ...socket.data.user, avatarUrl: updated.avatarUrl };
      return updated;
    });
    handle("user:profile", (p) => profileAction(me(), p));
    handle("me:profile", async (p) => {
      const updated = await updateProfileAction(me(), p);
      socket.data.user = { ...socket.data.user, name: updated.name, ...p };
      return updated;
    });
    handle("me:photo:remove", (p) => removePhotoAction(me(), p));
    handle("unread:get", async () => ({ unreadTotal: await totalUnread(uid) }));

    /* Dang go — chi bao cho thanh vien khac trong hoi thoai */
    /* Dang go: TRUOC day moi phim go deu goi listConversations (rat nang).
       NAY chi doc dung 1 hoi thoai, va chan spam bang khoang cach toi thieu 900ms. */
    let lastTypingAt = 0;
    let lastTypingState = null;
    socket.on("typing", async ({ conversationId, typing } = {}) => {
      try {
        const state = !!typing;
        const nowMs = Date.now();
        if (state === lastTypingState && nowMs - lastTypingAt < 900) return;
        lastTypingAt = nowMs;
        lastTypingState = state;

        const conv = await getConversationRaw(conversationId);
        if (!conv || !(conv.members || []).map(String).includes(uid)) return;
        for (const id of conv.members) {
          if (String(id) === uid) continue;
          io.to(room(String(id))).emit("typing", {
            conversationId: conv.id,
            userId: uid,
            name: me().name,
            typing: state,
          });
        }
      } catch { }
    });

    socket.on("disconnect", async () => {
      clearInterval(beat);
      const left = presenceRemove(uid);
      /* Ghi offline vao DB NGAY -> tai lai trang khong con hien "dang hoat dong" */
      await setUserOnline(uid, left > 0).catch(() => { });
      if (left === 0) {
        io.emit("presence:update", { userId: uid, online: false, lastSeen: new Date().toISOString() });
      }
    });
  });

  console.log("  [chat] Socket.IO đã bật tại /socket.io");
  return io;
}
