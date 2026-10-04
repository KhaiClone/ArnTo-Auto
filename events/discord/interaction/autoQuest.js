/**
 * autoQuest.js (interactionCreate event)
 * Handles all Auto Quest interactions: buttons, select menus, modals.
 * All custom IDs are namespaced with "quest:" prefix.
 * Every message is a template (templates/quest.js), editable on the bot-panel.
 */

const {
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
} = require("discord.js");

const {
    getRunningMap,
    getSelectableQuests,
    resolveDiscordAccount,
    startAccount,
    setAllowedQuests,
    cancelPayment,
    createQuestPayment,
    getPaymentById,
    getOpenPendingPayment,
    upsertPendingActivation,
    removeActivationByPaymentId,
    getTokenRefreshRecord,
    getStoredAccountOwner,
    createMonthlyPayment,
    getOpenMonthlyPayment,
    getMonthlyPaymentById,
    getMonthlySubscriptionRaw,
    getUserMonthlyAccountIds,
    cancelMonthlyPayment,
    activateMonthlySubscription,
    getUserAccountsStatus,
    buildVietQrUrl,
    stopAccount,
} = require("../../../extensions/AutoQuest");
const PanelQuest = require("../../../extensions/PanelQuest");

/**
 * Accounts this user may re-enter a token for WITHOUT anything having flagged them
 * locally. Two cases the local `needsTokenRefresh` flag never covers, because the
 * panel — not this bot — runs those accounts and holds their token:
 *   • a monthly plan, whose token usually dies between scheduled runs;
 *   • a single order the panel already marked `token_dead`.
 * A local monthly record is included too, for a plan this bot runs itself.
 * Returns accountId -> { kind: "monthly" | "panel_single", acc? }.
 */
async function _refreshableAccounts(client, userId) {
    const map = new Map();
    if (PanelQuest.isEnabled()) {
        const { single = [], monthly = [] } = await PanelQuest.listByRef(
            userId,
        ).catch(() => ({ single: [], monthly: [] }));
        for (const a of single)
            if (a.status === "token_dead")
                map.set(String(a.accountId), { kind: "panel_single", acc: a });
        for (const m of monthly)
            if (m.active) map.set(String(m.accountId), { kind: "monthly" });
    }
    const local = await getUserMonthlyAccountIds(client, userId).catch(() => []);
    for (const id of local)
        if (!map.has(String(id))) map.set(String(id), { kind: "monthly" });
    return map;
}

// Owner/dev users run Auto Quest for free — no payment step.
function _isStaffFree(client, userId) {
    const s = client.configs.settings;
    return (
        (s.ownerUserIds ?? []).includes(userId) ||
        (s.devUserIds ?? []).includes(userId)
    );
}

const {
    sendOrderLog,
    questPaymentMessage,
    monthlyPaymentMessage,
    cancelOrderLog,
    accountVars,
    planLabel,
} = require("../../../functions/autoQuestHelpers");

const ms = (iso) => (iso ? new Date(iso).getTime() : null);
/** A quest-template message, ephemeral by default (opts.ephemeral = false to turn off). */
const msg = (client, key, vars = {}, opts = {}) => client.ui.message(key, vars, { ephemeral: true, ...opts });

module.exports = {
    name: "interactionCreate",
    async execute(client, interaction) {
        // Only handle quest-namespaced interactions
        const id = interaction.customId ?? "";
        if (!id.startsWith("quest:")) return;

        // Allow DM interactions for the dead-token re-entry flow: the button
        // (refresh_token) AND its modal submit (refresh_modal). Without the modal
        // in this list, submitting the re-entered token from a DM was silently
        // dropped here, so the button appeared broken. Everything else needs a guild.
        const isDmAllowed =
            id.startsWith("quest:refresh_token:") ||
            id.startsWith("quest:refresh_modal:");
        if (!interaction.guild && !isDmAllowed) return;

        try {
            if (interaction.isButton())
                return await _handleButton(client, interaction);
            if (interaction.isStringSelectMenu())
                return await _handleSelectMenu(client, interaction);
            if (interaction.isModalSubmit())
                return await _handleModal(client, interaction);
        } catch (err) {
            console.error("[autoQuest interaction] error:", err);
            const payload = msg(client, "auto.quest.error", { error: err.message });
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp(payload).catch(() => null);
            } else {
                await interaction.reply(payload).catch(() => null);
            }
        }
    },
};

