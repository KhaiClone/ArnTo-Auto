// Message templates of ArnTo-Auto — editable on the bot-panel's Embeds page
// (extensions/MessageTemplates.js). This file: {auto.*}, given to every
// template of this bot, and the small helpers the other template files share.
// Feature files: quest.js, robux.js, badge.js, panelBot.js, system.js, decoGift.js.

const s = () => require("../configs/settings");

/** One embed, the way client.embed() draws it (configs/embed.js colour by default). */
const embed = ({ title, description, color = "{auto.color}", fields, footer, timestamp, image, thumbnail, author, url } = {}) => ({
    ...(author ? { author } : {}),
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(description ? { description } : {}),
    color,
    ...(fields ? { fields } : {}),
    ...(thumbnail ? { thumbnail: { url: thumbnail } } : {}),
    ...(image ? { image: { url: image } } : {}),
    ...(footer ? { footer: typeof footer === "string" ? { text: footer } : footer } : {}),
    ...(timestamp ? { timestamp: true } : {}),
});

/** A message template with one embed. */
const notice = (group, label, e, vars = {}, extra = {}) => ({ group, label, vars, ...extra, message: { embeds: [embed(e)], ...(extra.message || {}) } });

/** A plain-text message template. */
const text = (group, label, content, vars = {}, extra = {}) => ({ group, label, vars, ...extra, message: { content } });

const field = (name, value, inline = true, more = {}) => ({ name, value, inline, ...more });

module.exports = {
    embed,
    notice,
    text,
    field,
    types: {
        auto: {
            label: "ArnTo-Auto (dùng chung)",
            fields: {
                color: { type: "color", label: "Màu embed mặc định (configs/embed.js)", example: "#9f92ff" },
                bankHolder: { label: "Chủ tài khoản nhận tiền", example: "TRUONG DUY KHAI" },
                bankCode: { label: "Ngân hàng", example: "MB" },
                bankAccount: { label: "Số tài khoản", example: "0123456789" },
                questPrice: { type: "money", label: "Giá quest lẻ (.env)", example: 2000 },
                monthlyPrice: { type: "money", label: "Giá gói tháng (.env)", example: 50000 },
                runDays: { label: "Lịch chạy gói tháng", example: "Thứ 3 & Thứ 7" },
                tokenGuide: { label: "Kênh hướng dẫn lấy token (#)", example: "<#1485326007308386556>" },
            },
        },
    },
    globals: {
        auto: {
            type: "auto",
            label: "ArnTo-Auto (màu, ngân hàng, giá, lịch)",
            value: () => {
                const st = s();
                return {
                    color: require("../configs/embed").color,
                    bankHolder: st.bankHolder,
                    bankCode: st.bankCode,
                    bankAccount: st.bankAccount,
                    questPrice: st.questPricePerItem,
                    monthlyPrice: st.monthlyQuestPrice,
                    runDays: "Thứ 3 & Thứ 7",
                    tokenGuide: "<#1485326007308386556>",
                };
            },
        },
    },
};
