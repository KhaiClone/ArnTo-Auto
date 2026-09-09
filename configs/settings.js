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
    // ── Monthly Auto Quest subscription ────────────────────────────────────────
    // Flat price per 30-day month; bot runs ALL available quests on schedule.
    monthlyQuestPrice: Math.max(
        1000,
        parseInt(process.env.MONTHLY_QUEST_PRICE || "50000") || 50000,
    ),
    // Hour (0-23, Asia/Ho_Chi_Minh) the scheduled monthly batch runs on its days.
    monthlyRunHour: Math.min(
        23,
        Math.max(0, parseInt(process.env.MONTHLY_RUN_HOUR || "9") || 9),
    ),
    // Fixed run days: 2 = Tuesday, 6 = Saturday (JS getDay()).
    monthlyRunDays: [2, 6],
    // Hour (0-23, VN) of the DAILY enroll-only scan for monthly accounts. Runs
    // separately from the Tue/Sat completion run so quests get enrolled early
    // (which lets video quests complete much faster on the run day).
    monthlyEnrollHour: Math.min(
        23,
        Math.max(0, parseInt(process.env.MONTHLY_ENROLL_HOUR || "3") || 3),
    ),

    // ── Discord channels ───────────────────────────────────────────────────────
    vietqrChannelId: process.env.VIETQR_CHANNEL_ID || "",
    logWebhookUrl: process.env.LOG_WEBHOOK_URL || "",
    questOrderLogChannelId: process.env.QUEST_ORDER_LOG_CHANNEL_ID || "",
    robuxOrderLogChannelId: process.env.ROBUX_ORDER_LOG_CHANNEL_ID || "",
    robuxQueueChannelId: process.env.ROBUX_QUEUE_CHANNEL_ID || "",
    badgeOrderLogChannelId: process.env.BADGE_ORDER_LOG_CHANNEL_ID || "",
};
