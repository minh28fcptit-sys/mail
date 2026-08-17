const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let CFG = null;

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", !!err);
  t.classList.add("show");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("show"), 2600);
}
const api = async (url, opt = {}) => {
  const res = await fetch(url, {
    ...opt,
    headers: { "Content-Type": "application/json", ...(opt.headers || {}) },
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || `Lỗi ${res.status}`);
  return d;
};
const lines = (a) => (a || []).join("\n");
const toArr = (v) => String(v || "").split("\n").map((s) => s.trim()).filter(Boolean);

/* -------- Auth -------- */
async function boot() {
  const me = await api("/api/admin/me");
  if (me.loggedIn) {
    $("#loginView").hidden = true;
    $("#appView").hidden = false;
    await loadConfig();
  } else {
    $("#loginView").hidden = false;
    $("#appView").hidden = true;
  }
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password: $("#pwd").value }) });
    await boot();
    toast("Đăng nhập thành công");
  } catch (err) {
    toast(err.message, true);
  }
});
$("#logout").addEventListener("click", async () => {
  await api("/api/admin/logout", { method: "POST" });
  location.reload();
});

/* -------- Tabs -------- */
document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.tab));
  })
);

/* -------- Kho ảnh Cloudinary -------- */
const mb = (n) => (!n && n !== 0 ? "—" : `${(n / 1048576).toFixed(1)} MB`);

function pctTxt(x) {
  return typeof x === "number" ? `${x.toFixed(1)}%` : "—";
}

function usageBlock(u, note) {
  if (!u) {
    return `<div class="out" style="margin-bottom:12px">${note ? "⚠️ " + esc(note) : "Chưa kiểm tra — bấm “Kiểm tra dung lượng”."
      }</div>`;
  }
  return `<div class="out" style="margin-bottom:12px">
    Gói: <b>${esc(u.plan || "—")}</b> · Mức cao nhất: <b>${pctTxt(u.worstPercent)}</b>${u.full ? " · <b>ĐÃ ĐẦY</b>" : ""}<br>
    Dung lượng: ${pctTxt(u.storage?.percent)} (${mb(u.storage?.usage)}${u.storage?.limit ? " / " + mb(u.storage.limit) : ""})<br>
    Băng thông: ${pctTxt(u.bandwidth?.percent)} (${mb(u.bandwidth?.usage)}${u.bandwidth?.limit ? " / " + mb(u.bandwidth.limit) : ""})<br>
    Credits: ${pctTxt(u.credits?.percent)} (${u.credits?.usage ?? "—"}${u.credits?.limit ? " / " + u.credits.limit : ""})<br>
    Số ảnh: ${u.resources ?? "—"} · Cloudinary cập nhật: ${esc(u.lastUpdated || "—")}
  </div>`;
}

function storeCard(s) {
  const u = s.usage;
  return `<details class="acc" data-id="${esc(s.id)}">
    <summary><span>${esc(s.name)}<br><span class="mini">${s.enabled ? "Đang bật" : "Đang tắt"}${s.full ? " · đã đầy" : ""
    } · ${esc(s.cloudName)} · ${esc(s.uploads)} ảnh đã tải</span></span><span class="mini">${u ? pctTxt(u.worstPercent) : "chưa kiểm tra"
    } ▾</span></summary>
    <div class="body">
      ${usageBlock(u, s.lastError)}
      <div class="field"><label>Tên</label><input data-f="name" value="${esc(s.name)}" /></div>
      <div class="grid2">
        <div class="field"><label>Thư mục</label><input data-f="folder" value="${esc(s.folder || "")}" /></div>
        <div class="field"><label>Đầy khi đạt (%)</label><input data-f="fullPercent" inputmode="numeric" value="${esc(
      s.fullPercent ?? 95
    )}" /></div>
      </div>
      <div class="field"><label>API key</label><input data-f="apiKey" value="${esc(s.apiKey)}" /></div>
      <div class="field"><label>API secret mới (để trống nếu giữ nguyên)</label><input data-f="apiSecret" type="password" placeholder="${s.apiSecretSet ? "******** (đã lưu)" : "API secret"
    }" /></div>
      <div class="switch" style="margin-bottom:12px"><span>Bật kho này</span><input type="checkbox" data-f="enabled" ${s.enabled ? "checked" : ""
    } /></div>
      ${s.lastError ? `<div class="hint" style="color:#ff8f8f">Lỗi gần nhất: ${esc(s.lastError)}</div>` : ""}
      <div class="btn-row">
        <button class="btn ghost" data-act="check">Kiểm tra dung lượng</button>
        <button class="btn ghost" data-act="del">Xoá kho</button>
        <button class="btn" data-act="save">Lưu</button>
      </div>
    </div>
  </details>`;
}

