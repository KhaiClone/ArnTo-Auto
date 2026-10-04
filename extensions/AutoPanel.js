const axios = require("axios");

class AutoPanel {
    constructor(client) {
        this.client = client;
        this.apiUrl = process.env.PANEL_API_URL;
        this.apiKey = process.env.PANEL_API_KEY;

        if (this.apiUrl && this.apiKey) {
            this._registerRecoveryHandler();
        } else {
            console.warn(
                "[AutoPanel] PANEL_API_URL or PANEL_API_KEY is not set. Panel integration will be disabled.",
            );
        }
    }

    get isConfigured() {
        return !!this.apiUrl && !!this.apiKey;
    }

    _getHeaders() {
        return {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
        };
    }

    async fetchBots(buyerID) {
        if (!this.isConfigured) return [];
        try {
            const res = await axios.get(
                `${this.apiUrl}/api/external/bots?buyerID=${buyerID}`,
                {
                    headers: this._getHeaders(),
                },
            );
            return res.data;
        } catch (error) {
            console.error("[AutoPanel] Error fetching bots:", error.message);
            return [];
        }
    }

    async performAction(botId, action) {
        try {
            const res = await axios.post(
                `${this.apiUrl}/api/external/bots/${botId}/action`,
                { action },
                { headers: this._getHeaders() },
            );
            return res.data;
        } catch (error) {
            console.error(
                `[AutoPanel] Error performing action ${action} on bot ${botId}:`,
                error.message,
            );
            throw error;
        }
    }

    async extendBot(botId, months) {
        try {
            const res = await axios.post(
                `${this.apiUrl}/api/external/bots/${botId}/extend`,
                { months },
                { headers: this._getHeaders() },
            );
            return res.data;
        } catch (error) {
            console.error(
                `[AutoPanel] Error extending bot ${botId}:`,
                error.message,
            );
            throw error;
        }
    }

    async upgradeBot(botId, additionalRam) {
        try {
            const res = await axios.post(
                `${this.apiUrl}/api/external/bots/${botId}/upgrade`,
                { additionalRam },
                { headers: this._getHeaders() },
            );
            return res.data;
        } catch (error) {
            console.error(
                `[AutoPanel] Error upgrading bot ${botId}:`,
                error.message,
            );
            throw error;
        }
    }

    /**
     * Called automatically if the bot was restarted while waiting for a VietQR payment.
     * context contains: userId, botId, type ("extend" | "upgrade"), value (months | additionalRam)
     */
    _registerRecoveryHandler() {
        if (!this.client.autoBank) return;

        this.client.autoBank.registerMissedHandler("panel_payment", async (client, entry) => {
            const { context } = entry;
            if (!context) return;
            await this.applyPayment(context, "recovered");
        });
    }

    /** Applies a paid extend / upgrade and DMs the buyer (templates auto.panelbot.dm.*). */
    async applyPayment(context, via) {
        try {
            if (context.type === "extend") {
                await this.extendBot(context.botId, context.value);
                console.log(`[AutoPanel] Payment applied for bot ${context.botId} (extended ${context.value} months, ${via})`);
            } else if (context.type === "upgrade") {
                await this.upgradeBot(context.botId, context.value);
                console.log(`[AutoPanel] Payment applied for bot ${context.botId} (upgraded ${context.value} MB RAM, ${via})`);
            } else return;
            await this._notifyUser(context.userId, "auto.panelbot.dm.applied", { payment: AutoPanel.paymentVars(context), via });
        } catch (error) {
            console.error("[AutoPanel] Applying payment failed:", error.message);
            await this._notifyUser(context.userId, "auto.panelbot.dm.failed", { payment: AutoPanel.paymentVars(context), via, error: error.message });
        }
    }

    /** A customer's bot as templates see it (type customerBot). */
    static botVars(bot = {}) {
        const live = bot.live || {};
        return {
            id: bot._id ?? "",
            botID: bot.botID ?? "",
            name: bot.name || bot.botID || "",
            status: live.status || "",
            online: live.status === "online",
            maxMemory: bot.maxMemory || "",
            restarts: live.restarts || 0,
            uptime: live.uptime || null,
            expiresAt: bot.expiresAt || null,
            __text: bot.name || bot.botID || "",
        };
    }

    /** An extend / upgrade payment as templates see it (type botPayment). */
    static paymentVars(context = {}, extra = {}) {
        return {
            action: context.type ?? "",
            botId: context.botId ?? "",
            botName: context.botName ?? context.botId ?? "",
            value: context.value ?? 0,
            amount: context.amount ?? 0,
            transferCode: context.transferCode ?? "",
            qrUrl: context.qrUrl ?? null,
            expireMinutes: context.expireMinutes ?? 10,
            ...extra,
        };
    }

    async _notifyUser(userId, key, vars = {}) {
        try {
            const user = await this.client.users.fetch(userId);
            if (user) {
                await user.send(this.client.ui.message(key, { user: this.client.ui.user(user), ...vars })).catch(() => {});
            }
        } catch (err) {
            // Ignore
        }
    }
}

module.exports = AutoPanel;
