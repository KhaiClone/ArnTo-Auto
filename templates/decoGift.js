// Message templates of Auto Deco Gift (extensions/AutoDecoGift.js) — editable on
// the bot-panel's Embeds page (extensions/MessageTemplates.js).
//
// The buyer's screens are Components V2 views whose layout the code builds
// (lists of decors, menus): their templates are "cards" — every word, colour
// and button label, not the layout. The panel, the QR and the DMs are ordinary
// messages. Variables carry whole objects on purpose.

const ITEM = "**{name}**{#if inCart} ✓{/if}\n{typeLabel} · **{price|money}**{#if members}\n-# Gồm: {members|trunc:160}{/if}";

const decoItem = {
    label: "Deco",
    text: "name",
    fields: {
        sku_id: { label: "SKU", example: "1400000000000000001" },
        name: { label: "Tên", example: "Mèo Galaxy" },
        type: { type: "number", label: "Loại (0 avatar, 1 profile, 2 nameplate, 3 frame, 1000 bundle)", example: 0 },
        typeLabel: { label: "Loại (chữ)", example: "Avatar" },
        price: { type: "money", label: "Giá Gift", example: 45000 },
        thumb: { type: "url", label: "Ảnh nhỏ" },
        image: { type: "url", label: "Ảnh lớn (/decor-find)" },
        members: { label: "Thành viên bundle", example: "" },
        shopUrl: { type: "url", label: "Link shop Discord", example: "https://discord.com/shop#itemSkuId=1400000000000000001" },
        inCart: { type: "boolean", label: "Đã trong giỏ", example: false },
        index: { type: "number", label: "Số thứ tự (từ 1)", example: 1 },
    },
};

const STAFF_VARS = { order: "decoOrder", buyer: "user", admin: "user?" };

