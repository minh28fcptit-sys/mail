/**
 * Toan bo icon/avatar deu la LINK (URL) -> luu thang vao MongoDB.
 * CDN: jsDelivr (Twemoji) + DiceBear — on dinh, khong chan hotlink.
 */
const EMO = (code) => `https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/${code}.png`;
const SI = (name) => `https://cdn.jsdelivr.net/npm/simple-icons@11/icons/${name}.svg`;

/* ------------------------------------------- Cam xuc kieu Facebook (7 loai) */
export const REACTIONS = [
  { key: "like", label: "Thích", url: EMO("1f44d") },
  { key: "love", label: "Yêu thích", url: EMO("2764") },
  { key: "care", label: "Thương thương", url: EMO("1f970") },
  { key: "haha", label: "Haha", url: EMO("1f606") },
  { key: "wow", label: "Wow", url: EMO("1f62e") },
  { key: "sad", label: "Buồn", url: EMO("1f622") },
  { key: "angry", label: "Tức giận", url: EMO("1f620") },
];

/* ------------------------------------------------- Qua tang / sticker (link) */
export const GIFTS = [
  { key: "gift_box", label: "Hộp quà", url: EMO("1f381") },
  { key: "rose", label: "Hoa hồng", url: EMO("1f339") },
  { key: "bouquet", label: "Bó hoa", url: EMO("1f490") },
  { key: "cake", label: "Bánh kem", url: EMO("1f382") },
  { key: "teddy", label: "Gấu bông", url: EMO("1f9f8") },
  { key: "diamond", label: "Kim cương", url: EMO("1f48e") },
  { key: "trophy", label: "Cúp vàng", url: EMO("1f3c6") },
  { key: "medal", label: "Huy chương", url: EMO("1f3c5") },
  { key: "party", label: "Bắn pháo", url: EMO("1f389") },
  { key: "confetti", label: "Kim tuyến", url: EMO("1f38a") },
  { key: "balloon", label: "Bóng bay", url: EMO("1f388") },
  { key: "heart_fire", label: "Tim cháy", url: EMO("2764-fe0f-200d-1f525") },
  { key: "heart_gift", label: "Tim quà", url: EMO("1f49d") },
  { key: "star", label: "Ngôi sao", url: EMO("1f31f") },
  { key: "crown", label: "Vương miện", url: EMO("1f451") },
  { key: "money", label: "Bao tiền", url: EMO("1f4b0") },
  { key: "coffee", label: "Ly cà phê", url: EMO("2615") },
  { key: "boba", label: "Trà sữa", url: EMO("1f9cb") },
  { key: "pizza", label: "Pizza", url: EMO("1f355") },
  { key: "rocket", label: "Tên lửa", url: EMO("1f680") },
];

/* ------------------------------------------------- Bo emoji cho o nhap chu */
export const EMOJI_GROUPS = [
  {
    name: "Cảm xúc",
    items: ["😀", "😁", "😂", "🤣", "😊", "😍", "🥰", "😘", "😎", "🤩", "🥳", "😜", "🤔", "🙃", "😴", "😭", "😡", "🥲", "😳", "🤗"],
  },
  {
    name: "Cử chỉ",
    items: ["👍", "👎", "👏", "🙏", "🤝", "✌️", "🤟", "👌", "💪", "🫶", "👋", "🤙", "☝️", "🖐️", "🫡"],
  },
  {
    name: "Trái tim",
    items: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💖", "💗", "💓", "💞", "💘", "❤️‍🔥", "💔"],
  },
  {
    name: "Khác",
    items: ["🔥", "✨", "🎉", "🎁", "🌹", "🍀", "⭐", "🌈", "☀️", "🌙", "⚡", "💯", "🏆", "🎮", "⚽"],
  },
];

/* ---------------------------------- Icon thuong hieu (chi hien thi, khong link ra) */
export const BRAND_ICONS = {
  facebook: SI("facebook"),
  messenger: SI("messenger"),
  socketio: SI("socketdotio"),
};

/* ------------------------------------------------------- Avatar (nhieu loai) */
const AVA_STYLES = [
  "adventurer",
  "adventurer-neutral",
  "avataaars",
  "big-ears",
  "big-smile",
  "bottts",
  "croodles",
  "fun-emoji",
  "lorelei",
  "micah",
  "miniavs",
  "notionists",
  "open-peeps",
  "personas",
  "pixel-art",
  "thumbs",
];
const GROUP_STYLES = ["shapes", "identicon", "rings", "thumbs", "bottts-neutral", "glass"];
const AVA_BG = ["b6e3f4", "ffd5dc", "c0aede", "ffdfbf", "d1d4f9", "c7f9cc", "ffe0a3", "f9c7e0", "a0e7e5", "fbe7c6"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const dice = (style, seed, bg) =>
  `https://api.dicebear.com/7.x/${style}/svg?seed=${encodeURIComponent(seed)}&backgroundColor=${bg}`;

/** Danh sach avatar goi y de nguoi dung tu doi (tra ve link) */
export function avatarChoices(seed = "user", n = 24) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const style = AVA_STYLES[i % AVA_STYLES.length];
    out.push({
      key: `${style}-${i}`,
      style,
      url: dice(style, `${seed}-${i}`, AVA_BG[i % AVA_BG.length]),
    });
  }
  return out;
}

export function groupAvatarChoices(seed = "group", n = 12) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const style = GROUP_STYLES[i % GROUP_STYLES.length];
    out.push({ key: `${style}-${i}`, style, url: dice(style, `${seed}-${i}`, AVA_BG[i % AVA_BG.length]) });
  }
  return out;
}

/** Avatar random cho tai khoan moi */
export function randomAvatar(seed = "") {
  return dice(pick(AVA_STYLES), `${seed || "user"}-${Math.random().toString(36).slice(2, 8)}`, pick(AVA_BG));
}

/** Avatar random cho nhom */
export function randomGroupAvatar(seed = "") {
  return dice(pick(GROUP_STYLES), `${seed || "group"}-${Math.random().toString(36).slice(2, 8)}`, pick(AVA_BG));
}

/** Chi cho phep luu link avatar tu CDN tin cay */
export function isSafeAvatarUrl(url = "") {
  return /^https:\/\/(api\.dicebear\.com|cdn\.jsdelivr\.net|i\.pravatar\.cc|ui-avatars\.com|res\.cloudinary\.com)\//.test(
    String(url)
  );
}

export const reactionByKey = (k) => REACTIONS.find((r) => r.key === k) || null;
export const giftByKey = (k) => GIFTS.find((g) => g.key === k) || null;
