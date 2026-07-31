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
    randomUUID,
} = require("crypto");
const normalizeDiscordTokenInput = require("../functions/normalizeDiscordTokenInput");
const { nanoid } = require("nanoid");

// ══════════════════════════════════════════════════════════════════════════════
//  SECTION 1 — DISCORD QUEST ENGINE
// ══════════════════════════════════════════════════════════════════════════════

const AUTO_REMOVE_INACTIVE_MS = 30 * 60 * 1000;
// Dead-token records (needsTokenRefresh) are kept this long so the user can
// re-enter their token, then purged for privacy. See sweepStaleAccounts().
const REFRESH_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const API_BASE = "https://discord.com/api/v9";
const HEARTBEAT_INTERVAL = 20;
const AUTO_ACCEPT = true;
// STREAM_ON_DESKTOP is intentionally excluded — Discord requires real screen-share
// detection for it now, so heartbeat spoofing no longer completes it.
const SUPPORTED_TASKS = [
    "WATCH_VIDEO",
    "WATCH_VIDEO_ON_MOBILE",
    "PLAY_ON_DESKTOP",
    "PLAY_ON_XBOX",
    "PLAY_ON_PLAYSTATION",
    "PLAY_ACTIVITY",
    "ACHIEVEMENT_IN_ACTIVITY",
];
const GAME_HEARTBEAT_TASKS = ["PLAY_ON_DESKTOP", "PLAY_ON_XBOX", "PLAY_ON_PLAYSTATION"];
const DESKTOP_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9236 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36";
const ANDROID_USER_AGENT = "Discord-Android/316011;RNA";

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
    const FALLBACK = 539951;
    try {
        const res = await axios.get("https://discord.com/app", {
            headers: { "User-Agent": DESKTOP_USER_AGENT },
            timeout: 15000,
        });
        if (res.status !== 200) return FALLBACK;
        const scripts = [
            ...new Set(
                [...res.data.matchAll(/\/assets\/web\.([a-f0-9]+)\.js/g)].map(
                    (m) => m[0],
                ),
            ),
        ];
        for (const scriptPath of scripts.slice(0, 5)) {
            try {
                const ar = await axios.get(
                    `https://discord.com${scriptPath}`,
                    { headers: { "User-Agent": DESKTOP_USER_AGENT }, timeout: 15000 },
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

function _makeSuperProperties(buildNumber, isAndroid) {
    if (isAndroid) {
        return Buffer.from(
            JSON.stringify({
                os: "Android",
                browser: "Discord Android",
                device: "b0q",
                system_locale: "en-US",
                has_client_mods: false,
                client_version: "316.11 - rn",
                release_channel: "googleRelease",
                device_vendor_id: randomUUID(),
                design_id: 2,
                browser_user_agent: "",
                browser_version: "",
                os_version: "28",
                client_build_number: 5169,
                client_event_source: null,
                client_launch_id: randomUUID(),
                launch_signature: randomUUID(),
                client_app_state: "active",
                client_heartbeat_session_id: randomUUID(),
            }),
        ).toString("base64");
    }
    return Buffer.from(
        JSON.stringify({
            os: "Windows",
            browser: "Discord Client",
            release_channel: "stable",
            client_version: "1.0.9236",
            os_version: "10.0.19045",
            os_arch: "x64",
            app_arch: "x64",
            system_locale: "en-US",
            has_client_mods: false,
            client_launch_id: randomUUID(),
            browser_user_agent: DESKTOP_USER_AGENT,
            browser_version: "37.6.0",
            os_sdk_version: "19045",
            client_build_number: buildNumber,
            native_build_number: 81687,
            client_event_source: null,
            launch_signature: randomUUID(),
            client_heartbeat_session_id: randomUUID(),
            client_app_state: "focused",
        }),
    ).toString("base64");
}

class DiscordAPI {
    constructor(token, buildNumber) {
        this.token = token;
        this.buildNumber = buildNumber;
        this.client = axios.create({
            baseURL: API_BASE,
            timeout: 20000, // never hang the run loop on a stuck request
            headers: {
                Authorization: token,
                "Content-Type": "application/json",
                Accept: "*/*",
                "Accept-Language": "en-US,en;q=0.9",
                "User-Agent": DESKTOP_USER_AGENT,
                "X-Super-Properties": _makeSuperProperties(buildNumber, false),
                "X-Discord-Locale": "en-US",
                "X-Discord-Timezone": "Asia/Ho_Chi_Minh",
                "X-Debug-Options": "bugReporterEnabled",
                Origin: "https://discord.com",
                Referer: "https://discord.com/channels/@me",
            },
        });
    }
    async get(path, config = {}) {
        return this.client.get(path, { validateStatus: () => true, ...config });
    }
    async post(path, payload = null, config = {}) {
        return this.client.post(path, payload, {
            validateStatus: () => true,
            ...config,
        });
    }
    async delete(path, config = {}) {
        return this.client.delete(path, { validateStatus: () => true, ...config });
    }
    // Only the enroll call needs Android identity — used for quests that are
    // mobile-only (WATCH_VIDEO_ON_MOBILE without a desktop WATCH_VIDEO variant).
    androidEnrollHeaders() {
        return {
            "User-Agent": ANDROID_USER_AGENT,
            "X-Super-Properties": _makeSuperProperties(this.buildNumber, true),
        };
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
function _getApplicationId(q) {
    return (q.config ?? {}).application?.id ?? null;
}
function _isMobileOnlyTask(q) {
    const tc = _getTaskConfig(q);
    return Boolean(tc?.tasks?.WATCH_VIDEO_ON_MOBILE) && !tc?.tasks?.WATCH_VIDEO;
}

class QuestAutocompleter {
    constructor(api, label = "") {
        this.api = api;
        this.label = label; // account username, for readable progress logs
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
                const list = Array.isArray(d) ? d : (d?.quests ?? []);
                this._lastFetched = list; // cached for enrollSelected()
                return list;
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

    // Enroll a set of quest objects concurrently (each with its own 429 backoff),
    // instead of sequentially with a 3s gap — that gap made enrolling slow. Rejects
    // only with an invalidToken error, surfaced to the caller.
    async _enrollAll(questObjs) {
        if (!questObjs.length) return;
        const enrollOne = async (q) => {
            try {
                const isAndroid = _isMobileOnlyTask(q);
                for (let i = 1; i <= 3; i++) {
                    const res = await this.api.post(
                        `/quests/${q.id}/enroll`,
                        {
                            location: isAndroid ? 12 : 11, // QUEST_HOME_MOBILE : QUEST_HOME_DESKTOP
                            is_targeted: false,
                            metadata_sealed: null,
                            traffic_metadata_raw: q.traffic_metadata_raw ?? null,
                            traffic_metadata_sealed:
                                q.traffic_metadata_sealed ?? null,
                        },
                        isAndroid
                            ? { headers: this.api.androidEnrollHeaders() }
                            : {},
                    );

                    // Only 401 means the token is dead. A 403/400 here is
                    // quest-specific (account not eligible for THIS quest) — skip
                    // that quest, do NOT kill the whole account. (Using
                    // _throwIfUnauthorized would treat 403 as an invalid token and
                    // silently remove the account.)
                    if (res.status === 401) {
                        const e = new Error("Token bị từ chối khi enroll (401)");
                        e.invalidToken = true;
                        throw e;
                    }
                    if (res.status === 429) {
                        await sleep((res.data?.retry_after ?? 5) + 1);
                        continue;
                    }
                    if (![200, 201, 204].includes(res.status))
                        this._log(
                            `⚠ Không enroll được "${_getQuestName(q)}" (HTTP ${res.status}) — bỏ qua quest này.`,
                        );
                    break;
                }
            } catch (err) {
                if (err?.invalidToken) throw err; // surfaced below
            }
        };
        // Bounded concurrency — enroll in small batches so we never fire dozens of
        // requests at once (that triggers hard rate-limiting and stalls the loop).
        const CONCURRENCY = 5;
        for (let i = 0; i < questObjs.length; i += CONCURRENCY) {
            const batch = questObjs.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(batch.map(enrollOne));
            const invalid = results.find(
                (r) => r.status === "rejected" && r.reason?.invalidToken,
            );
            if (invalid) throw invalid.reason;
        }
    }

    async autoAccept(quests) {
        if (!AUTO_ACCEPT) return quests;
        const unaccepted = quests.filter(
            (q) => !_isEnrolled(q) && !_isCompleted(q) && _isCompletable(q),
        );
        if (!unaccepted.length) return quests;
        await this._enrollAll(unaccepted);
        await sleep(1);
        return this.fetchQuests();
    }

    // Enroll only the quests the user picked (looked up from the last fetch), so
    // the selection menu can be shown instantly without enrolling everything first.
    async enrollSelected(ids) {
        const idSet = new Set((ids ?? []).map(String));
        if (!idSet.size) return;
        const quests = this._lastFetched ?? (await this.fetchQuests());
        const toEnroll = quests.filter(
            (q) =>
                idSet.has(String(q.id)) &&
                !_isEnrolled(q) &&
                !_isCompleted(q) &&
                _isCompletable(q),
        );
        await this._enrollAll(toEnroll);
    }

    _log(msg) {
        console.log(`[Quest]${this.label ? ` ${this.label}` : ""} ${msg}`);
    }

    async processQuest(quest) {
        const taskType = _getTaskType(quest);
        if (!taskType || this.completedIds.has(quest.id)) return;
        const name = _getQuestName(quest);
        const needed = _getSecondsNeeded(quest);
        const startedAt = Date.now();
        this._log(
            `▶ Bắt đầu "${name}" (${taskType})${needed ? ` — cần ${needed}s` : ""}`,
        );
        if (["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE"].includes(taskType))
            await this._completeVideo(quest);
        else if (GAME_HEARTBEAT_TASKS.includes(taskType))
            await this._completeGameHeartbeat(quest, taskType);
        else if (taskType === "PLAY_ACTIVITY")
            await this._completeActivity(quest);
        else if (taskType === "ACHIEVEMENT_IN_ACTIVITY")
            await this._completeAchievement(quest);
        this.completedIds.add(quest.id);
        this._log(
            `✓ Hoàn thành "${name}" (mất ${Math.round((Date.now() - startedAt) / 1000)}s)`,
        );
    }

    async _completeVideo(quest) {
        const qid = quest.id,
            needed = _getSecondsNeeded(quest);
        const name = _getQuestName(quest);
        let done = _getSecondsDone(quest);
        let lastLog = 0;
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
            if (Date.now() - lastLog > 30000) {
                this._log(
                    `   "${name}": ${Math.round(done)}/${needed}s (${Math.round((done / needed) * 100)}%)`,
                );
                lastLog = Date.now();
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

    // PLAY_ON_DESKTOP / PLAY_ON_XBOX / PLAY_ON_PLAYSTATION now report progress
    // via `application_id` heartbeats instead of a fake voice `stream_key`.
    async _completeGameHeartbeat(quest, taskType) {
        const qid = quest.id,
            needed = _getSecondsNeeded(quest);
        const name = _getQuestName(quest);
        let done = _getSecondsDone(quest);
        let lastLog = 0;
        const applicationId = _getApplicationId(quest);
        while (done < needed) {
            try {
                const res = await this.api.post(`/quests/${qid}/heartbeat`, {
                    application_id: applicationId,
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
            if (Date.now() - lastLog > 30000) {
                this._log(
                    `   "${name}": ${Math.round(done)}/${needed}s (${Math.round((done / needed) * 100)}%)`,
                );
                lastLog = Date.now();
            }
            await sleep(HEARTBEAT_INTERVAL);
        }
        try {
            const res = await this.api.post(`/quests/${qid}/heartbeat`, {
                application_id: applicationId,
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

    // ACHIEVEMENT_IN_ACTIVITY quests are completed via the application's
    // embedded-activity domain (discordsays.com), not the normal Discord API.
    async _getActivityReferrer(applicationId) {
        const res = await this.api.post(
            `/applications/${applicationId}/proxy-tickets`,
            {},
        );
        _throwIfUnauthorized(res, "Lấy proxy ticket thất bại");
        const referrer = new URL(`https://${applicationId}.discordsays.com/`);
        referrer.searchParams.set("instance_id", "example-cl-instance");
        referrer.searchParams.set("platform", "desktop");
        referrer.searchParams.set(
            "discord_proxy_ticket",
            res.data?.ticket ?? "",
        );
        return referrer.toString();
    }

    async _completeAchievement(quest) {
        const qid = quest.id;
        const applicationId = _getApplicationId(quest);
        if (!applicationId) return;
        const tc = _getTaskConfig(quest);
        const questTarget = tc?.tasks?.ACHIEVEMENT_IN_ACTIVITY?.target ?? 0;
        try {
            const authRes = await this.api.post(
                `/oauth2/authorize`,
                {
                    permissions: "0",
                    authorize: true,
                    integration_type: 1,
                    location_context: {
                        guild_id: "10000",
                        channel_id: "10000",
                        channel_type: 10000,
                    },
                },
                {
                    params: {
                        response_type: "code",
                        client_id: applicationId,
                        scope: "identify applications.commands applications.entitlements",
                        state: "",
                    },
                },
            );
            _throwIfUnauthorized(authRes, "Achievement authorize thất bại");
            const location = authRes.data?.location;
            const authCode = location
                ? new URL(location).searchParams.get("code")
                : null;
            if (!authCode) return;

            const activityReferrer =
                await this._getActivityReferrer(applicationId);
            const activityHeaders = {
                "Content-Type": "application/json",
                "X-Discord-Quest-ID": qid,
                Referer: activityReferrer,
                "User-Agent": DESKTOP_USER_AGENT,
            };

            const authorizeRes = await axios.post(
                `https://${applicationId}.discordsays.com/.proxy/acf/authorize`,
                { code: authCode },
                { headers: activityHeaders, validateStatus: () => true },
            );
            const activityToken = authorizeRes.data?.token;
            if (!activityToken) return;

            await axios.post(
                `https://${applicationId}.discordsays.com/.proxy/acf/quest/progress`,
                { progress: questTarget },
                {
                    headers: {
                        ...activityHeaders,
                        "X-Auth-Token": activityToken,
                    },
                    validateStatus: () => true,
                },
            );

            const tokensRes = await this.api.get("/oauth2/tokens");
            if (tokensRes.status === 200 && Array.isArray(tokensRes.data)) {
                const tokenInfo = tokensRes.data.find(
                    (t) => t.application?.id === applicationId,
                );
                if (tokenInfo)
                    await this.api
                        .delete(`/oauth2/tokens/${tokenInfo.id}`)
                        .catch(() => null);
            }
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

// Monthly subscription end (ISO string) — set for accounts on the "gói tháng" plan.
// Kept as-is so a sub survives load/save; the scheduler and sweep read it.
function _normalizeMonthlyExpiresAt(record) {
    const v = record?.monthlyExpiresAt;
    if (typeof v !== "string") return null;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? v : null;
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
        monthlyExpiresAt: _normalizeMonthlyExpiresAt(record),
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
        // Timestamp for when this record entered the "waiting for re-entered token"
        // state. Used by sweepStaleAccounts() to expire dead-token records after
        // REFRESH_RECORD_TTL_MS so user data is not kept forever.
        refreshRequestedAt:
            typeof record.refreshRequestedAt === "string"
                ? record.refreshRequestedAt
                : new Date().toISOString(),
        questBatchNotification: _normalizeQuestBatch(record),
        orderLogPending: _normalizeOrderLogPending(record),
        selectedQuestIds: _normalizeSelectedQuestIds(record),
        monthlyExpiresAt: _normalizeMonthlyExpiresAt(record),
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
                monthlyExpiresAt: _normalizeMonthlyExpiresAt(record),
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
// Build number changes rarely (roughly weekly) and a slightly stale value still
// works, so cache it long to keep it off the token-entry path. Pre-warmed at
// startup via warmBuildNumber().
const BUILD_CACHE_TTL = 6 * 60 * 60_000; // 6 hours
let buildCache = { value: null, fetchedAt: 0 };
let accountNotifier = null;

async function _getBuildNumber() {
    if (buildCache.value && Date.now() - buildCache.fetchedAt < BUILD_CACHE_TTL)
        return buildCache.value;
    const v = await fetchLatestBuildNumber();
    buildCache = { value: v, fetchedAt: Date.now() };
    return v;
}

/** Fetch and cache the build number ahead of time (call on startup) so the first
 *  token entry does not pay the fetch cost. */
async function warmBuildNumber() {
    try {
        await _getBuildNumber();
    } catch {}
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

async function setAllowedQuests(client, userId, accountId, questIds) {
    const entry = getRunningMap(userId).get(accountId);
    if (!entry) return false;
    // Append (union) the incoming quests to whatever is already allowed, instead of
    // replacing. This lets a user buy more quests mid-run (e.g. 6 then +3 = 9 in one
    // session) without dropping the quests still running from the earlier order.
    const incoming = (questIds ?? []).map((id) => String(id)).filter(Boolean);
    if (entry.allowedQuestIds instanceof Set)
        for (const id of incoming) entry.allowedQuestIds.add(id);
    else entry.allowedQuestIds = new Set(incoming);
    const selectedIds = [...entry.allowedQuestIds];
    if (selectedIds.length > 0) {
        // Persist the account record and its selected quest IDs in a single
        // atomic load→save. The previous code fire-and-forgot _persistAccountRecord
        // and then awaited setStoredSelectedQuestIds separately, which raced: the
        // selectedQuestIds write often ran before the record existed and was
        // dropped, leaving a paid account stored with no selection.
        const data = await loadAccounts(client);
        if (!data[userId]) data[userId] = {};
        data[userId][accountId] = {
            ...data[userId][accountId],
            token: entry.token,
            username: entry.username,
            addedAt: new Date(entry.startedAt).toISOString(),
            expiresAt: entry.expiresAt,
            month: entry.month,
            selectedQuestIds: selectedIds,
        };
        await saveAccounts(client, data);
    } else {
        await setStoredSelectedQuestIds(client, userId, accountId, selectedIds);
    }
    entry.wakeRequested = true;
    return true;
}

async function getSelectableQuests(userId, accountId) {
    const entry = getRunningMap(userId).get(accountId);
    if (!entry) return [];
    // Show the menu from a single fetch — do NOT enroll here (that was the slow
    // step). enrollSelected() enrolls the picked quests when the user selects, so
    // they still enter the run loop's `potential` set and actually run.
    const quests = await entry.completer.fetchQuests();
    if (!quests.length) return [];
    // Exclude quests already selected/running for this account so re-entering the
    // token to buy MORE quests only offers new ones (no paying twice for a running
    // quest).
    const already =
        entry.allowedQuestIds instanceof Set
            ? entry.allowedQuestIds
            : new Set();
    return quests
        .filter(
            (q) =>
                !_isCompleted(q) &&
                _isCompletable(q) &&
                !already.has(String(q.id)),
        )
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
    console.log(`[Loop] ${username}: vòng chạy bắt đầu.`);
    while (!abortController.stopped) {
        const entry = getRunningMap(userId).get(accountId);
        if (!entry) break;
        try {
            let quests = await completer.fetchQuests();
            console.log(`[Loop] ${username}: fetch xong — ${quests.length} quest.`);
            if (quests.length) {
                // Enroll only the quests we intend to run. Blanket-enrolling every
                // quest (autoAccept) is what stalled the loop — an account can have
                // dozens, and a mass parallel enroll gets rate-limited hard.
                const preEntry = getRunningMap(userId).get(accountId);
                if (preEntry?.allowedQuestIds instanceof Set) {
                    if (preEntry.allowedQuestIds.size > 0) {
                        await completer.enrollSelected([
                            ...preEntry.allowedQuestIds,
                        ]);
                        quests = await completer.fetchQuests();
                    }
                } else {
                    quests = await completer.autoAccept(quests); // run-all mode
                }
                console.log(`[Loop] ${username}: enroll xong.`);
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

                console.log(
                    `[Loop] ${username}: ${quests.length} quest, ${potential.length} khả dụng (đã enroll), ` +
                        `${requiresSelection ? `${currentEntry.allowedQuestIds.size} đã chọn` : "chạy tất cả"}, ` +
                        `${actionable.length} sẽ chạy`,
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
                    const qName = _getQuestName(q);
                    completedNames.push(qName);
                    // DM the user immediately for THIS quest. Per-quest (not batch)
                    // so a restart mid-order doesn't drop earlier quests from the
                    // notification — each finished quest is reported as it completes.
                    await _notifyAccount({
                        type: "quest_completed_one",
                        userId,
                        accountId,
                        username,
                        questName: qName,
                        taskType: _getTaskType(q),
                    });
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
                        // Treat a selected quest as done when it is gone, already
                        // completed, or no longer completable (e.g. expired on
                        // Discord). Without the last case such a quest is enrolled
                        // but never completable, so the account never purges and
                        // lingers in the DB polling forever.
                        return !q || _isCompleted(q) || !_isCompletable(q);
                    });
                    if (allDone) {
                        console.log(
                            `[Loop] ${username}: các quest đã chọn đã xong/hết hạn → dừng & gỡ account.`,
                        );
                        _expireAccount(client, userId, accountId);
                        break;
                    }
                }
            }
        } catch (err) {
            if (_isInvalidTokenError(err)) {
                console.log(
                    `[Loop] ${username}: token bị từ chối (${err.message}) → gỡ account, gửi DM nhập lại token.`,
                );
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
            console.error(`[Loop] ${username}: lỗi vòng chạy — ${err.message}`);
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
    const completer = new QuestAutocompleter(resolved.api, resolved.username);
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
    // Inactivity auto-remove is a security feature for a FRESH token entry: if the
    // user pastes a token and never selects/pays within the window, drop the
    // in-memory token. It must NOT run for restored/refreshed/already-paid accounts
    // — those are established accounts, and deleting them here would wrongly wipe a
    // legitimate account (e.g. a restored account whose quests already finished, so
    // its allow-list is empty again, looks "never paid" to this check).
    if (options.autoRemoveIfInactive) {
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
    }

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
                // Monthly-subscription accounts run on a schedule (Tue/Sat), not a
                // continuous poll loop — skip them here; runMonthlyBatch() drives them.
                if (_isMonthlyActive(record)) continue;
                // Resume quest selection. Prefer explicitly stored selectedQuestIds,
                // but fall back to an in-progress quest batch (status "started")
                // whose signature holds the quest IDs that were mid-run when the bot
                // stopped. Without this, an account whose selection was never
                // persisted (e.g. an older record from before the setAllowedQuests
                // race fix) restores but sits idle because its allow-list is empty.
                let resumeIds = record.selectedQuestIds ?? [];
                if (
                    resumeIds.length === 0 &&
                    record.questBatchNotification?.status === "started"
                ) {
                    resumeIds = (record.questBatchNotification.signature ?? "")
                        .split("|")
                        .filter(Boolean);
                }
                const result = await startAccount(
                    client,
                    userId,
                    record.token,
                    {
                        allowRestartIfRunning: false,
                        addedAt: record.addedAt,
                        month: record.month,
                        requireQuestSelection: true,
                        // Pass resumed quest IDs so the run loop resumes immediately
                        // without waiting for the user to re-select quests
                        _storedSelectedQuestIds: resumeIds,
                    },
                );
                if (result.ok) {
                    total++;
                    // Wake the loop immediately and persist the resumed selection
                    // back to the DB so it survives the next restart too.
                    if (resumeIds.length > 0) {
                        const entry = getRunningMap(userId).get(
                            result.accountId,
                        );
                        if (entry) entry.wakeRequested = true;
                        await setStoredSelectedQuestIds(
                            client,
                            userId,
                            result.accountId,
                            resumeIds,
                        ).catch(() => null);
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

/**
 * Durable cleanup of the `accounts` store. Runs on startup and on an interval.
 * The in-memory inactivity timer in startAccount() only lives inside the running
 * process, so anything that slips past it (a dead-token record no one re-entered,
 * a stored account left idle after a restart) would otherwise stay forever.
 * A currently-running account is never touched.
 *
 * @returns {Promise<Array<{ userId, accountId, username, reason }>>} removed entries
 */
async function sweepStaleAccounts(client) {
    const rawData = await _readAccounts(client);
    const now = _now();
    let changed = false;
    const removed = [];

    for (const [userId, accounts] of Object.entries(rawData)) {
        if (
            !accounts ||
            typeof accounts !== "object" ||
            Array.isArray(accounts)
        ) {
            delete rawData[userId];
            changed = true;
            continue;
        }
        for (const [accountId, record] of Object.entries(accounts)) {
            if (
                !record ||
                typeof record !== "object" ||
                Array.isArray(record)
            ) {
                delete accounts[accountId];
                changed = true;
                continue;
            }

            // Never remove an account that is actively running.
            if (getRunningMap(userId).has(accountId)) continue;

            // Keep monthly-subscription accounts while the sub is active. They have
            // no selectedQuestIds (they run everything), so without this guard the
            // inactivity branch below would wrongly delete a paid subscriber. Once
            // the sub lapses the record falls through and is cleaned normally.
            if (_isMonthlyActive(record)) continue;

            // (a) Dead-token records waiting for the user to re-enter a token.
            if (_hasRefreshFlag(record)) {
                if (typeof record.refreshRequestedAt !== "string") {
                    // Legacy record with no timestamp: start the clock now so it
                    // still gets the full grace window instead of being nuked.
                    accounts[accountId] = {
                        ...record,
                        refreshRequestedAt: new Date(now).toISOString(),
                    };
                    changed = true;
                    continue;
                }
                const flaggedAt = new Date(record.refreshRequestedAt).getTime();
                if (
                    Number.isFinite(flaggedAt) &&
                    now - flaggedAt >= REFRESH_RECORD_TTL_MS
                ) {
                    delete accounts[accountId];
                    changed = true;
                    removed.push({
                        userId,
                        accountId,
                        username: record.username,
                        reason: "refresh_ttl",
                    });
                }
                continue;
            }

            // (b) Stored account that never got a quest selected and has been idle
            //     past the inactivity window (durable backstop for the RAM timer).
            if (_normalizeSelectedQuestIds(record).length === 0) {
                const addedAt = new Date(record.addedAt ?? 0).getTime();
                if (
                    Number.isFinite(addedAt) &&
                    now - addedAt >= AUTO_REMOVE_INACTIVE_MS
                ) {
                    delete accounts[accountId];
                    changed = true;
                    removed.push({
                        userId,
                        accountId,
                        username: record.username,
                        reason: "inactive",
                    });
                }
            }
        }
        if (Object.keys(accounts).length === 0) {
            delete rawData[userId];
            changed = true;
        }
    }

    if (changed) await _writeAccounts(client, rawData);
    return removed;
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
                // Timeout — payment expired without being paid. Remove the payment
                // record and its activation so nothing is left dangling as
                // "pending" in the DB, then update the order log.
                await cancelPayment(client, payment.id).catch(() => null);
                await removeActivationByPaymentId(client, payment.id).catch(
                    () => null,
                );
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

            // Unlock quest run (or stash for token reset if the account is dead)
            const unlockResult = await unlockPaymentIfPaid(
                client,
                paidPayment,
            ).catch((e) => {
                console.warn(`[autoQuest] unlock error: ${e.message}`);
                return false;
            });
            const pendingToken = unlockResult === "pending_token";

            // DM user — accurate message: running now vs waiting for token re-entry.
            try {
                const user = await client.users.fetch(userId).catch(() => null);
                if (user)
                    await user.send({
                        embeds: [
                            client.embed(
                                [
                                    `Mã đơn: \`${payment.id}\``,
                                    `Số tiền: ${Number(amount).toLocaleString("vi-VN")}đ`,
                                    pendingToken
                                        ? `⚠️ Token account đã die trong lúc chờ thanh toán. Vào panel Auto Quest và bấm nút **🔑 Cập nhật token** để gửi lại token — bot sẽ tự chạy ${selectedQuestIds.length} quest đã mua (đã lưu, không mất).`
                                        : `Đã mở chạy ${selectedQuestIds.length} quest đã chọn.`,
                                ].join("\n"),
                                {
                                    title: pendingToken
                                        ? "Đã thanh toán — cần cập nhật token"
                                        : "Đã xác nhận thanh toán",
                                    color: pendingToken ? 0xfee75c : 0x57f287,
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
//  SECTION 5 — MONTHLY SUBSCRIPTION (flat price, scheduled run of ALL quests)
// ══════════════════════════════════════════════════════════════════════════════

const MONTHLY_PENDING_DB = "quest_monthly_pending";
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function _isMonthlyActive(record) {
    const v = _normalizeMonthlyExpiresAt(record);
    return !!v && new Date(v).getTime() > _now();
}

async function _readMonthlyPending(client) {
    return (await client.db.get(MONTHLY_PENDING_DB)) ?? [];
}
async function _saveMonthlyPending(client, list) {
    await client.db.set(MONTHLY_PENDING_DB, list);
}

async function _generateUniqueMonthlyCode(client) {
    const list = await _readMonthlyPending(client);
    const active = new Set(
        list
            .filter((i) => i.status === "pending" && Number(i.expiresAt) > _now())
            .map((i) => i.transferCode),
    );
    for (let i = 0; i < 100; i++) {
        const code = _randomTransferCode();
        if (!active.has(code)) return code;
    }
    return _randomTransferCode();
}

async function getMonthlyPaymentById(client, paymentId) {
    return (
        (await _readMonthlyPending(client)).find(
            (i) => i.paymentId === paymentId,
        ) ?? null
    );
}

async function getOpenMonthlyPayment(client, userId, accountId) {
    return (
        (await _readMonthlyPending(client)).find(
            (i) =>
                i.status === "pending" &&
                Number(i.expiresAt) > _now() &&
                i.userId === userId &&
                i.accountId === accountId,
        ) ?? null
    );
}

/** Active subscription end (ISO) for an account, or null — reads RAW so it still
 *  reports for a dead-token account (which is not returned by loadAccounts). */
async function getMonthlySubscriptionRaw(client, userId, accountId) {
    const raw = await _readAccounts(client);
    const r = raw[userId]?.[accountId];
    return _isMonthlyActive(r) ? r.monthlyExpiresAt : null;
}

async function cancelMonthlyPayment(client, paymentId) {
    const list = await _readMonthlyPending(client);
    const removed = list.find((i) => i.paymentId === paymentId) ?? null;
    const next = list.filter((i) => i.paymentId !== paymentId);
    if (next.length !== list.length) await _saveMonthlyPending(client, next);
    return removed;
}

async function expireStaleMonthlyPayments(client) {
    const current = _now();
    const list = await _readMonthlyPending(client);
    const next = list.filter(
        (i) => !(i.status === "pending" && Number(i.expiresAt) <= current),
    );
    if (next.length !== list.length) await _saveMonthlyPending(client, next);
    return list.length - next.length;
}

/**
 * Activate / extend a monthly subscription on an account. Writes the account
 * record with an encrypted token and an extended monthlyExpiresAt. Reads RAW so
 * an existing sub (even one on a dead-token record) is extended, not reset.
 * months = 0 just refreshes the token while keeping the current expiry.
 */
async function activateMonthlySubscription(
    client,
    { userId, accountId, token, username, months = 1 },
) {
    const secret = client.configs.settings.token;
    const m = Math.max(0, parseInt(months, 10) || 0);
    const raw = await _readAccounts(client);
    if (!raw[userId]) raw[userId] = {};
    const existing = raw[userId][accountId] ?? {};
    const base = _isMonthlyActive(existing)
        ? new Date(existing.monthlyExpiresAt).getTime()
        : _now();
    const monthlyExpiresAt = new Date(base + m * MONTH_MS).toISOString();
    // Build a fresh secure record from the NEW token (no encrypted-token fields in
    // the input, so _buildSecureRecord encrypts the new token and drops any stale
    // needsTokenRefresh flag — reviving a dead-token subscriber).
    raw[userId][accountId] = _buildSecureRecord(
        {
            username: username ?? existing.username,
            addedAt:
                typeof existing.addedAt === "string"
                    ? existing.addedAt
                    : new Date().toISOString(),
            month: existing.month,
            selectedQuestIds: [],
            monthlyExpiresAt,
        },
        token,
        secret,
    );
    await _writeAccounts(client, raw);
    return { userId, accountId, months: m, monthlyExpiresAt };
}

/**
 * Create a monthly-subscription payment (QR) and register it with AutoBank.
 * The token is stored encrypted in the pending record so the sub can be activated
 * when payment lands (and recovered after a restart via the missed handler).
 */
async function createMonthlyPayment(
    client,
    { userId, accountId, token, username, months = 1 },
) {
    const m = Math.max(1, parseInt(months, 10) || 1);
    const amount = m * client.configs.settings.monthlyQuestPrice;
    const transferCode = await _generateUniqueMonthlyCode(client);
    const secret = client.configs.settings.token;
    const paymentId = _newPaymentId();
    const expiresAt = _now() + PAYMENT_EXPIRE_MS;

    const entry = {
        paymentId,
        type: "quest_monthly",
        userId,
        accountId,
        username: username ?? "Unknown",
        months: m,
        amount,
        transferCode,
        status: "pending",
        createdAt: _now(),
        expiresAt,
        ..._encryptActivationToken(token, secret),
    };
    const list = await _readMonthlyPending(client);
    const filtered = list.filter(
        (i) =>
            !(
                i.userId === userId &&
                i.accountId === accountId &&
                i.status === "pending"
            ),
    );
    filtered.push(entry);
    await _saveMonthlyPending(client, filtered);

    if (client.autoBank) {
        const context = {
            _handler: "quest_monthly_payment",
            paymentId,
            userId,
            accountId,
            months: m,
        };
        client.autoBank.createQR(amount, transferCode, context, async (err) => {
            if (err) {
                await cancelMonthlyPayment(client, paymentId).catch(() => null);
                return;
            }
            await activateMonthlyFromPayment(client, paymentId).catch((e) =>
                console.warn(`[Monthly] activate error: ${e.message}`),
            );
        });
        await client.db.create("autobank_pending", {
            customId: transferCode,
            amount,
            expireAt: expiresAt,
            context,
        });
    }

    return {
        paymentId,
        months: m,
        amount,
        transferCode,
        expiresAt,
        qrUrl: buildVietQrUrl(client, amount, transferCode),
    };
}

/** Activate the subscription tied to a paid monthly payment, then clear it. */
async function activateMonthlyFromPayment(client, paymentId) {
    const secret = client.configs.settings.token;
    const entry = await getMonthlyPaymentById(client, paymentId);
    if (!entry) return null;
    const token = _decryptActivationToken(entry, secret);
    if (!token) {
        await cancelMonthlyPayment(client, paymentId);
        return null;
    }
    // Delegate the monthly subscription (running) to the panel when enabled; payment
    // stays here. Otherwise activate + run locally.
    const PanelQuest = require("./PanelQuest");
    let result;
    if (PanelQuest.isEnabled()) {
        try {
            const r = await PanelQuest.activateMonthly({
                token,
                months: entry.months,
                ref: entry.userId,
            });
            result = { monthlyExpiresAt: r.monthlyExpiresAt };
        } catch (e) {
            console.warn(`[PanelQuest] monthly activate failed, local fallback: ${e.message}`);
        }
    }
    if (!result) {
        result = await activateMonthlySubscription(client, {
            userId: entry.userId,
            accountId: entry.accountId,
            token,
            username: entry.username,
            months: entry.months,
        });
    }
    await cancelMonthlyPayment(client, paymentId);
    await _notifyAccount({
        type: "monthly_activated",
        userId: entry.userId,
        accountId: entry.accountId,
        username: entry.username,
        months: entry.months,
        monthlyExpiresAt: result.monthlyExpiresAt,
    });
    return result;
}

/** All accounts with an active subscription and a usable (decryptable) token. */
async function getMonthlyAccounts(client) {
    const data = await loadAccounts(client);
    const out = [];
    for (const [userId, accounts] of Object.entries(data)) {
        for (const [accountId, record] of Object.entries(accounts)) {
            if (_isMonthlyActive(record) && record.token) {
                out.push({
                    userId,
                    accountId,
                    token: record.token,
                    username: record.username ?? "Unknown",
                    monthlyExpiresAt: record.monthlyExpiresAt,
                });
            }
        }
    }
    return out;
}

/**
 * Full status of every account a user has entered (for the "Kiểm tra trạng thái"
 * panel button). Merges the persisted accounts DB (incl. dead-token records) with
 * the in-memory running map (incl. fresh not-yet-paid runs).
 */
async function getUserAccountsStatus(client, userId) {
    const raw = await _readAccounts(client);
    const accounts = raw[userId];
    const userMap = getRunningMap(userId);
    const out = [];
    const seen = new Set();

    const push = (accountId, record, running) => {
        out.push({
            accountId,
            username:
                (record && record.username) || running?.username || "Unknown",
            type: _isMonthlyActive(record) ? "monthly" : "single",
            monthlyExpiresAt: _normalizeMonthlyExpiresAt(record),
            needsRefresh: _hasRefreshFlag(record),
            tokenAlive: !_hasRefreshFlag(record),
            running: !!running,
            runningQuestCount:
                running?.allowedQuestIds instanceof Set
                    ? running.allowedQuestIds.size
                    : null,
            completedCount: running?.completedCount ?? 0,
            startedAt: running?.startedAt ?? null,
            storedSelectedCount: record
                ? _normalizeSelectedQuestIds(record).length
                : 0,
        });
    };

    if (accounts && typeof accounts === "object" && !Array.isArray(accounts)) {
        for (const [accountId, record] of Object.entries(accounts)) {
            if (!record || typeof record !== "object" || Array.isArray(record))
                continue;
            seen.add(accountId);
            push(accountId, record, userMap.get(accountId));
        }
    }
    // Running accounts not yet persisted (fresh per-quest runs before payment).
    for (const [accountId, running] of userMap) {
        if (seen.has(accountId)) continue;
        push(accountId, {}, running);
    }
    return out;
}

/**
 * Scheduled batch: run through every active subscriber sequentially and complete
 * ALL available quests, DMing the owner per completed quest (via the notifier).
 */
async function runMonthlyBatch(client) {
    const accounts = await getMonthlyAccounts(client);
    let processedAccounts = 0;
    let completedQuests = 0;
    for (const { userId, accountId, token, username } of accounts) {
        try {
            const resolved = await resolveDiscordAccount(token);
            if (!resolved.ok) {
                if (resolved.invalidToken) {
                    await markTokenRefreshRequired(client, userId, accountId, {
                        username,
                    });
                    await _notifyAccount({
                        type: "monthly_token_dead",
                        userId,
                        accountId,
                        username,
                    });
                }
                continue;
            }
            const completer = new QuestAutocompleter(resolved.api, username);
            let guard = 0;
            while (guard++ < 10) {
                let quests = await completer.fetchQuests();
                if (!quests.length) break;
                quests = await completer.autoAccept(quests);
                const actionable = quests.filter(
                    (q) =>
                        _isEnrolled(q) &&
                        !_isCompleted(q) &&
                        _isCompletable(q) &&
                        !completer.completedIds.has(q.id),
                );
                if (!actionable.length) break;
                for (const q of actionable) {
                    try {
                        await completer.processQuest(q);
                        completedQuests++;
                        await _notifyAccount({
                            type: "monthly_quest_done",
                            userId,
                            accountId,
                            username,
                            questName: _getQuestName(q),
                            taskType: _getTaskType(q),
                        });
                    } catch (e) {
                        if (_isInvalidTokenError(e)) throw e;
                        console.error(
                            `[Monthly] ${username} quest error: ${e.message}`,
                        );
                    }
                    await sleep(2);
                }
            }
            processedAccounts++;
        } catch (e) {
            if (_isInvalidTokenError(e)) {
                await markTokenRefreshRequired(client, userId, accountId, {
                    username,
                });
                await _notifyAccount({
                    type: "monthly_token_dead",
                    userId,
                    accountId,
                    username,
                });
            } else {
                console.error(`[Monthly] ${username} error: ${e.message}`);
            }
        }
        await sleep(3);
    }
    return { processedAccounts, completedQuests, totalAccounts: accounts.length };
}

/**
 * Daily enroll-only scan for monthly subscribers: enroll every available quest but
 * do NOT complete anything. Runs separately from the Tue/Sat completion batch so
 * quests are accepted early — which makes video quests complete much faster on the
 * run day (their progress is gated by time since enrollment).
 */
async function runMonthlyEnrollScan(client) {
    const accounts = await getMonthlyAccounts(client);
    let processed = 0;
    for (const { userId, accountId, token, username } of accounts) {
        try {
            const resolved = await resolveDiscordAccount(token);
            if (!resolved.ok) {
                if (resolved.invalidToken) {
                    await markTokenRefreshRequired(client, userId, accountId, {
                        username,
                    });
                    await _notifyAccount({
                        type: "monthly_token_dead",
                        userId,
                        accountId,
                        username,
                    });
                }
                continue;
            }
            const completer = new QuestAutocompleter(resolved.api, username);
            const quests = await completer.fetchQuests();
            if (quests.length) {
                const before = quests.filter((q) => _isEnrolled(q)).length;
                await completer.autoAccept(quests); // enrolls all unaccepted (bounded)
                console.log(
                    `[MonthlyEnroll] ${username}: ${quests.length} quest, đã enroll thêm (trước: ${before} đã nhận).`,
                );
            }
            processed++;
        } catch (e) {
            if (_isInvalidTokenError(e)) {
                await markTokenRefreshRequired(client, userId, accountId, {
                    username,
                });
                await _notifyAccount({
                    type: "monthly_token_dead",
                    userId,
                    accountId,
                    username,
                });
            } else {
                console.error(`[MonthlyEnroll] ${username} error: ${e.message}`);
            }
        }
        await sleep(3);
    }
    return { processed, totalAccounts: accounts.length };
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
    sweepStaleAccounts,
    warmBuildNumber,

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

    // Monthly subscription
    createMonthlyPayment,
    getMonthlyPaymentById,
    getOpenMonthlyPayment,
    getMonthlySubscriptionRaw,
    cancelMonthlyPayment,
    expireStaleMonthlyPayments,
    activateMonthlySubscription,
    activateMonthlyFromPayment,
    getMonthlyAccounts,
    getUserAccountsStatus,
    runMonthlyBatch,
    runMonthlyEnrollScan,
};
