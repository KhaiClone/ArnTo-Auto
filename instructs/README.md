# ArnTo-Auto — Hướng dẫn sử dụng

Bot Discord tự động hoàn thành Discord Quest, tích hợp thanh toán qua VietQR.

---

## Mục lục

1. [Cài đặt](#cài-đặt)
2. [Cấu hình `.env`](#cấu-hình-env)
3. [Cấu trúc dự án](#cấu-trúc-dự-án)
4. [Quy trình hoạt động](#quy-trình-hoạt-động)
5. [Slash Commands](#slash-commands)
6. [AutoBank](#autobank)
7. [AutoQuest](#autoquest)

---

## Cài đặt

```bash
npm install
node index.js
```

**Yêu cầu:** Node.js >= 18

---

## Cấu hình `.env`

```env
TOKEN=             # Bot token Discord
GUILD_ID=          # ID server Discord

# Ngân hàng VietQR
BANK_CODE=         # Mã ngân hàng (vd: MB, VCB, TCB)
BANK_ACCOUNT=      # Số tài khoản
BANK_HOLDER=       # Tên chủ tài khoản
QUEST_PRICE_PER_ITEM=2000   # Giá mỗi quest (VND)

# Kênh Discord
VIETQR_CHANNEL_ID= # ID kênh nhận webhook VietQR
LOG_WEBHOOK_URL=   # Webhook URL ghi log trạng thái thanh toán
ORDER_LOG_CHANNEL_ID=  # ID kênh log đơn hàng (tuỳ chọn)
ORDER_LOG_TICKET_LABEL=    # Label ticket trong log (tuỳ chọn)

# UI Panel (tuỳ chọn)
QUEST_PANEL_THUMB_URL=
QUEST_PANEL_BANNER_URL=

# Khác
EXPRESS=false      # Bật web server ping (cho hosting)
WEBHOOK_BACKUP=    # Webhook backup .env + DB mỗi 1 giờ
```

---

## Cấu trúc dự án

```
ArnTo-Auto/
├── commands/
│   └── slash/
│       └── quest/          # Các lệnh slash của bot
├── configs/
│   ├── settings.js         # Config từ .env
│   └── embed.js            # Màu embed mặc định
├── events/
│   └── discord/
│       ├── client/
│       │   └── ready.js    # Khởi động bot, AutoBank, khôi phục account
│       ├── interaction/
│       │   ├── commands.js         # Xử lý slash commands (mặc định)
│       │   └── autoQuest.js        # Xử lý button/modal/select của Auto Quest
│       └── messages/
│           └── commands.js         # Xử lý DM (refresh token qua tin nhắn)
├── extensions/
│   ├── AutoBank.js         # Phát hiện thanh toán qua VietQR webhook
│   ├── AutoQuest.js        # Toàn bộ logic Auto Quest (4 sections)
│   └── QuickDB.js          # Database extension
├── functions/
│   ├── autoQuestHelpers.js # Helper dùng chung: order log, unlock payment
│   └── ...
├── instruct/               # Tài liệu hướng dẫn (thư mục này)
└── index.js                # Entry point
```

---

## Quy trình hoạt động

```
User bấm "Nhập token"
    → Nhập Discord token qua modal
    → Bot verify token, start run loop
    → Hiện menu chọn quest
    → User chọn quest
    → Bot tạo QR thanh toán (VietQR)
    → User chuyển khoản đúng nội dung
    → VietQR gửi webhook vào Discord channel
    → AutoBank phát hiện, confirm thanh toán
    → Bot unlock quest và bắt đầu chạy
    → Bot gửi DM khi xong
```

---

## Slash Commands

| Lệnh | Mô tả |
|------|-------|
| `/setup` | Gửi panel "Nhập token" vào kênh hiện tại (Admin) |
| `/status` | Xem các account đang chạy |
| `/stop <account_id>` | Dừng một account |
| `/stopall` | Dừng tất cả account |
| `/restart` | Restart tất cả account đã lưu |
| `/removeaccount <account_id>` | Xóa account khỏi storage |
| `/help` | Hướng dẫn |

---

## AutoBank

Xem chi tiết: [autobank.md](./autobank.md)

## AutoQuest

Xem chi tiết: [autoquest.md](./autoquest.md)