# Mail OTP Reader

Web đọc hộp thư và lấy **mã xác minh**, lọc mail theo **3 tầng điều kiện**:

1. **Người gửi** (senders / sendersExclude)
2. **Tiêu đề** (subjectInclude / subjectExclude)
3. **Lý Do** — đọc dòng `Lý Do: ...` (hoặc `Reason:`) bên trong nội dung mail
   (reasonInclude / reasonExclude / bắt buộc có Lý Do)

Ứng dụng **chỉ đọc mail (IMAP)** — không gửi mail.

## Cài đặt

```bash
npm install
npm run setup     # hỏi email + app password + mật khẩu quản trị rồi chạy luôn
# hoặc
npm start
```

- Trang người dùng: http://localhost:3000
- Trang quản trị:  http://localhost:3000/092819  (mật khẩu mặc định: `092819`)

Đổi đường dẫn quản trị: `ADMIN_PATH=/duong-dan-khac npm start`
(nhớ sửa `src` script trong `views/index.html` cho khớp).

## Gmail
Bật 2FA → tạo **App Password** 16 ký tự → dùng làm mật khẩu IMAP.

## Ví dụ mail Moonton
```
Mã Xác Minh:
459048
Lý Do: Thay Đổi Địa Chỉ Email
Giờ Server: 2026-08-07 21:12:39
Địa Chỉ IP: 42.114.212.234
```
→ rule *Moonton — Thay Đổi Địa Chỉ Email* khớp, trả mã `459048`.
IP và giờ server được loại khỏi vùng dò mã nên không bắt nhầm số.

---

## 💬 Mục Tin nhắn (chat kiểu Messenger)

Trang: **http://localhost:3000/chat** (nút "Tin nhắn" nổi ở góc phải trang chính, có badge số tin chưa đọc).

Tính năng:
- Danh sách hội thoại: avatar, trạng thái online, ghim, **badge số tin nhắn chưa đọc** (tổng + từng hội thoại, hiện luôn ở tiêu đề tab).
- Khung chat 2 pane trượt như app điện thoại, tối ưu **màn hình dọc** (100dvh, safe-area cho iPhone).
- **Ngày giờ đầy đủ** theo giờ Việt Nam: dải ngăn "Hôm nay / Hôm qua / thứ - ngày", giờ dưới mỗi tin, hover xem ngày giờ đầy đủ.
- **Icon cảm xúc Facebook** (Like, Love, Care, Haha, Wow, Sad, Angry): nhấn giữ / nhấp đôi / chuột phải vào bong bóng chat để thả cảm xúc.
- **Quà tặng (gift)**: khay 8 món quà, gửi thành tin nhắn quà.
- Icon thương hiệu Facebook / Messenger cho nút liên kết.
- **Toàn bộ icon lưu dưới dạng LINK (URL)** trong `server/assets.js` → lưu thẳng vào MongoDB, không nhúng file ảnh.

### MongoDB
```bash
MONGODB_URI="mongodb+srv://user:pass@cluster/..." MONGODB_DB=mail_chat npm start
```
- Toàn bộ chat lưu **trực tiếp vào MongoDB** (collections `users`, `conversations`, `messages`).
- Bắt buộc có `MONGODB_URI` (hoặc file `.env`), nếu thiếu server sẽ dừng — không còn lưu file JSON.

### API chat
| Method | Đường dẫn | Mô tả |
|---|---|---|
| GET | `/api/chat/assets` | Danh sách link icon cảm xúc / quà / brand |
| GET | `/api/chat/conversations` | Hội thoại + số tin chưa đọc |
| GET | `/api/chat/unread` | Tổng số tin chưa đọc |
| POST | `/api/chat/conversations` | Tạo hội thoại `{ title, avatarUrl }` |
| GET | `/api/chat/conversations/:id/messages` | Lấy tin nhắn |
| POST | `/api/chat/conversations/:id/messages` | Gửi `{ type: text\|gift\|icon, text, key }` |
| POST | `/api/chat/conversations/:id/read` | Đánh dấu đã đọc |
| POST | `/api/chat/conversations/:id/incoming` | Mô phỏng tin đến `{ text }` hoặc `{ key }` |
| POST | `/api/chat/messages/:id/reaction` | Thả cảm xúc `{ key: like\|love\|... }` |


## Chatbox (MongoDB) — `/chat`

- **Tài khoản thật**: bấm vào Tin nhắn → nhập **tên + mật khẩu**. Tên chưa tồn tại thì tạo mới, đã tồn tại thì đăng nhập.
  Mật khẩu băm bằng `scrypt` (salt riêng), token phiên lưu trong DB.
- **Nhớ trên thiết bị**: token lưu ở `localStorage` (`chat.token`) nên lần sau không hỏi lại. Đăng nhập ở máy khác chỉ cần nhập đúng tên + mật khẩu.
- **Tạo nhóm**: nút `+` hoặc "Tạo nhóm mới" → đặt tên nhóm, chọn thành viên. Có thể thêm thành viên sau bằng nút `+` trong khung chat.
- **Avatar random**: server tự sinh link avatar (DiceBear) cho mỗi tài khoản và mỗi nhóm, lưu dạng URL.
- **Mục icon cảm xúc kiểu Facebook**: hàng icon ngay trên khung nhập — bấm là gửi; nhấn giữ/nhấp đôi bong bóng để thả cảm xúc. Không còn liên kết mở facebook.com.
- **Lưu trữ**: MongoDB bắt buộc qua `MONGODB_URI` (collections `users`, `conversations`, `messages`).

