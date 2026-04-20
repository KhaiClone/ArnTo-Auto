/**
 * autoQuest.js
 * All Auto Quest logic in one place:
 *  - Discord API + quest autocomplete engine (questCore)
 *  - Account storage with token encryption (storage)
 *  - Account management + run loop (accounts)
 *  - Payment lifecycle + AutoBank integration (payments)
 */

const axios = require("axios");
const { Buffer } = require("buffer");
const {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
} = require("crypto");
const normalizeDiscordTokenInput = require("../functions/normalizeDiscordTokenInput");
const { nanoid } = require("nanoid");

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 1 — DISCORD QUEST ENGINE
// ══════════════════════════════════════════════════════════════════════════════

const AUTO_REMOVE_INACTIVE_MS = 30 * 60 * 1000;
const API_BASE = "https://discord.com/api/v9";
const HEARTBEAT_INTERVAL = 20;
const AUTO_ACCEPT = true;
const SUPPORTED_TASKS = [
    "WATCH_VIDEO",
    "PLAY_ON_DESKTOP",
    "STREAM_ON_DESKTOP",
    "PLAY_ACTIVITY",
    "WATCH_VIDEO_ON_MOBILE",
];
const C = { RESET: "\x1b[0m", YELLOW: "\x1b[93m", BOLD: "\x1b[1m" };

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

function _throwIfUnauthorized(res, ctx) {
    if (
        res?.status === 401 ||
        res?.status === 403 ||
        /unauthorized/i.test(res?.data?.message ?? "")
    ) {
        const e = new Error(`${ctx} (${res?.status ?? 401})`);
        e.invalidToken = true;
        throw e;
    }
}

