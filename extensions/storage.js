const { createCipheriv, createDecipheriv, createHash, randomBytes } = require("crypto");

const TOKEN_ALGORITHM = "aes-256-gcm";
const TOKEN_IV_BYTES = 12;
const DB_MODEL = "accounts";

function getTokenKey(secret) {
    return createHash("sha256").update(secret).digest();
}

function hashToken(token) {
    return createHash("sha256").update(token).digest("hex");
}

function hasEncryptedToken(record) {
    return typeof record?.tokenEncrypted === "string" && typeof record?.tokenIv === "string" && typeof record?.tokenTag === "string";
}

function encryptToken(token, secret) {
    const iv = randomBytes(TOKEN_IV_BYTES);
    const cipher = createCipheriv(TOKEN_ALGORITHM, getTokenKey(secret), iv);
    const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        tokenEncrypted: encrypted.toString("base64"),
        tokenIv: iv.toString("base64"),
        tokenTag: tag.toString("base64"),
        tokenHash: hashToken(token),
    };
}

function decryptToken(record, secret) {
    if (typeof record?.token === "string" && record.token.trim()) return record.token.trim();
    if (!hasEncryptedToken(record)) return null;
    try {
        const decipher = createDecipheriv(TOKEN_ALGORITHM, getTokenKey(secret), Buffer.from(record.tokenIv, "base64"));
        decipher.setAuthTag(Buffer.from(record.tokenTag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(record.tokenEncrypted, "base64")), decipher.final()]).toString("utf8");
    } catch { return null; }
}

function normalizeQuestBatchNotification(record) {
    const n = record?.questBatchNotification;
    if (!n || typeof n !== "object" || Array.isArray(n)) return null;
    const signature = typeof n.signature === "string" && n.signature ? n.signature : null;
    const status = n.status === "started" || n.status === "completed" ? n.status : null;
    if (!signature || !status) return null;
    return { signature, status };
}

function normalizeOrderLogPending(record) {
    const p = record?.orderLogPending;
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    const messageId = typeof p.messageId === "string" && p.messageId.trim() ? p.messageId.trim() : null;
    if (!messageId) return null;
    return { messageId, footerText: typeof p.footerText === "string" ? p.footerText : "" };
}

function normalizeSelectedQuestIds(record) {
    const raw = record?.selectedQuestIds;
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map((id) => String(id)).filter(Boolean))];
}

function buildSecureRecord(record, token, secret) {
    const secureToken = hasEncryptedToken(record) && !record.token
        ? { tokenEncrypted: record.tokenEncrypted, tokenIv: record.tokenIv, tokenTag: record.tokenTag, tokenHash: typeof record.tokenHash === "string" ? record.tokenHash : hashToken(token) }
        : encryptToken(token, secret);
    return {
        ...secureToken,
        username: typeof record.username === "string" && record.username ? record.username : "Unknown",
        addedAt: typeof record.addedAt === "string" ? record.addedAt : new Date().toISOString(),
        expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null,
        month: Number.isInteger(record.month) && record.month > 0 ? record.month : null,
        questBatchNotification: normalizeQuestBatchNotification(record),
        orderLogPending: normalizeOrderLogPending(record),
        selectedQuestIds: normalizeSelectedQuestIds(record),
    };
}

function buildRefreshRecord(record) {
    return {
        username: typeof record.username === "string" && record.username ? record.username : "Unknown",
        addedAt: typeof record.addedAt === "string" ? record.addedAt : new Date().toISOString(),
        expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null,
        month: Number.isInteger(record.month) && record.month > 0 ? record.month : null,
        needsTokenRefresh: true,
        questBatchNotification: normalizeQuestBatchNotification(record),
        orderLogPending: normalizeOrderLogPending(record),
        selectedQuestIds: normalizeSelectedQuestIds(record),
    };
}

function hasRefreshFlag(record) { return record?.needsTokenRefresh === true; }

async function readRaw(db) { return (await db.get(DB_MODEL)) ?? {}; }
async function writeRaw(db, data) { await db.set(DB_MODEL, data); }

// ── Public API (all take `client` as first arg) ────────────────────────────────

async function loadAccounts(client) {
    const secret = client.configs.settings.token;
    const rawData = await readRaw(client.db);
    const normalized = {};
    const persistent = {};
    let changed = false;

    for (const [userId, accounts] of Object.entries(rawData)) {
        if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) { changed = true; continue; }
        for (const [accountId, record] of Object.entries(accounts)) {
            if (!record || typeof record !== "object" || Array.isArray(record)) { changed = true; continue; }
            const token = decryptToken(record, secret);
            if (!token) {
                if (!persistent[userId]) persistent[userId] = {};
                persistent[userId][accountId] = hasRefreshFlag(record) ? buildRefreshRecord(record) : record;
                continue;
            }
            if (!normalized[userId]) normalized[userId] = {};
            normalized[userId][accountId] = {
                token,
                username: typeof record.username === "string" && record.username ? record.username : "Unknown",
                addedAt: typeof record.addedAt === "string" ? record.addedAt : new Date().toISOString(),
                expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null,
                month: Number.isInteger(record.month) && record.month > 0 ? record.month : null,
                questBatchNotification: normalizeQuestBatchNotification(record),
                orderLogPending: normalizeOrderLogPending(record),
                selectedQuestIds: normalizeSelectedQuestIds(record),
            };
            if (!persistent[userId]) persistent[userId] = {};
            const secureRecord = buildSecureRecord(record, token, secret);
            persistent[userId][accountId] = secureRecord;
            if (typeof record.token === "string" || !hasEncryptedToken(record) || hasRefreshFlag(record)) changed = true;
        }
    }
    if (changed) await writeRaw(client.db, persistent);
    return normalized;
}

