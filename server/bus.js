/**
 * Kenh phat su kien realtime. realtime.js se gan "sink" (Socket.IO),
 * cac module khac chi can goi emitToUsers(...) — khong phu thuoc socket.
 */
let sink = null;

export function setRealtimeSink(fn) {
  sink = typeof fn === "function" ? fn : null;
}

export function emitToUsers(userIds, event, data) {
  if (!sink) return;
  const ids = Array.from(new Set((userIds || []).map(String))).filter(Boolean);
  if (!ids.length) return;
  sink(ids, event, data);
}
