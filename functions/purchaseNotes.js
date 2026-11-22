/**
 * purchaseNotes.js
 * Lưu ý chung của mọi panel mua tự động: Auto Quest (/quest-setup), Auto Badge
 * (/badge-setup), Deco Gift (/dg-setup). Để một chỗ cho ba panel nói cùng một câu.
 *
 * Tin panel đã đăng trên Discord không tự sửa: đổi câu ở đây thì chạy lại lệnh
 * setup của từng panel.
 */

// Kênh tạo ticket của shop — cùng kênh mà tin "$done" của ArnTo-assistant chỉ khách tới.
const TICKET_CHANNEL_ID = "1246028759597846650";

const NO_REFUND = "Không hoàn tiền khi lỗi chủ quan từ phía khách hàng.";
const TICKET = `Cần hỗ trợ thêm? Tạo ticket tại <#${TICKET_CHANNEL_ID}>.`;

/** Các dòng lưu ý, đã gạch đầu dòng, theo thứ tự hiển thị. */
function lines() {
    return [`- ${NO_REFUND}`, `- ${TICKET}`];
}

module.exports = { TICKET_CHANNEL_ID, NO_REFUND, TICKET, lines };
