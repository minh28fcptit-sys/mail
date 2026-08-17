import "./env.js";
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readConfig, writeConfig, publicConfig, makeRule } from "./store.js";
import { fetchByRule, verifyImap, matchRule, extractOtp, extractMeta } from "./mail.js";
import { chatRouter } from "./chat.js";
import { initChatStore, resetPresence } from "./chat-store.js";
import {
  initMediaStore,
  listStores,
  createStore,
  updateStore,
  deleteStore,
  checkStore,
  fetchUsage,
  verifyUploadCredentials,
  MediaError,
} from "./media.js";
import { initRealtime } from "./realtime.js";
import { initPush, pushStatus, generateKeys, saveSubject, sendTest, PushError } from "./push.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "..", "public");
const VIEWS = path.join(__dirname, "..", "views");
const ADMIN_PATH = process.env.ADMIN_PATH || "/092819";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: process.env.JSON_LIMIT || "14mb" }));
app.use(cookieParser());

/* Trang quan tri an tai /092819 (khong lo file admin.html ra ngoai) */
app.get(ADMIN_PATH, (req, res) => res.sendFile(path.join(VIEWS, "index.html")));
app.get(`${ADMIN_PATH}/`, (req, res) => res.redirect(ADMIN_PATH));
app.use(`${ADMIN_PATH}/assets`, express.static(VIEWS));

/* Service worker phai luon lay ban moi nhat va duoc pham vi toan site */
app.get("/sw.js", (req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Service-Worker-Allowed", "/");
  res.type("application/javascript").sendFile(path.join(PUBLIC, "sw.js"));
});
app.get("/manifest.webmanifest", (req, res) => {
  res.type("application/manifest+json").sendFile(path.join(PUBLIC, "manifest.webmanifest"));
});

/**
 * Tinh: icon/anh khong doi -> cache 1 nam (tai lai rat nhanh tren dien thoai).
 * HTML/JS/CSS -> "no-cache": trinh duyet van hoi may chu (ETag) nen deploy ban
 * moi la thay ngay, khong bao gio ket ban cu.
 */
app.use(
  express.static(PUBLIC, {
    index: "index.html",
    extensions: ["html"],
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      if (/[\\/]icons[\\/]/.test(filePath) || /\.(png|jpg|jpeg|webp|avif|svg|ico|woff2?)$/i.test(filePath)) {
        res.set("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.set("Cache-Control", "no-cache");
      }
    },
  })
);

/* ---------------- Chat (Messenger-style) ---------------- */
app.use("/api/chat", chatRouter);
app.get("/chat", (req, res) => res.sendFile(path.join(PUBLIC, "chat.html")));

/* ---------------- Auth admin ---------------- */
const sessions = new Set();

function requireAdmin(req, res, next) {
  const token = req.cookies?.admin_token;
  if (token && sessions.has(token)) return next();
  return res.status(401).json({ error: "Chưa đăng nhập quản trị" });
}

app.post("/api/admin/login", (req, res) => {
  const cfg = readConfig();
  if (!req.body?.password || req.body.password !== cfg.adminPassword) {
    return res.status(401).json({ error: "Sai mật khẩu quản trị" });
  }
  const token = crypto.randomBytes(24).toString("hex");
  sessions.add(token);
  res.cookie("admin_token", token, { httpOnly: true, sameSite: "lax", path: "/" });
  res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  const token = req.cookies?.admin_token;
  if (token) sessions.delete(token);
  res.clearCookie("admin_token");
  res.json({ ok: true });
});

app.get("/api/admin/me", (req, res) => {
  const token = req.cookies?.admin_token;
  res.json({ loggedIn: !!(token && sessions.has(token)) });
});

/* ---------------- Cau hinh ---------------- */
app.get("/api/admin/config", requireAdmin, (req, res) => res.json(publicConfig(readConfig())));

app.put("/api/admin/config", requireAdmin, (req, res) => {
  const cfg = readConfig();
  const body = req.body || {};
  const next = {
    ...cfg,
    imap: { ...cfg.imap, ...(body.imap || {}) },
    filterEnabled: body.filterEnabled !== undefined ? !!body.filterEnabled : cfg.filterEnabled,
    rules: Array.isArray(body.rules) ? body.rules.map(makeRule) : cfg.rules,
  };
  if (!body.imap?.appPassword || body.imap.appPassword === "********") {
    next.imap.appPassword = cfg.imap.appPassword;
  }
  if (body.adminPassword) next.adminPassword = body.adminPassword;
  writeConfig(next);
  res.json(publicConfig(next));
});

app.post("/api/admin/test", requireAdmin, async (req, res) => {
  res.json({ imap: await verifyImap(readConfig()) });
});

/** Thu 1 mail mau voi 1 rule */
app.post("/api/admin/try-rule", requireAdmin, (req, res) => {
  const { rule, sample } = req.body || {};
  if (!rule || !sample) return res.status(400).json({ error: "Thiếu rule hoặc mail mẫu" });
  const r = makeRule(rule);
  const body = sample.body || "";
  const mail = {
    from: sample.from || "",
    subject: sample.subject || "",
    body,
    date: sample.date || new Date().toISOString(),
    ...extractMeta(body),
  };
  const verdict = matchRule(r, mail);
  res.json({ ...verdict, detectedReason: mail.reason, otp: verdict.ok ? extractOtp(r, mail) : null });
});