// ── Button handler ─────────────────────────────────────────────────────────────
async function _handleButton(client, interaction) {
    const { customId } = interaction;
    const user = client.ui.user(interaction.user);

    // "Nhập token" button on the quest panel
    if (customId === "quest:enter_token") {
        const refreshRecord = await getTokenRefreshRecord(
            client,
            interaction.user.id,
        );
        if (refreshRecord) {
            return interaction.showModal(
                _buildTokenModal(client, `quest:refresh_modal:${refreshRecord.accountId}`, "titleRefresh"),
            );
        }
        return interaction.showModal(_buildTokenModal(client, "quest:token_modal", "titleNew"));
    }

    // "Gia hạn theo tháng" button on the quest panel
    if (customId === "quest:enter_token_monthly") {
        return interaction.showModal(_buildTokenModal(client, "quest:monthly_token_modal", "titleMonthly"));
    }

    // "Cập nhật token" button — for accounts whose token has died. Opens the token
    // re-entry modal (the quest:refresh_modal flow resolves the token and resumes the
    // paid quests / monthly plan) for the account that is waiting for one. A monthly
    // plan runs on a schedule, so its token can die with nothing here flagging it —
    // in that case the modal is opened without a fixed account and the account is
    // taken from the token itself. Only a user with no quest at all is turned away.
    if (customId === "quest:update_token") {
        const refreshRecord = await getTokenRefreshRecord(
            client,
            interaction.user.id,
        );
        if (refreshRecord)
            return interaction.showModal(
                _buildTokenModal(client, `quest:refresh_modal:${refreshRecord.accountId}`, "titleRefresh"),
            );
        const refreshable = await _refreshableAccounts(client, interaction.user.id);
        if (refreshable.size)
            return interaction.showModal(_buildTokenModal(client, "quest:refresh_modal:any", "titleRefresh"));
        return interaction.reply(msg(client, "auto.quest.noRefreshable", { user }));
    }

    if (customId === "quest:check_token") {
        await interaction.deferReply({ ephemeral: true });

        // When execution is delegated to the panel, read status from there.
        if (PanelQuest.isEnabled()) {
            const stLabel = {
                running: "Đang chạy",
                done: "Đã xong",
                stopped: "Đã dừng",
                token_dead: "⚠️ Token lỗi",
                error: "Lỗi",
            };
            const { single = [], monthly = [] } = await PanelQuest.listByRef(
                interaction.user.id,
            );
            const accounts = [];
            for (const a of single.slice(0, 20)) {
                const qs = a.quests || {};
                accounts.push({
                    accountId: a.accountId,
                    username: a.username,
                    plan: "single",
                    planText: planLabel("single"),
                    status: a.status,
                    statusText: stLabel[a.status] ?? a.status,
                    questsTotal: Object.keys(qs).length,
                    questsDone: Object.values(qs).filter((q) => q.state === "done").length,
                    completedCount: a.completedCount ?? 0,
                    __text: a.username,
                });
            }
            for (const a of monthly.slice(0, 5)) {
                accounts.push({
                    accountId: a.accountId,
                    username: a.username,
                    plan: "monthly",
                    planText: planLabel("monthly"),
                    monthlyExpiresAt: ms(a.monthlyExpiresAt),
                    __text: a.username,
                });
            }
            if (!accounts.length) return interaction.editReply(client.ui.message("auto.quest.status.empty", { user, panel: true }));
            return interaction.editReply(
                client.ui.message("auto.quest.status.panel", { user, accounts, total: single.length + monthly.length }),
            );
        }

        const list = await getUserAccountsStatus(client, interaction.user.id);
        if (!list.length) return interaction.editReply(client.ui.message("auto.quest.status.empty", { user, panel: false }));
        const accounts = list.slice(0, 25).map((a) => ({
            accountId: a.accountId,
            username: a.username,
            plan: a.type === "monthly" ? "monthly" : "single",
            planText: planLabel(a.type === "monthly" ? "monthly" : "single"),
            tokenAlive: !!a.tokenAlive,
            running: !!a.running,
            runningQuestCount: a.runningQuestCount ?? null,
            completedCount: a.completedCount ?? 0,
            startedAt: a.startedAt ? ms(a.startedAt) || a.startedAt : null,
            uptime: a.startedAt ? client.funcs.formatUptime(a.startedAt) : "",
            monthlyExpiresAt: ms(a.monthlyExpiresAt),
            __text: a.username,
        }));
        return interaction.editReply(client.ui.message("auto.quest.status.local", { user, accounts, total: list.length, shown: accounts.length }));
    }

    // "Nhập token ngay" button sent via DM when token is dead
    if (customId.startsWith("quest:refresh_token:")) {
        const accountId = customId.split(":")[2];
        const refreshRecord = await getTokenRefreshRecord(
            client,
            interaction.user.id,
        );
        if (!refreshRecord || refreshRecord.accountId !== accountId) {
            return interaction.reply(msg(client, "auto.quest.notWaitingToken", { accountId }));
        }
        return interaction.showModal(_buildTokenModal(client, `quest:refresh_modal:${accountId}`, "titleRefresh"));
    }

    // "Hủy đơn" button on the payment embed
    if (customId.startsWith("quest:cancel_payment:")) {
        const paymentId = customId.split(":")[2];
        const payment = await getPaymentById(client, paymentId);

        if (!payment) return interaction.reply(msg(client, "auto.quest.payment.notFound"));
        if (payment.userId !== interaction.user.id) return interaction.reply(msg(client, "auto.quest.payment.notYours"));
        if (payment.status !== "pending") return interaction.reply(msg(client, "auto.quest.payment.handled"));

        await interaction.deferUpdate();
        await cancelPayment(client, paymentId);
        await removeActivationByPaymentId(client, paymentId);
        await cancelOrderLog(client, payment.userId, payment.accountId, "cancelled");

        const buyer = await client.users.fetch(payment.userId).catch(() => null);
        if (buyer) {
            await buyer.send(client.ui.message("auto.quest.payment.cancelledDm", { user: client.ui.user(buyer) })).catch(() => null);
        }
        return;
    }

    // "Hủy đơn" button on the monthly-subscription payment embed
    if (customId.startsWith("quest:cancel_monthly:")) {
        const paymentId = customId.split(":")[2];
        const payment = await getMonthlyPaymentById(client, paymentId);
        if (!payment || payment.status !== "pending") return interaction.reply(msg(client, "auto.quest.monthly.cancelInvalid"));
        if (payment.userId !== interaction.user.id) return interaction.reply(msg(client, "auto.quest.payment.notYours"));
        await interaction.deferUpdate();
        await cancelMonthlyPayment(client, paymentId);
        const buyer = await client.users.fetch(payment.userId).catch(() => null);
        if (buyer) await buyer.send(client.ui.message("auto.quest.monthly.cancelledDm", { user: client.ui.user(buyer) })).catch(() => null);
        return;
    }
}

