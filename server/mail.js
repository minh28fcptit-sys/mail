import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

/* --------------------------- Tien ich --------------------------- */

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();

const anyIncludes = (haystack, list = []) => {
  const h = norm(haystack);
  return list.some((k) => k && h.includes(norm(k)));
};

/** Lay dong "Lý Do: ..." (hoac Reason/Ly do/Lí do) trong noi dung mail */
export function extractReason(text) {
  const src = String(text || "").replace(/\u00a0/g, " ");
  const re = /(?:^|\n)\s*(?:l[ýyíi]\s*do|reason)\s*[:：]\s*([^\n\r]{1,160})/i;
  const m = src.match(re);
  return m ? m[1].trim().replace(/\s+/g, " ") : "";
}

/** Cac truong khac thuong gap trong mail Moonton */
export function extractMeta(text) {
  const src = String(text || "").replace(/\u00a0/g, " ");
  const grab = (labels) => {
    const re = new RegExp(`(?:^|\\n)\\s*(?:${labels})\\s*[:：]\\s*([^\\n\\r]{1,120})`, "i");
    const m = src.match(re);
    return m ? m[1].trim() : "";
  };
  return {
    reason: extractReason(src),
    serverTime: grab("gi[ờo]\\s*server|server\\s*time"),
    ip: grab("[đd][ị i]a\\s*ch[ỉi]\\s*ip|ip\\s*address"),
  };
}

/**
 * Kiem tra 1 mail co dung "loai mail" cua rule khong.
 * Thu tu: thoi gian -> NGUOI GUI -> TIEU DE -> LY DO -> noi dung.
 */
export function matchRule(rule, mail) {
  const { from, subject, body, date } = mail;
  const reason = mail.reason ?? extractReason(body);

  if (rule.maxAgeMinutes && date) {
    const ageMin = (Date.now() - new Date(date).getTime()) / 60000;
    if (ageMin > rule.maxAgeMinutes) return { ok: false, field: "time", reason: "Mail quá hạn thời gian" };
  }
  if (rule.senders?.length && !anyIncludes(from, rule.senders)) {
    return { ok: false, field: "sender", reason: "Người gửi không khớp" };
  }
  if (rule.sendersExclude?.length && anyIncludes(from, rule.sendersExclude)) {
    return { ok: false, field: "sender", reason: "Người gửi bị loại trừ" };
  }
  if (rule.subjectInclude?.length && !anyIncludes(subject, rule.subjectInclude)) {
    return { ok: false, field: "subject", reason: "Tiêu đề thiếu từ khoá bắt buộc" };
  }
  if (rule.subjectExclude?.length && anyIncludes(subject, rule.subjectExclude)) {
    return { ok: false, field: "subject", reason: "Tiêu đề dính từ khoá loại trừ" };
  }
  if (rule.reasonRequired && !reason) {
    return { ok: false, field: "reason", reason: "Mail không có dòng Lý Do" };
  }
  if (rule.reasonInclude?.length && !anyIncludes(reason, rule.reasonInclude)) {
    return { ok: false, field: "reason", reason: "Lý Do không khớp" };
  }
  if (rule.reasonExclude?.length && anyIncludes(reason, rule.reasonExclude)) {
    return { ok: false, field: "reason", reason: "Lý Do bị loại trừ" };
  }
  if (rule.bodyInclude?.length && !anyIncludes(body, rule.bodyInclude)) {
    return { ok: false, field: "body", reason: "Nội dung thiếu từ khoá bắt buộc" };
  }
  if (rule.bodyExclude?.length && anyIncludes(body, rule.bodyExclude)) {
    return { ok: false, field: "body", reason: "Nội dung dính từ khoá loại trừ" };
  }
  return { ok: true, field: null, reason: "Khớp toàn bộ điều kiện" };
}

/**
 * Trich OTP: uu tien dong co tu khoa ngu canh (mã xác minh / code / otp)
 * hoac dong ngay sau dong do -> tranh bat nham IP, gio server, nam.
 */
