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

        this.client.autoBank.registerMissedHandler(
            "panel_payment",
            async (client, entry) => {
                const { context } = entry;
                if (!context) return;

                try {
                    if (context.type === "extend") {
                        await this.extendBot(context.botId, context.value);
                        console.log(
                            `[AutoPanel] Recovered payment for bot ${context.botId} (extended ${context.value} months)`,
                        );
                        this._notifyUser(
                            context.userId,
                            `✅ Đã nhận được thanh toán! Bot của bạn đã được gia hạn thêm **${context.value}** tháng.`,
                        );
                    } else if (context.type === "upgrade") {
                        await this.upgradeBot(context.botId, context.value);
                        console.log(
                            `[AutoPanel] Recovered payment for bot ${context.botId} (upgraded ${context.value} MB RAM)`,
                        );
                        this._notifyUser(
                            context.userId,
                            `✅ Đã nhận được thanh toán! RAM của bot đã được nâng cấp thêm **${context.value}** MB.`,
                        );
                    }
                } catch (error) {
                    console.error(
                        "[AutoPanel] Recovery failed:",
                        error.message,
                    );
                    this._notifyUser(
                        context.userId,
                        `❌ Đã nhận được thanh toán, nhưng có lỗi xảy ra khi áp dụng nâng cấp. Vui lòng liên hệ hỗ trợ. (Bot ID: ${context.botId})`,
                    );
                }
            },
        );
    }

    async _notifyUser(userId, message) {
        try {
            const user = await this.client.users.fetch(userId);
            if (user) {
                await user.send(message).catch(() => {});
            }
        } catch (err) {
            // Ignore
        }
    }
}

module.exports = AutoPanel;
