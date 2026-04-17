const {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
} = require("crypto");
const { nanoid } = require("nanoid");

const TOKEN_ALGORITHM = "aes-256-gcm";
const TOKEN_IV_BYTES = 12;
const EXPIRE_MS = 10 * 60_000;
const PAYMENTS_MODEL = "quest_payments";
const ACTIVATIONS_MODEL = "quest_pending_activations";

function getTokenKey(secret) {
    return createHash("sha256").update(secret).digest();
}

function encryptToken(token, secret) {
    const iv = randomBytes(TOKEN_IV_BYTES);
    const cipher = createCipheriv(TOKEN_ALGORITHM, getTokenKey(secret), iv);
    const encrypted = Buffer.concat([
        cipher.update(token, "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
        tokenEncrypted: encrypted.toString("base64"),
        tokenIv: iv.toString("base64"),
        tokenTag: tag.toString("base64"),
    };
}

function decryptToken(record, secret) {
    if (!record?.tokenEncrypted || !record?.tokenIv || !record?.tokenTag)
        return null;
    try {
        const decipher = createDecipheriv(
            TOKEN_ALGORITHM,
            getTokenKey(secret),
            Buffer.from(record.tokenIv, "base64"),
        );
        decipher.setAuthTag(Buffer.from(record.tokenTag, "base64"));
        return Buffer.concat([
            decipher.update(Buffer.from(record.tokenEncrypted, "base64")),
            decipher.final(),
        ]).toString("utf8");
    } catch {
        return null;
    }
}

function now() {
    return Date.now();
}
function newPaymentId() {
    return `QP${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
function randomCode() {
    return `${nanoid(5)} Chuyen tien`;
}

async function readPayments(client) {
    return (await client.db.get(PAYMENTS_MODEL)) ?? [];
}
async function savePayments(client, list) {
    await client.db.set(PAYMENTS_MODEL, list);
}
async function readActivations(client) {
    return (await client.db.get(ACTIVATIONS_MODEL)) ?? [];
}
async function saveActivations(client, list) {
    await client.db.set(ACTIVATIONS_MODEL, list);
}

async function generateUniqueCode(client) {
    const list = await readPayments(client);
    const active = new Set(
        list
            .filter(
                (i) => i.status === "pending" && Number(i.expiresAt) > now(),
            )
            .map((i) => i.transferCode),
    );
    for (let i = 0; i < 100; i++) {
        const code = randomCode();
        if (!active.has(code)) return code;
    }
    return `${nanoid(5)} Chuyen tien`;
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
    const transferCode = await generateUniqueCode(client);

    const payment = {
        id: newPaymentId(),
        type: "quest",
        userId,
        accountId,
        selectedQuestIds,
        amount,
        transferCode,
        status: "pending",
        createdAt: now(),
        expiresAt: now() + EXPIRE_MS,
        paidAt: null,
    };

    const list = await readPayments(client);
    list.push(payment);
    await savePayments(client, list);

    // Register with AutoBank — use transferCode as customId so it matches the VietQR webhook message
    if (client.autoBank) {
        const context = {
            paymentId: payment.id,
            userId,
            accountId,
            transferCode,
        };

        client.autoBank.createQR(amount, transferCode, context, async (err) => {
            if (err) return; // timeout — expireStalePayments handles cleanup
            const paidPayment = await markPaid(client, payment.id);
            if (paidPayment) {
                // Bug 3 fix: trigger quest unlock/start after payment confirmed
                const {
                    _unlockPaymentIfPaid,
                } = require("../events/discord/client/ready");
                await _unlockPaymentIfPaid(client, paidPayment).catch((e) => {
                    console.warn(
                        `[payments] unlock error for ${payment.id}: ${e.message}`,
                    );
                });

                // Notify user
                try {
                    const user = await client.users
                        .fetch(userId)
                        .catch(() => null);
                    if (user) {
                        await user.send({
                            embeds: [
                                client.embed(
                                    [
                                        `Mã đơn: \`${payment.id}\``,
                                        `Số tiền: ${Number(payment.amount).toLocaleString("vi-VN")}đ`,
                                        `Đã mở chạy ${selectedQuestIds.length} quest đã chọn.`,
                                    ].join("\n"),
                                    {
                                        title: "Đã xác nhận thanh toán",
                                        color: 0x57f287,
                                    },
                                ),
                            ],
                        });
                    }
                } catch (e) {
                    console.warn(`[payments] DM notify error: ${e.message}`);
                }
            }
        });

        // Store in AutoBank DB for recovery on restart — customId must be transferCode
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
    return (await readPayments(client)).find((i) => i.id === paymentId) ?? null;
}