// ── Select menu handler ────────────────────────────────────────────────────────
async function _handleSelectMenu(client, interaction) {
    // Per-account quest picker (the only select menu left on the quest flow).
    if (!interaction.customId.startsWith("quest:select:")) return;

    const accountId = interaction.customId.split(":")[2];
    const selectedQuestIds = interaction.values ?? [];
    const runningEntry = getRunningMap(interaction.user.id).get(accountId);

    if (!runningEntry) return interaction.reply(msg(client, "auto.quest.accountGone", { accountId }));

    const account = accountVars(accountId, runningEntry.username);

    // Owner/dev: unlock the selected quests immediately, no payment.
    if (_isStaffFree(client, interaction.user.id)) {
        // Ack now — enrolling the picked quests can take ~1-2s (past the 3s limit
        // if we waited to update). enrollSelected() makes sure the chosen quests are
        // enrolled so the run loop can start them right away.
        await interaction.deferUpdate();
        runningEntry.staffFree = true;
        if (PanelQuest.isEnabled()) {
            // Delegate execution to the panel (stop the idle local loop first).
            const token = runningEntry.token;
            stopAccount(interaction.user.id, accountId);
            await PanelQuest.start({
                token,
                mode: "select",
                selectedQuestIds,
                ref: interaction.user.id,
            }).catch((e) => console.warn(`[PanelQuest] staff start: ${e.message}`));
        } else {
            await runningEntry.completer
                .enrollSelected(selectedQuestIds)
                .catch(() => {});
            await setAllowedQuests(
                client,
                interaction.user.id,
                accountId,
                selectedQuestIds,
            );
        }
        // Create the order log now (marked "Miễn phí (Staff)" via the staffFree flag).
        await sendOrderLog(
            client,
            interaction.user.id,
            accountId,
            runningEntry.username,
            selectedQuestIds,
        );
        return interaction.editReply(client.ui.message("auto.quest.staffFree", { count: selectedQuestIds.length, account }, { edit: true }));
    }

    // Check if user already has a pending payment for this account
    const existed = await getOpenPendingPayment(
        client,
        interaction.user.id,
        accountId,
    );
    if (existed) {
        return interaction.update(questPaymentMessage(client, existed, "existed", { username: runningEntry.username, edit: true }));
    }

    // Create new payment and register with AutoBank
    const payment = await createQuestPayment(client, {
        userId: interaction.user.id,
        accountId,
        questIds: selectedQuestIds,
    });

    // Create the order log immediately at QR creation ("⏳ Chờ thanh toán"),
    // consistent with AutoBadge/Robux. It is edited to paid/cancelled later.
    await sendOrderLog(
        client,
        interaction.user.id,
        accountId,
        runningEntry.username,
        selectedQuestIds,
    );

    // Save activation so we can restore it if bot restarts before payment is confirmed
    await upsertPendingActivation(client, {
        paymentId: payment.id,
        userId: interaction.user.id,
        accountId,
        token: runningEntry.token,
        selectedQuestIds,
    });

    return interaction.update(questPaymentMessage(client, payment, "created", { username: runningEntry.username, edit: true }));
}

