import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "config.json");

const arr = (v) =>
  (Array.isArray(v) ? v : String(v || "").split(/[\n,]/))
    .map((s) => String(s).trim())
    .filter(Boolean);

/** Mot "loai mail" = mot bo dieu kien loc rieng biet */
export function makeRule(partial = {}) {
  return {
    id: partial.id || `rule_${Math.random().toString(36).slice(2, 10)}`,
    name: partial.name || "Loại mail mới",
    enabled: partial.enabled !== false,

    // 1. Nguoi gui
    senders: arr(partial.senders),
    sendersExclude: arr(partial.sendersExclude),

    // 2. Tieu de
    subjectInclude: arr(partial.subjectInclude),
    subjectExclude: arr(partial.subjectExclude),

    // 3. Ly Do (dong "Lý Do:" ben trong noi dung mail)
    reasonInclude: arr(partial.reasonInclude),
    reasonExclude: arr(partial.reasonExclude),
    reasonRequired: !!partial.reasonRequired,

    // Phu tro
    bodyInclude: arr(partial.bodyInclude),
    bodyExclude: arr(partial.bodyExclude),

    otpRegex: partial.otpRegex || "\\b(\\d{4,8})\\b",
    otpContextKeywords: arr(partial.otpContextKeywords).length
      ? arr(partial.otpContextKeywords)
      : ["mã xác minh", "verification code", "mã", "code", "otp"],
    maxAgeMinutes: Number(partial.maxAgeMinutes) || 30,
    unseenOnly: !!partial.unseenOnly,
  };
}

export const DEFAULT_CONFIG = {
  adminPassword: "092819",
  /* Thong bao day (Web Push). Tao khoa trong trang quan tri -> tab "Thông báo". */
  push: { publicKey: "", privateKey: "", subject: "mailto:admin@example.com" },
  imap: {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    user: "",
    appPassword: "",
    mailbox: "INBOX",
  },
  filterEnabled: true,
  rules: [
    makeRule({
      id: "moonton_change_email",
      name: "Moonton — Thay Đổi Địa Chỉ Email",
      senders: ["donotreply@register-sc.moonton.com", "moonton"],
      subjectInclude: [],
      reasonInclude: ["thay đổi địa chỉ email", "change email"],
      reasonExclude: ["đặt lại mật khẩu", "reset password"],
      reasonRequired: true,
      otpRegex: "\\b(\\d{6})\\b",
      otpContextKeywords: ["mã xác minh", "verification code", "mã", "code"],
      maxAgeMinutes: 15,
    }),
    makeRule({
      id: "moonton_reset_password",
      name: "Moonton — Đặt Lại Mật Khẩu",
      senders: ["donotreply@register-sc.moonton.com", "moonton"],
      reasonInclude: ["đặt lại mật khẩu", "reset password", "khôi phục mật khẩu"],
      reasonRequired: true,
      otpRegex: "\\b(\\d{6})\\b",
      maxAgeMinutes: 15,
    }),
    makeRule({
      id: "login_otp",
      name: "OTP đăng nhập (chung)",
      subjectInclude: ["đăng nhập", "sign in", "login", "verification code", "mã xác minh", "otp"],
      subjectExclude: ["đặt lại", "reset", "khôi phục", "recover"],
      otpRegex: "\\b(\\d{4,8})\\b",
      maxAgeMinutes: 15,
    }),
  ],
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function readConfig() {
  ensureDir();
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return structuredClone(DEFAULT_CONFIG);
  }
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    imap: { ...DEFAULT_CONFIG.imap, ...(raw.imap || {}) },
    filterEnabled: raw.filterEnabled !== false,
    push: { ...DEFAULT_CONFIG.push, ...(raw.push || {}) },
    rules:
      Array.isArray(raw.rules) && raw.rules.length
        ? raw.rules.map(makeRule)
        : structuredClone(DEFAULT_CONFIG.rules),
  };
}

export function writeConfig(cfg) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

/** Che giau thong tin nhay cam khi tra ve trinh duyet */
export function publicConfig(cfg) {
  return {
    imap: { ...cfg.imap, appPassword: cfg.imap.appPassword ? "********" : "" },
    filterEnabled: cfg.filterEnabled,
    rules: cfg.rules,
    push: { publicKey: cfg.push?.publicKey || "", subject: cfg.push?.subject || "", configured: !!(cfg.push?.publicKey && cfg.push?.privateKey) },
  };
}
