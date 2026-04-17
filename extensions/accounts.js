const { C, DiscordAPI, QuestAutocompleter, fetchLatestBuildNumber } = require("./questCore");
const storage = require("./storage");
const { normalizeDiscordTokenInput, sleep } = require("../bot/utils");

const running = new Map();
const BUILD_CACHE_TTL = 5 * 60_000;
let buildCache = { value: null, fetchedAt: 0 };
let accountNotifier = null;

// ── Build number ───────────────────────────────────────────────────────────────
async function getBuildNumber() {
    if (buildCache.value && Date.now() - buildCache.fetchedAt < BUILD_CACHE_TTL) return buildCache.value;
    const v = await fetchLatestBuildNumber();
    buildCache = { value: v, fetchedAt: Date.now() };
    return v;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function getSupportedTasks() {
    return ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"];
}

function getHelpers() {
    const supportedTasks = getSupportedTasks();
    function getValue(d, ...keys) { if (!d) return undefined; for (const k of keys) if (k in d) return d[k]; return undefined; }
    function getTaskConfig(q) { const c = q.config ?? {}; return getValue(c, "taskConfig", "task_config", "taskConfigV2", "task_config_v2"); }
    function getUserStatus(q) { const us = getValue(q, "userStatus", "user_status"); return us && typeof us === "object" ? us : {}; }
    function getExpiresAt(q) { return getValue(q.config ?? {}, "expiresAt", "expires_at"); }
    function isEnrolled(q) { return Boolean(getValue(getUserStatus(q), "enrolledAt", "enrolled_at")); }
    function isCompleted(q) { return Boolean(getValue(getUserStatus(q), "completedAt", "completed_at")); }
    function isCompletable(q) {
        const exp = getExpiresAt(q);
        if (exp && new Date(exp) <= new Date()) return false;
        const tc = getTaskConfig(q);
        return tc?.tasks && supportedTasks.some((t) => tc.tasks[t] != null);
    }
    function getQuestName(q) {
        const c = q.config ?? {}, m = c.messages ?? {};
        return getValue(m, "questName", "quest_name", "gameTitle", "game_title")?.trim?.() || c.application?.name || `Quest#${q.id ?? "?"}`;
    }
    function getTaskType(q) {
        const tc = getTaskConfig(q);
        return (tc?.tasks && supportedTasks.find((t) => tc.tasks[t] != null)) ?? null;
    }
    return { isEnrolled, isCompleted, isCompletable, getQuestName, getTaskType };
}

// ── Running map ────────────────────────────────────────────────────────────────
function getRunningMap(userId) {
    if (!running.has(userId)) running.set(userId, new Map());
    return running.get(userId);
}

function setAccountNotifier(fn) { accountNotifier = typeof fn === "function" ? fn : null; }

async function notifyAccountEvent(event) {
    if (!accountNotifier) return;
    try { await accountNotifier(event); } catch (e) { console.warn(`[accounts] notify error: ${e.message}`); }
}

// ── Account management ─────────────────────────────────────────────────────────
function isInvalidTokenResult(result) { return result?.ok === false && result.invalidToken === true; }
function isInvalidTokenError(err) {
    if (err?.invalidToken) return true;
    return /401|403|unauthorized/i.test(err?.message ?? "");
}

async function removeDeadAccount(client, userId, accountId, record, source, reason) {
    stopAccount(userId, accountId);
    await storage.markTokenRefreshRequired(client, userId, accountId, record);
    await notifyAccountEvent({ type: "token_dead", userId, accountId, username: record.username, source, reason });
}

function stopAccount(userId, accountId) {
    const userMap = getRunningMap(userId);
    const entry = userMap.get(accountId);
    if (!entry) return false;
    entry.abortController.stopped = true;
    userMap.delete(accountId);
    return true;
}

function stopAllAccounts(userId) {
    const userMap = getRunningMap(userId);
    for (const [, entry] of userMap) entry.abortController.stopped = true;
    userMap.clear();
}

function expireAccount(client, userId, accountId) {
    stopAccount(userId, accountId);
    return removeStoredAccount(client, userId, accountId);
}

async function removeStoredAccount(client, userId, accountId) {
    const data = await storage.loadAccounts(client);
    if (!data[userId]?.[accountId]) return null;
    const removed = data[userId][accountId];
    delete data[userId][accountId];
    if (Object.keys(data[userId]).length === 0) delete data[userId];
    await storage.saveAccounts(client, data);
    return removed;
}

function persistAccountRecord(client, userId, accountId, record) {
    storage.loadAccounts(client).then((data) => {
        if (!data[userId]) data[userId] = {};
        data[userId][accountId] = { ...data[userId][accountId], ...record };
        storage.saveAccounts(client, data);
    });
}

async function setAllowedQuests(client, userId, accountId, questIds) {
    const userMap = getRunningMap(userId);
    const entry = userMap.get(accountId);
    if (!entry) return false;
    entry.allowedQuestIds = new Set((questIds ?? []).map((id) => String(id)).filter(Boolean));
    const selectedIds = [...entry.allowedQuestIds];
    if (selectedIds.length > 0) {
        persistAccountRecord(client, userId, accountId, { token: entry.token, username: entry.username, addedAt: new Date(entry.startedAt).toISOString(), expiresAt: entry.expiresAt, month: entry.month });
    }
    await storage.setStoredSelectedQuestIds(client, userId, accountId, selectedIds);
    entry.wakeRequested = true;
    return true;
}

async function getSelectableQuests(userId, accountId) {
    const entry = getRunningMap(userId).get(accountId);
    if (!entry) return [];
    let quests = await entry.completer.fetchQuests();
    if (!quests.length) return [];
    quests = await entry.completer.autoAccept(quests);
    const helpers = getHelpers();
    return quests
        .filter((q) => helpers.isEnrolled(q) && !helpers.isCompleted(q) && helpers.isCompletable(q))
        .map((q) => ({ id: q.id, name: helpers.getQuestName(q), taskType: helpers.getTaskType(q) }));
}

async function resolveDiscordAccount(token) {
    const normalized = normalizeDiscordTokenInput(token);
    if (!normalized) return { ok: false, invalidToken: false, reason: "Token trống hoặc không hợp lệ." };
    const buildNumber = await getBuildNumber();
    const api = new DiscordAPI(normalized, buildNumber);
    try {
        const res = await api.get("/users/@me");
        if (res.status !== 200) return { ok: false, invalidToken: res.status === 401 || res.status === 403, reason: `Token không hợp lệ (HTTP ${res.status})` };
        return { ok: true, api, buildNumber, accountId: res.data.id, username: res.data.username ?? "Unknown" };
    } catch (err) {
        return { ok: false, invalidToken: false, reason: `Không kết nối được Discord: ${err.message}` };
    }
}

// ── Main run loop ──────────────────────────────────────────────────────────────
async function runLoop(client, userId, accountId, completer, abortController, username) {
    const POLL_SEC = 60;
    while (!abortController.stopped) {
        const entry = getRunningMap(userId).get(accountId);
        if (!entry) break;

        try {
            let quests = await completer.fetchQuests();
            if (quests.length) {
                quests = await completer.autoAccept(quests);
                const helpers = getHelpers();
                const potential = quests.filter((q) => helpers.isEnrolled(q) && !helpers.isCompleted(q) && helpers.isCompletable(q));
                const currentEntry = getRunningMap(userId).get(accountId);
                const requiresSelection = currentEntry?.allowedQuestIds instanceof Set;

                if (requiresSelection && currentEntry.allowedQuestIds.size === 0 && !currentEntry.selectionShown && potential.length) {
                    currentEntry.selectionShown = true;
                    await notifyAccountEvent({ type: "quest_selection", userId, accountId, username, quests: potential.map((q) => ({ id: q.id, name: helpers.getQuestName(q), taskType: helpers.getTaskType(q) })) });
                    continue;
                }

                const actionable = potential.filter((q) => !requiresSelection || currentEntry.allowedQuestIds.has(String(q.id)));

                if (actionable.length) {
                    const questSummaries = actionable.map((q) => ({ id: q.id, name: helpers.getQuestName(q), taskType: helpers.getTaskType(q) }));
                    const sig = actionable.map((q) => String(q.id)).sort().join("|");
                    const prevNotif = await storage.getQuestBatchNotification(client, userId, accountId);
                    const prevIds = prevNotif?.signature?.split("|").filter(Boolean) ?? [];
                    const hasNew = questSummaries.some((q) => !prevIds.includes(String(q.id)));
                    const forceNotify = currentEntry?.forceNotifyNextQuestBatch === true;

                    if (!prevNotif || hasNew || forceNotify) {
                        await storage.setQuestBatchNotification(client, userId, accountId, { signature: sig, status: "started" });
                        await notifyAccountEvent({ type: "quest_batch_started", userId, accountId, username, quests: questSummaries });
                    }
                    if (currentEntry) currentEntry.forceNotifyNextQuestBatch = false;
                }

                const completedNames = [];
                for (const q of actionable) {
                    if (abortController.stopped) break;
                    await completer.processQuest(q);
                    completedNames.push(getHelpers().getQuestName(q));
                    const e2 = getRunningMap(userId).get(accountId);
                    if (e2) {
                        e2.completedCount++;
                        if (e2.allowedQuestIds instanceof Set) {
                            e2.allowedQuestIds.delete(String(q.id));
                            await storage.setStoredSelectedQuestIds(client, userId, accountId, [...e2.allowedQuestIds]);
                        }
                    }
                }

                const e3 = getRunningMap(userId).get(accountId);
                if (actionable.length > 0 && e3 && !e3.abortController.stopped && completedNames.length === actionable.length) {
                    const prevNotif2 = await storage.getQuestBatchNotification(client, userId, accountId);
                    const prevIds2 = prevNotif2?.signature?.split("|").filter(Boolean) ?? [];
                    const curIds = actionable.map((q) => String(q.id)).sort();
                    if (prevNotif2 && prevNotif2.status !== "completed" && curIds.every((id) => prevIds2.includes(id))) {
                        await storage.setQuestBatchNotification(client, userId, accountId, { signature: prevNotif2.signature, status: "completed" });
                        await notifyAccountEvent({ type: "quest_batch_completed", userId, accountId, username, completedQuestNames: completedNames });
                    }
                }

                // Purge when all selected quests done
                const e4 = getRunningMap(userId).get(accountId);
                if (e4?.allowedQuestIds instanceof Set && (e4.allowedQuestIds.size > 0 || e4.completedCount > 0)) {
                    const refreshList = await completer.fetchQuests();
                    const h = getHelpers();
                    const allDone = [...e4.allowedQuestIds].every((qid) => {
                        const q = (Array.isArray(refreshList) ? refreshList : refreshList?.quests ?? []).find((x) => String(x.id) === qid);
                        return !q || h.isCompleted(q);
                    });
                    if (allDone) { expireAccount(client, userId, accountId); break; }
                }
            }
        } catch (err) {
            if (isInvalidTokenError(err)) {
                await removeDeadAccount(client, userId, accountId, entry, "runtime", err.message);
                break;
            }
            console.error(`[${username}] Loop error:`, err.message);
        }

        for (let i = 0; i < POLL_SEC; i++) {
            const e = getRunningMap(userId).get(accountId);
            if (!e || e.abortController.stopped) break;
            if (e.wakeRequested) { e.wakeRequested = false; break; }
            await sleep(1);
        }
    }
    console.log(`${C.YELLOW}[BOT]${C.RESET} Stopped: ${username}`);
}

async function startAccount(client, userId, token, options = {}) {
    const normalized = normalizeDiscordTokenInput(token);
    const resolved = options.resolvedAccount ?? (await resolveDiscordAccount(normalized));
    if (!resolved.ok) return resolved;

    const ownerId = await storage.getStoredAccountOwner(client, resolved.accountId);
    if (ownerId && ownerId !== userId) return { ok: false, reason: "Discord account này đã được gán cho user khác." };

    if (options.rejectDuplicateStoredAccount && await storage.hasStoredAccountEntry(client, userId, resolved.accountId)) {
        return { ok: false, reason: "Account đã có trong dữ liệu. Dùng `/removeaccount` trước khi nhập lại.", duplicateStored: true, accountId: resolved.accountId, username: resolved.username };
    }

    const userMap = getRunningMap(userId);
    if (userMap.has(resolved.accountId)) {
        if (!options.allowRestartIfRunning) return { ok: false, reason: `Account **${resolved.username}** đã đang chạy rồi.` };
        stopAccount(userId, resolved.accountId);
        await sleep(1);
    }

    const storedIds = await storage.getStoredSelectedQuestIds(client, userId, resolved.accountId);
    let allowedQuestIds, selectionShown;
    if (storedIds.length > 0) { allowedQuestIds = new Set(storedIds); selectionShown = true; }
    else if (options.requireQuestSelection) { allowedQuestIds = new Set(); selectionShown = false; }
    else { allowedQuestIds = undefined; selectionShown = false; }

    const abortController = { stopped: false };
    const completer = new QuestAutocompleter(resolved.api);

    userMap.set(resolved.accountId, {
        completer, api: resolved.api, username: resolved.username, token: normalized,
        startedAt: Date.now(), abortController, completedCount: 0,
        expiresAt: null, month: options.month ?? null,
        forceNotifyNextQuestBatch: options.forceNotifyQuestBatch === true,
        allowedQuestIds, selectionShown, wakeRequested: false,
    });

    runLoop(client, userId, resolved.accountId, completer, abortController, resolved.username).catch((e) => {
        console.error(`[${resolved.username}] Loop crash:`, e);
    });

    if (options.notifyStarted) {
        await notifyAccountEvent({ type: "account_started", userId, accountId: resolved.accountId, username: resolved.username, source: options.source ?? "manual" });
    }

    return { ok: true, accountId: resolved.accountId, username: resolved.username, buildNumber: resolved.buildNumber };
}

async function restoreAccounts(client) {
    const data = await storage.loadAccounts(client);
    let total = 0;
    for (const [userId, accounts] of Object.entries(data)) {
        for (const [accountId, record] of Object.entries(accounts)) {
            try {
                const result = await startAccount(client, userId, record.token, { allowRestartIfRunning: false, addedAt: record.addedAt, month: record.month, requireQuestSelection: true });
                if (result.ok) { total++; console.log(`Restored: ${record.username}`); }
                else if (isInvalidTokenResult(result)) {
                    await removeDeadAccount(client, userId, accountId, record, "restore", result.reason);
                }
            } catch (e) { console.warn(`Cannot restore ${record.username}: ${e.message}`); }
        }
    }
    return total;
}

module.exports = {
    getRunningMap, setAccountNotifier, setAllowedQuests, getSelectableQuests,
    resolveDiscordAccount, startAccount, stopAccount, stopAllAccounts,
    expireAccount, removeStoredAccount, restoreAccounts,
};