// ── Modal handler ──────────────────────────────────────────────────────────────
async function _handleModal(client, interaction) {
    // Monthly subscription token submission
    if (interaction.customId === "quest:monthly_token_modal") {
        return _handleMonthlyModal(client, interaction);
    }

    const failed = (reason) => interaction.editReply(client.ui.message("auto.quest.activateFailed", { reason }));

    // New token submission
    if (interaction.customId === "quest:token_modal") {
        const token = client.funcs.normalizeDiscordTokenInput(
            interaction.fields.getTextInputValue("token"),
        );
        await interaction.deferReply({ ephemeral: true });

        const resolved = await resolveDiscordAccount(token);
        if (!resolved.ok) return failed(resolved.reason);

        // Account already running → let the user pick MORE quests and add them to
        // the current run (paid quests are appended, not replaced) — no need to wait
        // for the earlier batch to finish before buying more.
        if (getRunningMap(interaction.user.id).get(resolved.accountId)) {
            return _replyWithQuestSelection(client, interaction, resolved);
        }

        // Not running → start it (fresh entry, or resume a stored account).
        const result = await startAccount(client, interaction.user.id, token, {
            resolvedAccount: resolved,
            allowRestartIfRunning: false,
            notifyStarted: true,
            forceNotifyQuestBatch: true,
            source: "activate",
            requireQuestSelection: true,
            // Fresh token entry: drop it if the user never selects/pays in time.
            autoRemoveIfInactive: true,
        });

        if (!result.ok) return failed(result.reason);

        return _replyWithQuestSelection(client, interaction, result);
    }

    // Refresh token submission
    if (interaction.customId.startsWith("quest:refresh_modal:")) {
        const modalTarget = interaction.customId.split(":")[2];
        // "any" = the panel button opened this with nothing flagged (a monthly
        // token that died between scheduled runs). The account is then whatever the
        // token resolves to, checked against this user's plans below.
        const wildcard = modalTarget === "any";
        const token = client.funcs.normalizeDiscordTokenInput(
            interaction.fields.getTextInputValue("token"),
        );
        await interaction.deferReply({ ephemeral: true });

        const userId = interaction.user.id;
        const user = client.ui.user(interaction.user);
        const refreshRecord = await getTokenRefreshRecord(client, userId);
        const preFlagged =
            !wildcard && refreshRecord?.accountId === modalTarget;
        // Panel-run accounts may be re-tokened even when nothing flagged them —
        // and a flagged order can ALSO be one the panel runs (paid while the token
        // was dead), which must resume there rather than in this bot, so ask either
        // way.
        const refreshable = await _refreshableAccounts(client, userId);
        if (!wildcard && !preFlagged && !refreshable.has(modalTarget)) {
            return interaction.editReply(client.ui.message("auto.quest.notWaitingToken", { accountId: modalTarget }));
        }

        const resolved = await resolveDiscordAccount(token);
        if (!resolved.ok) return failed(resolved.reason);
        if (!wildcard && resolved.accountId !== modalTarget) {
            return interaction.editReply(client.ui.message("auto.quest.wrongAccount", { accountId: modalTarget }));
        }
        const accountId = resolved.accountId;
        const account = accountVars(accountId, resolved.username);
        const flagged = refreshRecord?.accountId === accountId;
        if (!flagged && !refreshable.has(accountId)) {
            return interaction.editReply(client.ui.message("auto.quest.noOrderWaiting", { accountId }));
        }

        // ── Monthly subscribers ──────────────────────────────────────────────
        // A monthly subscription's quest run does NOT use the local per-batch
        // loop that startAccount() revives — it runs on the panel (PanelQuest)
        // when enabled, and/or via the local monthly scheduler, each holding its
        // OWN copy of the token. Refreshing only the local per-batch token (as the
        // single-quest flow below does) leaves those with the dead token, so the
        // next scheduled run fails and re-flags the account — which is why, before
        // this branch, only the "Mua/nhập gói tháng" button actually re-installed
        // the token. Push the new token to wherever the monthly run reads it so a
        // single "Cập nhật token" press fixes monthly accounts too.
        let panelMonthlyActive = false;
        if (PanelQuest.isEnabled()) {
            const { monthly = [] } = await PanelQuest.listByRef(userId).catch(
                () => ({ monthly: [] }),
            );
            panelMonthlyActive = monthly.some(
                (m) => m.accountId === accountId && m.active,
            );
            if (panelMonthlyActive) {
                try {
                    await PanelQuest.activateMonthly({
                        token,
                        months: 0,
                        ref: userId,
                    });
                } catch (e) {
                    return failed(e.message);
                }
            }
        }
        const localMonthlyActive = await getMonthlySubscriptionRaw(
            client,
            userId,
            accountId,
        ).catch(() => null);
        if (panelMonthlyActive || localMonthlyActive) {
            // Refresh the local monthly record's token too (keeps the current
            // expiry, drops the dead-token flag) so the status panel and any local
            // monthly scheduler stop seeing a dead token.
            await activateMonthlySubscription(client, {
                userId,
                accountId,
                token,
                username: resolved.username,
                months: 0,
            }).catch(() => {});
            return interaction.editReply(client.ui.message("auto.quest.monthlyTokenUpdated", { account, user }));
        }

        // ── Panel-run single order ───────────────────────────────────────────
        // The panel holds this account's token and its quest selection; the local
        // startAccount() below would start a SECOND run here instead of reviving
        // the paid one. Re-install the token on the panel and let it resume.
        const panelEntry = refreshable.get(accountId);
        if (PanelQuest.isEnabled() && panelEntry?.kind === "panel_single") {
            const acc = panelEntry.acc ?? {};
            try {
                await PanelQuest.start({
                    token,
                    mode: acc.mode === "select" ? "select" : "all",
                    selectedQuestIds: acc.selectedQuestIds ?? [],
                    ref: userId,
                });
            } catch (e) {
                return failed(e.message);
            }
            return interaction.editReply(client.ui.message("auto.quest.tokenUpdatedPanel", { account, user }));
        }

        // Past the branches above, only a flagged local order can be revived
        // (a plan that expired between the two lookups above lands here).
        if (!refreshRecord) return interaction.editReply(client.ui.message("auto.quest.noOrderFound", { accountId }));

        const result = await startAccount(client, userId, token, {
            resolvedAccount: resolved,
            allowRestartIfRunning: false,
            addedAt: refreshRecord.addedAt,
            month: refreshRecord.month,
            notifyStarted: false,
            forceNotifyQuestBatch: true,
            source: "refresh",
            requireQuestSelection: true, // keeps stored quest selection
        });

        if (!result.ok) return failed(result.reason);

        // Restore stored quest selection so the run loop resumes immediately
        const {
            setAllowedQuests,
            getStoredSelectedQuestIds,
        } = require("../../../extensions/AutoQuest");
        const storedIds = await getStoredSelectedQuestIds(
            client,
            interaction.user.id,
            result.accountId,
        );
        if (storedIds.length > 0) {
            await setAllowedQuests(
                client,
                interaction.user.id,
                result.accountId,
                storedIds,
            );
        }

        return interaction.editReply(
            client.ui.message("auto.quest.tokenUpdated", {
                account: accountVars(result.accountId, result.username),
                user,
                resumed: storedIds.length > 0,
            }),
        );
    }
}

