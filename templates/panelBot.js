// Bot quản lý (panel bot của khách): /panel-setup, chọn bot, trạng thái, bật/tắt,
// gia hạn & nâng cấp RAM bằng QR, DM sau khi nhận tiền.
const { embed, notice, text, field } = require("./_auto");

const G = {
    panel: "Bot quản lý · panel",
    flow: "Bot quản lý · thao tác",
    pay: "Bot quản lý · thanh toán",
    dm: "Bot quản lý · DM khách",
};
const BLURPLE = "#5865f2";
const PAY = { payment: "botPayment" };

module.exports = {
    types: {
        customerBot: {
            label: "Bot của khách (trên panel)",
            text: "name",
            fields: {
                id: { label: "ID trên panel", example: "66f0c0ffee" },
                botID: { label: "Bot ID", example: "1234567890" },
                name: { label: "Tên bot (không có thì là Bot ID)", example: "MusicBot" },
                status: { label: "Trạng thái (online / stopped / …, trống = ngoại tuyến)", example: "online" },
                online: { type: "boolean", label: "Đang chạy", example: true },
                maxMemory: { label: "RAM tối đa", example: "128M" },
                restarts: { type: "number", label: "Số lần khởi động lại", example: 0 },
                uptime: { type: "time", label: "Chạy từ lúc" },
                expiresAt: { type: "time", label: "Hết hạn lúc" },
            },
        },
        botPayment: {
            label: "Thanh toán gia hạn / nâng cấp",
            fields: {
                action: { label: "extend (gia hạn) / upgrade (nâng cấp)", example: "extend" },
                botId: { label: "ID bot trên panel", example: "66f0c0ffee" },
                botName: { label: "Tên bot", example: "MusicBot" },
                value: { type: "number", label: "Số tháng (gia hạn) / số MB RAM (nâng cấp)", example: 1 },
                amount: { type: "money", label: "Số tiền", example: 35000 },
                transferCode: { label: "Nội dung chuyển khoản", example: "aB3dE5fG Chuyen tien" },
                qrUrl: { type: "url", label: "Ảnh QR" },
                expireMinutes: { type: "number", label: "QR hết hạn sau (phút)", example: 10 },
            },
        },
    },

    templates: {
        // ── Panel ────────────────────────────────────────────────────────────
        "auto.panelbot.panel": {
            group: G.panel,
            label: "Panel quản lý bot (/panel-setup)",
            description: "Tin công khai: 4 nút trạng thái / quản lý / gia hạn / nâng cấp. Cập nhật được các panel đã gửi.",
            refreshable: true,
            vars: {},
            slots: {
                status: { label: "Trạng thái", emoji: "📊", style: "Secondary" },
                manage: { label: "Quản lý", emoji: "⚙️", style: "Primary" },
                extend: { label: "Gia hạn", emoji: "⏳", style: "Success" },
                upgrade: { label: "Nâng cấp", emoji: "🚀", style: "Danger" },
            },
            message: {
                embeds: [
                    embed({
                        title: "🎮 TRUNG TÂM QUẢN LÝ BOT",
                        description:
                            "Chào mừng bạn đến với hệ thống quản lý bot tự động. Sử dụng các chức năng bên dưới để theo dõi và điều chỉnh bot của bạn một cách nhanh chóng.",
                        color: BLURPLE,
                        thumbnail: "{bot.avatar}",
                        fields: [
                            field("📊 Trạng thái", "Xem chi tiết thông số và tình trạng hoạt động."),
                            field("⚙️ Quản lý", "Bật, Tắt hoặc Khởi động lại bot của bạn."),
                            field("⏳ Gia hạn", "Kéo dài thời gian sử dụng bot."),
                            field("🚀 Nâng cấp", "Tăng dung lượng RAM để bot chạy mượt hơn."),
                        ],
                        footer: { text: "ArnTo Auto Tool • Hệ thống quản lý chuyên nghiệp", icon_url: "{bot.avatar}" },
                        timestamp: true,
                    }),
                ],
                components: [[{ slot: "status" }, { slot: "manage" }, { slot: "extend" }, { slot: "upgrade" }]],
            },
        },
        "auto.panelbot.cmd": {
            kind: "card",
            group: G.panel,
            label: "Trả lời /panel-setup",
            vars: {},
            texts: {
                notConfigured: "⚠️ Tích hợp Panel chưa được cấu hình. Vui lòng kiểm tra PANEL_API_URL và PANEL_API_KEY trong file .env.",
                setupDone: "✅ Đã thiết lập Panel quản lý thành công.",
            },
        },

        // ── Thao tác ─────────────────────────────────────────────────────────
        "auto.panelbot.flow": {
            kind: "card",
            group: G.flow,
            label: "Các bước thao tác (chữ, form, menu, nút)",
            description: "Mọi câu bot trả lời khi khách bấm panel, menu chọn bot, 4 nút quản lý và 2 form gia hạn / nâng cấp.",
            vars: {
                user: "user",
                action: { type: "string", label: "Nút đã bấm: status / manage / extend / upgrade", example: "manage" },
                customerBot: "customerBot",
                message: { type: "string", label: "Panel trả lời (bật / tắt / khởi động lại)", example: "Bot started" },
                error: "string",
            },
            slotVars: { bot: { customerBot: "customerBot" } },
            texts: {
                noBots: "❌ Bạn chưa có bot nào trong hệ thống.",
                chooseBot:
                    '🔍 Bạn đang chọn: **{#if action == "manage"}Quản lý{#elseif action == "extend"}Gia hạn{#elseif action == "upgrade"}Nâng cấp{#else}Trạng thái{/if}**. Vui lòng chọn Bot:',
                botNotFound: "❌ Không tìm thấy thông tin Bot.",
                chooseAction: "🎯 Chọn hành động cho Bot này:",
                actionOk: "✅ Thành công: {message}",
                actionFailed: "❌ Thất bại: {error}",
                badMonths: "❌ Số tháng không hợp lệ.",
                badRam: "❌ Dung lượng RAM không hợp lệ. Phải là bội số của 64 (vd: 64, 128).",
                extendTitle: "Gia hạn thời gian chạy Bot",
                extendLabel: "Số tháng muốn gia hạn",
                extendDefault: "1",
                upgradeTitle: "Nâng cấp dung lượng RAM",
                upgradeLabel: "Số MB RAM muốn thêm (vd: 64, 128, ...)",
                upgradePlaceholder: "64",
            },
            selects: {
                bot: {
                    placeholder: "Vui lòng chọn một Bot",
                    label: "{customerBot.name}",
                    description: '{#if customerBot.maxMemory}RAM: {customerBot.maxMemory}{#else}RAM: 128M{/if} | Trạng thái: {customerBot.status|default:"offline"}',
                    emoji: "🤖",
                },
            },
            buttons: {
                status: { label: "Trạng thái", emoji: "📊", style: "Secondary" },
                start: { label: "Khởi động", emoji: "▶️", style: "Success" },
                restart: { label: "Khởi động lại", emoji: "🔄", style: "Primary" },
                stop: { label: "Dừng", emoji: "⏹️", style: "Danger" },
            },
        },
        "auto.panelbot.status": notice(
            G.flow,
            "Chi tiết một bot",
            {
                title: "📊 CHI TIẾT BOT: {customerBot.name}",
                color: "{#if customerBot.online}#2ecc71{#else}#e74c3c{/if}",
                fields: [
                    field("📌 Tên Bot", "`{customerBot.name}`"),
                    field("🆔 Bot ID", "`{customerBot.botID}`"),
                    field("📡 Trạng thái", '{#if customerBot.online}🟢{#else}🔴{/if} **{customerBot.status|upper|default:"NGOẠI TUYẾN"}**'),
                    field("💾 RAM tối đa", '`{customerBot.maxMemory|default:"128M"}`'),
                    field("🔄 Khởi động lại", "`{customerBot.restarts}` lần"),
                    { ...field("⏱️ Thời gian chạy", "{customerBot.uptime|time:R}"), if: "customerBot.uptime" },
                    { ...field("📅 Ngày hết hạn", "🕒 {customerBot.expiresAt|time:f}\n⏳ ({customerBot.expiresAt|time:R})", false), if: "customerBot.expiresAt" },
                ],
                footer: "Dữ liệu được cập nhật thời gian thực",
                timestamp: true,
            },
            { customerBot: "customerBot" },
        ),

        // ── Thanh toán ───────────────────────────────────────────────────────
        "auto.panelbot.payment": notice(
            G.pay,
            "QR gia hạn / nâng cấp",
            {
                title: '💳 THANH TOÁN: {#if payment.action == "extend"}GIA HẠN{#else}NÂNG CẤP{/if}',
                description:
                    '💡 **Nội dung:** {#if payment.action == "extend"}Gia hạn bot **{payment.botName}** thêm **{payment.value}** tháng.{#else}Nâng cấp bot **{payment.botName}** thêm **{payment.value}MB** RAM.{/if}\n\n💵 **Số tiền:** `{payment.amount|number} VNĐ`\n📝 **Nội dung chuyển khoản:** `{payment.transferCode}`\n\n👉 Quét mã QR bên dưới bằng ứng dụng ngân hàng của bạn. Hệ thống sẽ tự động cập nhật sau vài giây sau khi nhận được tiền.',
                image: "{payment.qrUrl}",
                color: BLURPLE,
                footer: "⚠️ Mã QR sẽ hết hạn sau {payment.expireMinutes} phút.",
                timestamp: true,
            },
            PAY,
        ),

        // ── DM ───────────────────────────────────────────────────────────────
        "auto.panelbot.dm.applied": text(
            G.dm,
            "Đã nhận tiền & áp dụng",
            '✅ Đã nhận được thanh toán! {#if payment.action == "extend"}Bot của bạn đã được gia hạn thêm **{payment.value}** tháng.{#else}RAM của bot đã được nâng cấp thêm **{payment.value}** MB.{/if}',
            { ...PAY, via: { type: "string", label: "live (bot đang chạy) / recovered (phát hiện khi khởi động lại)", example: "live" } },
        ),
        "auto.panelbot.dm.failed": text(
            G.dm,
            "Đã nhận tiền nhưng áp dụng lỗi",
            "❌ Đã nhận được thanh toán, nhưng có lỗi xảy ra khi áp dụng nâng cấp. Vui lòng liên hệ hỗ trợ. (Bot ID: {payment.botId})",
            { ...PAY, via: "string", error: "string" },
        ),
    },
};
