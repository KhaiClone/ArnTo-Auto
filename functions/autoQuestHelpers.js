/**
 * autoQuestHelpers.js
 * Shared helper functions for the Auto Quest feature.
 * Extracted here so they can be imported by multiple files
 * without circular dependency or duplication.
 */

const { MessageFlags } = require("discord.js");
const pricing = require("./pricing");

// Every message here is a template (templates/quest.js), editable on the
// bot-panel's Embeds page.

/**
 * The Auto Quest panel /quest-setup posts (template auto.quest.panel): Quest lẻ,
 * Quest tháng, Kiểm tra trạng thái, Cập nhật token. Buttons are stateless, so the
 * same panel works forever — and the Embeds page can re-render it.
 */
async function questPanelMessage(client) {
    return client.ui.message(
        "auto.quest.panel",
        { price: await pricing.questPricePerItem(client), monthlyPrice: await pricing.questMonthlyPrice(client) },
        {
            buttons: {
                single: { customId: "quest:enter_token" },
                monthly: { customId: "quest:enter_token_monthly" },
                status: { customId: "quest:check_token" },
                token: { customId: "quest:update_token" },
            },
        },
    );
}
const {
    getRunningMap,
    setAllowedQuests,
    startAccount,
    stopAccount,
    getActivationByPaymentId,
    removeActivationByPaymentId,
    getOrderLogPending,
    setOrderLogPending,
    markTokenRefreshRequired,
    getStoredSelectedQuestIds,
} = require("../extensions/AutoQuest");
const PanelQuest = require("../extensions/PanelQuest");

// In-memory registry: `${userId}:${accountId}` → { messageId, footerText }
const orderLogRegistry = new Map();

// ── Quest completion notices ───────────────────────────────────────────────────
// Completions used to go to the buyer's DMs. They now go to ONE channel
// (settings.questNotifyChannelId) so every run is visible in one place; the buyer is
// mentioned so each notice still says whose quest it is. Messages keep the silent
// style (SuppressNotifications): the mention renders, no ping is pushed.
// No channel configured → the notice is DMed, exactly like before.

/** The configured notify channel, or null when unset/unreachable/not text-based. */
async function _questNotifyChannel(client) {
    const id = client.configs.settings.questNotifyChannelId;
    if (!id) return null;
    const channel = await client.channels.fetch(id).catch(() => null);
    return channel?.isTextBased?.() ? channel : null;
}

/** Post the notice to the notify channel, or DM the buyer when there is none. */
async function _deliverQuestNotice(client, userId, payload) {
    try {
        const channel = await _questNotifyChannel(client);
        if (channel) {
            await channel.send({
                ...payload,
                allowedMentions: { users: [userId] },
                flags: MessageFlags.SuppressNotifications,
            });
            return true;
        }
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user) return false;
        await user.send({ ...payload, flags: MessageFlags.SuppressNotifications });
        return true;
    } catch (e) {
        console.warn(
            `[autoQuestHelpers] quest notice for ${userId} failed: ${e.message}`,
        );
        return false;
    }
}

const planLabel = (plan) =>
    plan === "monthly" ? "♾️ Quest tháng" : "⚡ Quest lẻ";
const accountVars = (accountId, username) => ({ accountId: accountId ?? null, username: username || "", __text: username || accountId || "" });

/**
 * Notice for ONE finished quest (template auto.quest.done).
 * @param {Object} info - { userId, accountId?, username?, questName, taskType?, plan? }
 */
async function sendQuestDoneNotice(
    client,
    { userId, accountId, username, questName, taskType, plan },
) {
    if (!userId || !questName) return false;
    const payload = client.ui.message("auto.quest.done", {
        userId,
        account: accountVars(accountId, username),
        quest: { name: questName, taskType: taskType || "", __text: questName },
        plan: plan || "single",
        planText: planLabel(plan),
    });
    return _deliverQuestNotice(client, userId, payload);
}

/**
 * Notice for a finished ORDER — every selected quest is done (template auto.quest.orderDone).
 * @param {Object} info - { userId, accountId?, username?, completed?, plan? }
 */
async function sendQuestOrderDoneNotice(
    client,
    { userId, accountId, username, completed, plan },
) {
    if (!userId) return false;
    const payload = client.ui.message("auto.quest.orderDone", {
        userId,
        account: accountVars(accountId, username),
        completed: Number.isFinite(completed) ? completed : null,
        hasCount: Number.isFinite(completed),
        plan: plan || "single",
        planText: planLabel(plan),
    });
    return _deliverQuestNotice(client, userId, payload);
}

