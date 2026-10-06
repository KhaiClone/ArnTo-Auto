const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

class AutoBank {
    /**
     * @param {import("discord.js").Client} client
     * @param {string} vietqrChannelId - Channel ID where VietQR sends webhook messages
     * @param {string} logWebhookUrl   - Discord webhook URL for payment status logs
     */
    constructor(client, vietqrChannelId, logWebhookUrl) {
        this.client = client;
        this.vietqrChannelId = vietqrChannelId;
        this.logWebhookUrl = logWebhookUrl;

        // In-memory callbacks: customId -> Function
        // Lost on restart — _missedHandlers covers that case
        this._callbacks = new Map();

        // Active timeouts: customId -> TimeoutHandle
        this._timeouts = new Map();

        // Named recovery handlers: handlerName -> async Function(client, entry)
        // Registered by each feature on startup via registerMissedHandler()
        // Looked up by entry.context._handler when callback is missing after restart
        this._missedHandlers = new Map();

        this._listen();
    }

    // ─────────────────────────────────────────────
    //  PUBLIC API
    // ─────────────────────────────────────────────

    /**
     * Register a named recovery handler for a specific feature.
     * Must be called on every bot startup before any payments can arrive.
     * When the bot restarts and a live payment arrives with no in-memory callback,
     * AutoBank looks up entry.context._handler and calls this function instead.
     *
     * @param {string} handlerName - Unique name matching the _handler field in context
     * @param {Function} fn        - async (client, entry) => void
     *                               entry = { customId, amount, context, message }
     *
     * @example
     * client.autoBank.registerMissedHandler("quest_payment", async (client, entry) => {
     *     const { markPaymentAsPaid, unlockPaymentIfPaid } = require("./autoQuest");
     *     const paid = await markPaymentAsPaid(client, entry.context.paymentId);
     *     if (paid) await unlockPaymentIfPaid(client, paid);
     * });
     */
    registerMissedHandler(handlerName, fn) {
        if (typeof fn !== "function")
            throw new Error(
                `AutoBank: handler "${handlerName}" must be a function`,
            );
        this._missedHandlers.set(handlerName, fn);
    }

    /**
     * Register a pending payment with AutoBank.
     *
     * @param {number}   amount   - Payment amount in VND
     * @param {string}   customId - The transferCode that appears in the VietQR webhook message
     * @param {Object}   context  - Data to persist in DB (must include _handler: "your_handler_name")
     * @param {Function} callback - (err, data) => void — called on payment or timeout
     *
     * @example
     * client.autoBank.createQR(50000, transferCode, {
     *     _handler: "quest_payment",   // <-- links to registerMissedHandler
     *     paymentId: payment.id,
     *     userId: interaction.user.id,
     * }, (err, data) => {
     *     if (err) return; // timeout
     *     // handle live payment
     * });
     */
    createQR(amount, customId, context = {}, callback) {
        this._callbacks.set(customId, callback);
        this._scheduleTimeout(customId, TIMEOUT_MS);
    }

    /**
     * Call once on bot ready. Fetches missed messages from the VietQR channel,
     * matches against pending DB entries, fires recovery handlers for paid ones,
     * and reschedules timeouts for entries still within their window.
     *
     * @returns {Promise<{ paid: Array, expired: Array }>}
     */
    async recover() {
        const paid = [];
        const expired = [];
        const pending = await this.client.db.find("autobank_pending");
        if (!pending || pending.length === 0) return { paid, expired };

        let missedMessages = [];
        try {
            const channel = await this.client.channels.fetch(
                this.vietqrChannelId,
            );
            if (channel) {
                const fetched = await channel.messages.fetch({ limit: 100 });
                missedMessages = fetched.map((m) => m.content);
            }
        } catch (err) {
            console.error(
                "[AutoBank] Failed to fetch missed messages:",
                err.message,
            );
        }

        const now = Date.now();
        for (const entry of pending) {
            const matchedMessage = missedMessages.find((c) =>
                c.includes(entry.customId),
            );

            if (matchedMessage) {
                await this.client.db.findOneAndDelete("autobank_pending", {
                    customId: entry.customId,
                });
                await this._sendLog("PAID_MISSED", {
                    ...entry,
                    message: matchedMessage,
                });
                paid.push({
                    customId: entry.customId,
                    amount: entry.amount,
                    context: entry.context,
                    message: matchedMessage,
                });
                continue;
            }

            if (now >= entry.expireAt) {
                await this.client.db.findOneAndDelete("autobank_pending", {
                    customId: entry.customId,
                });
                await this._sendLog("EXPIRED_MISSED", entry);
                expired.push({
                    customId: entry.customId,
                    amount: entry.amount,
                    context: entry.context,
                });
                continue;
            }

            // Still within window — reschedule timeout (callback is gone after restart)
            this._scheduleTimeout(entry.customId, entry.expireAt - now);
        }

        return { paid, expired };
    }