/** Doi chieu mail mau voi TAT CA rule */
app.post("/api/admin/classify", requireAdmin, (req, res) => {
  const cfg = readConfig();
  const sample = req.body?.sample || {};
  const body = sample.body || "";
  const mail = {
    from: sample.from || "",
    subject: sample.subject || "",
    body,
    date: sample.date || new Date().toISOString(),
    ...extractMeta(body),
  };
  res.json({
    detectedReason: mail.reason,
    results: cfg.rules.map((rule) => {
      const v = matchRule(rule, mail);
      return { id: rule.id, name: rule.name, ...v, otp: v.ok ? extractOtp(rule, mail) : null };
    }),
  });
});

/** Xem thu hop mail that voi 1 rule (co ca mail bi loai + ly do) */
app.post("/api/admin/preview", requireAdmin, async (req, res) => {
  const cfg = readConfig();
  const rule = cfg.rules.find((r) => r.id === req.body?.ruleId);
  if (!rule) return res.status(400).json({ error: "Không tìm thấy loại mail" });
  try {
    res.json(await fetchByRule(cfg, rule, { debug: true }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- Quan tri kho anh Cloudinary ---------------- */
const mediaRun = (fn) => async (req, res) => {
  try {
    res.json((await fn(req)) ?? { ok: true });
  } catch (e) {
    res.status(e instanceof MediaError ? e.status : 500).json({ error: e.message });
  }
};

app.get("/api/admin/media-stores", requireAdmin, mediaRun(async () => ({ items: await listStores() })));

app.post("/api/admin/media-stores", requireAdmin, mediaRun((req) => createStore(req.body || {})));

app.put("/api/admin/media-stores/:id", requireAdmin, mediaRun((req) => updateStore(req.params.id, req.body || {})));

app.delete("/api/admin/media-stores/:id", requireAdmin, mediaRun((req) => deleteStore(req.params.id)));

/* Bam "Kiem tra" -> doc dung luong THAT tu chinh API key cua kho do */
app.post("/api/admin/media-stores/:id/check", requireAdmin, mediaRun((req) => checkStore(req.params.id)));

/* Kiem tra key truoc khi luu */
app.post(
  "/api/admin/media-stores/check",
  requireAdmin,
  mediaRun(async (req) => {
    const body = req.body || {};
    try {
      return { usage: await fetchUsage(body) };
    } catch (e) {
      if (!e.permission) throw e;
      /* Key khong co quyen doc dung luong -> kiem tra bang quyen ghi */
      await verifyUploadCredentials(body);
      return { usage: null, warning: e.message };
    }
  })
);

/* ---------------- Quan tri thong bao day (Web Push) ---------------- */
const pushRun = (fn) => async (req, res) => {
  try {
    res.json((await fn(req)) ?? { ok: true });
  } catch (e) {
    res.status(e instanceof PushError ? e.status : 500).json({ error: e.message });
  }
};

app.get("/api/admin/push", requireAdmin, pushRun(() => pushStatus()));

/* Tao cap khoa VAPID moi (thiet bi cu phai bat lai thong bao) */
app.post("/api/admin/push/keys", requireAdmin, pushRun(async (req) => {
  const out = await generateKeys(req.body?.subject || "");
  return { ...out, ...(await pushStatus()) };
}));

app.put("/api/admin/push", requireAdmin, pushRun(async (req) => {
  await saveSubject(req.body?.subject || "");
  return await pushStatus();
}));

app.post("/api/admin/push/test", requireAdmin, pushRun(() => sendTest()));

/* ---------------- Client ---------------- */
app.get("/api/client/account", (req, res) => {
  const cfg = readConfig();
  res.json({
    account: cfg.imap.user || null,
    configured: !!(cfg.imap.user && cfg.imap.appPassword),
    filterEnabled: cfg.filterEnabled,
    rules: cfg.rules
      .filter((r) => r.enabled)
      .map((r) => ({
        id: r.id,
        name: r.name,
        senders: r.senders,
        subjectInclude: r.subjectInclude,
        reasonInclude: r.reasonInclude,
        maxAgeMinutes: r.maxAgeMinutes,
      })),
  });
});

app.post("/api/client/otp", async (req, res) => {
  const cfg = readConfig();
  const rule = cfg.rules.find((r) => r.id === req.body?.ruleId && r.enabled);
  if (!rule) return res.status(400).json({ error: "Loại mail không hợp lệ hoặc đang bị tắt" });
  try {
    const { items } = await fetchByRule(cfg, rule);
    res.json({ rule: { id: rule.id, name: rule.name }, count: items.length, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

try {
  await initChatStore();
  /* Server vua khoi dong -> khong ai dang ket noi, xoa trang thai online cu */
  await resetPresence();
  await initMediaStore();
  await initPush();
} catch (e) {
  console.error(`\n  [chat] Không thể kết nối MongoDB:\n  ${e.message}\n`);
  process.exit(1);
}

const server = http.createServer(app);
initRealtime(server);

server.listen(PORT, () => {
  console.log(`\n  Mail OTP Reader → http://localhost:${PORT}`);
  console.log(`  Trang quản trị  → http://localhost:${PORT}${ADMIN_PATH}`);
  console.log(`  Hộp tin nhắn    → http://localhost:${PORT}/chat  (realtime: Socket.IO)\n`);
});
