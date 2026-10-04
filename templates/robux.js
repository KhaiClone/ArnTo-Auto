// Auto Robux: panel chọn gói, form gamepass, QR, hàng chờ, log đơn, DM, lệnh /rb-*.
const { embed, notice, field } = require("./_auto");

const G = {
    panel: "Robux · panel & mua",
    pay: "Robux · thanh toán",
    dm: "Robux · DM khách",
    log: "Robux · log đơn & hàng chờ (kênh admin)",
    cmd: "Robux · lệnh admin",
};
const ROBUX = "<:robux:1456493708382830735>";
const RED = "#ed4245";
const GREEN = "#57f287";
const ORDER = { order: "robuxOrder" };
const LINKS = "{order.gamepassLinks}";

module.exports = {
    types: {
        robuxPackage: {
            label: "Gói Robux",
            fields: {
                robux: { type: "number", label: "Số Robux", example: 500 },
                robuxText: { label: "Số Robux (chữ)", example: "500" },
                price: { type: "money", label: "Giá", example: 95000 },
            },
        },
        robuxOrder: {
            label: "Đơn Robux",
            text: "paymentId",
            fields: {
                paymentId: { label: "Mã đơn", example: "RBm1abcd" },
                userId: { type: "id", label: "ID khách" },
                robux: { type: "number", label: "Số Robux", example: 500 },
                robuxText: { label: "Số Robux (chữ)", example: "500" },
                price: { type: "money", label: "Số tiền", example: 95000 },
                accountName: { label: "Tên tài khoản Roblox", example: "roblox_user" },
                gamepassLinks: { label: "Link gamepass (mỗi dòng một link)", example: "https://www.roblox.com/game-pass/1" },
                linkCount: { type: "number", label: "Số link", example: 2 },
                transferCode: { label: "Nội dung chuyển khoản", example: "aB3dE5fG Chuyen tien" },
                qrUrl: { type: "url", label: "Ảnh QR" },
                status: { label: "Trạng thái (pending / paid)", example: "pending" },
            },
        },
        robuxRefund: {
            label: "Mã hoàn tiền Robux",
            fields: {
                code: { label: "Mã hoàn tiền", example: "AB3CD5EF" },
                amount: { type: "money", label: "Số tiền hoàn", example: 95000 },
            },
        },
        robuxQueueItem: {
            label: "Đơn trong hàng chờ",
            fields: {
                number: { type: "number", label: "Thứ tự", example: 1 },
                paymentId: { label: "Mã đơn", example: "RBm1abcd" },
                robuxText: { label: "Số Robux", example: "500" },
                userId: { type: "id", label: "ID khách" },
            },
        },
    },

    templates: {
        // ── Panel ────────────────────────────────────────────────────────────
        "auto.robux.panel": {
            group: G.panel,
            label: "Panel mua Robux (/rb-setup)",
            description: "Tin công khai trong kênh, menu chọn gói. Cập nhật được các panel đã gửi.",
            refreshable: true,
            vars: { packages: "robuxPackage[]" },
            slotVars: { package: "robuxPackage" },
            allowEmpty: false,
            message: {
                embeds: [
                    embed({
                        title: "<:roblox:1487511739246444606> Robux 120h <:roblox:1487511739246444606>",
                        description: `{#each packages}> - **{robuxText} ${ROBUX}** <a:Love:1379091872747880670> **{price|number}đ**\n{/each}\n<:warning:1487512261793808586> **Lưu Ý**\n- Đây là robux gamepass đã tính thuế.\n- Nick phải trên 7 ngày và có skin bất kì.\n- Mua bằng link gamepass, mỗi link cài cố định 358 ${ROBUX} (hướng dẫn: <#1456496321413386461>)`,
                        fields: [field("⏱ Thời gian chờ QR", "10 phút (quá thời gian sẽ hết hạn)."), field("⚙️ Xử lý", "Trong vòng 24h sau khi thanh toán, lâu hơn nếu hệ thống gặp lỗi.")],
                        thumbnail:
                            "https://cdn.discordapp.com/attachments/1245991899450572912/1456492591506788383/1767325292739.png?ex=69e6f1ee&is=69e5a06e&hm=766ce191eeee144238a57ebdbcaa687bbb705db9b350f9bcee5249c75e007570&",
                        image: "https://logos-world.net/wp-content/uploads/2020/10/Roblox-Logo-2018-present.jpg",
                    }),
                ],
            },
            selects: { package: { placeholder: "💲 Chọn gói Robux muốn mua", label: "{robuxText} Robux", description: "{price|number}đ", emoji: ROBUX } },
        },
        "auto.robux.form": {
            kind: "card",
            group: G.panel,
            label: "Form gamepass",
            vars: { robux: "number", robuxText: "string", price: "money", index: "number", linkCount: "number" },
            texts: {
                title: "Mua {robuxText} Robux — {price|number}đ",
                linkLabelOne: "Link Gamepass Roblox của bạn",
                linkLabelMany: "Link Gamepass #{index} (250 Robux)",
                linkPlaceholder: "https://www.roblox.com/game-pass/...",
                accountLabel: "Tên tài khoản Roblox của bạn",
                accountPlaceholder: "Nhập username Roblox...",
            },
        },
        "auto.robux.sessionExpired": notice(G.panel, "Phiên chọn gói hết hạn", { title: "Lỗi phiên", description: "Phiên làm việc đã hết hạn. Vui lòng chọn lại gói." }),
        "auto.robux.badLink": notice(G.panel, "Link gamepass sai", { title: "Link không hợp lệ", description: "Link Gamepass #{index} không hợp lệ. Vui lòng nhập đúng link từ Roblox." }, { index: "number" }),
        "auto.robux.error": notice(G.panel, "Lỗi chung", { title: "Có lỗi xảy ra", description: "{error}" }, { error: "string" }),

        // ── Thanh toán ───────────────────────────────────────────────────────
        "auto.robux.payment": {
            group: G.pay,
            label: "QR Robux",
            description: "{state} = created (vừa tạo) / existed (đã có đơn chờ).",
            vars: { ...ORDER, state: { type: "string", label: "created / existed", example: "created" } },
            slots: { cancel: { label: "Hủy đơn", style: "Danger" } },
            message: {
                embeds: [
                    embed({
                        title: "Thanh toán Robux",
                        color: "#e74c3c",
                        description: '{#if state == "existed"}Bạn đã có đơn chờ thanh toán. Thanh toán hoặc chờ hết hạn để tạo đơn mới.{#else}Đã tạo QR thanh toán cho **{order.robuxText} Robux**. Chuyển khoản xong admin sẽ xử lý cho bạn.{/if}',
                        fields: [
                            field("Mã đơn", "`{order.paymentId}`", false),
                            field("Số Robux", "**{order.robuxText} Robux**"),
                            field("Tổng tiền", "`{order.price|number} VNĐ`"),
                            field("Tên tài khoản Roblox", "{order.accountName}"),
                            field("Link Gamepass", LINKS, false),
                            field("Chủ tài khoản", "`{auto.bankHolder}`", false),
                            field("Ngân hàng", "`{auto.bankCode}`"),
                            field("Số tài khoản", "```\n{auto.bankAccount}\n```", false),
                            field("Nội dung chuyển khoản", "```\n{order.transferCode}\n```", false),
                        ],
                        image: '{#if order.status == "pending"}{order.qrUrl}{/if}',
                        footer: "Bot tự kiểm tra qua VietQR webhook. Chuyển đúng nội dung.",
                        timestamp: true,
                    }),
                ],
                components: [[{ slot: "cancel" }]],
            },
        },
        "auto.robux.cancel.notFound": notice(G.pay, "Hủy: không thấy đơn", { title: "Lỗi", description: "Không tìm thấy đơn." }),
        "auto.robux.cancel.notYours": notice(G.pay, "Hủy đơn người khác", { title: "Không có quyền", description: "Bạn không thể hủy đơn của người khác." }),
        "auto.robux.cancel.handled": notice(G.pay, "Hủy đơn đã xử lý", { title: "Không thể hủy", description: "Đơn này đã được xử lý." }),

        // ── DM ───────────────────────────────────────────────────────────────
        "auto.robux.dm.cancelled": notice(G.dm, "Đã hủy đơn", { title: "Đã hủy đơn Robux", color: RED }, { user: "user" }),
        "auto.robux.dm.paid": notice(
            G.dm,
            "Đã nhận thanh toán",
            { title: "Đã xác nhận thanh toán Robux", color: GREEN, description: `Mã đơn: \`{order.paymentId}\`\nSố Robux: **{order.robuxText} Robux**\nTên tài khoản: {order.accountName}\nLink Gamepass:\n${LINKS}\n✅ Đã xác nhận thanh toán! Admin sẽ xử lý đơn của bạn sớm nhất.` },
            ORDER,
        ),
        "auto.robux.dm.recovered": notice(
            G.dm,
            "Đã nhận thanh toán (phát hiện khi khởi động lại)",
            { title: "Đã xác nhận thanh toán (khôi phục)", color: GREEN, description: "Mã đơn: `{paymentId}`\nSố tiền: {amount|money}\nBot phát hiện thanh toán khi khởi động lại. Admin sẽ xử lý đơn sớm nhất." },
            { paymentId: "string", amount: "money" },
        ),
        "auto.robux.dm.expired": notice(
            G.dm,
            "QR hết hạn (phát hiện khi khởi động lại)",
            { title: "QR thanh toán đã hết hạn", color: "#fee75c", description: "Mã đơn: `{paymentId}`\nSố tiền: {amount|money}\nQR Robux đã hết hạn. Hãy tạo đơn mới." },
            { paymentId: "string", amount: "money" },
        ),
        "auto.robux.dm.done": notice(
            G.dm,
            "Đơn hoàn thành",
            { title: "Đơn Robux hoàn thành", color: GREEN, description: `Mã đơn: \`{order.paymentId}\`\n${ROBUX} **{order.robuxText} Robux** đã được nạp vào tài khoản **{order.accountName}**.\n✅ Đơn hàng của bạn đã hoàn thành!` },
            ORDER,
        ),
        "auto.robux.dm.failed": notice(
            G.dm,
            "Đơn thất bại + mã hoàn tiền",
            {
                title: "Đơn Robux thất bại — Mã hoàn tiền",
                color: RED,
                description: "Mã đơn: `{order.paymentId}`\n❌ Rất tiếc, đơn **{order.robuxText} Robux** của bạn không thể xử lý.\n\n**Mã hoàn tiền của bạn:**\n```{refund.code}```\nHãy tạo ticket và gửi mã này để được hoàn tiền.\nMã chỉ dùng được một lần.",
            },
            { ...ORDER, refund: "robuxRefund" },
        ),
        "auto.robux.dm.refunded": notice(
            G.dm,
            "Đã hoàn tiền",
            { title: "Đã xác nhận hoàn tiền", color: GREEN, description: "Mã hoàn tiền: `{refund.code}`\nMã đơn gốc: `{order.paymentId}`\n💰 Số tiền hoàn: **{refund.amount|number}đ**\n✅ Admin đã xác nhận hoàn tiền. Vui lòng kiểm tra tài khoản của bạn." },
            { ...ORDER, refund: "robuxRefund" },
        ),

        // ── Log đơn & hàng chờ ───────────────────────────────────────────────
        "auto.robux.log.pending": notice(
            G.log,
            "Đơn mới — chờ thanh toán",
            {
                title: "🎮 Đơn Robux",
                color: "#e74c3c",
                fields: [
                    field("📦 Mã đơn (Queue)", "`{order.paymentId}`", false),
                    field("👤 Khách hàng", "<@{order.userId}>"),
                    field(`${ROBUX} Số Robux`, "**{order.robuxText} Robux**"),
                    field("💰 Số tiền", "**{order.price|number}đ**"),
                    field("👤 Tên tài khoản", "{order.accountName}"),
                    field("🔗 Link Gamepass", LINKS, false),
                    field("📋 Trạng thái", "⏳ Chờ thanh toán"),
                ],
                footer: "{footer}",
                timestamp: true,
            },
            { ...ORDER, footer: "string" },
        ),
        "auto.robux.log.paid": notice(
            G.log,
            "Đã thanh toán — chờ admin",
            {
                title: "🎮 Đơn Robux",
                color: "#f39c12",
                fields: [
                    field("📦 Mã đơn (Queue)", "`{order.paymentId}`", false),
                    field(`${ROBUX} Số Robux`, "**{order.robuxText} Robux**"),
                    field("👤 Tên tài khoản", "{order.accountName}"),
                    field("🔗 Link Gamepass", LINKS, false),
                    field("📋 Trạng thái", "✅ Đã thanh toán — Chờ admin xử lý"),
                ],
                footer: "{footer}",
                timestamp: true,
            },
            { ...ORDER, footer: "string" },
        ),
        "auto.robux.log.done": notice(
            G.log,
            "Hoàn thành",
            {
                title: "🎮 Đơn Robux",
                color: GREEN,
                fields: [
                    field(`${ROBUX} Số Robux`, "**{order.robuxText} Robux**"),
                    field("👤 Tài khoản", "{order.accountName}"),
                    field("🔗 Link Gamepass", LINKS, false),
                    field("📋 Trạng thái", "✅ Đã hoàn thành"),
                ],
                footer: "{footer}",
                timestamp: true,
            },
            { ...ORDER, footer: "string" },
        ),
        "auto.robux.log.failed": notice(
            G.log,
            "Thất bại — đã cấp mã hoàn tiền",
            {
                title: "🎮 Đơn Robux",
                color: RED,
                fields: [
                    field("📦 Mã đơn (Queue)", "`{order.paymentId}`", false),
                    field(`${ROBUX} Số Robux`, "**{order.robuxText} Robux**"),
                    field("👤 Tài khoản", "{order.accountName}"),
                    field("📋 Trạng thái", "❌ Thất bại — Đã cấp mã hoàn tiền"),
                ],
                footer: "{footer}",
                timestamp: true,
            },
            { ...ORDER, footer: "string" },
        ),
        "auto.robux.log.cancelled": notice(
            G.log,
            "Đã hủy / hết hạn",
            { title: "🎮 Đơn Robux", color: "#95a5a6", fields: [field("📦 Mã đơn (Queue)", "`{order.paymentId}`", false), field("📋 Trạng thái", "🚫 Đã hủy bởi khách / Hết hạn")], footer: "{footer}", timestamp: true },
            { ...ORDER, footer: "string" },
        ),
        "auto.robux.queue": notice(
            G.log,
            "Hàng chờ (tin ghim)",
            {
                title: "🎮 Hàng chờ Robux",
                color: "#e74c3c",
                description: `{#each queue}**#{number}** | \`{paymentId}\` | ${ROBUX} {robuxText} Robux | <@{userId}>{#if !@last}\n{/if}{#else}*Không có đơn nào đang chờ xử lý.*{/each}`,
                fields: [{ ...field("Tổng đơn chờ", "**{queue.length}**"), if: "queue" }],
                footer: "Cập nhật lúc",
                timestamp: true,
            },
            { queue: "robuxQueueItem[]" },
        ),

        // ── Lệnh admin ───────────────────────────────────────────────────────
        "auto.robux.cmd.setupDone": { group: G.cmd, label: "/rb-setup: đã gửi panel", vars: {}, message: { content: "✅ Đã gửi panel Robux vào kênh này." } },
        "auto.robux.cmd.error": notice(G.cmd, "Lỗi (/rb-done, /rb-fail)", { title: "Lỗi", color: RED, description: "{reason}" }, { reason: "string" }),
        "auto.robux.cmd.done": notice(
            G.cmd,
            "/rb-done: đã hoàn thành",
            {
                title: "✅ Đơn đã hoàn thành",
                color: GREEN,
                fields: [field("Mã đơn", "`{order.paymentId}`"), field("Khách hàng", "<@{order.userId}>"), field("Số Robux", "**{order.robuxText} Robux**"), field("Tài khoản", "{order.accountName}")],
                timestamp: true,
            },
            ORDER,
        ),
        "auto.robux.cmd.failed": notice(
            G.cmd,
            "/rb-fail: đã đánh dấu thất bại",
            {
                title: "❌ Đơn thất bại — Đã gửi mã hoàn tiền",
                color: RED,
                description: "Mã hoàn tiền đã được gửi cho khách qua DM.",
                fields: [
                    field("Mã đơn", "`{order.paymentId}`"),
                    field("Khách hàng", "<@{order.userId}>"),
                    field("Số Robux", "**{order.robuxText} Robux**"),
                    field("Số tiền hoàn", "**{order.price|number}đ**"),
                    field("Mã hoàn tiền", "```{refund.code}```", false),
                ],
                timestamp: true,
            },
            { ...ORDER, refund: "robuxRefund" },
        ),
        "auto.robux.cmd.refundInvalid": notice(G.cmd, "/rb-refund: mã không hợp lệ", { title: "Mã không hợp lệ", color: RED, description: "{reason}" }, { reason: "string" }),
        "auto.robux.cmd.refunded": notice(
            G.cmd,
            "/rb-refund: đã xác nhận",
            {
                title: "✅ Mã hoàn tiền hợp lệ — Đã xác nhận",
                color: GREEN,
                description: "Mã đã được đánh dấu là đã dùng. DM xác nhận đã gửi cho khách.",
                fields: [
                    field("Mã hoàn tiền", "`{refund.code}`"),
                    field("Mã đơn gốc", "`{order.paymentId}`"),
                    field("Khách hàng", "<@{order.userId}>"),
                    field("Số Robux", "**{order.robuxText} Robux**"),
                    field("Số tiền hoàn", "**{refund.amount|number}đ**"),
                    field("Tài khoản", "{order.accountName}"),
                ],
                timestamp: true,
            },
            { ...ORDER, refund: "robuxRefund" },
        ),
    },
};