    // ─────────────────────────────────────────────
    //  INTERNAL
    // ─────────────────────────────────────────────

    _scheduleTimeout(customId, delay) {
        const handle = setTimeout(async () => {
            this._timeouts.delete(customId);
            const entry = await this.client.db.findOneAndDelete(
                "autobank_pending",
                { customId },
            );

            const callback = this._callbacks.get(customId);
            this._callbacks.delete(customId);

            if (!callback) return; // Already paid and handled

            await this._sendLog(
                "EXPIRED",
                entry ?? { customId, amount: 0, context: {} },
            );
            callback(new Error("TIMEOUT"), {
                customId,
                context: entry?.context ?? {},
            });
        }, delay);
        this._timeouts.set(customId, handle);
    }

    _listen() {
        this.client.on("messageCreate", async (message) => {
            if (message.channelId !== this.vietqrChannelId) return;
            await this._handleMessage(message.content);
        });
    }

    async _handleMessage(content) {
        const pending = await this.client.db.find("autobank_pending");
        if (!pending || pending.length === 0) return;

        for (const entry of pending) {
            if (!content.includes(entry.customId)) continue;

            // Cancel scheduled timeout
            const handle = this._timeouts.get(entry.customId);
            if (handle) {
                clearTimeout(handle);
                this._timeouts.delete(entry.customId);
            }

            // Remove from DB
            await this.client.db.findOneAndDelete("autobank_pending", {
                customId: entry.customId,
            });
            await this._sendLog("PAID", { ...entry, message: content });

            const callback = this._callbacks.get(entry.customId);
            this._callbacks.delete(entry.customId);

            if (callback) {
                // Normal flow: bot was running, fire the in-memory callback
                callback(null, {
                    customId: entry.customId,
                    amount: entry.amount,
                    context: entry.context,
                    message: content,
                });
            } else {
                // Bot restarted: callback is gone — look up the named recovery handler
                const handlerName = entry.context?._handler;
                const missedHandler = handlerName
                    ? this._missedHandlers.get(handlerName)
                    : null;

                if (missedHandler) {
                    try {
                        await missedHandler(this.client, {
                            customId: entry.customId,
                            amount: entry.amount,
                            context: entry.context,
                            message: content,
                        });
                    } catch (e) {
                        console.error(
                            `[AutoBank] missedHandler "${handlerName}" error: ${e.message}`,
                        );
                    }
                } else {
                    console.warn(
                        `[AutoBank] Payment received but no handler found for "${handlerName}" — customId: ${entry.customId}`,
                    );
                }
            }
            break;
        }
    }

    async _sendLog(status, entry) {
        if (!this.logWebhookUrl) return;

        const colors = {
            PAID: 0x57f287,
            EXPIRED: 0xed4245,
            PAID_MISSED: 0xfee75c,
            EXPIRED_MISSED: 0xeb459e,
        };
        const labels = {
            PAID: "✅ Payment Received",
            EXPIRED: "❌ Payment Expired",
            PAID_MISSED: "⚠️ Missed Payment (Recovered)",
            EXPIRED_MISSED: "⏰ Missed Expiry (Recovered)",
        };

        const embed = {
            title: labels[status] || status,
            color: colors[status] || 0x99aab5,
            fields: [
                {
                    name: "type handle",
                    value: `\`${entry.context?._handler}\``,
                    inline: true,
                },
                {
                    name: "user",
                    value: `<@${entry.context?.userId}> \`${entry.context?.userId}\``,
                },
                {
                    name: "Custom ID",
                    value: `\`${entry.customId}\``,
                    inline: true,
                },
                {
                    name: "Amount",
                    value: `${Number(entry.amount).toLocaleString()} VND`,
                    inline: true,
                },
                { name: "Status", value: status, inline: true },
            ],
            timestamp: new Date().toISOString(),
            footer: { text: "AutoBank" },
        };

        if (entry.message) {
            embed.fields.push({
                name: "Webhook Message",
                value: String(entry.message).slice(0, 1024),
                inline: false,
            });
        }

        try {
            await fetch(this.logWebhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ embeds: [embed] }),
            });
        } catch (err) {
            console.error("[AutoBank] Failed to send log:", err.message);
        }
    }
}

module.exports = AutoBank;