async function getOpenPendingPayment(client, userId, accountId) {
    return (
        (await readPayments(client)).find(
            (i) =>
                i.status === "pending" &&
                Number(i.expiresAt) > now() &&
                i.userId === userId &&
                i.accountId === accountId,
        ) ?? null
    );
}

async function cancelPayment(client, paymentId) {
    const list = await readPayments(client);
    const idx = list.findIndex((i) => i.id === paymentId);
    if (idx < 0) return null;
    list[idx] = { ...list[idx], status: "cancelled" };
    await savePayments(client, list);
    return list[idx];
}

async function markPaid(client, paymentId) {
    const list = await readPayments(client);
    const idx = list.findIndex((i) => i.id === paymentId);
    if (idx < 0) return null;
    list[idx] = { ...list[idx], status: "paid", paidAt: now() };
    await savePayments(client, list);
    return list[idx];
}

async function expireStalePayments(client) {
    const current = now();
    const list = await readPayments(client);
    let changed = false;
    const expiredNow = [];

    const nextList = list.map((item) => {
        if (item.status === "pending" && Number(item.expiresAt) <= current) {
            changed = true;
            const exp = { ...item, status: "expired" };
            expiredNow.push(exp);
            return exp;
        }
        return item;
    });
    if (changed) await savePayments(client, nextList);

    const activations = await readActivations(client);
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
        await saveActivations(client, nextActivations);

    return expiredNow;
}

async function upsertPendingActivation(
    client,
    {
        paymentId,
        userId,
        accountId,
        token,
        selectedQuestIds,
        hypeSquadHouseId,
        hypeSquadHouseName,
    },
) {
    const secret = client.configs.settings.token;
    const list = await readActivations(client);
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
        hypeSquadHouseId:
            hypeSquadHouseId != null ? String(hypeSquadHouseId) : null,
        hypeSquadHouseName:
            hypeSquadHouseName != null
                ? String(hypeSquadHouseName).trim()
                : null,
        ...encryptToken(token, secret),
        createdAt: now(),
        expiresAt: now() + EXPIRE_MS,
    };
    const idx = list.findIndex((i) => i.paymentId === paymentId);
    if (idx >= 0) list[idx] = { ...list[idx], ...next };
    else list.push(next);
    await saveActivations(client, list);
    return next;
}

async function getActivationByPaymentId(client, paymentId) {
    const secret = client.configs.settings.token;
    const item = (await readActivations(client)).find(
        (e) => e.paymentId === paymentId,
    );
    if (!item) return null;
    const token = decryptToken(item, secret);
    if (!token) return null;
    return {
        paymentId: item.paymentId,
        userId: item.userId,
        accountId: item.accountId,
        selectedQuestIds: Array.isArray(item.selectedQuestIds)
            ? item.selectedQuestIds
            : [],
        hypeSquadHouseId:
            typeof item.hypeSquadHouseId === "string"
                ? item.hypeSquadHouseId
                : null,
        hypeSquadHouseName:
            typeof item.hypeSquadHouseName === "string"
                ? item.hypeSquadHouseName
                : null,
        token,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
    };
}

async function removeActivationByPaymentId(client, paymentId) {
    const list = await readActivations(client);
    const next = list.filter((i) => i.paymentId !== paymentId);
    if (next.length !== list.length) await saveActivations(client, next);
}

async function getRecoverablePaidActivations(client) {
    const secret = client.configs.settings.token;
    const current = now();
    const payments = await readPayments(client);
    const paymentMap = new Map(payments.map((i) => [i.id, i]));
    const activations = await readActivations(client);
    const results = [];
    for (const a of activations) {
        if (Number(a.expiresAt) <= current) continue;
        const payment = paymentMap.get(a.paymentId);
        if (!payment || payment.status !== "paid") continue;
        const token = decryptToken(a, secret);
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
                hypeSquadHouseId:
                    typeof a.hypeSquadHouseId === "string"
                        ? a.hypeSquadHouseId
                        : null,
                hypeSquadHouseName:
                    typeof a.hypeSquadHouseName === "string"
                        ? a.hypeSquadHouseName
                        : null,
                token,
                createdAt: a.createdAt,
                expiresAt: a.expiresAt,
            },
        });
    }
    return results;
}

module.exports = {
    createQuestPayment,
    getPaymentById,
    getOpenPendingPayment,
    cancelPayment,
    markPaid,
    expireStalePayments,
    upsertPendingActivation,
    getActivationByPaymentId,
    removeActivationByPaymentId,
    getRecoverablePaidActivations,
    buildVietQrUrl,
};