async function loadStores() {
  const d = await api("/api/admin/media-stores");
  const box = $("#msList");
  box.innerHTML = d.items.length ? d.items.map(storeCard).join("") : `<div class="hint">Chưa có kho nào — thêm API key ở trên.</div>`;
  box.querySelectorAll("details").forEach((el) => {
    const id = el.dataset.id;
    const val = (f) => el.querySelector(`[data-f="${f}"]`);
    el.querySelector('[data-act="check"]')?.addEventListener("click", async () => {
      try {
        toast("Đang đọc dung lượng thật từ Cloudinary…");
        await api(`/api/admin/media-stores/${id}/check`, { method: "POST" });
        await loadStores();
        toast("Đã cập nhật dung lượng");
      } catch (e) {
        await loadStores().catch(() => { });
        await loadPush().catch(() => { });
        toast(e.message, true);
      }
    });
    el.querySelector('[data-act="save"]')?.addEventListener("click", async () => {
      const patch = {
        name: val("name").value.trim(),
        folder: val("folder").value.trim(),
        fullPercent: Number(val("fullPercent").value) || 90,
        enabled: val("enabled").checked,
      };
      if (val("apiKey").value.trim()) patch.apiKey = val("apiKey").value.trim();
      if (val("apiSecret").value.trim()) patch.apiSecret = val("apiSecret").value.trim();
      try {
        await api(`/api/admin/media-stores/${id}`, { method: "PUT", body: JSON.stringify(patch) });
        await loadStores();
        toast("Đã lưu kho");
      } catch (e) {
        toast(e.message, true);
      }
    });
    el.querySelector('[data-act="del"]')?.addEventListener("click", async () => {
      if (!confirm("Xoá kho này? Ảnh đã tải lên vẫn còn trên Cloudinary.")) return;
      try {
        await api(`/api/admin/media-stores/${id}`, { method: "DELETE" });
        await loadStores();
        toast("Đã xoá kho");
      } catch (e) {
        toast(e.message, true);
      }
    });
  });
}

function newStoreBody() {
  return {
    name: $("#msName").value.trim(),
    cloudName: $("#msCloud").value.trim(),
    apiKey: $("#msKey").value.trim(),
    apiSecret: $("#msSecret").value.trim(),
    folder: $("#msFolder").value.trim(),
    fullPercent: Number($("#msFull").value) || 90,
  };
}

$("#msCheckNew").addEventListener("click", async () => {
  const out = $("#msOut");
  out.hidden = false;
  out.textContent = "Đang kiểm tra API key…";
  try {
    const d = await api("/api/admin/media-stores/check", { method: "POST", body: JSON.stringify(newStoreBody()) });
    out.innerHTML = (d.warning ? `Key tải ảnh được ✅ nhưng không đọc được dung lượng` : `Key hợp lệ ✅`) +
      usageBlock(d.usage, d.warning);
  } catch (e) {
    out.textContent = "Lỗi: " + e.message;
  }
});