module.exports = {
    types: {
        decoItem,
        cart: {
            label: "Giỏ hàng",
            fields: {
                count: { type: "number", label: "Số deco", example: 2 },
                max: { type: "number", label: "Tối đa", example: 5 },
                room: { type: "number", label: "Còn trống", example: 3 },
                total: { type: "money", label: "Tổng tiền", example: 95000 },
                full: { type: "boolean", label: "Đã đầy", example: false },
                items: { type: "decoItem[]", label: "Các deco" },
            },
        },
        category: {
            label: "Bộ sưu tập",
            text: "name",
            fields: {
                sku_id: { label: "SKU", example: "c1" },
                name: { label: "Tên", example: "Thiên hà" },
                count: { type: "number", label: "Số deco bán Gift", example: 8 },
                minPrice: { type: "money", label: "Giá thấp nhất", example: 40000 },
            },
        },
        bank: {
            label: "Tài khoản nhận tiền",
            fields: {
                holder: { label: "Chủ tài khoản", example: "TRUONG DUY KHAI" },
                code: { label: "Ngân hàng", example: "MB" },
                account: { label: "Số tài khoản", example: "0123456789" },
            },
        },
        payment: {
            label: "Thanh toán Deco Gift",
            text: "id",
            fields: {
                id: { label: "Mã thanh toán", example: "DGm1abcd" },
                total: { type: "money", label: "Tổng tiền", example: 95000 },
                transferCode: { label: "Nội dung chuyển khoản", example: "aB3dE5fG Chuyen tien" },
                qrUrl: { type: "url", label: "Ảnh QR", example: "https://img.vietqr.io/image/MB-0123456789-qr_only.png" },
                status: { label: "Trạng thái (pending / cancelled)", example: "pending" },
                open: { type: "boolean", label: "Còn chờ thanh toán", example: true },
                expiresAt: { type: "time", label: "Hết hạn lúc" },
                count: { type: "number", label: "Số deco", example: 2 },
                items: { type: "decoItem[]", label: "Các deco" },
            },
        },
        decoOrder: {
            label: "Đơn Deco Gift",
            text: "id",
            fields: {
                id: { label: "Mã thanh toán", example: "DGm1abcd" },
                shopOrderId: { label: "Mã đơn Shop", example: "arnto_2613" },
                waitingUrl: { type: "url", label: "Link tin hàng chờ", example: "https://discord.com/channels/1/2/3" },
                total: { type: "money", label: "Tổng tiền", example: 95000 },
                paidAt: { type: "time", label: "Thanh toán lúc" },
                status: { label: "Trạng thái (paid / delivering / dm_failed / delivered / completed / cancelled)", example: "paid" },
                bankMessage: { label: "Tin ngân hàng", example: "MB +95,000 VND aB3dE5fG Chuyen tien" },
                shopError: { label: "Lỗi tạo đơn Shop", example: "" },
                lastError: { label: "Lỗi gần nhất", example: "" },
                stuck: { type: "boolean", label: "Đã ngừng tự thử lại", example: false },
                deliveredBy: { type: "id", label: "Admin giao" },
                deliveredAt: { type: "time", label: "Giao lúc" },
                cancelledBy: { type: "id", label: "Admin hủy" },
                cancelledAt: { type: "time", label: "Hủy lúc" },
                cancelReason: { label: "Lý do hủy", example: "Hết hàng" },
                shopCancelPending: { type: "boolean", label: "Đơn Shop chưa hủy xong", example: false },
                linksMasked: { label: "Link đã giao (che)", example: "discord.gift/AbCd…wxYz" },
                count: { type: "number", label: "Số deco", example: 2 },
                items: { type: "decoItem[]", label: "Các deco" },
            },
        },
    },

    templates: {
        // ── Panel trong kênh ─────────────────────────────────────────────────
        "auto.dg.panel": {
            group: "Deco Gift · panel",
            label: "Panel mua Deco Gift (/dg-setup)",
            description: "Tin công khai trong kênh. Cập nhật được các panel đã gửi từ trang Embeds.",
            refreshable: true,
            vars: { max: { type: "number", label: "Tối đa deco mỗi đơn", example: 5 } },
            slots: {
                browse: { label: "Bộ sưu tập", emoji: "🛍️", style: "Primary" },
                search: { label: "Tìm / dán link", emoji: "🔎", style: "Secondary" },
                cart: { label: "Giỏ hàng", emoji: "🛒", style: "Success" },
            },
            message: {
                embeds: [
                    {
                        color: "#9f92ff",
                        title: "🎁 Deco Gift — Mua tự động",
                        description:
                            "Mua **Deco Discord dạng quà tặng (Gift)** — avatar, hiệu ứng hồ sơ, nameplate, khung, bundle. Chọn deco, quét QR là xong, không cần gõ lệnh.\n\n**Cách mua**\n1. Bấm **Bộ sưu tập** để xem theo bộ, hoặc **Tìm / dán link** để gõ tên deco hay dán link shop Discord.\n2. Chọn tối đa **{max} deco** mỗi đơn, xem lại ảnh trong **Giỏ hàng**.\n3. Bấm **Thanh toán** và quét QR (hết hạn sau 10 phút).\n4. Admin duyệt đơn, link quà được gửi qua **tin nhắn riêng** — nhớ mở DM.",
                    },
                ],
                components: [[{ slot: "browse" }, { slot: "search" }, { slot: "cart" }]],
            },
        },

        // ── Màn hình của khách (V2) ──────────────────────────────────────────
        "auto.dg.view": {
            kind: "card",
            group: "Deco Gift · màn hình khách",
            label: "Chữ chung (tải, lỗi, ghi chú)",
            description: "Màu của mọi màn hình, và các dòng ghi chú hiện trên đầu màn hình.",
            vars: { cart: "cart", names: "string", count: "number", line: "string", query: "string", error: "string" },
            color: "#9f92ff",
            texts: {
                loading: "⏳ Đang tải…",
                error: "❌ {error}",
                closed: "Deco Gift đang tạm đóng, bạn quay lại sau nhé.",
                added: "✅ Đã thêm vào giỏ: {names|trunc:300}",
                full: "⚠️ Giỏ đã đủ {cart.max} deco, chưa thêm: {names|trunc:200}",
                alreadyIn: "Các deco này đã có trong giỏ.",
                notGift: "⚠️ `{line|trunc:60}`: deco này không bán dạng Gift.",
                notFound: "⚠️ Không tìm thấy “{query|trunc:60}”.",
                removed: "🗑️ Đã bỏ {count} deco khỏi giỏ.",
                cleared: "🗑️ Đã xóa giỏ.",
                stoppedSelling: "⚠️ {count} deco vừa ngừng bán dạng Gift nên đã được bỏ khỏi giỏ.",
                stoppedBeforePay: "⚠️ {count} deco vừa ngừng bán dạng Gift nên đã bị bỏ khỏi giỏ — xem lại rồi thanh toán.",
                categoryGone: "⚠️ Bộ này không còn deco bán dạng Gift.",
                paymentExists: "⚠️ Bạn đang có một đơn chờ thanh toán (tin bên dưới) — thanh toán hoặc hủy nó trước khi tạo đơn mới.",
                qrCreated: "✅ Đã tạo QR thanh toán ở tin bên dưới. Giỏ đã được làm trống.",
            },
            buttons: { cart: { label: "Giỏ hàng ({cart.count}/{cart.max})", emoji: "🛒", style: "Success" } },
        },
        "auto.dg.categories": {
            kind: "card",
            group: "Deco Gift · màn hình khách",
            label: "Danh sách bộ sưu tập",
            vars: { cart: "cart", page: "number", pages: "number", note: "string" },
            slotVars: { category: { category: "category" } },
            texts: {
                header: "## 🛍️ Bộ sưu tập\nChọn một bộ để xem deco và giá Gift — bộ mới nhất ở trên.{#if note}\n{note}{/if}",
                empty: "*Hiện chưa có deco nào bán dạng Gift.*",
            },
            selects: {
                category: {
                    placeholder: "Chọn bộ sưu tập (trang {page}/{pages})",
                    label: "{category.name}",
                    description: "{category.count} deco · từ {category.minPrice|money}",
                },
            },
            buttons: {
                prev: { emoji: "◀️", style: "Secondary" },
                next: { emoji: "▶️", style: "Secondary" },
                search: { label: "Tìm / dán link", emoji: "🔎", style: "Secondary" },
            },
        },
        "auto.dg.category": {
            kind: "card",
            group: "Deco Gift · màn hình khách",
            label: "Deco trong một bộ",
            vars: { category: "category", cart: "cart", page: "number", pages: "number", note: "string" },
            slotVars: { item: "decoItem", add: "decoItem" },
            texts: {
                header: "## {category.name}\n{category.count} deco · trang {page}/{pages} · giỏ {cart.count}/{cart.max}{#if note}\n{note}{/if}",
                item: ITEM,
            },
            selects: {
                add: {
                    placeholder: "{#if cart.room > 0}Chọn deco để thêm vào giỏ (còn {cart.room} chỗ){#else}Giỏ đã đủ {cart.max} deco{/if}",
                    label: "{name}",
                    description: "{#if inCart}✓ Đã trong giỏ · {/if}{typeLabel} · {price|money}",
                },
            },
            buttons: {
                prev: { emoji: "◀️", style: "Secondary" },
                next: { emoji: "▶️", style: "Secondary" },
                back: { label: "Bộ khác", emoji: "↩️", style: "Secondary" },
            },
        },
        "auto.dg.search": {
            kind: "card",
            group: "Deco Gift · màn hình khách",
            label: "Tìm deco (form + kết quả)",
            vars: { cart: "cart", query: "string", note: "string" },
            slotVars: { item: "decoItem", add: "decoItem" },
            texts: {
                modalTitle: "Tìm deco",
                modalLabel: "Tên deco hoặc link shop (mỗi dòng 1 cái)",
                modalPlaceholder: "VD: Mèo Galaxy\nhttps://discord.com/shop#itemSkuId=...",
                header: "## 🔎 Kết quả tìm{#if query}: {query|trunc:80}{/if}\ngiỏ {cart.count}/{cart.max}{#if note}\n{note}{/if}",
                empty: "Không có kết quả — thử gõ ngắn hơn (không cần dấu), tên bộ sưu tập, hoặc dán link shop Discord của deco.",
                item: ITEM,
            },
            selects: {
                add: {
                    placeholder: "{#if cart.room > 0}Chọn deco để thêm vào giỏ (còn {cart.room} chỗ){#else}Giỏ đã đủ {cart.max} deco{/if}",
                    label: "{name}",
                    description: "{#if inCart}✓ Đã trong giỏ · {/if}{typeLabel} · {price|money}",
                },
            },
            buttons: {
                again: { label: "Tìm tiếp", emoji: "🔎", style: "Secondary" },
                browse: { label: "Bộ sưu tập", emoji: "🛍️", style: "Secondary" },
            },
        },
        "auto.dg.cart": {
            kind: "card",
            group: "Deco Gift · màn hình khách",
            label: "Giỏ hàng",
            vars: { cart: "cart", note: "string" },
            slotVars: { item: "decoItem", remove: "decoItem" },
            texts: {
                header: "## 🛒 Giỏ Deco Gift\n{cart.count}/{cart.max} deco{#if note}\n{note}{/if}",
                empty: "Giỏ đang trống — chọn deco từ **Bộ sưu tập** hoặc **Tìm / dán link**.",
                item: "**{index}. {name}**\n{typeLabel} · **{price|money}**{#if members}\n-# Gồm: {members|trunc:160}{/if}",
                total: "### Tổng: {cart.total|money}\n-# Sau khi thanh toán, admin duyệt đơn và link quà được gửi qua tin nhắn riêng — nhớ mở DM.",
            },
            selects: { remove: { placeholder: "Bỏ bớt deco…", label: "{index}. {name}" } },
            buttons: {
                pay: { label: "Thanh toán {cart.total|money}", emoji: "💳", style: "Success" },
                browse: { label: "Chọn thêm", emoji: "🛍️", style: "Secondary" },
                browseEmpty: { label: "Bộ sưu tập", emoji: "🛍️", style: "Primary" },
                search: { label: "Tìm / dán link", emoji: "🔎", style: "Secondary" },
                clear: { label: "Xóa giỏ", emoji: "🗑️", style: "Danger" },
            },
        },

        // ── Thanh toán ───────────────────────────────────────────────────────
        "auto.dg.payment": {
            group: "Deco Gift · thanh toán",
            label: "QR thanh toán",
            description: "Riêng khách, sau khi bấm Thanh toán. Khi khách hủy, tin được sửa thành bản không QR ({payment.open} = false).",
            vars: { payment: "payment", bank: "bank", note: "string" },
            slots: { cancel: { label: "Hủy đơn", style: "Danger" } },
            message: {
                embeds: [
                    {
                        title: "Thanh toán Deco Gift",
                        color: "{#if payment.open}#9f92ff{#else}#95a5a6{/if}",
                        description: "{note}",
                        fields: [
                            { name: "Mã thanh toán", value: "`{payment.id}`" },
                            {
                                name: "Deco ({payment.count})",
                                value: "{#each payment.items}{index}. **{name}** · {typeLabel} — {price|money}{#if !@last}\n{/if}{/each}",
                            },
                            { name: "Tổng tiền", value: "`{payment.total|money}`", inline: true },
                            { name: "Chủ tài khoản", value: "`{bank.holder}`", inline: true, if: "payment.open" },
                            { name: "Ngân hàng", value: "`{bank.code}`", inline: true, if: "payment.open" },
                            { name: "Số tài khoản", value: "```\n{bank.account}\n```", if: "payment.open" },
                            { name: "Nội dung chuyển khoản", value: "```\n{payment.transferCode}\n```", if: "payment.open" },
                        ],
                        image: { url: "{#if payment.open}{payment.qrUrl}{/if}" },
                        footer: { text: "{#if payment.open}QR hết hạn sau 10 phút. Bot tự xác nhận khi nhận được tiền — chuyển đúng nội dung.{#else}Deco Gift{/if}" },
                        timestamp: true,
                    },
                ],
                components: [[{ slot: "cancel" }]],
            },
        },
        "auto.dg.payment.notes": {
            kind: "card",
            group: "Deco Gift · thanh toán",
            label: "Ghi chú QR + trả lời khi khách hủy",
            vars: { payment: "payment" },
            texts: {
                created: "Quét QR để thanh toán **{payment.count} deco**. Thanh toán xong, đơn được lên tự động và admin sẽ gửi link quà qua tin nhắn riêng.",
                pending: "Đơn đang chờ thanh toán.",
                cancelled: "🚫 Đã hủy đơn — đừng chuyển khoản nữa. Nếu bạn đã lỡ chuyển trong 10 phút của QR, đơn vẫn được ghi nhận.",
                notFound: "Không tìm thấy đơn (có thể QR đã hết hạn).",
                alreadyPaid: "Đơn này đã được thanh toán, không hủy được nữa.",
                notYours: "Bạn không thể hủy đơn của người khác.",
                alreadyCancelled: "Đơn này đã được hủy.",
            },
        },

        // ── DM cho khách ─────────────────────────────────────────────────────
        "auto.dg.dm.paid": {
            group: "Deco Gift · DM khách",
            label: "Đã nhận tiền (khi chưa lên được đơn Shop)",
            description: "Chỉ gửi khi đơn Shop chưa tạo được ngay — bình thường khách nhận hóa đơn của Shop.",
            vars: { order: "decoOrder", buyer: "user" },
            message: {
                embeds: [
                    {
                        color: "#57f287",
                        title: "Đã xác nhận thanh toán",
                        description: "Mã thanh toán: `{order.id}`\nSố tiền: **{order.total|money}**\n✅ Đã nhận thanh toán Deco Gift. Admin sẽ duyệt và gửi link quà qua tin nhắn riêng.",
                    },
                ],
            },
        },
        "auto.dg.dm.cancelled": {
            group: "Deco Gift · DM khách",
            label: "Đơn bị hủy (lý do + hoàn tiền)",
            vars: { order: "decoOrder", buyer: "user", admin: "user?", reason: "string" },
            message: {
                embeds: [
                    {
                        color: "#ed4245",
                        title: "Đơn Deco Gift đã bị hủy",
                        description:
                            "Mã đơn: `{order.shopOrderId|default:order.id}`{#if order.shopOrderId} (thanh toán `{order.id}`){/if}\nLý do: {reason|trunc:500}\n\nBạn sẽ được hoàn **{order.total|money}**: hãy tạo ticket và gửi mã đơn này cho admin.",
                    },
                ],
            },
        },
        "auto.dg.dm.expired": {
            group: "Deco Gift · DM khách",
            label: "QR hết hạn (phát hiện khi bot khởi động lại)",
            vars: { paymentId: "string", amount: "money" },
            message: {
                embeds: [
                    {
                        color: "#fee75c",
                        title: "QR thanh toán đã hết hạn",
                        description: "Mã thanh toán: `{paymentId}`\nSố tiền: {amount|money}\nQR Deco Gift đã hết hạn. Hãy chọn lại deco trên panel để tạo QR mới.",
                    },
                ],
            },
        },

        // ── Kênh staff ───────────────────────────────────────────────────────
        "auto.dg.staff": {
            kind: "card",
            group: "Deco Gift · kênh staff",
            label: "Tin đơn trong kênh staff",
            description: "Màu theo trạng thái, chữ từng trạng thái, các nút, form giao link và form hủy.",
            vars: STAFF_VARS,
            slotVars: { item: "decoItem", linkLabel: "decoItem", linkPlaceholder: "decoItem" },
            texts: {
                header:
                    "## 🎁 Đơn Deco Gift\n**Mã đơn:** {#if order.shopOrderId}`{order.shopOrderId}`{#if order.waitingUrl} · [hàng chờ]({order.waitingUrl}){/if}{#else}*chưa có*{/if} · thanh toán `{order.id}`\n**Khách:** {buyer.mention} (`{buyer.id}`)\n**Tổng:** {order.total|money} · đã thanh toán lúc {order.paidAt|time:f}",
                item: "**{index}. [{name}]({shopUrl})**\n{typeLabel} · {price|money}",
                bank: "**Tin ngân hàng** (kiểm tra số tiền):\n```\n{order.bankMessage|trunc:600}\n```",
                paid: "⏳ **Chờ admin duyệt** — bấm Duyệt rồi điền link quà cho từng deco.",
                paidNoShop:
                    "⏳ **Chờ admin duyệt** · ⚠️ chưa tạo được đơn Shop — bot tự thử lại mỗi 5 phút.{#if order.shopError}\n-# Lỗi: {order.shopError|trunc:200}{/if}{#if order.stuck}\n-# Đã ngừng tự thử lại — bấm Thử lại.{/if}",
                delivering:
                    "📨 **Đang giao link** (bởi <@{order.deliveredBy}>) — chưa có phản hồi, bot tự thử lại.{#if order.lastError}\n-# Lỗi gần nhất: {order.lastError|trunc:200}{/if}{#if order.stuck}\n-# Đã ngừng tự thử lại — bấm Thử lại.{/if}",
                dmFailed:
                    '⚠️ **Chưa giao được:** {#if order.lastError == "dm_blocked"}Khách chặn tin nhắn riêng (hoặc không còn chung server với bot gửi link){#elseif order.lastError == "unknown_user"}Không tìm thấy tài khoản khách{#else}{order.lastError}{/if}.\nNhờ khách mở tin nhắn riêng từ thành viên server rồi bấm **Gửi lại DM**.',
                delivered:
                    "✅ **Đã giao link** bởi <@{order.deliveredBy}> lúc {order.deliveredAt|time:f} · ⏳ đang chờ Shop hoàn thành đơn.{#if order.lastError}\n-# Lỗi gần nhất: {order.lastError|trunc:200}{/if}{#if order.stuck}\n-# Đã ngừng tự thử lại — bấm Thử lại.{/if}",
                completed: "✅ **Hoàn thành** — giao bởi <@{order.deliveredBy}> lúc {order.deliveredAt|time:f}.{#if order.linksMasked}\n-# {order.linksMasked}{/if}",
                cancelled:
                    "❌ **Đã hủy** bởi <@{order.cancelledBy}> lúc {order.cancelledAt|time:f}\nLý do: {order.cancelReason}{#if order.shopCancelPending}\n⏳ Đang hủy đơn Shop…{#if order.lastError}\n-# Lỗi gần nhất: {order.lastError|trunc:200}{/if}{#if order.stuck}\n-# Đã ngừng tự thử lại — bấm Thử lại.{/if}{/if}",
                colorPaid: "#fee75c",
                colorDelivering: "#5865f2",
                colorDmFailed: "#ed4245",
                colorDone: "#57f287",
                colorCancelled: "#95a5a6",
                linksTitle: "Giao deco – {order.shopOrderId}",
                linkLabel: "#{index} {name}",
                linkPlaceholder: "https://discord.gift/...",
                rejectTitle: "Hủy đơn – {order.shopOrderId|default:order.id}",
                rejectLabel: "Lý do (gửi cho khách)",
            },
            buttons: {
                approve: { label: "Duyệt & giao link", emoji: "✅", style: "Success" },
                retryShop: { label: "Thử lại tạo đơn Shop", emoji: "🔁", style: "Secondary" },
                resend: { label: "Gửi lại DM", emoji: "🔁", style: "Secondary" },
                relink: { label: "Nhập lại link", emoji: "✏️", style: "Secondary" },
                retry: { label: "Thử lại", emoji: "🔁", style: "Secondary" },
                reject: { label: "Hủy đơn", emoji: "❌", style: "Danger" },
            },
        },
        "auto.dg.admin": {
            kind: "card",
            group: "Deco Gift · kênh staff",
            label: "Trả lời admin",
            description: "Các câu bot trả lời riêng admin khi bấm nút trong kênh staff.",
            vars: { order: "decoOrder", bad: "string", error: "string" },
            texts: {
                completed: "✅ Đã gửi link cho khách và hoàn thành đơn `{order.shopOrderId}`.",
                delivered: "✅ Đã gửi link cho khách. Đơn Shop chưa hoàn thành được — bot tự thử lại.",
                dmFailed: "⚠️ Chưa gửi được cho khách (xem tin đơn). Link được giữ lại — bấm **Gửi lại DM** khi khách đã mở DM.",
                delivering: "⏳ Chưa có phản hồi — bot tự thử lại.{#if order.lastError}\nLỗi: {order.lastError}{/if}",
                paidReady: "Đơn Shop: `{order.shopOrderId}` — có thể duyệt.",
                paidNoShop: '⚠️ Vẫn chưa tạo được đơn Shop: {order.shopError|default:"không rõ lỗi"}',
                cancelledPending: "⏳ Đã hủy, đơn Shop chưa hủy được — bot tự thử lại.{#if order.lastError}\nLỗi: {order.lastError}{/if}",
                cancelled: "❌ Đơn đã hủy.",
                cancelledNotified: "Đã nhắn lý do và hướng dẫn hoàn tiền cho khách.",
                busy: "Đơn đang được xử lý (hoặc không tồn tại) — thử lại sau ít giây.",
                notAdmin: "Chỉ admin mới xử lý được đơn Deco Gift.",
                notFound: "Không tìm thấy đơn.",
                handled: "Đơn này đã được xử lý.",
                cannotCancel: "Chỉ hủy được đơn chưa giao link.",
                noShopYet: "Đơn Shop chưa được tạo — bấm Thử lại trên tin đơn trước.",
                badLinks: "Link #{bad} không phải link quà Discord (dạng `https://discord.gift/...`).",
                duplicateLinks: "Có link bị trùng — mỗi deco cần một link riêng.",
                linkRetry: "❌ {error}\nBấm **Duyệt** lại — những gì bạn đã nhập được giữ sẵn trong form.",
                setupMissing: "Deco Gift chưa bật được — thiếu trong .env: {error}.",
                setupDone: "✅ Đã gửi panel Deco Gift vào kênh này.",
            },
        },
    },
};
