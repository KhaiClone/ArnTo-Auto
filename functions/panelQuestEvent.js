const { cancelOrderLog } = require("./autoQuestHelpers");
const questFeed = require("./questFeed");
const accountLabel = require("./accountLabel");

/**
 * A quest event from the bot-panel (it runs the quests; payment stays here).
 * Arrives over the Discord bus ("quest.event", extensions/panelLink.js).
 * ref = the buyer's Discord user id. What the buyer sees of a run is its message in
 * the order feed (functions/questFeed.js): run_start lists the quests, quest_done
 * ticks one off, the run's end sets the state; a monthly pass carries runId.
 */
module.exports = async function handleQuestEvent(client, body) {
    const { type, accountId, ref, status, error, taskType, username, plan, runId, questId, quests } = body || {};
    // Single-quest events (questEngine) send the quest name as `name`;
    // the monthly runner sends it as `questName`. Accept either.
    const questName = body?.questName ?? body?.name;
    const userId = ref;
    if (!userId) return { handled: false };
    const who = { userId, accountId, username, plan, runId };

    if (type === "run_start" && Array.isArray(quests)) {
        await questFeed.runStarted(client, { ...who, quests });
    } else if (type === "quest_done" && questName) {
        await questFeed.questDone(client, { ...who, questId, questName, taskType });
    } else if (type === "run_end") {
        // A monthly pass is over (one stopped half-way says ok: false).
        await questFeed.runEnded(client, { ...who, state: body.ok === false ? "stopped" : "done" });
    } else if (type === "removed") {
        await questFeed.runEnded(client, { ...who, state: "stopped" });
    } else if (type === "status" && status === "done") {
        await questFeed.runEnded(client, { ...who, state: "done" });
    } else if (type === "status" && status === "stopped") {
        await questFeed.runEnded(client, { ...who, state: "stopped" });
    } else if (type === "status" && status === "token_dead") {
        await questFeed.runEnded(client, { ...who, state: "paused" });
        // Name the account (the panel sends its name + id): a buyer with several
        // accounts has to know which token to send again, and so does staff.
        const acc = accountLabel(username, accountId);
        const accLine = acc ? `Account: ${acc}` : null;
        await cancelOrderLog(
            client,
            userId,
            accountId,
            ["⏸️ Token account bị dead. Nhập lại token để tiếp tục.", accLine].filter(Boolean).join("\n"),
        ).catch(() => null);
        // Still a DM: this one asks the buyer to do something.
        const user = await client.users.fetch(userId).catch(() => null);
        if (user)
            await user
                .send({
                    embeds: [
                        client.embed(
                            [accLine, "Token account đã dead. Vào panel nhập token để tiếp tục chạy quest đã mua."]
                                .filter(Boolean)
                                .join("\n"),
                            {
                                title: "Cần nhập lại token",
                                color: 0xfee75c,
                            },
                        ),
                    ],
                })
                .catch(() => null);
    } else if (type === "status" && status === "error") {
        if (error) console.warn(`[quest-event] ${userId} error: ${error}`);
        await questFeed.runEnded(client, { ...who, state: "error" });
    }
    return { handled: true };
};
