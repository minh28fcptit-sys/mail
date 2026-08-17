const $ = (s) => document.querySelector(s);
const rulesEl = $("#rules");
const resultsEl = $("#results");
const getBtn = $("#getBtn");
let selected = null;
let busy = false;

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", !!err);
  t.classList.add("show");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("show"), 2600);
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function timeAgo(d) {
  if (!d) return "—";
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 1) return "vừa xong";
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} giờ trước` : new Date(d).toLocaleString("vi-VN");
}

function ruleMeta(r) {
  const bits = [];
  if (r.senders?.length) bits.push(`Từ: ${r.senders[0]}`);
  if (r.reasonInclude?.length) bits.push(`Lý do: ${r.reasonInclude[0]}`);
  else if (r.subjectInclude?.length) bits.push(`Tiêu đề: ${r.subjectInclude[0]}`);
  bits.push(`${r.maxAgeMinutes} phút`);
  return bits.join(" · ");
}

async function loadAccount() {
  try {
    const d = await (await fetch("/api/client/account")).json();
    $("#account").textContent = d.account || "Chưa cấu hình email";
    $("#accountState").textContent = d.configured ? "Đã kết nối hộp thư" : "Vào trang quản trị để cấu hình";
    $("#dot").classList.toggle("off", !d.configured);
    $("#filterState").textContent = d.filterEnabled ? "Bộ lọc bật" : "Bộ lọc tắt";

    if (!d.rules.length) {
      rulesEl.innerHTML = `<div class="empty"><span class="ico">🗂️</span>Chưa có loại mail nào được bật.</div>`;
      return;
    }
    rulesEl.innerHTML = d.rules
      .map(
        (r) => `<button class="rule" type="button" aria-pressed="false" data-id="${esc(r.id)}">
          <span><span class="nm">${esc(r.name)}</span><span class="meta">${esc(ruleMeta(r))}</span></span>
          <span class="check">✓</span>
        </button>`
      )
      .join("");

    rulesEl.querySelectorAll(".rule").forEach((b) =>
      b.addEventListener("click", () => {
        rulesEl.querySelectorAll(".rule").forEach((x) => x.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        selected = b.dataset.id;
        getBtn.disabled = !d.configured;
      })
    );
    rulesEl.querySelector(".rule")?.click();
  } catch {
    toast("Không tải được cấu hình", true);
  }
}

function renderItems(items, ruleName) {
  if (!items.length) {
    resultsEl.innerHTML = `<div class="card empty"><span class="ico">🔍</span>
      Không có mail nào khớp <b>${esc(ruleName)}</b> trong khoảng thời gian cho phép.</div>`;
    return;
  }
  resultsEl.innerHTML = items
    .map(
      (it) => `<article class="otp-card">
        <div class="otp-head"><span class="tag">${esc(it.ruleName)}</span><span>${esc(timeAgo(it.date))}</span></div>
        <div class="otp-code">${esc(it.otp || "—")}</div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="copy" data-otp="${esc(it.otp || "")}">Sao chép mã</button>
        </div>
        <dl class="kv">
          <dt>Người gửi</dt><dd>${esc(it.from)}</dd>
          <dt>Tiêu đề</dt><dd>${esc(it.subject || "—")}</dd>
          <dt>Lý do</dt><dd>${esc(it.reason || "—")}</dd>
          ${it.ip ? `<dt>IP</dt><dd>${esc(it.ip)}</dd>` : ""}
          ${it.serverTime ? `<dt>Giờ server</dt><dd>${esc(it.serverTime)}</dd>` : ""}
        </dl>
      </article>`
    )
    .join("");

  resultsEl.querySelectorAll(".copy").forEach((b) =>
    b.addEventListener("click", async () => {
      const v = b.dataset.otp;
      if (!v) return toast("Không có mã để sao chép", true);
      try {
        await navigator.clipboard.writeText(v);
      } catch {
        const t = document.createElement("textarea");
        t.value = v;
        document.body.appendChild(t);
        t.select();
        document.execCommand("copy");
        t.remove();
      }
      b.textContent = "Đã sao chép ✓";
      setTimeout(() => (b.textContent = "Sao chép mã"), 1600);
      toast(`Đã sao chép ${v}`);
    })
  );
}

getBtn.addEventListener("click", async () => {
  if (!selected || busy) return;
  busy = true;
  getBtn.disabled = true;
  getBtn.textContent = "Đang quét hộp thư…";
  resultsEl.innerHTML = `<div class="skel"></div><div class="skel" style="opacity:.6"></div>`;
  try {
    const res = await fetch("/api/client/otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ruleId: selected }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "Lỗi không xác định");
    renderItems(d.items, d.rule.name);
    if (d.items.length) toast(`Tìm thấy ${d.items.length} mail khớp`);
  } catch (e) {
    resultsEl.innerHTML = `<div class="card empty"><span class="ico">⚠️</span>${esc(e.message)}</div>`;
    toast(e.message, true);
  } finally {
    busy = false;
    getBtn.disabled = false;
    getBtn.textContent = "Lấy mã xác minh";
  }
});

loadAccount();
