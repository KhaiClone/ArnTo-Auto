module.exports = {
    token: process.env.TOKEN || "",
    devUserIds: ["871329074046435338", "1133037157527859230"],
    ownerUserIds: ["871329074046435338"],
    port: process.env.PORT || 3000,
    guildIds: ["1183033659838697542", "1103736775815471257"],
    textCommands: false,
    prefix: "",

    // ── Quest payment ──────────────────────────────────────────────────────────
    bankCode: process.env.BANK_CODE || "",
    bankAccount: process.env.BANK_ACCOUNT || "",
    bankHolder: process.env.BANK_HOLDER || "",
    questPricePerItem: Math.max(
        100,
        parseInt(process.env.QUEST_PRICE_PER_ITEM || "2000") || 2000,
    ),
    hypeSquadPrice: Math.max(
        100,
        parseInt(process.env.HYPESQUAD_PRICE || "5000") || 5000,
    ),

    // ── Discord channels ───────────────────────────────────────────────────────
    vietqrChannelId: process.env.VIETQR_CHANNEL_ID || "",
    logWebhookUrl: process.env.LOG_WEBHOOK_URL || "",
    orderLogChannelId: process.env.ORDER_LOG_CHANNEL_ID || "",
    orderLogTicketLabel: process.env.ORDER_LOG_TICKET_LABEL || "",
};