$("#msAdd").addEventListener("click", async () => {
  try {
    await api("/api/admin/media-stores", { method: "POST", body: JSON.stringify(newStoreBody()) });
    ["#msName", "#msCloud", "#msKey", "#msSecret", "#msFolder", "#msFull"].forEach((s2) => ($(s2).value = ""));
    $("#msOut").hidden = true;
    await loadStores();
    toast("Đã thêm kho ảnh");
  } catch (e) {
    toast(e.message, true);
  }
});

$("#msRefresh").addEventListener("click", async () => {
  const ids = [...$("#msList").querySelectorAll("details")].map((el) => el.dataset.id);
  toast("Đang kiểm tra tất cả kho…");
  for (const id of ids) await api(`/api/admin/media-stores/${id}/check`, { method: "POST" }).catch(() => { });
  await loadStores();
  toast("Đã cập nhật dung lượng");
});


/* -------- Thông báo đẩy (Web Push) -------- */
async function loadPush() {
  const el = $("#pushState");
  try {
    const d = await api("/api/admin/push");
    $("#pushSubject").value = d.subject || "";
    el.innerHTML = d.configured
      ? `✅ Đã bật · thiết bị đang nhận: <b>${d.devices}</b>${d.fromEnv ? " · khoá lấy từ biến môi trường" : ""}<br>
         Public key: <span class="mini">${esc(String(d.publicKey || "").slice(0, 28))}…</span>`
      : "⚠️ Chưa có khoá VAPID — bấm “Tạo khoá VAPID” để bật thông báo đẩy.";
  } catch (e) {
    el.textContent = e.message;
  }
}

function pushOut(msg, err = false) {
  const o = $("#pushOut");
  o.hidden = false;
  o.textContent = msg;
  o.style.color = err ? "#ff8f8f" : "";
}

$("#pushGen").addEventListener("click", async () => {
  if (!confirm("Tạo cặp khoá mới? Mọi thiết bị đang bật thông báo sẽ phải bật lại.")) return;
  try {
    await api("/api/admin/push/keys", { method: "POST", body: JSON.stringify({ subject: $("#pushSubject").value }) });
    await loadPush();
    pushOut("Đã tạo khoá VAPID — người dùng bấm 🔔 trong web để bật thông báo.");
    toast("Đã bật thông báo đẩy");
  } catch (e) {
    pushOut(e.message, true);
    toast(e.message, true);
  }
});

$("#pushSave").addEventListener("click", async () => {
  try {
    await api("/api/admin/push", { method: "PUT", body: JSON.stringify({ subject: $("#pushSubject").value }) });
    await loadPush();
    toast("Đã lưu");
  } catch (e) {
    toast(e.message, true);
  }
});

$("#pushTest").addEventListener("click", async () => {
  try {
    const d = await api("/api/admin/push/test", { method: "POST" });
    pushOut(`Đã gửi thử: ${d.sent ?? 0} thiết bị nhận được${d.removed ? `, ${d.removed} thiết bị hết hiệu lực đã xoá` : ""}.`);
  } catch (e) {
    pushOut(e.message, true);
  }
});

/* -------- Config -------- */
async function loadConfig() {
  CFG = await api("/api/admin/config");
  $("#imapUser").value = CFG.imap.user || "";
  $("#imapPass").value = "";
  $("#imapPass").placeholder = CFG.imap.appPassword ? "******** (đã lưu)" : "App password";
  $("#imapHost").value = CFG.imap.host || "";
  $("#imapPort").value = CFG.imap.port || 993;
  $("#imapBox").value = CFG.imap.mailbox || "INBOX";
  $("#filterEnabled").checked = !!CFG.filterEnabled;
  renderRules();
  await loadStores().catch(() => { });
  await loadPush().catch(() => { });
}

