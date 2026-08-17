/* Khoá phóng to (zoom) trên điện thoại: chặn chụm 2 ngón, chạm 2 lần nhanh và
   cử chỉ zoom của Safari. Không ảnh hưởng thao tác chạm/cuộn bình thường. */
(function () {
  var d = document;

  /* Safari iOS: cử chỉ chụm ngón */
  ["gesturestart", "gesturechange", "gestureend"].forEach(function (ev) {
    d.addEventListener(ev, function (e) { e.preventDefault(); }, { passive: false });
  });

  /* Chụm 2 ngón trên mọi trình duyệt */
  d.addEventListener("touchmove", function (e) {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  /* Chạm nhanh 2 lần = zoom -> chặn, nhưng vẫn cho bấm bình thường */
  var last = 0;
  d.addEventListener("touchend", function (e) {
    var now = Date.now();
    if (now - last <= 300) e.preventDefault();
    last = now;
  }, { passive: false });

  /* Ctrl + con lăn chuột (trình duyệt máy tính giả lập điện thoại) */
  d.addEventListener("wheel", function (e) {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });

  /* Nếu hệ thống vẫn zoom (xoay màn hình), ép về tỉ lệ 1 */
  var vp = d.querySelector('meta[name="viewport"]');
  if (vp) {
    window.addEventListener("orientationchange", function () {
      vp.setAttribute(
        "content",
        "width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"
      );
    });
  }
})();
