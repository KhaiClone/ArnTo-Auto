// Auto Badge: panel, nhập token, chọn badge/mốc, khai số, QR, log đơn, DM.
const { embed, notice, field } = require("./_auto");

const G = {
    panel: "Auto Badge · panel",
    flow: "Auto Badge · mua",
    dm: "Auto Badge · DM khách",
    log: "Auto Badge · log đơn (kênh admin)",
};

const TIER = "{#if payment.isChoice}{payment.tierName}{#else}{payment.tierName} — {payment.threshold|number} {payment.unitText}{/if}";
// The order lines every DM starts with, so the buyer always sees what they bought.
const DM_FIELDS = [field("🎖️ Badge", "{payment.badgeName}"), { ...field("{#if payment.isChoice}🏠 Nhà{#else}🎯 Mốc{/if}", TIER), if: "payment.tierName" }];
const DM_VARS = { payment: "badgePayment", user: "user" };
const dm = (label, title, color, description, extra = {}) =>
    notice(G.dm, label, { title, color, description, fields: [...DM_FIELDS, ...(extra.fields || [])], footer: extra.footer || "Mã đơn: {payment.orderId}", timestamp: true }, { ...DM_VARS, ...(extra.vars || {}) });

module.exports = {
    types: {
        badgePayment: {
            label: "Đơn Auto Badge",
            text: "id",
            fields: {
                id: { label: "Mã thanh toán", example: "BGm1abcd" },
                orderId: { label: "Mã đơn panel", example: "bg_42" },
                userId: { type: "id", label: "ID khách" },
                badgeKey: { label: "Badge (game_time / game_variety / hypesquad …)", example: "game_time" },
                badgeName: { label: "Tên badge", example: "Game Time" },
                tierKey: { label: "Mốc (key)", example: "dedicated" },
                tierName: { label: "Tên mốc / nhà", example: "Dedicated" },
                isChoice: { type: "boolean", label: "Badge chọn nhà (HypeSquad)", example: false },
                threshold: { type: "number", label: "Mốc cần đạt", example: 100 },
                unitText: { label: "Đơn vị (giờ / game / nhà)", example: "giờ" },
                amount: { type: "money", label: "Số tiền", example: 50000 },
                hasNitro: { type: "boolean", label: "Có Nitro", example: true },
                declaredValue: { type: "number", label: "Khách tự khai", example: 20 },
                transferCode: { label: "Nội dung chuyển khoản", example: "aB3dE5fG Chuyen tien" },
                qrUrl: { type: "url", label: "Ảnh QR" },
                expireMinutes: { type: "number", label: "QR hết hạn sau (phút)", example: 10 },
            },
        },
        badgeOffer: {
            label: "Badge đang bán",
            fields: {
                key: { label: "Key", example: "game_time" },
                title: { label: "Tiêu đề", example: "Game Time - Giờ chơi game" },
                label: { label: "Tên", example: "Game Time" },
                tag: { label: "Emoji", example: "🎮" },
                kind: { label: "Loại (tiered / choice)", example: "tiered" },
                tiers: { type: "badgeTier[]", label: "Các mốc" },
            },
        },
        badgeTier: {
            label: "Mốc badge",
            text: "name",
            fields: {
                key: { label: "Key", example: "dedicated" },
                name: { label: "Tên", example: "Dedicated" },
                tag: { label: "Emoji", example: "🥉" },
                threshold: { type: "number", label: "Mốc", example: 100 },
                unitText: { label: "Đơn vị", example: "giờ" },
                price: { type: "money", label: "Giá", example: 50000 },
                rarityName: { label: "Độ hiếm", example: "Hiếm" },
                isChoice: { type: "boolean", label: "Lựa chọn nhà", example: false },
                already: { type: "boolean", label: "Khách đã có", example: false },
            },
        },
    },

    templates: {
        // ── Panel ────────────────────────────────────────────────────────────
        "auto.badge.panel": {
            group: G.panel,
            label: "Panel Auto Badge (/badge-setup)",
            description: "Tin công khai: các badge và mốc đang bán (giá gốc, khách có Nitro). Cập nhật được các panel đã gửi.",
            refreshable: true,
            vars: { badges: "badgeOffer[]", crown: { type: "string", label: "Emoji tiêu đề", example: "🎮" }, hasTiered: "boolean", hasChoice: "boolean", banner: "url" },
            slots: { start: { label: "Mua badge", style: "Success" } },
            message: {
                embeds: [
                    embed({
                        description:
                            "# {crown} Auto Badge Discord {crown}\n{#each badges}### {tag} {title}\n{#each tiers}- {#if tag}{tag} {/if}**{name}**{#if threshold} - {threshold|number} {unitText}{/if} - **{price|number} VNĐ**\n{/each}{/each}### ⚠️ Lưu ý ⚠️\n{#if hasTiered}- **Game Time** và **Game Variety** chỉ người xem có **Nitro** mới thấy.\n- Acc không Nitro: tự khai mốc đang có, chịu phụ phí. Mua mốc **đã đạt rồi** thì **không hoàn tiền**.\n- Badge lên sau **~2 ngày**. Bot nhắn ngay khi gửi xong.\n{/if}{#if hasChoice}- **HypeSquad**: có thể thay đổi giữa các màu.\n{/if}- Cách lấy token: {auto.tokenGuide}\n### Liên hệ trực tiếp với shop qua <#1246028759597846650>",
                        image: "{banner}",
                    }),
                ],
                components: [[{ slot: "start" }]],
            },
        },
        "auto.badge.cmd": {
            kind: "card",
            group: G.panel,
            label: "Trả lời /badge-setup",
            vars: {},
            texts: {
                setupDone: "Đã gửi panel Auto Badge.",
                noOffers: "Chưa có mốc nào mở bán. Vào trang `/pricing` của panel để đặt giá và bật Auto Badge.",
            },
        },

        // ── Mua ──────────────────────────────────────────────────────────────
        "auto.badge.flow": {
            kind: "card",
            group: G.flow,
            label: "Các bước mua (chữ, form, menu)",
            description: "Mọi câu bot trả lời trong lúc khách mua, 2 form và 2 menu chọn.",
            vars: { user: "user", username: "string", hasNitro: "boolean", payment: "badgePayment", currentValue: "number", unitText: "string", error: "string" },
            slotVars: { badge: { badge: "badgeOffer" }, tier: "badgeTier" },
            texts: {
                disabled: "Auto Badge hiện chưa được bật.",
                openPayment: "Bạn đang có một đơn chờ thanh toán (`{payment.id}`). Hãy thanh toán hoặc huỷ nó trước.",
                invalidToken: "Token không hợp lệ.",
                noOffers: "Hiện chưa có mốc nào mở bán.",
                verified:
                    "Đã xác thực **{username}**.\n{#if hasNitro}Tài khoản có Nitro — hệ thống đọc được tiến độ của bạn và đã ẩn những mốc bạn đã đạt.{#else}Tài khoản không có Nitro — giá có phụ thu, và bạn sẽ cần tự khai tình trạng hiện tại.{/if}",
                sessionExpired: "Phiên đã hết hạn. Bấm lại nút để bắt đầu.",
                noTiersLeft: "Không còn mốc nào bạn chưa đạt cho badge này.",
                chooseTier: "Chọn mốc bạn muốn mua:",
                alreadyOwned:
                    "{#if payment.isChoice}❌ Tài khoản của bạn **đang ở nhà {payment.tierName}** rồi. Hãy chọn nhà khác.{#else}❌ Tài khoản của bạn **đã đạt mốc {payment.tierName}** rồi ({currentValue|number}/{payment.threshold|number} {payment.unitText}). Hãy chọn mốc cao hơn.{/if}",
                invalidNumber: "Vui lòng nhập một số hợp lệ.",
                paidNoCancel: "Đơn này đã được thanh toán, không huỷ được.",
                cancelled: "Đã huỷ đơn.",
                tokenDead: "Token không hợp lệ hoặc đã chết.",
                error: "Lỗi: {error}",
                tokenTitle: "Auto Badge — nhập token",
                tokenLabel: "Token Discord của bạn",
                tokenPlaceholder: "Dán token vào đây",
                declareTitle: "Khai tình trạng hiện tại",
                declareLabel: "Bạn đang có bao nhiêu {unitText}?",
                declarePlaceholder: "Không rõ thì ghi 0",
            },
            selects: {
                badge: {
                    placeholder: "Chọn loại badge",
                    label: "{badge.label}",
                    description:
                        '{#if badge.key == "game_time"}Số giờ chơi game tích luỹ{#elseif badge.key == "game_variety"}Số lượng game đã chơi{#elseif badge.key == "hypesquad"}Đổi nhà HypeSquad — ăn ngay{#else}{badge.label}{/if}',
                },
                tier: {
                    placeholder: "Chọn mốc muốn mua",
                    label: "{#if isChoice}{name}{#else}{name} — {threshold|number} {unitText}{/if}",
                    description: "{#if already}{#if isChoice}Bạn đang ở nhà này rồi{#else}Bạn đã đạt mốc này rồi{/if}{#else}{price|number}đ · {rarityName}{/if}",
                },
            },
        },
        "auto.badge.payment": {
            group: G.flow,
            label: "QR thanh toán",
            description: "Khách không Nitro mua badge theo mốc có thêm dòng cảnh báo (nội dung tin).",
            vars: { payment: "badgePayment", warn: { type: "boolean", label: "Hiện cảnh báo không hoàn tiền", example: false } },
            slots: { cancel: { label: "Huỷ đơn", style: "Danger" } },
            message: {
                content: "{#if warn}⚠️ Sau khi thanh toán, hệ thống sẽ kiểm tra tài khoản của bạn. **Nếu bạn đã đạt mốc này từ trước, số tiền đã chuyển sẽ không được hoàn lại.**{/if}",
                embeds: [
                    embed({
                        title: "Thanh toán Auto Badge",
                        image: "{payment.qrUrl}",
                        description: `**Badge:** {payment.badgeName}\n{#if payment.isChoice}**Lựa chọn:** {payment.tierName}{#else}**Mốc:** {payment.tierName} — {payment.threshold|number} {payment.unitText}{/if}\n**Số tiền:** {payment.amount|number}đ\n**Nội dung CK:** \`{payment.transferCode}\`\n\nQR hết hạn sau {payment.expireMinutes} phút.`,
                        footer: "Mã đơn: {payment.id}",
                    }),
                ],
                components: [[{ slot: "cancel" }]],
            },
        },

        // ── Log đơn ──────────────────────────────────────────────────────────
        "auto.badge.log": notice(
            G.log,
            "Log đơn (mọi trạng thái)",
            {
                title: "🎖️ Đơn Auto Badge",
                color:
                    '{#if state == "pending"}#5865f2{#elseif state == "paid"}#f39c12{#elseif state == "sent"}#57f287{#elseif state == "manual_review"}#fee75c{#else}#ed4245{/if}',
                description: "{note}",
                fields: [
                    field("👤 Khách hàng", "<@{payment.userId}>"),
                    field("🎖️ Badge", "{payment.badgeName}"),
                    field("🎯 Mốc", TIER),
                    field("💰 Số tiền", "{payment.amount|number}đ"),
                    field("💎 Nitro", '{payment.hasNitro|yesno:"Có":"Không"}'),
                    field(
                        "📋 Trạng thái",
                        '{#if state == "paid"}💸 Đã thanh toán — đang gửi{#elseif state == "sent"}✅ Hoàn tất{#elseif state == "manual_review"}⏳ Chờ admin duyệt{#elseif state == "forfeited"}🔴 Tịch thu{#elseif state == "refund_due"}↩️ Cần hoàn tiền{#elseif state == "failed"}❌ Lỗi{#elseif state == "cancelled"}🚫 Đã huỷ{#elseif state == "expired"}⌛ Hết hạn QR{#else}⏳ Chờ thanh toán{/if}',
                    ),
                    { ...field("✍️ Khách khai", "{payment.declaredValue|number} {payment.unitText}"), if: "!payment.hasNitro && payment.declaredValue != null" },
                    { ...field("🧾 Mã đơn panel", "`{payment.orderId}`", false), if: "payment.orderId" },
                ],
                footer: "{footer}",
                timestamp: true,
            },
            {
                payment: "badgePayment",
                state: { type: "string", label: "pending / paid / sent / manual_review / forfeited / refund_due / failed / cancelled / expired", example: "pending" },
                note: { type: "string", label: "Ghi chú (lý do…)", example: "" },
                footer: "string",
            },
        ),

        // ── DM ───────────────────────────────────────────────────────────────
        "auto.badge.dm.paid": dm("Đã nhận thanh toán", "💸 Đã nhận thanh toán", "#f39c12", "Bot sẽ nhắn lại ngay khi gửi xong."),
        "auto.badge.dm.startFailed": notice(
            G.dm,
            "Đã nhận tiền nhưng chưa chạy được",
            { title: "⚠️ Đã nhận thanh toán nhưng chưa chạy được", color: "#ed4245", description: "Không khởi chạy được đơn: {error}\nVui lòng liên hệ admin — đơn của bạn không bị mất.", footer: "Mã thanh toán: {payment.id}", timestamp: true },
            { ...DM_VARS, error: "string" },
        ),
        "auto.badge.dm.sent": dm(
            "Đơn hoàn tất",
            "🎉 Đơn hoàn tất!",
            "#57f287",
            '{#if payment.badgeKey == "hypesquad"}Nhà HypeSquad đã đổi, bạn kiểm tra trên profile là thấy ngay.{#else}Badge sẽ hiện trên profile sau khoảng **1 ngày** — đó là chu kỳ xử lý của Discord, không phải đơn chưa xong.\n_Badge này chỉ hiển thị với người xem có Nitro._{/if}',
        ),
        "auto.badge.dm.forfeited": dm(
            "Bị huỷ — không hoàn tiền (đã đạt mốc)",
            "❌ Đơn bị huỷ — không hoàn tiền",
            "#ed4245",
            "Tài khoản của bạn **đã đạt mốc {payment.tierName}** từ trước ({measuredValue|number} {payment.unitText} ≥ {payment.threshold|number}).\nTheo điều khoản, số tiền đã chuyển không được hoàn lại.",
            { vars: { measuredValue: "number" } },
        ),
        "auto.badge.dm.refundDue": dm("Đã huỷ — sẽ hoàn tiền", "↩️ Đơn đã huỷ", "#ed4245", "Admin sẽ hoàn tiền cho bạn."),
        "auto.badge.dm.manualReview": dm("Chờ admin kiểm tra", "⏳ Đơn đang chờ admin kiểm tra", "#fee75c", "Tiền của bạn vẫn được giữ, không mất đi đâu."),
        "auto.badge.dm.failed": dm("Thất bại", "❌ Đơn thất bại", "#ed4245", '{error|default:"Lỗi không xác định"}. Admin sẽ liên hệ với bạn.', { vars: { error: "string" } }),
        "auto.badge.dm.recovered": notice(
            G.dm,
            "Đã nhận thanh toán (phát hiện khi khởi động lại)",
            { title: "Đã xác nhận thanh toán (khôi phục)", color: "#57f287", description: "Mã đơn: `{paymentId}`\nSố tiền: {amount|money}\nBot phát hiện thanh toán khi khởi động lại. Đang tiến hành xử lý badge..." },
            { paymentId: "string", amount: "money" },
        ),
        "auto.badge.dm.expired": notice(
            G.dm,
            "QR hết hạn (phát hiện khi khởi động lại)",
            { title: "QR thanh toán đã hết hạn", color: "#fee75c", description: "Mã đơn: `{paymentId}`\nSố tiền: {amount|money}\nQR Auto Badge đã hết hạn. Hãy tạo đơn mới." },
            { paymentId: "string", amount: "money" },
        ),
    },
};