function ruleCard(r, i) {
  return `<details class="acc" data-i="${i}">
    <summary><span>${esc(r.name)}<br><span class="mini">${r.enabled ? "Đang bật" : "Đang tắt"} · ${r.maxAgeMinutes} phút</span></span><span class="mini">▾</span></summary>
    <div class="body">
      <div class="field"><label>Tên loại mail</label><input data-f="name" value="${esc(r.name)}" /></div>
      <div class="switch" style="margin-bottom:12px"><span>Bật loại mail này</span><input type="checkbox" data-f="enabled" ${r.enabled ? "checked" : ""} /></div>

      <div class="field"><label>① Người gửi — khớp 1 trong (mỗi dòng 1 mục)</label>
        <textarea data-f="senders">${esc(lines(r.senders))}</textarea></div>
      <div class="field"><label>Người gửi loại trừ</label>
        <textarea data-f="sendersExclude">${esc(lines(r.sendersExclude))}</textarea></div>

      <div class="field"><label>② Tiêu đề phải chứa 1 trong</label>
        <textarea data-f="subjectInclude">${esc(lines(r.subjectInclude))}</textarea></div>
      <div class="field"><label>Tiêu đề loại trừ</label>
        <textarea data-f="subjectExclude">${esc(lines(r.subjectExclude))}</textarea></div>

      <div class="field"><label>③ Lý Do phải chứa 1 trong</label>
        <textarea data-f="reasonInclude">${esc(lines(r.reasonInclude))}</textarea>
        <div class="hint">Đọc dòng “Lý Do: …” bên trong nội dung mail.</div></div>
      <div class="field"><label>Lý Do loại trừ</label>
        <textarea data-f="reasonExclude">${esc(lines(r.reasonExclude))}</textarea></div>
      <div class="switch" style="margin-bottom:12px"><span>Bắt buộc mail có dòng Lý Do</span>
        <input type="checkbox" data-f="reasonRequired" ${r.reasonRequired ? "checked" : ""} /></div>

      <div class="field"><label>Nội dung phải chứa</label><textarea data-f="bodyInclude">${esc(lines(r.bodyInclude))}</textarea></div>
      <div class="field"><label>Nội dung loại trừ</label><textarea data-f="bodyExclude">${esc(lines(r.bodyExclude))}</textarea></div>

      <div class="grid2">
        <div class="field"><label>Regex mã OTP</label><input data-f="otpRegex" value="${esc(r.otpRegex)}" /></div>
        <div class="field"><label>Hiệu lực (phút)</label><input data-f="maxAgeMinutes" inputmode="numeric" value="${esc(r.maxAgeMinutes)}" /></div>
      </div>
      <div class="field"><label>Từ khoá ngữ cảnh quanh mã</label><textarea data-f="otpContextKeywords">${esc(lines(r.otpContextKeywords))}</textarea></div>
      <div class="switch" style="margin-bottom:12px"><span>Chỉ mail chưa đọc</span><input type="checkbox" data-f="unseenOnly" ${r.unseenOnly ? "checked" : ""} /></div>

      <button class="btn ghost sm" data-del="${i}" style="width:100%;color:var(--danger)">Xoá loại mail</button>
    </div>
  </details>`;
}

function renderRules() {
  $("#ruleList").innerHTML = CFG.rules.map(ruleCard).join("");
  $("#ruleList").querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => {
      collectRules();
      CFG.rules.splice(Number(b.dataset.del), 1);
      renderRules();
    })
  );
  $("#previewRule").innerHTML = CFG.rules.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
}

const LIST_FIELDS = ["senders", "sendersExclude", "subjectInclude", "subjectExclude", "reasonInclude", "reasonExclude", "bodyInclude", "bodyExclude", "otpContextKeywords"];

function collectRules() {
  $("#ruleList").querySelectorAll(".acc").forEach((el) => {
    const r = CFG.rules[Number(el.dataset.i)];
    el.querySelectorAll("[data-f]").forEach((inp) => {
      const f = inp.dataset.f;
      if (inp.type === "checkbox") r[f] = inp.checked;
      else if (LIST_FIELDS.includes(f)) r[f] = toArr(inp.value);
      else if (f === "maxAgeMinutes") r[f] = Number(inp.value) || 15;
      else r[f] = inp.value;
    });
  });
}