async function saveAccounts(client, data) {
    const secret = client.configs.settings.token;
    const rawData = await readRaw(client.db);
    const persistent = {};

    for (const [userId, accounts] of Object.entries(data ?? {})) {
        if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) continue;
        for (const [accountId, record] of Object.entries(accounts)) {
            if (!record || typeof record !== "object" || Array.isArray(record)) continue;
            const token = decryptToken(record, secret) ?? (typeof record.token === "string" ? record.token.trim() : "");
            if (!token) continue;
            if (!persistent[userId]) persistent[userId] = {};
            persistent[userId][accountId] = buildSecureRecord(record, token, secret);
        }
    }

    for (const [userId, accounts] of Object.entries(rawData)) {
        if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) continue;
        for (const [accountId, record] of Object.entries(accounts)) {
            if (!record || typeof record !== "object" || Array.isArray(record)) continue;
            if (decryptToken(record, secret) || !hasRefreshFlag(record)) continue;
            if (!persistent[userId]) persistent[userId] = {};
            if (!persistent[userId][accountId]) persistent[userId][accountId] = buildRefreshRecord(record);
        }
    }
    await writeRaw(client.db, persistent);
}

async function getTokenRefreshRecord(client, userId) {
    const rawData = await readRaw(client.db);
    const userRecords = rawData[userId];
    if (!userRecords || typeof userRecords !== "object" || Array.isArray(userRecords)) return null;
    const candidates = Object.entries(userRecords)
        .filter(([, r]) => r && typeof r === "object" && !Array.isArray(r) && hasRefreshFlag(r))
        .sort((a, b) => new Date(b[1].addedAt ?? 0).getTime() - new Date(a[1].addedAt ?? 0).getTime());
    const match = candidates[0];
    if (!match) return null;
    return { accountId: match[0], ...buildRefreshRecord(match[1]) };
}

async function markTokenRefreshRequired(client, userId, accountId, record = {}) {
    const rawData = await readRaw(client.db);
    const current = rawData[userId]?.[accountId] ?? {};
    if (!rawData[userId]) rawData[userId] = {};
    rawData[userId][accountId] = buildRefreshRecord({ ...current, ...record });
    await writeRaw(client.db, rawData);
    return { accountId, ...rawData[userId][accountId] };
}

async function getStoredAccountOwner(client, accountId) {
    const rawData = await readRaw(client.db);
    for (const [userId, accounts] of Object.entries(rawData)) {
        if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) continue;
        if (accounts[accountId] && typeof accounts[accountId] === "object") return userId;
    }
    return null;
}

async function hasStoredAccountEntry(client, userId, accountId) {
    const rawData = await readRaw(client.db);
    const record = rawData[userId]?.[accountId];
    return Boolean(record && typeof record === "object" && !Array.isArray(record));
}

async function getQuestBatchNotification(client, userId, accountId) {
    const rawData = await readRaw(client.db);
    const record = rawData[userId]?.[accountId];
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    return normalizeQuestBatchNotification(record);
}

async function setQuestBatchNotification(client, userId, accountId, notification) {
    const rawData = await readRaw(client.db);
    const record = rawData[userId]?.[accountId];
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const normalized = normalizeQuestBatchNotification({ questBatchNotification: notification });
    rawData[userId][accountId] = { ...record, questBatchNotification: normalized };
    await writeRaw(client.db, rawData);
    return normalized;
}

async function getOrderLogPending(client, userId, accountId) {
    const rawData = await readRaw(client.db);
    const record = rawData[userId]?.[accountId];
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    return normalizeOrderLogPending(record);
}

async function setOrderLogPending(client, userId, accountId, pending) {
    const rawData = await readRaw(client.db);
    const record = rawData[userId]?.[accountId];
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const normalized = pending == null ? null : normalizeOrderLogPending({ orderLogPending: pending });
    rawData[userId][accountId] = { ...record, orderLogPending: normalized };
    await writeRaw(client.db, rawData);
    return normalized;
}

async function getStoredSelectedQuestIds(client, userId, accountId) {
    const rawData = await readRaw(client.db);
    const record = rawData[userId]?.[accountId];
    if (!record || typeof record !== "object" || Array.isArray(record)) return [];
    return normalizeSelectedQuestIds(record);
}

async function setStoredSelectedQuestIds(client, userId, accountId, ids) {
    const rawData = await readRaw(client.db);
    const record = rawData[userId]?.[accountId];
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const normalized = [...new Set((ids ?? []).map((id) => String(id)).filter(Boolean))];
    rawData[userId][accountId] = { ...record, selectedQuestIds: normalized };
    await writeRaw(client.db, rawData);
    return normalized;
}

module.exports = {
    loadAccounts, saveAccounts, getTokenRefreshRecord, markTokenRefreshRequired,
    getStoredAccountOwner, hasStoredAccountEntry,
    getQuestBatchNotification, setQuestBatchNotification,
    getOrderLogPending, setOrderLogPending,
    getStoredSelectedQuestIds, setStoredSelectedQuestIds,
    decryptToken, encryptToken, buildRefreshRecord,
};
