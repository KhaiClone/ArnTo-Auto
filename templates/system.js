// Hệ thống: log AutoBank (webhook admin), trả lời lệnh không tồn tại.
const { notice, text, field } = require("./_auto");

const G = { bank: "Hệ thống · log AutoBank (webhook)", misc: "Hệ thống · khác" };

module.exports = {
    types: {
        bankEntry: {
            label: "Giao dịch AutoBank",
            text: "customId",
            fields: {
                handler: { label: "Loại (quest_payment / panel_payment / …)", example: "quest_payment" },
                userId: { type: "id", label: "ID khách" },
                customId: { label: "Nội dung chuyển khoản", example: "aB3dE5fG Chuyen tien" },
                amount: { type: "money", label: "Số tiền", example: 20000 },
                message: { label: "Tin webhook ngân hàng", example: "" },
            },
        },
    },

    templates: {
        "auto.bank.log": notice(
            G.bank,
            "Log thanh toán (mọi trạng thái)",
            {
                title: '{#if status == "PAID"}✅ Payment Received{#elseif status == "EXPIRED"}❌ Payment Expired{#elseif status == "PAID_MISSED"}⚠️ Missed Payment (Recovered){#elseif status == "EXPIRED_MISSED"}⏰ Missed Expiry (Recovered){#else}{status}{/if}',
                color: '{#if status == "PAID"}#57f287{#elseif status == "EXPIRED"}#ed4245{#elseif status == "PAID_MISSED"}#fee75c{#elseif status == "EXPIRED_MISSED"}#eb459e{#else}#99aab5{/if}',
                fields: [
                    field("type handle", "`{entry.handler}`"),
                    field("user", "<@{entry.userId}> `{entry.userId}`", false),
                    field("Custom ID", "`{entry.customId}`"),
                    field("Amount", "{entry.amount|number} VND"),
                    field("Status", "{status}"),
                    { ...field("Webhook Message", "{entry.message|trunc:1024}", false), if: "entry.message" },
                ],
                footer: "AutoBank",
                timestamp: true,
            },
            {
                entry: "bankEntry",
                status: { type: "string", label: "PAID / EXPIRED / PAID_MISSED / EXPIRED_MISSED", example: "PAID" },
            },
        ),
        "auto.system.unknownCommand": text(G.misc, "Lệnh không tồn tại", "Không tìm thấy lệnh, vui lòng thử lại sau.", {
            user: "user",
            command: { type: "string", label: "Tên lệnh", example: "help" },
        }),
    },
};