// ── Monthly subscription modal ───────────────────────────────────────────────────
async function _handleMonthlyModal(client, interaction) {
    const token = client.funcs.normalizeDiscordTokenInput(
        interaction.fields.getTextInputValue("token"),
    );
    await interaction.deferReply({ ephemeral: true });

    const reply = (key, vars = {}, opts = {}) => interaction.editReply(client.ui.message(key, vars, opts));
    const resolved = await resolveDiscordAccount(token);
    if (!resolved.ok) return reply("auto.quest.activateFailed", { reason: resolved.reason });
    const userId = interaction.user.id;
    const accountId = resolved.accountId;
    const vars = { account: accountVars(accountId, resolved.username), user: client.ui.user(interaction.user) };

    // Account ownership guard
    const ownerId = await getStoredAccountOwner(client, accountId);
    if (ownerId && ownerId !== userId) return reply("auto.quest.monthly.ownedByOther", vars);

    // ── Panel-delegated monthly (execution runs on the panel) ─────────────────────
    if (PanelQuest.isEnabled()) {
        const { monthly = [] } = await PanelQuest.listByRef(userId);
        const activePanel = monthly.find(
            (m) => m.accountId === accountId && m.active,
        );
        // Already subscribed on the panel → just refresh the token (free, keep expiry).
        if (activePanel) {
            await PanelQuest.activateMonthly({ token, months: 0, ref: userId }).catch(
                () => {},
            );
            return reply("auto.quest.monthly.tokenRefreshed", { ...vars, expiresAt: ms(activePanel.monthlyExpiresAt) });
        }
        // Owner/dev → activate 1 month free on the panel.
        if (_isStaffFree(client, userId)) {
            try {
                const r = await PanelQuest.activateMonthly({
                    token,
                    months: 1,
                    ref: userId,
                });
                return reply("auto.quest.monthly.staffFree", { ...vars, expiresAt: ms(r.monthlyExpiresAt) });
            } catch (e) {
                return reply("auto.quest.activateFailed", { reason: e.message });
            }
        }
        // Non-staff → fall through to the payment flow below; on payment,
        // activateMonthlyFromPayment delegates activation to the panel.
    }

    // Already subscribed → refresh the stored token for free, keep current expiry.
    const activeUntil = PanelQuest.isEnabled()
        ? null
        : await getMonthlySubscriptionRaw(client, userId, accountId);
    if (activeUntil) {
        await activateMonthlySubscription(client, {
            userId,
            accountId,
            token,
            username: resolved.username,
            months: 0,
        });
        return reply("auto.quest.monthly.tokenRefreshed", { ...vars, expiresAt: ms(activeUntil) });
    }

    // Owner/dev → activate 1 month free.
    if (_isStaffFree(client, userId)) {
        const result = await activateMonthlySubscription(client, {
            userId,
            accountId,
            token,
            username: resolved.username,
            months: 1,
        });
        return reply("auto.quest.monthly.staffFree", { ...vars, expiresAt: ms(result.monthlyExpiresAt) });
    }

    // Existing pending monthly payment → show it again.
    const existed = await getOpenMonthlyPayment(client, userId, accountId);
    if (existed) {
        return interaction.editReply(
            monthlyPaymentMessage(
                client,
                {
                    paymentId: existed.paymentId,
                    months: existed.months,
                    amount: existed.amount,
                    transferCode: existed.transferCode,
                    qrUrl: buildVietQrUrl(client, existed.amount, existed.transferCode),
                },
                "existed",
                { accountId, username: resolved.username },
            ),
        );
    }

    // Create a new monthly payment (1 month; buy again to stack more).
    const payment = await createMonthlyPayment(client, {
        userId,
        accountId,
        token,
        username: resolved.username,
        months: 1,
    });
    return interaction.editReply(monthlyPaymentMessage(client, payment, "created", { accountId, username: resolved.username }));
}