```bash
npm install
MONGODB_URI="mongodb+srv://..." MONGODB_DB="mail_chat" npm start
```

---

## v4 — Chat realtime bằng Socket.IO

- **Gửi là nhận ngay**: `socket.io` (`/socket.io`), mỗi người 1 room `u:<userId>` — không còn polling.
- **Thông báo tức thì**: toast + Notification trình duyệt + tiếng "bíp", badge số tin chưa đọc tự cập nhật.
- **Trạng thái hoạt động**: online/offline đổi ngay khi kết nối/ngắt kết nối (`presence:update`), có "đang nhập…" và "đã xem".
- **Sửa / xoá (thu hồi) tin nhắn**: giữ (hoặc bấm phải / nháy đúp) vào tin nhắn để mở menu. Chỉ sửa tin của mình; quản trị nhóm xoá được tin trong nhóm.
- **Quản lý nhóm**: đổi tên, đổi ảnh nhóm, thêm/xoá thành viên, rời nhóm, xoá nhóm (nút ⋯ trong khung chat).
- **Tối ưu icon**: 20 quà tặng, 7 cảm xúc kiểu Facebook, 4 nhóm emoji, 24 avatar chọn được (tất cả lưu dạng LINK trong MongoDB).
- REST cũ vẫn hoạt động và được dùng làm phương án dự phòng nếu WebSocket bị chặn.

### Chạy

```bash
npm install
MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net" npm start
# http://localhost:3000/chat
```

### Sự kiện Socket.IO

| Gửi lên | Ý nghĩa |
| --- | --- |
| `conversations:list`, `conversation:open` | tải danh sách / mở hội thoại |
| `message:send`, `message:edit`, `message:delete`, `message:react` | gửi / sửa / thu hồi / thả cảm xúc |
| `conversation:create`, `conversation:update`, `conversation:delete`, `conversation:leave` | tạo / đổi tên-ảnh / xoá / rời nhóm |
| `conversation:members:add`, `conversation:member:remove` | thêm / xoá thành viên |
| `conversation:read`, `typing`, `me:avatar` | đã đọc / đang nhập / đổi avatar |

| Nhận về | Ý nghĩa |
| --- | --- |
| `message:new`, `message:update`, `message:read` | tin mới / tin vừa sửa-xoá-reaction / đã xem |
| `conversation:update`, `conversation:removed` | hội thoại thay đổi / bị xoá |
| `presence:update`, `typing`, `me:update`, `unread:total` | trạng thái online, đang nhập, avatar, số chưa đọc |

## v5 — Cảm xúc khi giữ tin, nút 3 chấm, trạng thái off dứt điểm, trang cá nhân

- **Giữ (long-press ~0.4s) hoặc bấm phải / nháy đúp** vào tin nhắn → mở bảng thả cảm xúc ngay.
- **Nút ⋯ cạnh mỗi tin nhắn** → Sửa · Sao chép · Thả cảm xúc · Thu hồi/Xoá.
- **Trạng thái hoạt động chuẩn**: khi thoát, server ghi ngay `online: false` vào DB (`setUserOnline`), và mỗi lần server khởi động lại thì `resetPresence()` xoá trạng thái cũ → tải lại trang không còn hiện "đang hoạt động" rồi mới tắt.
- **Đã xem bằng avatar nhỏ** (kiểu Messenger) ở tin cuối mà mỗi người đã đọc; nhóm hiện tối đa 5 avatar + "+n".
- **Trang cá nhân**: bấm avatar bất kỳ (người gửi, avatar đã xem, avatar khung chat, avatar của mình) → xem hồ sơ: ngày/tháng/năm sinh (kèm tuổi, nhắc sinh nhật), giới tính, nơi ở, sở thích (dạng thẻ), giới thiệu, ghi chú bản thân, ngày tham gia, trạng thái online. Hồ sơ của mình có form chỉnh sửa + đổi tên + đổi ảnh; người khác có nút "Gửi tin nhắn".
- API mới: `GET /api/chat/users/:id/profile`, `PUT /api/chat/me/profile`; socket: `user:profile`, `me:profile`, broadcast `profile:update`.

## Tài khoản quản trị & nhóm thông báo

- Khi server khởi động, hệ thống tự tạo tài khoản quản trị (`ADMIN_NAME` / `ADMIN_PASSWORD`,
  mặc định `Admin` / `admin123`) và một nhóm **📢 Thông báo** được ghim lên đầu danh sách.
- Mọi người dùng (kể cả người đăng ký sau) đều tự động là thành viên nhóm thông báo.
- Chỉ quản trị viên được đăng tin trong nhóm; thành viên khác chỉ **xem** và **thả cảm xúc**.
  Ô soạn tin được thay bằng dòng nhắc: “Vui lòng nhắn tin riêng hoặc tạo nhóm mới để trò chuyện nhé.”
- Không ai có thể rời/xoá/đổi tên nhóm thông báo ngoài quản trị viên.

- Tài khoản admin **không nhận tin nhắn riêng**: admin bị ẩn khỏi danh sách chọn người, không thể tạo/gửi chat 1-1 hay bị thêm vào nhóm bởi người dùng thường.
