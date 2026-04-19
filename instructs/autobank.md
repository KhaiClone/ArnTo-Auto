# AutoBank — Tài liệu kỹ thuật

`extensions/AutoBank.js`

Class quản lý phát hiện thanh toán qua VietQR Discord webhook.

---

## Khởi tạo

```js
client.autoBank = new AutoBank(client, vietqrChannelId, logWebhookUrl);
```

| Tham số | Kiểu | Mô tả |
|---------|------|-------|
| `client` | `discord.Client` | Discord client |
| `vietqrChannelId` | `string` | ID kênh nhận webhook VietQR |
| `logWebhookUrl` | `string` | Webhook URL để ghi log thanh toán |

---

## API công khai

### `registerMissedHandler(handlerName, fn)`

Đăng ký handler khôi phục khi bot restart giữa chừng và callback bị mất.

```js
client.autoBank.registerMissedHandler("quest_payment", async (client, entry) => {
    // entry = { customId, amount, context, message }
    const paid = await markPaymentAsPaid(client, entry.context.paymentId);
    if (paid) await unlockPaymentIfPaid(client, paid);
});
```

- **Phải gọi trước khi `createQR()`**
- Mỗi feature đăng ký một tên handler riêng
- Tên handler phải khớp với `context._handler` khi tạo QR

---

### `createQR(amount, customId, context, callback)`

Đăng ký một payment đang chờ với AutoBank.

```js
client.autoBank.createQR(
    50000,          // amount (VND)
    transferCode,   // customId — phải khớp với nội dung chuyển khoản
    {
        _handler: "quest_payment",  // tên handler để khôi phục khi restart
        paymentId: payment.id,
        userId: "...",
    },
    (err, data) => {
        if (err) return; // TIMEOUT — hết 10 phút
        // data = { customId, amount, context, message }
        // thanh toán thành công
    }
);
```

> **Lưu ý quan trọng:** `customId` phải là chính xác chuỗi xuất hiện trong tin nhắn webhook VietQR (tức là `transferCode` — ví dụ: `Quest12345`).

---

### `recover()`

Gọi một lần trong sự kiện `clientReady`. Lấy tin nhắn bị bỏ lỡ từ kênh VietQR và đối chiếu với DB.

```js
const { paid, expired } = await client.autoBank.recover();
// paid[]   — thanh toán xảy ra khi bot offline
// expired[] — QR hết hạn khi bot offline
```

---

## Luồng xử lý

```
VietQR gửi tin nhắn vào kênh Discord
    ↓
messageCreate event kích hoạt _handleMessage()
    ↓
Tìm customId trong DB (autobank_pending)
    ↓
Nếu tìm thấy:
    - Xóa khỏi DB
    - Hủy timeout
    - Nếu có callback trong memory → gọi callback
    - Nếu không có callback (bot restart) → gọi missedHandler theo _handler trong context
```

---

## DB model: `autobank_pending`

Mỗi QR được lưu vào DB khi tạo để khôi phục sau khi bot restart:

```js
{
    _id: "...",          // nanoid
    customId: "Quest12345",   // transferCode
    amount: 50000,
    expireAt: 1234567890000,  // timestamp ms
    context: {
        _handler: "quest_payment",
        paymentId: "QP...",
        userId: "...",
        accountId: "...",
        transferCode: "Quest12345",
    }
}
```

---

## Log statuses

| Status | Màu | Khi nào |
|--------|-----|---------|
| `PAID` | 🟢 Xanh | Phát hiện thanh toán trực tiếp |
| `EXPIRED` | 🔴 Đỏ | Hết 10 phút, không thanh toán |
| `PAID_MISSED` | 🟡 Vàng | Thanh toán khi bot offline, phát hiện lúc recover |
| `EXPIRED_MISSED` | 🩷 Hồng | Hết hạn khi bot offline |

---

## Thêm feature mới dùng AutoBank

```js
// 1. Đăng ký handler trong ready.js
client.autoBank.registerMissedHandler("my_feature", async (client, entry) => {
    // xử lý khi bot restart và payment đến
});

// 2. Khi tạo QR trong feature của bạn
client.autoBank.createQR(amount, transferCode, {
    _handler: "my_feature",  // khớp với tên đã đăng ký
    // ...context của bạn
}, (err, data) => {
    // callback bình thường
});

// 3. Lưu vào DB để AutoBank có thể khôi phục
await client.db.create("autobank_pending", {
    customId: transferCode,
    amount,
    expireAt: Date.now() + 10 * 60 * 1000,
    context: { _handler: "my_feature", ...yourContext },
});
```