// ── UI helpers ─────────────────────────────────────────────────────────────────
/** The token form (template auto.quest.tokenModal); `titleSlot` = titleNew | titleRefresh | titleMonthly. */
function _buildTokenModal(client, customId, titleSlot) {
    const card = client.ui.card("auto.quest.tokenModal");
    return new ModalBuilder()
        .setCustomId(customId)
        .setTitle((card.text(titleSlot) || "Discord token").slice(0, 45))
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("token")
                    .setLabel((card.text("label") || "Discord token").slice(0, 45))
                    .setPlaceholder((card.text("placeholder") || "").slice(0, 100) || " ")
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true),
            ),
        );
}

async function _replyWithQuestSelection(client, interaction, result) {
    const quests = await getSelectableQuests(
        interaction.user.id,
        result.accountId,
    );
    const shown = quests.slice(0, 25).map((q) => ({ id: String(q.id), name: q.name, taskType: q.taskType || "", __text: q.name }));
    const vars = {
        account: accountVars(result.accountId, result.username),
        quests: shown,
        hasQuests: quests.length > 0,
        user: client.ui.user(interaction.user),
    };

    if (!quests.length) return interaction.editReply(client.ui.message("auto.quest.activated", vars));

    const entry = getRunningMap(interaction.user.id).get(result.accountId);
    if (entry) entry.selectionShown = true;

    const sel = client.ui.select("auto.quest.activated", vars);
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`quest:select:${result.accountId}`)
        .setPlaceholder(sel.placeholder("pick"))
        .setMinValues(1)
        .setMaxValues(Math.min(quests.length, 25))
        .addOptions(
            shown.map((q) => {
                const o = sel.option("pick", q);
                return { label: o.label.slice(0, 100), value: q.id, ...(o.description ? { description: o.description } : {}) };
            }),
        );

    return interaction.editReply(client.ui.message("auto.quest.activated", vars, { components: [new ActionRowBuilder().addComponents(menu)] }));
}
