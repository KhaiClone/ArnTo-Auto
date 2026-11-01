# Auto Deco Gift

Khách mua Deco Discord dạng quà tặng (Gift) ngay trên một panel trong kênh, không cần
gõ lệnh: chọn deco → quét QR → admin duyệt và điền link quà → khách nhận link qua DM.

## Ai làm gì

| Phần | Ở đâu |
|------|-------|
| Panel, giỏ hàng, QR, kênh staff | ArnTo-Auto (`extensions/AutoDecoGift.js`, `events/discord/interaction/autoDecoGift.js`) |
| Danh sách deco + giá Gift | bot-panel đọc dữ liệu của ArnTo-assistant (`GET /api/external/decor-gift/catalog`) |
| Tin đơn trong kênh feed đơn auto (webhook `ORDER_FEED_WEBHOOK_URL`, `functions/orderFeed.js`) | ArnTo-Auto |
| Đơn `arnto_N`, DM hóa đơn, hoàn thành/hủy | ArnTo-Shop, panel gửi lệnh qua kênh bus (`order.create` / `order.complete` / `order.cancel`) |
| DM link quà cho khách | ArnTo-assistant (`decor.gift.deliver`, link được mã hóa trên kênh bus) |

Auto chỉ gọi panel (`extensions/PanelDecoGift.js`), không gọi bot nào khác.

## Cài đặt

`.env` của Auto:

```env
PANEL_API_URL=http://127.0.0.1:4201
PANEL_API_KEY=            # key riêng của Auto
DECO_GIFT_STAFF_CHANNEL_ID=   # kênh staff nhận đơn đã thanh toán
DECO_GIFT_SELLER_ID=871329074046435338   # seller tính đơn (KhaiDev)
ORDER_FEED_WEBHOOK_URL=   # webhook kênh feed đơn auto (chung với Auto Quest / Auto Badge)
# + BANK_CODE / BANK_ACCOUNT / BANK_HOLDER / VIETQR_CHANNEL_ID như các tính năng khác
```

Sau đó gõ `/dg-setup` (Administrator) trong kênh muốn đặt panel.

Thứ tự deploy lần đầu: **bot-panel → ArnTo-Shop + ArnTo-assistant → ArnTo-Auto** (panel
từ chối khi Shop/assistant chưa báo lệnh mới trên bus).

## Khách mua

- **Bộ sưu tập**: chọn bộ (mới nhất ở trên, 25 bộ/trang) → xem ảnh từng deco + giá Gift
  (6 deco/trang) → tick để thêm vào giỏ.
- **Tìm / dán link**: mỗi dòng một tên deco (không cần dấu, gõ tên bộ cũng được) hoặc link
  shop Discord. Link/SKU vào giỏ luôn; tên thì hiện kết quả để tick.
- **Giỏ hàng**: tối đa 5 deco/đơn, ảnh từng cái, tổng tiền, bỏ bớt, Thanh toán.
- QR hết hạn sau 10 phút, mỗi người một đơn chờ. Bấm Hủy thì đơn vẫn được ghi nhận nếu
  khách đã lỡ chuyển khoản trong 10 phút đó. Giá chốt lúc tạo QR; deco vừa tắt Gift bị
  bỏ khỏi giỏ trước khi tạo QR.

Mọi màn hình chỉ người bấm thấy (ephemeral). Giỏ nằm trong bộ nhớ — bot khởi động lại là
giỏ chưa thanh toán mất.

## Admin duyệt

Mỗi đơn đã thanh toán là một tin trong kênh staff: khách, deco (ảnh + link shop), tổng
tiền, **tin ngân hàng** (AutoBank chỉ khớp nội dung CK, không kiểm số tiền — xem số tiền
ở đây trước khi duyệt) và trạng thái. Chỉ **Administrator** bấm được.

- **Duyệt & giao link** → form, mỗi deco một ô `https://discord.gift/...` (nhận cả
  `discord.com/gifts/...`). Sai/trùng thì form mở lại vẫn giữ những gì đã nhập.
- Giao thành công → tin đơn trên feed chuyển xanh, khách nhận DM link (assistant) + DM hoàn
  thành/xin legit (Shop). Link chỉ còn bản che (`discord.gift/AbCd…wxYz`) trong DB.
- **Khách chặn DM** → đơn không hoàn thành, link được giữ để bấm **Gửi lại DM** khi
  khách mở DM; hoặc **Nhập lại link** / **Hủy đơn**.
- **Hủy đơn** → nhập lý do → Shop hủy đơn, Auto DM lý do + hướng dẫn tạo ticket hoàn tiền.
- **Thử lại**: bước nào lỗi (tạo đơn Shop, giao link, hoàn thành, hủy) thì vòng quét 5
  phút tự thử lại tối đa 24 lần; nút này chạy lại ngay.

## Tạo đơn trên panel (khách trả qua ticket)

Khách không biết dùng panel thì thanh toán trong ticket, admin tạo đơn thay ở trang
**Orders** của bot-panel → **New Deco Gift order**: chọn deco (tối đa 5), ID Discord
của khách, ghi chú (vd. số ticket). Giá luôn là giá Gift hiện tại, không sửa được.

Panel gửi lệnh `decor.gift.create` qua kênh bus cho Auto → Auto ghi đơn vào
`dg_orders` (mã `DGP-…`, có `manual: { by, byId, note }`), Shop mở đơn `arnto_N`
(source `decoGift`, tính chung với đơn Auto), kênh staff nhận tin đơn ghi **tạo trên
panel** — từ đó duyệt / hủy / thử lại y như đơn trả bằng QR. Tạo lại cùng một form
(panel gửi lại sau khi hết giờ chờ) không tạo đơn thứ hai.

## Tin đơn trên feed

Mỗi đơn (QR hay tạo trên panel) là **một tin** trong kênh feed đơn auto, đăng bằng webhook lúc
đơn được ghi (trước khi Shop mở đơn): khách (tag, không ping), tên các deco, mã `arnto_N`, trạng
thái ⏳ Đang chờ xử lý → ✅ Đã hoàn thành / 🚫 Đã huỷ — sửa tại chỗ. Link tin đi kèm `order.create`
(`statusUrl`): Shop **không** đăng vào kênh hàng chờ nữa, nút "Xem trạng thái" trong DM của Shop
mở tin feed. Không có webhook (hoặc đăng lỗi) → Shop đăng hàng chờ như cũ. Đơn mở trước khi có
feed vẫn ở hàng chờ tới khi xong.

Đơn deco gift không có nút ✅/❌, không hiện trong `/done` `/cancel`
`/remove` của Shop, và trang Orders của panel không hoàn thành/hủy được — tất cả để
không đơn nào bị đóng khi khách chưa nhận link.

## Dữ liệu (DB riêng của Auto)

- `dg_payments` — đơn chờ chuyển khoản (xóa khi hết hạn QR).
- `dg_orders` — đơn đã thanh toán (hoặc tạo trên panel, mã `DGP-…`): `status` = `paid` → `delivering` → `completed`
  (hoặc `dm_failed`, `delivered` = đã giao nhưng Shop chưa hoàn thành, `cancelled`).