// ── Order log ──────────────────────────────────────────────────────────────────
// One message per order in the admin log channel, edited as it moves on
// (templates auto.quest.log.*). The footer (creation time) is kept with the entry.

async function _logChannel(client) {
    const id = client.configs.settings.questOrderLogChannelId;
    if (!id) return null;
    const channel = await client.channels.fetch(id).catch(() => null);
    return channel?.isTextBased?.() ? channel : null;
}

async function _logEntry(client, userId, accountId) {
    return orderLogRegistry.get(`${userId}:${accountId}`) || (await getOrderLogPending(client, userId, accountId));
}

async function sendOrderLog(client, userId, accountId, username, quests) {
    try {
        const channel = await _logChannel(client);
        if (!channel) return;
        const staffFree = getRunningMap(userId).get(accountId)?.staffFree === true;
        const footerText = `QUEST | Tạo lúc ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false })}`;
        const msg = await channel.send(
            client.ui.message("auto.quest.log.pending", {
                userId,
                account: accountVars(accountId, username),
                count: quests.length,
                staffFree,
                footer: footerText,
            }),
        );
        const entry = { messageId: msg.id, footerText };
        orderLogRegistry.set(`${userId}:${accountId}`, entry);
        await setOrderLogPending(client, userId, accountId, entry);
    } catch (e) {
        console.warn(`[autoQuestHelpers] sendOrderLog error: ${e.message}`);
    }
}

/** Edit the order's log message to template `key`; `done` forgets the entry afterwards. */
async function _editLog(client, userId, accountId, key, vars, { done = false } = {}) {
    const entry = await _logEntry(client, userId, accountId);
    if (!entry) return;
    try {
        const channel = await _logChannel(client);
        if (!channel) return;
        const msg = await channel.messages.fetch(entry.messageId);
        await msg.edit(client.ui.message(key, { userId, footer: entry.footerText, ...vars }, { edit: true }));
        if (done) {
            orderLogRegistry.delete(`${userId}:${accountId}`);
            await setOrderLogPending(client, userId, accountId, null);
        }
    } catch (e) {
        console.warn(`[autoQuestHelpers] ${key} error: ${e.message}`);
    }
}

async function editOrderLog(client, userId, accountId, username, completedNames) {
    await _editLog(client, userId, accountId, "auto.quest.log.done", { account: accountVars(accountId, username), count: completedNames.length }, { done: true });
}

async function editOrderLogPaid(client, userId, accountId, username, questCount) {
    // The entry stays: editOrderLog (completion) still needs it.
    await _editLog(client, userId, accountId, "auto.quest.log.paid", { account: accountVars(accountId, username), count: questCount });
}

/** @param {string} reason  cancelled | expired | token_dead | token_dead_panel (template auto.quest.log.cancelled) */
async function cancelOrderLog(client, userId, accountId, reason) {
    await _editLog(client, userId, accountId, "auto.quest.log.cancelled", { account: accountVars(accountId, ""), reason: reason || "" }, { done: true });
}

// ── Payment unlock ─────────────────────────────────────────────────────────────

// Persist paid quests into the account's token-refresh record so they are NOT lost
// when the account can't start (token died while waiting for payment). After the
// user re-enters their token, the refresh flow reads these and resumes the run.
async function _stashPaidQuestsForReset(client, userId, accountId, questIds) {
    const existing = await getStoredSelectedQuestIds(client, userId, accountId);
    const merged = [
        ...new Set(
            [...existing, ...(questIds ?? [])].map(String).filter(Boolean),
        ),
    ];
    await markTokenRefreshRequired(client, userId, accountId, {
        selectedQuestIds: merged,
    });
    return merged;
}

/**
 * After a payment is confirmed as paid, unlock the quest run for the user.
 * Returns "unlocked" (running now), "pending_token" (paid quests saved, waiting for
 * the user to re-enter a dead token), or false (nothing to do).
 */