$("#addRule").addEventListener("click", () => {
  collectRules();
  CFG.rules.push({
    id: `rule_${Math.random().toString(36).slice(2, 10)}`,
    name: "Loại mail mới", enabled: true,
    senders: [], sendersExclude: [], subjectInclude: [], subjectExclude: [],
    reasonInclude: [], reasonExclude: [], reasonRequired: false,
    bodyInclude: [], bodyExclude: [],
    otpRegex: "\\b(\\d{6})\\b", otpContextKeywords: ["mã xác minh", "code"],
    maxAgeMinutes: 15, unseenOnly: false,
  });
  renderRules();
  $("#ruleList").lastElementChild.open = true;
});

async function save() {
  collectRules();
  const body = {
    imap: {
      user: $("#imapUser").value.trim(),
      appPassword: $("#imapPass").value || "********",
      host: $("#imapHost").value.trim(),
      port: Number($("#imapPort").value) || 993,
      secure: true,
      mailbox: $("#imapBox").value.trim() || "INBOX",
    },
    filterEnabled: $("#filterEnabled").checked,
    rules: CFG.rules,
  };
  if ($("#adminPwd").value) body.adminPassword = $("#adminPwd").value;
  try {
    CFG = await api("/api/admin/config", { method: "PUT", body: JSON.stringify(body) });
    $("#adminPwd").value = "";
    $("#imapPass").value = "";
    renderRules();
    toast("Đã lưu cấu hình");
  } catch (e) {
    toast(e.message, true);
  }
}
$("#saveBtn1").addEventListener("click", save);
$("#saveBtn2").addEventListener("click", save);

$("#testBtn").addEventListener("click", async () => {
  const out = $("#testOut");
  out.hidden = false;
  out.textContent = "Đang kiểm tra…";
  try {
    const d = await api("/api/admin/test", { method: "POST" });
    out.textContent = d.imap.ok ? "✅ IMAP kết nối thành công" : `❌ IMAP lỗi: ${d.imap.error}`;
  } catch (e) {
    out.textContent = `❌ ${e.message}`;
  }
});

$("#classifyBtn").addEventListener("click", async () => {
  const out = $("#classifyOut");
  out.hidden = false;
  out.textContent = "Đang đối chiếu…";
  try {
    const d = await api("/api/admin/classify", {
      method: "POST",
      body: JSON.stringify({ sample: { from: $("#sFrom").value, subject: $("#sSubject").value, body: $("#sBody").value } }),
    });
    out.textContent =
      `Lý Do nhận diện: ${d.detectedReason || "(không có)"}\n\n` +
      d.results.map((r) => `${r.ok ? "✅" : "❌"} ${r.name}\n   ${r.reason}${r.otp ? `\n   Mã: ${r.otp}` : ""}`).join("\n\n");
  } catch (e) {
    out.textContent = `❌ ${e.message}`;
  }
});

$("#previewBtn").addEventListener("click", async () => {
  const out = $("#previewOut");
  out.hidden = false;
  out.textContent = "Đang quét hộp thư…";
  try {
    const d = await api("/api/admin/preview", { method: "POST", body: JSON.stringify({ ruleId: $("#previewRule").value }) });
    out.textContent =
      `KHỚP (${d.items.length}):\n` +
      (d.items.map((i) => `✅ ${i.otp || "—"} | ${i.from}\n   Lý do: ${i.reason || "—"}\n   ${i.subject}`).join("\n") || "(trống)") +
      `\n\nBỊ LOẠI (${d.skipped.length}):\n` +
      (d.skipped.map((s) => `❌ ${s.from}\n   ${s.reason}${s.ruleReason ? ` | Lý do mail: ${s.ruleReason}` : ""}`).join("\n") || "(trống)");
  } catch (e) {
    out.textContent = `❌ ${e.message}`;
  }
});

boot();
