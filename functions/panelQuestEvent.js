const {
    cancelOrderLog,
    sendQuestDoneNotice,
    sendQuestOrderDoneNotice,
} = require("./autoQuestHelpers");

/**
 * A quest event from the bot-panel (it runs the quests; payment stays here).
 * Arrives over the Discord bus ("quest.event", extensions/panelLink.js).
 * ref = the buyer's Discord user id.
 */
module.exports = async function handleQuestEvent(client, body) {
    const { type, accountId, ref, status, error, taskType, username, plan } = body || {};
    // Single-quest events (questEngine) send the quest name as `name`;
    // the monthly runner sends it as `questName`. Accept either so the
    // completion notice fires for both flows.
    const questName = body?.questName ?? body?.name;
    const userId = ref;
    if (!userId) return { handled: false };

    if (type === "quest_done" && questName) {
        // Goes to the quest notify channel (settings.questNotifyChannelId),
        // mentioning the buyer — no longer a DM.
        await sendQuestDoneNotice(client, { userId, accountId, username, questName, taskType, plan });
    } else if (type === "status" && status === "done") {
        await sendQuestOrderDoneNotice(client, { userId, accountId, username, plan });
    } else if (type === "status" && status === "token_dead") {
        await cancelOrderLog(client, userId, accountId, "token_dead_panel").catch(() => null);
        // Still a DM: this one asks the buyer to do something.
        const user = await client.users.fetch(userId).catch(() => null);
        if (user)
            await user
                .send(
                    client.ui.message("auto.quest.dm.tokenDeadPanel", {
                        account: { accountId: accountId ?? null, username: username || "", __text: username || accountId || "" },
                        user: client.ui.user(user),
                    }),
                )
                .catch(() => null);
    } else if (type === "status" && status === "error" && error) {
        console.warn(`[quest-event] ${userId} error: ${error}`);
    }
    return { handled: true };
};
