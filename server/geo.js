/**
 * Danh muc hanh chinh Viet Nam (Tinh/Thanh - Quan/Huyen - Phuong/Xa).
 * Lay tu API cong khai provinces.open-api.vn, co cache trong bo nho.
 * Neu may chu khong ra internet -> dung danh sach tinh/thanh du phong,
 * luc do o Quan/Huyen va Phuong/Xa se cho nhap tay.
 */
const BASE = process.env.GEO_API_BASE || "https://provinces.open-api.vn/api/v1";
const TTL = Number(process.env.GEO_TTL_MS || 12 * 60 * 60 * 1000);
const cache = new Map(); // key -> { at, data }

const FALLBACK_PROVINCES = [
  "An Giang", "Bà Rịa - Vũng Tàu", "Bạc Liêu", "Bắc Giang", "Bắc Kạn", "Bắc Ninh", "Bến Tre", "Bình Dương",
  "Bình Định", "Bình Phước", "Bình Thuận", "Cao Bằng", "Cà Mau", "Cần Thơ", "Đà Nẵng", "Đắk Lắk", "Đắk Nông",
  "Điện Biên", "Đồng Nai", "Đồng Tháp", "Gia Lai", "Hà Giang", "Hà Nam", "Hà Nội", "Hà Tĩnh", "Hải Dương",
  "Hải Phòng", "Hậu Giang", "Hoà Bình", "Hưng Yên", "Khánh Hoà", "Kiên Giang", "Kon Tum", "Lai Châu", "Lâm Đồng",
  "Lạng Sơn", "Lào Cai", "Long An", "Nam Định", "Nghệ An", "Ninh Bình", "Ninh Thuận", "Phú Thọ", "Phú Yên",
  "Quảng Bình", "Quảng Nam", "Quảng Ngãi", "Quảng Ninh", "Quảng Trị", "Sóc Trăng", "Sơn La", "Tây Ninh",
  "Thái Bình", "Thái Nguyên", "Thanh Hoá", "Thừa Thiên Huế", "Tiền Giang", "TP. Hồ Chí Minh", "Trà Vinh",
  "Tuyên Quang", "Vĩnh Long", "Vĩnh Phúc", "Yên Bái",
].map((name, i) => ({ code: `fb-${i}`, name }));

async function get(path, key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Danh mục địa chỉ lỗi ${res.status}`);
  const data = await res.json();
  cache.set(key, { at: Date.now(), data });
  return data;
}

const slim = (a) => (a || []).map((x) => ({ code: String(x.code), name: x.name }));

export async function provinces() {
  try {
    return { items: slim(await get("/p/", "p")), live: true };
  } catch {
    return { items: FALLBACK_PROVINCES, live: false };
  }
}

export async function districts(provinceCode) {
  try {
    const d = await get(`/p/${encodeURIComponent(provinceCode)}?depth=2`, `p:${provinceCode}`);
    return { items: slim(d.districts), live: true };
  } catch {
    return { items: [], live: false };
  }
}

export async function wards(districtCode) {
  try {
    const d = await get(`/d/${encodeURIComponent(districtCode)}?depth=2`, `d:${districtCode}`);
    return { items: slim(d.wards), live: true };
  } catch {
    return { items: [], live: false };
  }
}