export function extractOtp(rule, { subject, body }) {
  let re;
  try {
    re = new RegExp(rule.otpRegex || "\\b(\\d{4,8})\\b", "g");
  } catch {
    re = /\b(\d{4,8})\b/g;
  }
  const clean = String(body || "")
    .replace(/(?:^|\n)\s*(?:[đd][ị i]a ch[ỉi] ip|ip address|gi[ờo] server|server time)\s*[:：][^\n]*/gi, "\n");
  const lines = `${subject || ""}\n${clean}`.split(/\r?\n/);
  const ctx = rule.otpContextKeywords || [];

  const test = (line) => {
    if (!line) return null;
    re.lastIndex = 0;
    const m = re.exec(line);
    return m ? m[1] || m[0] : null;
  };

  if (ctx.length) {
    for (let i = 0; i < lines.length; i++) {
      if (!anyIncludes(lines[i], ctx)) continue;
      const hit = test(lines[i]) || test(lines[i + 1]) || test(lines[i + 2]);
      if (hit) return hit;
    }
  }
  for (const line of lines) {
    const hit = test(line);
    if (hit) return hit;
  }
  return null;
}

/* ------------------------------ IMAP ------------------------------ */

async function withMailbox(cfg, fn) {
  const { imap } = cfg;
  if (!imap.user || !imap.appPassword) {
    throw new Error("Chưa cấu hình email / app password trong trang quản trị");
  }
  const client = new ImapFlow({
    host: imap.host,
    port: Number(imap.port),
    secure: !!imap.secure,
    auth: { user: imap.user, pass: imap.appPassword },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock(imap.mailbox || "INBOX");
  try {
    return await fn(client);
  } finally {
    lock.release();
    await client.logout().catch(() => { });
  }
}

function toMail(parsed) {
  const body = parsed.text || String(parsed.html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ");
  const meta = extractMeta(body);
  return {
    from: parsed.from?.text || parsed.from?.value?.[0]?.address || "",
    subject: parsed.subject || "",
    body,
    date: parsed.date,
    ...meta,
  };
}

/** Lay mail thoa dieu kien cua MOT rule */
export async function fetchByRule(cfg, rule, { limit = 60, take = 8, debug = false } = {}) {
  return withMailbox(cfg, async (client) => {
    const since = new Date(Date.now() - (Number(rule.maxAgeMinutes) || 30) * 60 * 1000);
    const criteria = { since };
    if (rule.unseenOnly) criteria.seen = false;

    const uids = await client.search(criteria, { uid: true });
    const pick = (uids || []).slice(-limit).reverse();

    const items = [];
    const skipped = [];

    for (const uid of pick) {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg?.source) continue;
      const mail = toMail(await simpleParser(msg.source));

      const verdict = cfg.filterEnabled ? matchRule(rule, mail) : { ok: true, reason: "Bộ lọc đang tắt" };
      if (!verdict.ok) {
        if (debug) skipped.push({ subject: mail.subject, from: mail.from, reason: verdict.reason, ruleReason: mail.reason });
        continue;
      }

      items.push({
        uid,
        ruleId: rule.id,
        ruleName: rule.name,
        from: mail.from,
        subject: mail.subject,
        date: mail.date,
        reason: mail.reason,
        serverTime: mail.serverTime,
        ip: mail.ip,
        otp: extractOtp(rule, mail),
        preview: mail.body.replace(/\s+/g, " ").slice(0, 240),
      });
      if (items.length >= take) break;
    }
    return { items, skipped };
  });
}

export async function verifyImap(cfg) {
  try {
    const client = new ImapFlow({
      host: cfg.imap.host,
      port: Number(cfg.imap.port),
      secure: !!cfg.imap.secure,
      auth: { user: cfg.imap.user, pass: cfg.imap.appPassword },
      logger: false,
    });
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