async function unlockPaymentIfPaid(client, payment) {
    if (!payment || payment.status !== "paid") return false;

    const activation = await getActivationByPaymentId(client, payment.id);

    // Delegate execution to the panel when enabled: stop the idle local loop (it was
    // started at token entry and never got quests) and let the panel run + webhook
    // completions back. Payment itself stays here in arnto-auto.
    if (PanelQuest.isEnabled()) {
        const token = activation?.token;
        const ids =
            activation?.selectedQuestIds ?? payment.selectedQuestIds ?? [];
        if (token) {
            try {
                stopAccount(payment.userId, payment.accountId);
                await PanelQuest.start({
                    token,
                    mode: "select",
                    selectedQuestIds: ids,
                    ref: payment.userId,
                });
                if (activation)
                    await removeActivationByPaymentId(client, payment.id);
                return "unlocked";
            } catch (err) {
                if (err.tokenDead) {
                    await _stashPaidQuestsForReset(
                        client,
                        payment.userId,
                        payment.accountId,
                        ids,
                    );
                    if (activation)
                        await removeActivationByPaymentId(client, payment.id);
                    return "pending_token";
                }
                console.warn(
                    `[PanelQuest] start failed, fallback to local: ${err.message}`,
                );
                // fall through to local execution below
            }
        }
    }

    if (activation) {
        const userMap = getRunningMap(payment.userId);

        // Case 1: account is already running — just unlock the quests
        if (userMap.has(payment.accountId)) {
            const unlocked = await setAllowedQuests(
                client,
                payment.userId,
                payment.accountId,
                activation.selectedQuestIds,
            );
            if (unlocked) await removeActivationByPaymentId(client, payment.id);
            return unlocked ? "unlocked" : false;
        }

        // Case 2: account not running — start it, then unlock
        const started = await startAccount(
            client,
            payment.userId,
            activation.token,
            {
                allowRestartIfRunning: false,
                notifyStarted: true,
                forceNotifyQuestBatch: true,
                source: "activate",
                requireQuestSelection: true,
            },
        );
        if (!started.ok) {
            // Token dead / can't start — stash the paid quests so they resume after
            // the user re-enters their token, instead of being silently lost.
            console.warn(
                `[autoQuestHelpers] Cannot start account for payment ${payment.id} (${started.reason}) — lưu quest chờ reset token.`,
            );
            await _stashPaidQuestsForReset(
                client,
                payment.userId,
                payment.accountId,
                activation.selectedQuestIds,
            );
            await removeActivationByPaymentId(client, payment.id);
            return "pending_token";
        }
        const unlocked = await setAllowedQuests(
            client,
            payment.userId,
            started.accountId ?? payment.accountId,
            activation.selectedQuestIds,
        );
        if (unlocked) await removeActivationByPaymentId(client, payment.id);
        return unlocked ? "unlocked" : false;
    }

    // Case 3: no activation record — try a running account, else stash for reset.
    const unlocked = await setAllowedQuests(
        client,
        payment.userId,
        payment.accountId,
        payment.selectedQuestIds,
    );
    if (unlocked) return "unlocked";
    await _stashPaidQuestsForReset(
        client,
        payment.userId,
        payment.accountId,
        payment.selectedQuestIds,
    );
    return "pending_token";
}

// ── Payment messages ───────────────────────────────────────────────────────────

/**
 * The QR of a single-quest order (template auto.quest.payment). `state` =
 * created | existed. A pending payment carries its Hủy đơn button.
 */
function questPaymentMessage(client, payment, state = "created", opts = {}) {
    const count = (payment.selectedQuestIds ?? []).length;
    return client.ui.message(
        "auto.quest.payment",
        {
            state,
            account: accountVars(payment.accountId, opts.username),
            payment: {
                id: payment.id,
                count,
                unitPrice: count ? Math.round(Number(payment.amount) / count) : client.configs.settings.questPricePerItem,
                amount: Number(payment.amount),
                transferCode: payment.transferCode,
                qrUrl: payment.qrUrl || null,
                status: payment.status,
                __text: payment.id,
            },
        },
        { buttons: payment.status === "pending" ? { cancel: { customId: `quest:cancel_payment:${payment.id}` } } : {}, ...opts },
    );
}

/** The QR of a monthly plan (template auto.quest.monthly.payment). */
function monthlyPaymentMessage(client, payment, state = "created", { username, accountId } = {}) {
    return client.ui.message(
        "auto.quest.monthly.payment",
        {
            state,
            account: accountVars(accountId ?? payment.accountId, username ?? payment.username),
            payment: {
                paymentId: payment.paymentId,
                months: payment.months,
                unitPrice: payment.months ? Math.round(Number(payment.amount) / payment.months) : client.configs.settings.monthlyQuestPrice,
                amount: Number(payment.amount),
                transferCode: payment.transferCode,
                qrUrl: payment.qrUrl || null,
                __text: payment.paymentId,
            },
        },
        { buttons: { cancel: { customId: `quest:cancel_monthly:${payment.paymentId}` } } },
    );
}

module.exports = {
    sendQuestDoneNotice,
    sendQuestOrderDoneNotice,
    sendOrderLog,
    editOrderLog,
    editOrderLogPaid,
    cancelOrderLog,
    unlockPaymentIfPaid,
    questPaymentMessage,
    monthlyPaymentMessage,
    questPanelMessage,
    accountVars,
    planLabel,
};
