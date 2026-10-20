// Ảnh QR thanh toán của mọi luồng AutoBank (Auto Panel, Auto Quest lẻ + gói
// tháng, Auto Badge, Deco Gift) — làm như pokezone-pay: bot tự vẽ QR (gói
// qrcode) từ chuỗi VietQR rồi gửi kèm tin nhắn (attachment://qr.png), không
// lấy ảnh của dịch vụ ngoài nữa. img.vietqr.io đã 301 .png sang .svg mà
// Discord không bao giờ hiện SVG trong embed.
// pokezone-pay có sẵn chuỗi VietQR do payOS trả về; ở đây không có payOS nên
// bot tự dựng chuỗi (EMVCo, chuẩn NAPAS) — giống từng ký tự chuỗi trong ảnh
// QR của api.vietqr.io với cùng tài khoản, số tiền, nội dung. (VietQR còn bỏ
// ký tự không phải chữ/số/dấu cách khỏi nội dung; ở đây giữ nguyên văn — mã
// chuyển khoản của bot vốn chỉ có chữ, số và dấu cách.)
// Vẽ hỏng (vd không tra được BIN ngân hàng) thì dùng link ảnh api.vietqr.io như
// trước, để khách vẫn có QR mà quét.

const QRCode = require("qrcode");

const FETCH_TIMEOUT = 10000;
const NAME = "qr.png";

const vietQrUrl = (client, amount, transferCode) => {
    const s = client.configs.settings;
    return `https://api.vietqr.io/image/${s.bankCode}-${s.bankAccount}-compact.png?addInfo=${encodeURIComponent(transferCode)}&accountName=${encodeURIComponent(s.bankHolder)}&amount=${amount}`;
};

// BANK_CODE là mã chữ (MB, VCB, ...) như link VietQR vẫn nhận; chuỗi QR cần BIN
// 6 số. Tra một lần trong danh sách ngân hàng của VietQR rồi giữ cho cả tiến
// trình; tra hỏng thì lần sau tra lại. BANK_CODE đã là 6 số thì dùng luôn.
let _banks = null;
const _binOf = async (bankCode) => {
    const code = String(bankCode || "").trim();
    if (/^\d{6}$/.test(code)) return code;
    if (!_banks) {
        _banks = fetch("https://api.vietqr.io/v2/banks", { signal: AbortSignal.timeout(FETCH_TIMEOUT) })
            .then((res) => res.json())
            .then(({ data }) => {
                const map = new Map();
                for (const b of data) {
                    for (const k of [b.code, b.shortName, b.short_name]) if (k) map.set(k.toLowerCase(), b.bin);
                }
                return map;
            });
        _banks.catch(() => (_banks = null));
    }
    const bin = (await _banks).get(code.toLowerCase());
    if (!bin) throw new Error(`không tìm thấy BIN của ngân hàng "${code}"`);
    return bin;
};

const _tlv = (id, value) => `${id}${String(value.length).padStart(2, "0")}${value}`;

// CRC-16/CCITT-FALSE trên cả chuỗi kể cả "6304", như EMVCo quy định cho trường 63.
const _crc16 = (str) => {
    let crc = 0xffff;
    for (const byte of Buffer.from(str, "utf8")) {
        crc ^= byte << 8;
        for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc.toString(16).toUpperCase().padStart(4, "0");
};

// 38 = NAPAS (GUID A000000727) + BIN + số tài khoản + QRIBFTTA (chuyển tới tài
// khoản); 01 = 12 vì QR có số tiền; 62/08 = nội dung chuyển khoản.
const _payload = (bin, account, amount, addInfo) => {
    const body =
        _tlv("00", "01") +
        _tlv("01", "12") +
        _tlv("38", _tlv("00", "A000000727") + _tlv("01", _tlv("00", bin) + _tlv("01", account)) + _tlv("02", "QRIBFTTA")) +
        _tlv("53", "704") +
        _tlv("54", String(amount)) +
        _tlv("58", "VN") +
        _tlv("62", _tlv("08", addInfo)) +
        "6304";
    return body + _crc16(body);
};

/**
 * Ảnh QR chuyển `amount` đồng với nội dung `transferCode`.
 * @returns {Promise<{qrUrl: string, qrFiles: Array<{attachment: Buffer, name: string}>}>}
 *   qrUrl cho ảnh embed, qrFiles cho `files` của tin nhắn (rỗng khi vẽ hỏng).
 */
const vietQr = async (client, amount, transferCode) => {
    const s = client.configs.settings;
    try {
        const bin = await _binOf(s.bankCode);
        const attachment = await QRCode.toBuffer(_payload(bin, String(s.bankAccount).trim(), amount, transferCode), {
            type: "png",
            errorCorrectionLevel: "M",
            width: 512,
            margin: 2,
            color: { dark: "#000000ff", light: "#ffffffff" },
        });
        return { qrUrl: `attachment://${NAME}`, qrFiles: [{ attachment, name: NAME }] };
    } catch (e) {
        const url = vietQrUrl(client, amount, transferCode);
        console.error(`[vietQr] Không vẽ được mã QR (${transferCode}), dùng link ${url}:`, e.message);
        return { qrUrl: url, qrFiles: [] };
    }
};

module.exports = { vietQr };