async function fetchLatestBuildNumber() {
    const FALLBACK = 504649;
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
    try {
        const res = await axios.get("https://discord.com/app", {
            headers: { "User-Agent": ua },
            timeout: 15000,
        });
        if (res.status !== 200) return FALLBACK;
        const hashes = [...res.data.matchAll(/\/assets\/([a-f0-9]+)\.js/g)].map(
            (m) => m[1],
        );
        for (const hash of hashes.slice(-5)) {
            try {
                const ar = await axios.get(
                    `https://discord.com/assets/${hash}.js`,
                    { headers: { "User-Agent": ua }, timeout: 15000 },
                );
                const match = ar.data.match(
                    /buildNumber["'\s:]+["'\s]*(\d{5,7})/,
                );
                if (match) return parseInt(match[1], 10);
            } catch {}
        }
        return FALLBACK;
    } catch {
        return FALLBACK;
    }
}

function _makeSuperProperties(buildNumber) {
    return Buffer.from(
        JSON.stringify({
            os: "Windows",
            browser: "Discord Client",
            release_channel: "stable",
            client_version: "1.0.9175",
            os_version: "10.0.26100",
            os_arch: "x64",
            app_arch: "x64",
            system_locale: "en-US",
            browser_user_agent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9175 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36",
            browser_version: "32.2.7",
            client_build_number: buildNumber,
            native_build_number: 59498,
            client_event_source: null,
        }),
    ).toString("base64");
}

class DiscordAPI {
    constructor(token, buildNumber) {
        this.token = token;
        this.client = axios.create({
            baseURL: API_BASE,
            headers: {
                Authorization: token,
                "Content-Type": "application/json",
                Accept: "*/*",
                "Accept-Language": "en-US,en;q=0.9",
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9175 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36",
                "X-Super-Properties": _makeSuperProperties(buildNumber),
                "X-Discord-Locale": "en-US",
                "X-Discord-Timezone": "Asia/Ho_Chi_Minh",
                Origin: "https://discord.com",
                Referer: "https://discord.com/channels/@me",
            },
        });
    }
    async get(path) {
        return this.client.get(path, { validateStatus: () => true });
    }
    async post(path, payload = null) {
        return this.client.post(path, payload, { validateStatus: () => true });
    }
}

// Quest field helpers
function _getValue(d, ...keys) {
    if (!d) return undefined;
    for (const k of keys) if (k in d) return d[k];
    return undefined;
}
function _getTaskConfig(q) {
    return _getValue(
        q.config ?? {},
        "taskConfig",
        "task_config",
        "taskConfigV2",
        "task_config_v2",
    );
}
function _getUserStatus(q) {
    const us = _getValue(q, "userStatus", "user_status");
    return us && typeof us === "object" ? us : {};
}
function _getExpiresAt(q) {
    return _getValue(q.config ?? {}, "expiresAt", "expires_at");
}
function _isEnrolled(q) {
    return Boolean(_getValue(_getUserStatus(q), "enrolledAt", "enrolled_at"));
}
function _isCompleted(q) {
    return Boolean(_getValue(_getUserStatus(q), "completedAt", "completed_at"));
}
function _isCompletable(q) {
    const exp = _getExpiresAt(q);
    if (exp && new Date(exp) <= new Date()) return false;
    const tc = _getTaskConfig(q);
    return !!(tc?.tasks && SUPPORTED_TASKS.some((t) => tc.tasks[t] != null));
}
function _getQuestName(q) {
    const m = (q.config ?? {}).messages ?? {};
    return (
        _getValue(
            m,
            "questName",
            "quest_name",
            "gameTitle",
            "game_title",
        )?.trim?.() ||
        (q.config ?? {}).application?.name ||
        `Quest#${q.id ?? "?"}`
    );
}
function _getTaskType(q) {
    const tc = _getTaskConfig(q);
    return (
        (tc?.tasks && SUPPORTED_TASKS.find((t) => tc.tasks[t] != null)) ?? null
    );
}
function _getSecondsNeeded(q) {
    const tc = _getTaskConfig(q),
        t = _getTaskType(q);
    return !tc || !t ? 0 : (tc.tasks[t]?.target ?? 0);
}
function _getSecondsDone(q) {
    const t = _getTaskType(q);
    return t ? (_getUserStatus(q).progress?.[t]?.value ?? 0) : 0;
}
function _getEnrolledAt(q) {
    return _getValue(_getUserStatus(q), "enrolledAt", "enrolled_at");
}

class QuestAutocompleter {
    constructor(api) {
        this.api = api;
        this.completedIds = new Set();
        this._cachedChannelId = null;
    }

    async _getValidChannelId() {
        if (this._cachedChannelId) return this._cachedChannelId;
        try {
            const dmRes = await this.api.get("/users/@me/channels");
            if (
                dmRes.status === 200 &&
                Array.isArray(dmRes.data) &&
                dmRes.data.length > 0
            ) {
                this._cachedChannelId = dmRes.data[0].id;
                return this._cachedChannelId;
            }
        } catch {}
        try {
            const guildRes = await this.api.get("/users/@me/guilds");
            if (guildRes.status === 200 && Array.isArray(guildRes.data)) {
                for (const guild of guildRes.data) {
                    try {
                        const chRes = await this.api.get(
                            `/guilds/${guild.id}/channels`,
                        );
                        if (chRes.status === 200 && Array.isArray(chRes.data)) {
                            const vc = chRes.data.find((c) => c.type === 2); // GUILD_VOICE
                            if (vc) {
                                this._cachedChannelId = vc.id;
                                return this._cachedChannelId;
                            }
                        }
                    } catch {}
                }
            }
        } catch {}
        return "1"; // fallback an toàn hơn "0"
    }

    async fetchQuests() {
        try {
            const res = await this.api.get("/quests/@me");
            if (res.status === 200) {
                const d = res.data;
                return Array.isArray(d) ? d : (d?.quests ?? []);
            }
            _throwIfUnauthorized(res, "Lấy danh sách quest thất bại");
            if (res.status === 429) {
                await sleep(res.data?.retry_after ?? 10);
                return this.fetchQuests();
            }
            return [];
        } catch (err) {
            if (err?.invalidToken) throw err;
            return [];
        }
    }

    async autoAccept(quests) {
        if (!AUTO_ACCEPT) return quests;
        const unaccepted = quests.filter(
            (q) => !_isEnrolled(q) && !_isCompleted(q) && _isCompletable(q),
        );
        if (!unaccepted.length) return quests;
        for (const q of unaccepted) {
            try {
                for (let i = 1; i <= 3; i++) {
                    const res = await this.api.post(
                        `/quests/${q.id}/enroll`,
                        {},
                    );

                    _throwIfUnauthorized(res, "Enroll quest thất bại");
                    if (res.status === 429) {
                        await sleep((res.data?.retry_after ?? 5) + 1);
                        continue;
                    }
                    if ([200, 201, 204].includes(res.status)) break;
                }
            } catch (err) {
                if (err?.invalidToken) throw err;
            }
            await sleep(3);
        }
        await sleep(2);
        return this.fetchQuests();
    }

    async processQuest(quest) {
        const taskType = _getTaskType(quest);
        if (!taskType || this.completedIds.has(quest.id)) return;
        if (["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE"].includes(taskType))
            await this._completeVideo(quest);
        else if (["PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP"].includes(taskType))
            await this._completeHeartbeat(quest);
        else if (taskType === "PLAY_ACTIVITY")
            await this._completeActivity(quest);
        this.completedIds.add(quest.id);
    }

    async _completeVideo(quest) {
        const qid = quest.id,
            needed = _getSecondsNeeded(quest);
        let done = _getSecondsDone(quest);
        const enrolledTs =
            (_getEnrolledAt(quest)
                ? new Date(_getEnrolledAt(quest)).getTime()
                : Date.now()) / 1000;
        while (done < needed) {
            const maxAllowed = Date.now() / 1000 - enrolledTs + 10;
            if (maxAllowed - done >= 7) {
                try {
                    const res = await this.api.post(
                        `/quests/${qid}/video-progress`,
                        {
                            timestamp: Math.min(
                                needed,
                                done + 7 + Math.random(),
                            ),
                        },
                    );
                    _throwIfUnauthorized(res, "Video progress thất bại");
                    if (res.status === 200) {
                        if (res.data.completed_at) return;
                        done = Math.min(needed, done + 7);
                    } else if (res.status === 429) {
                        await sleep((res.data?.retry_after ?? 5) + 1);
                        continue;
                    }
                } catch (err) {
                    if (err?.invalidToken) throw err;
                }
            }
            if (done + 7 >= needed) break;
            await sleep(1);
        }
        try {
            const res = await this.api.post(`/quests/${qid}/video-progress`, {
                timestamp: needed,
            });
            _throwIfUnauthorized(res, "Video finish thất bại");
        } catch (err) {
            if (err?.invalidToken) throw err;
        }
    }

    async _completeHeartbeat(quest) {
        const qid = quest.id,
            taskType = _getTaskType(quest),
            needed = _getSecondsNeeded(quest);
        let done = _getSecondsDone(quest);
        const channelId = await this._getValidChannelId();
        const streamKey = `call:${channelId}:1`;
        while (done < needed) {
            try {
                const res = await this.api.post(`/quests/${qid}/heartbeat`, {
                    stream_key: streamKey,
                    terminal: false,
                });
                _throwIfUnauthorized(res, "Heartbeat thất bại");
                if (res.status === 200) {
                    done = res.data.progress?.[taskType]?.value ?? done;
                    if (res.data.completed_at || done >= needed) break;
                } else if (res.status === 429) {
                    await sleep((res.data?.retry_after ?? 10) + 1);
                    continue;
                }
            } catch (err) {
                if (err?.invalidToken) throw err;
            }
            await sleep(HEARTBEAT_INTERVAL);
        }
        try {
            const res = await this.api.post(`/quests/${qid}/heartbeat`, {
                stream_key: streamKey,
                terminal: true,
            });
            _throwIfUnauthorized(res, "Heartbeat terminal thất bại");
        } catch (err) {
            if (err?.invalidToken) throw err;
        }
    }

    async _completeActivity(quest) {
        const qid = quest.id,
            needed = _getSecondsNeeded(quest);
        let done = _getSecondsDone(quest);
        const channelId = await this._getValidChannelId();
        const streamKey = `call:${channelId}:1`;
        while (done < needed) {
            try {
                const res = await this.api.post(`/quests/${qid}/heartbeat`, {
                    stream_key: streamKey,
                    terminal: false,
                });
                _throwIfUnauthorized(res, "Activity heartbeat thất bại");
                if (res.status === 200) {
                    done = res.data.progress?.PLAY_ACTIVITY?.value ?? done;
                    if (res.data.completed_at || done >= needed) break;
                } else if (res.status === 429) {
                    await sleep((res.data?.retry_after ?? 10) + 1);
                    continue;
                }
            } catch (err) {
                if (err?.invalidToken) throw err;
            }
            await sleep(HEARTBEAT_INTERVAL);
        }
        try {
            const res = await this.api.post(`/quests/${qid}/heartbeat`, {
                stream_key: streamKey,
                terminal: true,
            });
            _throwIfUnauthorized(res, "Activity terminal thất bại");
        } catch (err) {
            if (err?.invalidToken) throw err;
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 2 — ACCOUNT STORAGE (token encryption + DB read/write)
// ══════════════════════════════════════════════════════════════════════════════

const TOKEN_ALGORITHM = "aes-256-gcm";
const TOKEN_IV_BYTES = 12;
const ACCOUNTS_DB = "accounts";

function _getTokenKey(secret) {
    return createHash("sha256").update(secret).digest();
}
function _hashToken(token) {
    return createHash("sha256").update(token).digest("hex");
}
function _hasEncryptedToken(r) {
    return (
        typeof r?.tokenEncrypted === "string" &&
        typeof r?.tokenIv === "string" &&
        typeof r?.tokenTag === "string"
    );
}

function _encryptToken(token, secret) {
    const iv = randomBytes(TOKEN_IV_BYTES);
    const cipher = createCipheriv(TOKEN_ALGORITHM, _getTokenKey(secret), iv);
    const encrypted = Buffer.concat([
        cipher.update(token, "utf8"),
        cipher.final(),
    ]);
    return {
        tokenEncrypted: encrypted.toString("base64"),
        tokenIv: iv.toString("base64"),
        tokenTag: cipher.getAuthTag().toString("base64"),
        tokenHash: _hashToken(token),
    };
}

function _decryptToken(record, secret) {
    if (typeof record?.token === "string" && record.token.trim())
        return record.token.trim();
    if (!_hasEncryptedToken(record)) return null;
    try {
        const d = createDecipheriv(
            TOKEN_ALGORITHM,
            _getTokenKey(secret),
            Buffer.from(record.tokenIv, "base64"),
        );
        d.setAuthTag(Buffer.from(record.tokenTag, "base64"));
        return Buffer.concat([
            d.update(Buffer.from(record.tokenEncrypted, "base64")),
            d.final(),
        ]).toString("utf8");
    } catch {
        return null;
    }
}

function _normalizeQuestBatch(record) {
    const n = record?.questBatchNotification;
    if (!n || typeof n !== "object" || Array.isArray(n)) return null;
    const signature =
        typeof n.signature === "string" && n.signature ? n.signature : null;
    const status =
        n.status === "started" || n.status === "completed" ? n.status : null;
    return signature && status ? { signature, status } : null;
}

function _normalizeOrderLogPending(record) {
    const p = record?.orderLogPending;
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    const messageId =
        typeof p.messageId === "string" && p.messageId.trim()
            ? p.messageId.trim()
            : null;
    return messageId
        ? {
              messageId,
              footerText: typeof p.footerText === "string" ? p.footerText : "",
          }
        : null;
}

function _normalizeSelectedQuestIds(record) {
    const raw = record?.selectedQuestIds;
    return Array.isArray(raw)
        ? [...new Set(raw.map((id) => String(id)).filter(Boolean))]
        : [];
}

function _buildSecureRecord(record, token, secret) {
    const secureToken =
        _hasEncryptedToken(record) && !record.token
            ? {
                  tokenEncrypted: record.tokenEncrypted,
                  tokenIv: record.tokenIv,
                  tokenTag: record.tokenTag,
                  tokenHash:
                      typeof record.tokenHash === "string"
                          ? record.tokenHash
                          : _hashToken(token),
              }
            : _encryptToken(token, secret);
    return {
        ...secureToken,
        username:
            typeof record.username === "string" && record.username
                ? record.username
                : "Unknown",
        addedAt:
            typeof record.addedAt === "string"
                ? record.addedAt
                : new Date().toISOString(),
        expiresAt:
            typeof record.expiresAt === "string" ? record.expiresAt : null,
        month:
            Number.isInteger(record.month) && record.month > 0
                ? record.month
                : null,
        questBatchNotification: _normalizeQuestBatch(record),
        orderLogPending: _normalizeOrderLogPending(record),
        selectedQuestIds: _normalizeSelectedQuestIds(record),
    };
}

function _buildRefreshRecord(record) {
    return {
        username:
            typeof record.username === "string" && record.username
                ? record.username
                : "Unknown",
        addedAt:
            typeof record.addedAt === "string"
                ? record.addedAt
                : new Date().toISOString(),
        expiresAt:
            typeof record.expiresAt === "string" ? record.expiresAt : null,
        month:
            Number.isInteger(record.month) && record.month > 0
                ? record.month
                : null,
        needsTokenRefresh: true,
        questBatchNotification: _normalizeQuestBatch(record),
        orderLogPending: _normalizeOrderLogPending(record),
        selectedQuestIds: _normalizeSelectedQuestIds(record),
    };
}

function _hasRefreshFlag(r) {
    return r?.needsTokenRefresh === true;
}

async function _readAccounts(client) {
    return (await client.db.get(ACCOUNTS_DB)) ?? {};
}
async function _writeAccounts(client, data) {
    await client.db.set(ACCOUNTS_DB, data);
}

async function loadAccounts(client) {
    const secret = client.configs.settings.token;
    const rawData = await _readAccounts(client);
    const normalized = {},
        persistent = {};
    let changed = false;

    for (const [userId, accounts] of Object.entries(rawData)) {
        if (
            !accounts ||
            typeof accounts !== "object" ||
            Array.isArray(accounts)
        ) {
            changed = true;
            continue;
        }
        for (const [accountId, record] of Object.entries(accounts)) {
            if (
                !record ||
                typeof record !== "object" ||
                Array.isArray(record)
            ) {
                changed = true;
                continue;
            }
            const token = _decryptToken(record, secret);
            if (!token) {
                if (!persistent[userId]) persistent[userId] = {};
                persistent[userId][accountId] = _hasRefreshFlag(record)
                    ? _buildRefreshRecord(record)
                    : record;
                continue;
            }
            if (!normalized[userId]) normalized[userId] = {};
            normalized[userId][accountId] = {
                token,
                username:
                    typeof record.username === "string" && record.username
                        ? record.username
                        : "Unknown",
                addedAt:
                    typeof record.addedAt === "string"
                        ? record.addedAt
                        : new Date().toISOString(),
                expiresAt:
                    typeof record.expiresAt === "string"
                        ? record.expiresAt
                        : null,
                month:
                    Number.isInteger(record.month) && record.month > 0
                        ? record.month
                        : null,
                questBatchNotification: _normalizeQuestBatch(record),
                orderLogPending: _normalizeOrderLogPending(record),
                selectedQuestIds: _normalizeSelectedQuestIds(record),
            };
            if (!persistent[userId]) persistent[userId] = {};
            persistent[userId][accountId] = _buildSecureRecord(
                record,
                token,
                secret,
            );
            if (
                typeof record.token === "string" ||
                !_hasEncryptedToken(record) ||
                _hasRefreshFlag(record)
            )
                changed = true;
        }
    }
    if (changed) await _writeAccounts(client, persistent);
    return normalized;
}

async function saveAccounts(client, data) {
    const secret = client.configs.settings.token;
    const rawData = await _readAccounts(client);
    const persistent = {};
    for (const [userId, accounts] of Object.entries(data ?? {})) {
        if (
            !accounts ||
            typeof accounts !== "object" ||
            Array.isArray(accounts)
        )
            continue;
        for (const [accountId, record] of Object.entries(accounts)) {
            if (!record || typeof record !== "object" || Array.isArray(record))
                continue;
            const token =
                _decryptToken(record, secret) ??
                (typeof record.token === "string" ? record.token.trim() : "");
            if (!token) continue;
            if (!persistent[userId]) persistent[userId] = {};
            persistent[userId][accountId] = _buildSecureRecord(
                record,
                token,
                secret,
            );
        }
    }
    for (const [userId, accounts] of Object.entries(rawData)) {
        if (
            !accounts ||
            typeof accounts !== "object" ||
            Array.isArray(accounts)
        )
            continue;
        for (const [accountId, record] of Object.entries(accounts)) {
            if (!record || typeof record !== "object" || Array.isArray(record))
                continue;
            if (_decryptToken(record, secret) || !_hasRefreshFlag(record))
                continue;
            if (!persistent[userId]) persistent[userId] = {};
            if (!persistent[userId][accountId])
                persistent[userId][accountId] = _buildRefreshRecord(record);
        }
    }
    await _writeAccounts(client, persistent);
}

async function getTokenRefreshRecord(client, userId) {
    const rawData = await _readAccounts(client);
    const userRecords = rawData[userId];
    if (
        !userRecords ||
        typeof userRecords !== "object" ||
        Array.isArray(userRecords)
    )
        return null;
    const candidates = Object.entries(userRecords)
        .filter(
            ([, r]) =>
                r &&
                typeof r === "object" &&
                !Array.isArray(r) &&
                _hasRefreshFlag(r),
        )
        .sort(
            (a, b) =>
                new Date(b[1].addedAt ?? 0).getTime() -
                new Date(a[1].addedAt ?? 0).getTime(),
        );
    if (!candidates[0]) return null;
    return {
        accountId: candidates[0][0],
        ..._buildRefreshRecord(candidates[0][1]),
    };
}

async function markTokenRefreshRequired(
    client,
    userId,
    accountId,
    record = {},
) {
    const rawData = await _readAccounts(client);
    if (!rawData[userId]) rawData[userId] = {};
    rawData[userId][accountId] = _buildRefreshRecord({
        ...(rawData[userId]?.[accountId] ?? {}),
        ...record,
    });
    await _writeAccounts(client, rawData);
    return { accountId, ...rawData[userId][accountId] };
}

async function getStoredAccountOwner(client, accountId) {
    const rawData = await _readAccounts(client);
    for (const [userId, accounts] of Object.entries(rawData)) {
        if (
            accounts &&
            typeof accounts === "object" &&
            !Array.isArray(accounts) &&
            accounts[accountId]
        )
            return userId;
    }
    return null;
}

async function hasStoredAccountEntry(client, userId, accountId) {
    const rawData = await _readAccounts(client);
    const r = rawData[userId]?.[accountId];
    return Boolean(r && typeof r === "object" && !Array.isArray(r));
}

async function getQuestBatchNotification(client, userId, accountId) {
    const rawData = await _readAccounts(client);
    const r = rawData[userId]?.[accountId];
    return r && typeof r === "object" ? _normalizeQuestBatch(r) : null;
}

async function setQuestBatchNotification(
    client,
    userId,
    accountId,
    notification,
) {
    const rawData = await _readAccounts(client);
    const r = rawData[userId]?.[accountId];
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    rawData[userId][accountId] = {
        ...r,
        questBatchNotification: _normalizeQuestBatch({
            questBatchNotification: notification,
        }),
    };
    await _writeAccounts(client, rawData);
}

async function getOrderLogPending(client, userId, accountId) {
    const rawData = await _readAccounts(client);
    const r = rawData[userId]?.[accountId];
    return r && typeof r === "object" ? _normalizeOrderLogPending(r) : null;
}

async function setOrderLogPending(client, userId, accountId, pending) {
    const rawData = await _readAccounts(client);
    const r = rawData[userId]?.[accountId];
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    rawData[userId][accountId] = {
        ...r,
        orderLogPending:
            pending == null
                ? null
                : _normalizeOrderLogPending({ orderLogPending: pending }),
    };
    await _writeAccounts(client, rawData);
}

async function getStoredSelectedQuestIds(client, userId, accountId) {
    const rawData = await _readAccounts(client);
    const r = rawData[userId]?.[accountId];
    return r && typeof r === "object" ? _normalizeSelectedQuestIds(r) : [];
}

async function setStoredSelectedQuestIds(client, userId, accountId, ids) {
    const rawData = await _readAccounts(client);
    const r = rawData[userId]?.[accountId];
    if (!r || typeof r !== "object" || Array.isArray(r)) return;
    rawData[userId][accountId] = {
        ...r,
        selectedQuestIds: [
            ...new Set((ids ?? []).map((id) => String(id)).filter(Boolean)),
        ],
    };
    await _writeAccounts(client, rawData);
}

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 3 — ACCOUNT MANAGEMENT + RUN LOOP
// ══════════════════════════════════════════════════════════════════════════════

const running = new Map();
const BUILD_CACHE_TTL = 5 * 60_000;
let buildCache = { value: null, fetchedAt: 0 };
let accountNotifier = null;

async function _getBuildNumber() {
    if (buildCache.value && Date.now() - buildCache.fetchedAt < BUILD_CACHE_TTL)
        return buildCache.value;
    const v = await fetchLatestBuildNumber();
    buildCache = { value: v, fetchedAt: Date.now() };
    return v;
}

function getRunningMap(userId) {
    if (!running.has(userId)) running.set(userId, new Map());
    return running.get(userId);
}

function setAccountNotifier(fn) {
    accountNotifier = typeof fn === "function" ? fn : null;
}

async function _notifyAccount(event) {
    if (!accountNotifier) return;
    try {
        await accountNotifier(event);
    } catch (e) {
        console.warn(`[autoQuest] notify error: ${e.message}`);
    }
}

function _isInvalidTokenResult(result) {
    return result?.ok === false && result.invalidToken === true;
}
function _isInvalidTokenError(err) {
    return (
        err?.invalidToken || /401|403|unauthorized/i.test(err?.message ?? "")
    );
}

async function _removeDeadAccount(
    client,
    userId,
    accountId,
    record,
    source,
    reason,
) {
    stopAccount(userId, accountId);
    await markTokenRefreshRequired(client, userId, accountId, record);
    await _notifyAccount({
        type: "token_dead",
        userId,
        accountId,
        username: record.username,
        source,
        reason,
    });
}

function stopAccount(userId, accountId) {
    const entry = getRunningMap(userId).get(accountId);
    if (!entry) return false;
    entry.abortController.stopped = true;
    getRunningMap(userId).delete(accountId);
    return true;
}

function stopAllAccounts(userId) {
    const userMap = getRunningMap(userId);
    for (const [, entry] of userMap) entry.abortController.stopped = true;
    userMap.clear();
}

async function removeStoredAccount(client, userId, accountId) {
    const data = await loadAccounts(client);
    if (!data[userId]?.[accountId]) return null;
    const removed = data[userId][accountId];
    delete data[userId][accountId];
    if (Object.keys(data[userId]).length === 0) delete data[userId];
    await saveAccounts(client, data);
    return removed;
}

function _expireAccount(client, userId, accountId) {
    stopAccount(userId, accountId);
    return removeStoredAccount(client, userId, accountId);
}

function _persistAccountRecord(client, userId, accountId, record) {
    loadAccounts(client).then((data) => {
        if (!data[userId]) data[userId] = {};
        data[userId][accountId] = { ...data[userId][accountId], ...record };
        saveAccounts(client, data);
    });
}

async function setAllowedQuests(client, userId, accountId, questIds) {
    const entry = getRunningMap(userId).get(accountId);
    if (!entry) return false;
    entry.allowedQuestIds = new Set(
        (questIds ?? []).map((id) => String(id)).filter(Boolean),
    );
    const selectedIds = [...entry.allowedQuestIds];
    if (selectedIds.length > 0) {
        _persistAccountRecord(client, userId, accountId, {
            token: entry.token,
            username: entry.username,
            addedAt: new Date(entry.startedAt).toISOString(),
            expiresAt: entry.expiresAt,
            month: entry.month,
        });
    }
    await setStoredSelectedQuestIds(client, userId, accountId, selectedIds);
    entry.wakeRequested = true;
    return true;
}

async function getSelectableQuests(userId, accountId) {
    const entry = getRunningMap(userId).get(accountId);
    if (!entry) return [];
    let quests = await entry.completer.fetchQuests();
    if (!quests.length) return [];
    quests = await entry.completer.autoAccept(quests);
    return quests
        .filter((q) => _isEnrolled(q) && !_isCompleted(q) && _isCompletable(q))
        .map((q) => ({
            id: q.id,
            name: _getQuestName(q),
            taskType: _getTaskType(q),
        }));
}

async function resolveDiscordAccount(token) {
    const normalized = normalizeDiscordTokenInput(token);
    if (!normalized)
        return {
            ok: false,
            invalidToken: false,
            reason: "Token trống hoặc không hợp lệ.",
        };
    const buildNumber = await _getBuildNumber();
    const api = new DiscordAPI(normalized, buildNumber);
    try {
        const res = await api.get("/users/@me");
        if (res.status !== 200)
            return {
                ok: false,
                invalidToken: res.status === 401 || res.status === 403,
                reason: `Token không hợp lệ (HTTP ${res.status})`,
            };
        return {
            ok: true,
            api,
            buildNumber,
            accountId: res.data.id,
            username: res.data.username ?? "Unknown",
        };
    } catch (err) {
        return {
            ok: false,
            invalidToken: false,
            reason: `Không kết nối được Discord: ${err.message}`,
        };
    }
}

async function _runLoop(
    client,
    userId,
    accountId,
    completer,
    abortController,
    username,
) {
    const POLL_SEC = 60;
    while (!abortController.stopped) {
        const entry = getRunningMap(userId).get(accountId);
        if (!entry) break;
        try {
            let quests = await completer.fetchQuests();
            if (quests.length) {
                quests = await completer.autoAccept(quests);
                const potential = quests.filter(
                    (q) =>
                        _isEnrolled(q) && !_isCompleted(q) && _isCompletable(q),
                );
                const currentEntry = getRunningMap(userId).get(accountId);
                const requiresSelection =
                    currentEntry?.allowedQuestIds instanceof Set;

                if (
                    requiresSelection &&
                    currentEntry.allowedQuestIds.size === 0 &&
                    !currentEntry.selectionShown &&
                    potential.length
                ) {
                    currentEntry.selectionShown = true;
                    await _notifyAccount({
                        type: "quest_selection",
                        userId,
                        accountId,
                        username,
                        quests: potential.map((q) => ({
                            id: q.id,
                            name: _getQuestName(q),
                            taskType: _getTaskType(q),
                        })),
                    });
                    continue;
                }

                const actionable = potential.filter(
                    (q) =>
                        !requiresSelection ||
                        currentEntry.allowedQuestIds.has(String(q.id)),
                );

                if (actionable.length) {
                    const summaries = actionable.map((q) => ({
                        id: q.id,
                        name: _getQuestName(q),
                        taskType: _getTaskType(q),
                    }));
                    const sig = actionable
                        .map((q) => String(q.id))
                        .sort()
                        .join("|");
                    const prevNotif = await getQuestBatchNotification(
                        client,
                        userId,
                        accountId,
                    );
                    const prevIds =
                        prevNotif?.signature?.split("|").filter(Boolean) ?? [];
                    if (
                        !prevNotif ||
                        summaries.some(
                            (q) => !prevIds.includes(String(q.id)),
                        ) ||
                        currentEntry?.forceNotifyNextQuestBatch
                    ) {
                        await setQuestBatchNotification(
                            client,
                            userId,
                            accountId,
                            { signature: sig, status: "started" },
                        );
                        await _notifyAccount({
                            type: "quest_batch_started",
                            userId,
                            accountId,
                            username,
                            quests: summaries,
                        });
                    }
                    if (currentEntry)
                        currentEntry.forceNotifyNextQuestBatch = false;
                }

                const completedNames = [];
                for (const q of actionable) {
                    if (abortController.stopped) break;
                    await completer.processQuest(q);
                    completedNames.push(_getQuestName(q));
                    const e2 = getRunningMap(userId).get(accountId);
                    if (e2) {
                        e2.completedCount++;
                        if (e2.allowedQuestIds instanceof Set) {
                            e2.allowedQuestIds.delete(String(q.id));
                            await setStoredSelectedQuestIds(
                                client,
                                userId,
                                accountId,
                                [...e2.allowedQuestIds],
                            );
                        }
                    }
                }

                const e3 = getRunningMap(userId).get(accountId);
                if (
                    actionable.length > 0 &&
                    e3 &&
                    !e3.abortController.stopped &&
                    completedNames.length === actionable.length
                ) {
                    const prevNotif2 = await getQuestBatchNotification(
                        client,
                        userId,
                        accountId,
                    );
                    const prevIds2 =
                        prevNotif2?.signature?.split("|").filter(Boolean) ?? [];
                    const curIds = actionable.map((q) => String(q.id)).sort();
                    if (
                        prevNotif2 &&
                        prevNotif2.status !== "completed" &&
                        curIds.every((id) => prevIds2.includes(id))
                    ) {
                        await setQuestBatchNotification(
                            client,
                            userId,
                            accountId,
                            {
                                signature: prevNotif2.signature,
                                status: "completed",
                            },
                        );
                        await _notifyAccount({
                            type: "quest_batch_completed",
                            userId,
                            accountId,
                            username,
                            completedQuestNames: completedNames,
                        });
                    }
                }

                // Purge when all selected quests are done on Discord
                const e4 = getRunningMap(userId).get(accountId);
                if (
                    e4?.allowedQuestIds instanceof Set &&
                    (e4.allowedQuestIds.size > 0 || e4.completedCount > 0)
                ) {
                    const refreshList = await completer.fetchQuests();
                    const allDone = [...e4.allowedQuestIds].every((qid) => {
                        const q = (
                            Array.isArray(refreshList)
                                ? refreshList
                                : (refreshList?.quests ?? [])
                        ).find((x) => String(x.id) === qid);
                        return !q || _isCompleted(q);
                    });
                    if (allDone) {
                        _expireAccount(client, userId, accountId);
                        break;
                    }
                }
            }
        } catch (err) {
            if (_isInvalidTokenError(err)) {
                await _removeDeadAccount(
                    client,
                    userId,
                    accountId,
                    entry,
                    "runtime",
                    err.message,
                );
                break;
            }
            console.error(`[${username}] Loop error:`, err.message);
        }
        for (let i = 0; i < POLL_SEC; i++) {
            const e = getRunningMap(userId).get(accountId);
            if (!e || e.abortController.stopped) break;
            if (e.wakeRequested) {
                e.wakeRequested = false;
                break;
            }
            await sleep(1);
        }
    }
}

async function startAccount(client, userId, token, options = {}) {
    const normalized = normalizeDiscordTokenInput(token);
    const resolved =
        options.resolvedAccount ?? (await resolveDiscordAccount(normalized));
    if (!resolved.ok) return resolved;

    const ownerId = await getStoredAccountOwner(client, resolved.accountId);
    if (ownerId && ownerId !== userId)
        return {
            ok: false,
            reason: "Discord account này đã được gán cho user khác.",
        };

    if (
        options.rejectDuplicateStoredAccount &&
        (await hasStoredAccountEntry(client, userId, resolved.accountId))
    ) {
        return {
            ok: false,
            reason: "Account đã có trong dữ liệu. Dùng `/removeaccount` trước khi nhập lại.",
            duplicateStored: true,
            accountId: resolved.accountId,
            username: resolved.username,
        };
    }

    const userMap = getRunningMap(userId);
    if (userMap.has(resolved.accountId)) {
        if (!options.allowRestartIfRunning)
            return {
                ok: false,
                reason: `Account **${resolved.username}** đã đang chạy rồi.`,
            };
        stopAccount(userId, resolved.accountId);
        await sleep(1);
    }

    // Use _storedSelectedQuestIds from options (passed by restoreAccounts) or load from DB
    const storedIds =
        options._storedSelectedQuestIds ??
        (await getStoredSelectedQuestIds(client, userId, resolved.accountId));
    let allowedQuestIds, selectionShown;
    if (storedIds.length > 0) {
        allowedQuestIds = new Set(storedIds);
        selectionShown = true;
    } else if (options.requireQuestSelection) {
        allowedQuestIds = new Set();
        selectionShown = false;
    } else {
        allowedQuestIds = undefined;
        selectionShown = false;
    }

    const abortController = { stopped: false };
    const completer = new QuestAutocompleter(resolved.api);
    userMap.set(resolved.accountId, {
        completer,
        api: resolved.api,
        username: resolved.username,
        token: normalized,
        startedAt: Date.now(),
        abortController,
        completedCount: 0,
        expiresAt: null,
        month: options.month ?? null,
        forceNotifyNextQuestBatch: options.forceNotifyQuestBatch === true,
        allowedQuestIds,
        selectionShown,
        wakeRequested: false,
    });
    setTimeout(async () => {
        const currentEntry = getRunningMap(userId).get(resolved.accountId);
        if (!currentEntry) return; // already removed

        const neverPaid =
            currentEntry.completedCount === 0 &&
            currentEntry.allowedQuestIds instanceof Set &&
            currentEntry.allowedQuestIds.size === 0;

        if (neverPaid) {
            console.log(
                `[AutoQuest] Auto-removing inactive account: ${resolved.username} (${resolved.accountId})`,
            );
            await _expireAccount(client, userId, resolved.accountId);
        }
    }, AUTO_REMOVE_INACTIVE_MS);

    _runLoop(
        client,
        userId,
        resolved.accountId,
        completer,
        abortController,
        resolved.username,
    ).catch((e) => console.error(`[${resolved.username}] Loop crash:`, e));

    if (options.notifyStarted) {
        await _notifyAccount({
            type: "account_started",
            userId,
            accountId: resolved.accountId,
            username: resolved.username,
            source: options.source ?? "manual",
        });
    }
    return {
        ok: true,
        accountId: resolved.accountId,
        username: resolved.username,
        buildNumber: resolved.buildNumber,
    };
}

async function restoreAccounts(client) {
    const data = await loadAccounts(client);
    let total = 0;
    for (const [userId, accounts] of Object.entries(data)) {
        for (const [accountId, record] of Object.entries(accounts)) {
            try {
                const result = await startAccount(
                    client,
                    userId,
                    record.token,
                    {
                        allowRestartIfRunning: false,
                        addedAt: record.addedAt,
                        month: record.month,
                        requireQuestSelection: true,
                        // Pass stored selected quest IDs so run loop resumes immediately
                        // without waiting for user to re-select quests
                        _storedSelectedQuestIds: record.selectedQuestIds ?? [],
                    },
                );
                if (result.ok) {
                    total++;
                    // If account had selected quests stored, wake the loop immediately
                    if ((record.selectedQuestIds ?? []).length > 0) {
                        const entry = getRunningMap(userId).get(
                            result.accountId,
                        );
                        if (entry) entry.wakeRequested = true;
                    }
                } else if (_isInvalidTokenResult(result))
                    await _removeDeadAccount(
                        client,
                        userId,
                        accountId,
                        record,
                        "restore",
                        result.reason,
                    );
            } catch (e) {
                console.warn(`Cannot restore ${record.username}: ${e.message}`);
            }
        }
    }
    return total;
}

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 4 — PAYMENT LIFECYCLE + AUTOBANK INTEGRATION
// ══════════════════════════════════════════════════════════════════════════════

const PAYMENT_EXPIRE_MS = 10 * 60_000;
const PAYMENTS_DB = "quest_payments";
const ACTIVATIONS_DB = "quest_pending_activations";

function _now() {
    return Date.now();
}
function _newPaymentId() {
    return `QP${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
function _randomTransferCode() {
    return `${nanoid(8).replaceAll("-", "").replaceAll("_", "")} Chuyen tien`;
}

function _encryptActivationToken(token, secret) {
    const iv = randomBytes(TOKEN_IV_BYTES);
    const cipher = createCipheriv(TOKEN_ALGORITHM, _getTokenKey(secret), iv);
    const encrypted = Buffer.concat([
        cipher.update(token, "utf8"),
        cipher.final(),
    ]);
    return {
        tokenEncrypted: encrypted.toString("base64"),
        tokenIv: iv.toString("base64"),
        tokenTag: cipher.getAuthTag().toString("base64"),
    };
}

function _decryptActivationToken(record, secret) {
    if (!record?.tokenEncrypted || !record?.tokenIv || !record?.tokenTag)
        return null;
    try {
        const d = createDecipheriv(
            TOKEN_ALGORITHM,
            _getTokenKey(secret),
            Buffer.from(record.tokenIv, "base64"),
        );
        d.setAuthTag(Buffer.from(record.tokenTag, "base64"));
        return Buffer.concat([
            d.update(Buffer.from(record.tokenEncrypted, "base64")),
            d.final(),
        ]).toString("utf8");
    } catch {
        return null;
    }
}

async function _readPayments(client) {
    return (await client.db.get(PAYMENTS_DB)) ?? [];
}
async function _savePayments(client, list) {
    await client.db.set(PAYMENTS_DB, list);
}
async function _readActivations(client) {
    return (await client.db.get(ACTIVATIONS_DB)) ?? [];
}
async function _saveActivations(client, list) {
    await client.db.set(ACTIVATIONS_DB, list);
}

async function _generateUniqueTransferCode(client) {
    const list = await _readPayments(client);
    const active = new Set(
        list
            .filter(
                (i) => i.status === "pending" && Number(i.expiresAt) > _now(),
            )
            .map((i) => i.transferCode),
    );
    for (let i = 0; i < 100; i++) {
        const code = _randomTransferCode();
        if (!active.has(code)) return code;
    }
    return `${nanoid(8).replaceAll("-", "").replaceAll("_", "")} Chuyen tien`;
}

function buildVietQrUrl(client, amount, transferCode) {
    const s = client.configs.settings;
    return `https://img.vietqr.io/image/${s.bankCode}-${s.bankAccount}-qr_only.png?addInfo=${encodeURIComponent(transferCode)}&accountName=${encodeURIComponent(s.bankHolder)}&amount=${amount}`;
}

async function createQuestPayment(client, { userId, accountId, questIds }) {
    const selectedQuestIds = [
        ...new Set((questIds ?? []).map((id) => String(id)).filter(Boolean)),
    ];
    const amount =
        selectedQuestIds.length * client.configs.settings.questPricePerItem;
    const transferCode = await _generateUniqueTransferCode(client);

    const payment = {
        id: _newPaymentId(),
        type: "quest",
        userId,
        accountId,
        selectedQuestIds,
        amount,
        transferCode,
        status: "pending",
        createdAt: _now(),
        expiresAt: _now() + PAYMENT_EXPIRE_MS,
        paidAt: null,
    };

    const list = await _readPayments(client);
    list.push(payment);
    await _savePayments(client, list);

    // Register with AutoBank — transferCode is the customId because it's what appears in the VietQR webhook message
    if (client.autoBank) {
        const context = {
            _handler: "quest_payment",
            paymentId: payment.id,
            userId,
            accountId,
            transferCode,
        };

        client.autoBank.createQR(amount, transferCode, context, async (err) => {
            if (err) {
                // Timeout — payment expired without being paid; update order log
                const {
                    cancelOrderLog,
                } = require("../functions/autoQuestHelpers");
                await cancelOrderLog(
                    client,
                    userId,
                    accountId,
                    "🚫 Đã hủy / Hết hạn thanh toán",
                ).catch(() => null);
                return;
            }
            const paidPayment = await _markPaid(client, payment.id);
            if (!paidPayment) return;

            // Update order log → paid / processing
            const {
                unlockPaymentIfPaid,
                editOrderLogPaid,
            } = require("../functions/autoQuestHelpers");
            const runningEntry = getRunningMap(userId).get(accountId);
            await editOrderLogPaid(
                client,
                userId,
                accountId,
                runningEntry?.username ?? "",
                selectedQuestIds.length,
            ).catch(() => null);

            // Unlock quest run
            await unlockPaymentIfPaid(client, paidPayment).catch((e) =>
                console.warn(`[autoQuest] unlock error: ${e.message}`),
            );

            // DM user
            try {
                const user = await client.users.fetch(userId).catch(() => null);
                if (user)
                    await user.send({
                        embeds: [
                            client.embed(
                                [
                                    `Mã đơn: \`${payment.id}\``,
                                    `Số tiền: ${Number(amount).toLocaleString("vi-VN")}đ`,
                                    `Đã mở chạy ${selectedQuestIds.length} quest đã chọn.`,
                                ].join("\n"),
                                {
                                    title: "Đã xác nhận thanh toán",
                                    color: 0x57f287,
                                },
                            ),
                        ],
                    });
            } catch (e) {
                console.warn(`[autoQuest] DM notify error: ${e.message}`);
            }
        });

        // Save to AutoBank DB for recovery on restart — customId must match transferCode
        await client.db.create("autobank_pending", {
            customId: transferCode,
            amount,
            expireAt: payment.expiresAt,
            context,
        });
    }

    return { ...payment, qrUrl: buildVietQrUrl(client, amount, transferCode) };
}

async function getPaymentById(client, paymentId) {
    return (
        (await _readPayments(client)).find((i) => i.id === paymentId) ?? null
    );
}

async function getOpenPendingPayment(client, userId, accountId) {
    return (
        (await _readPayments(client)).find(
            (i) =>
                i.status === "pending" &&
                Number(i.expiresAt) > _now() &&
                i.userId === userId &&
                i.accountId === accountId,
        ) ?? null
    );
}

async function cancelPayment(client, paymentId) {
    const list = await _readPayments(client);
    const idx = list.findIndex((i) => i.id === paymentId);
    if (idx < 0) return null;
    const removed = list[idx];
    list.splice(idx, 1);
    await _savePayments(client, list);
    return removed;
}

async function _markPaid(client, paymentId) {
    const list = await _readPayments(client);
    const idx = list.findIndex((i) => i.id === paymentId);
    if (idx < 0) return null;
    const paid = { ...list[idx], status: "paid", paidAt: _now() };
    // Remove from DB immediately — no need to keep paid records
    list.splice(idx, 1);
    await _savePayments(client, list);
    return paid;
}

async function expireStalePayments(client) {
    const current = _now();
    const list = await _readPayments(client);
    let changed = false;
    const expiredNow = [];
    const nextList = list.filter((item) => {
        if (item.status === "pending" && Number(item.expiresAt) <= current) {
            changed = true;
            expiredNow.push({ ...item, status: "expired" });
            return false; // remove from list
        }
        return true;
    });
    if (changed) await _savePayments(client, nextList);

    const activations = await _readActivations(client);
    const activeIds = new Set(
        nextList
            .filter(
                (i) =>
                    ["pending", "paid"].includes(i.status) &&
                    Number(i.expiresAt) > current,
            )
            .map((i) => i.id),
    );
    const nextActivations = activations.filter(
        (e) => Number(e.expiresAt) > current && activeIds.has(e.paymentId),
    );
    if (nextActivations.length !== activations.length)
        await _saveActivations(client, nextActivations);

    return expiredNow;
}

async function upsertPendingActivation(
    client,
    { paymentId, userId, accountId, token, selectedQuestIds },
) {
    const secret = client.configs.settings.token;
    const list = await _readActivations(client);
    const next = {
        paymentId,
        userId,
        accountId,
        selectedQuestIds: [
            ...new Set(
                (selectedQuestIds ?? [])
                    .map((id) => String(id))
                    .filter(Boolean),
            ),
        ],
        ..._encryptActivationToken(token, secret),
        createdAt: _now(),
        expiresAt: _now() + PAYMENT_EXPIRE_MS,
    };
    const idx = list.findIndex((i) => i.paymentId === paymentId);
    if (idx >= 0) list[idx] = { ...list[idx], ...next };
    else list.push(next);
    await _saveActivations(client, list);
    return next;
}

async function getActivationByPaymentId(client, paymentId) {
    const secret = client.configs.settings.token;
    const item = (await _readActivations(client)).find(
        (e) => e.paymentId === paymentId,
    );
    if (!item) return null;
    const token = _decryptActivationToken(item, secret);
    if (!token) return null;
    return {
        paymentId: item.paymentId,
        userId: item.userId,
        accountId: item.accountId,
        selectedQuestIds: Array.isArray(item.selectedQuestIds)
            ? item.selectedQuestIds
            : [],
        token,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
    };
}

async function removeActivationByPaymentId(client, paymentId) {
    const list = await _readActivations(client);
    const next = list.filter((i) => i.paymentId !== paymentId);
    if (next.length !== list.length) await _saveActivations(client, next);
}

async function getRecoverablePaidActivations(client) {
    const secret = client.configs.settings.token;
    const current = _now();
    const payments = await _readPayments(client);
    const paymentMap = new Map(payments.map((i) => [i.id, i]));
    const activations = await _readActivations(client);
    const results = [];
    for (const a of activations) {
        if (Number(a.expiresAt) <= current) continue;
        const payment = paymentMap.get(a.paymentId);
        if (!payment || payment.status !== "paid") continue;
        const token = _decryptActivationToken(a, secret);
        if (!token) continue;
        results.push({
            payment,
            activation: {
                paymentId: a.paymentId,
                userId: a.userId,
                accountId: a.accountId,
                selectedQuestIds: Array.isArray(a.selectedQuestIds)
                    ? a.selectedQuestIds
                    : [],
                token,
                createdAt: a.createdAt,
                expiresAt: a.expiresAt,
            },
        });
    }
    return results;
}

// ══════════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ══════════════════════════════════════════════════════════════════════════════
module.exports = {
    // Account management
    getRunningMap,
    setAccountNotifier,
    setAllowedQuests,
    getSelectableQuests,
    resolveDiscordAccount,
    startAccount,
    stopAccount,
    stopAllAccounts,
    removeStoredAccount,
    restoreAccounts,

    // Storage
    loadAccounts,
    saveAccounts,
    getTokenRefreshRecord,
    markTokenRefreshRequired,
    getStoredAccountOwner,
    hasStoredAccountEntry,
    getQuestBatchNotification,
    setQuestBatchNotification,
    getOrderLogPending,
    setOrderLogPending,
    getStoredSelectedQuestIds,
    setStoredSelectedQuestIds,

    // Payments
    markPaymentAsPaid: _markPaid,
    createQuestPayment,
    getPaymentById,
    getOpenPendingPayment,
    cancelPayment,
    expireStalePayments,
    upsertPendingActivation,
    getActivationByPaymentId,
    removeActivationByPaymentId,
    getRecoverablePaidActivations,
    buildVietQrUrl,
};
