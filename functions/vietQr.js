// Ảnh QR thanh toán của mọi luồng AutoBank (Auto Panel, Auto Quest lẻ + gói
// tháng, Auto Badge, Deco Gift) — làm như pokezone-pay: mẫu "compact" (logo
// VietQR, napas, ngân hàng), bot tự tải ảnh rồi gửi kèm tin nhắn
// (attachment://qr.png) thay vì đưa link để Discord tự tải. Tải hỏng thì dùng
// lại link như cũ.
// Link ở api.vietqr.io chứ không phải img.vietqr.io: img.vietqr.io giờ chuyển
// .png sang .svg (301), mà Discord không hiện được ảnh SVG.

const FETCH_TIMEOUT = 10000;
const NAME = "qr.png";

const vietQrUrl = (client, amount, transferCode) => {
    const s = client.configs.settings;
    return `https://api.vietqr.io/image/${s.bankCode}-${s.bankAccount}-compact.png?addInfo=${encodeURIComponent(transferCode)}&accountName=${encodeURIComponent(s.bankHolder)}&amount=${amount}`;
};

/**
 * Ảnh QR chuyển `amount` đồng với nội dung `transferCode`.
 * @returns {Promise<{qrUrl: string, qrFiles: Array<{attachment: Buffer, name: string}>}>}
 *   qrUrl cho ảnh embed, qrFiles cho `files` của tin nhắn (rỗng khi tải hỏng).
 */
const vietQr = async (client, amount, transferCode) => {
    const url = vietQrUrl(client, amount, transferCode);
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
        const type = res.headers.get("content-type") || "";
        if (!res.ok || !type.startsWith("image/") || type.includes("svg")) {
            throw new Error(`VietQR trả về ${res.status} (${type || "không rõ kiểu dữ liệu"})`);
        }
        const attachment = Buffer.from(await res.arrayBuffer());
        return { qrUrl: `attachment://${NAME}`, qrFiles: [{ attachment, name: NAME }] };
    } catch (e) {
        console.error(`[vietQr] Không tải được mã QR: ${url}`, e.message);
        return { qrUrl: url, qrFiles: [] };
    }
};

module.exports = { vietQr };
