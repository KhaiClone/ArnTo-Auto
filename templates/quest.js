// Auto Quest: panel, nhập token, chọn quest, thanh toán (lẻ + gói tháng), trạng
// thái, DM cho khách, thông báo xong quest, log đơn, lệnh /quest-*.
const { embed, notice, field } = require("./_auto");

const G = {
    panel: "Auto Quest · panel",
    flow: "Auto Quest · nhập token & chọn quest",
    pay: "Auto Quest · thanh toán",
    status: "Auto Quest · trạng thái",
    dm: "Auto Quest · DM khách",
    notify: "Auto Quest · thông báo xong quest",
    log: "Auto Quest · log đơn (kênh admin)",
    cmd: "Auto Quest · lệnh /quest-*",
};

const GREEN = "#57f287";
const YELLOW = "#fee75c";
const RED = "#ed4245";
const BLURPLE = "#5865f2";
const PURPLE = "#9b59b6";

const ACCOUNT = "Account: **{account.username}** (`{account.accountId}`)";
const ACC_VARS = { account: "questAccount", user: "user" };
const ACC_FIELDS = [field("Tài khoản", "{account.username}"), field("ID", "`{account.accountId}`")];

const BANK_FIELDS = [
    field("Chủ tài khoản", "`{auto.bankHolder}`", false),
    field("Ngân hàng", "`{auto.bankCode}`"),
    field("Số tài khoản", "```\n{auto.bankAccount}\n```", false),
    field("Nội dung chuyển khoản", "```\n{payment.transferCode}\n```", false),
];

const LOG_FOOTER = { text: "{footer}" };
const LOG_HEAD = [field("👤 Khách hàng", "<@{userId}>"), field("🎮 Account", "{account.username}")];

module.exports = {
    types: {
        questAccount: {
            label: "Account Discord chạy quest",
            text: "username",
            fields: {
                accountId: { type: "id", label: "ID account", example: "1300000000000000000" },
                username: { label: "Tên account", example: "khachhang" },
            },
        },
        questItem: {
            label: "Quest",
            text: "name",
            fields: {
                id: { label: "ID quest", example: "1400000000000000000" },
                name: { label: "Tên quest", example: "Chơi Fortnite 15 phút" },
                taskType: { label: "Loại nhiệm vụ", example: "PLAY_ON_DESKTOP" },
            },
        },
        questStatus: {
            label: "Trạng thái một account",
            text: "username",
            fields: {
                accountId: { type: "id", label: "ID" },
                username: { label: "Tên", example: "khachhang" },
                plan: { label: "Gói (single / monthly)", example: "single" },
                planText: { label: "Gói (chữ)", example: "⚡ Quest lẻ" },
                status: { label: "Trạng thái trên panel (running / done / stopped / token_dead / error)", example: "running" },
                statusText: { label: "Trạng thái (chữ)", example: "Đang chạy" },
                tokenAlive: { type: "boolean", label: "Token còn sống", example: true },
                running: { type: "boolean", label: "Đang chạy", example: true },
                runningQuestCount: { type: "number", label: "Số quest đang chạy", example: 3 },
                completedCount: { type: "number", label: "Số quest đã xong", example: 2 },
                questsDone: { type: "number", label: "Quest xong (panel)", example: 2 },
                questsTotal: { type: "number", label: "Tổng quest (panel)", example: 5 },
                startedAt: { type: "time", label: "Bắt đầu lúc" },
                uptime: { label: "Đã chạy (chữ)", example: "2 giờ 5 phút" },
                monthlyExpiresAt: { type: "time", label: "Gói tháng hết hạn lúc" },
            },
        },
        questPayment: {
            label: "Thanh toán quest lẻ",
            text: "id",
            fields: {
                id: { label: "Mã đơn", example: "QPm1abcd" },
                count: { type: "number", label: "Số quest", example: 3 },
                unitPrice: { type: "money", label: "Đơn giá", example: 2000 },
                amount: { type: "money", label: "Tổng tiền", example: 6000 },
                transferCode: { label: "Nội dung chuyển khoản", example: "aB3dE5fG Chuyen tien" },
                qrUrl: { type: "url", label: "Ảnh QR" },
                status: { label: "Trạng thái (pending / paid / cancelled / expired)", example: "pending" },
            },
        },
        monthlyPayment: {
            label: "Thanh toán gói tháng",
            text: "paymentId",
            fields: {
                paymentId: { label: "Mã đơn", example: "QMm1abcd" },
                months: { type: "number", label: "Số tháng", example: 1 },
                unitPrice: { type: "money", label: "Đơn giá/tháng", example: 50000 },
                amount: { type: "money", label: "Tổng tiền", example: 50000 },
                transferCode: { label: "Nội dung chuyển khoản", example: "aB3dE5fG Chuyen tien" },
                qrUrl: { type: "url", label: "Ảnh QR" },
            },
        },
        restartResult: {
            label: "Kết quả restart một account",
            fields: {
                ok: { type: "boolean", label: "Thành công", example: true },
                username: { label: "Tên", example: "khachhang" },
                reason: { label: "Lý do lỗi", example: "" },
            },
        },
    },

    templates: {
        // ── Panel ────────────────────────────────────────────────────────────
        "auto.quest.panel": {
            group: G.panel,
            label: "Panel Auto Quest (/quest-setup)",
            description: "Tin công khai trong kênh. Cập nhật được các panel đã gửi từ trang Embeds.",
            refreshable: true,
            vars: { price: { type: "money", label: "Giá quest lẻ (từ trang Pricing)" }, monthlyPrice: { type: "money", label: "Giá gói tháng (từ trang Pricing)" } },
            slots: {
                single: { label: "Quest lẻ", emoji: "⚡", style: "Primary" },
                monthly: { label: "Quest tháng", emoji: "♾️", style: "Primary" },
                status: { label: "Kiểm tra trạng thái", emoji: "📊", style: "Secondary" },
                token: { label: "Cập nhật token", emoji: "🔑", style: "Secondary" },
            },
            message: {
                embeds: [
                    embed({
                        title: "Auto Quest - Tự động làm nhiệm vụ Discord",
                        description: "Nhấn nút bên dưới để chọn dịch vụ và bắt đầu.\nCách lấy token: {auto.tokenGuide}",
                        fields: [
                            field("⚡ Quest lẻ - done nhanh", "Chọn số quest cần làm, trả **{price|number}đ/quest**.\nBot chạy đúng số quest bạn đã chọn rồi dừng.", false),
                            field(
                                "♾️ Quest tháng - bot tự động",
                                "Trả **{monthlyPrice|number}đ/tháng**, không giới hạn số quest.\nBot tự làm **toàn bộ** quest trên account theo lịch **Thứ 3 & Thứ 7** hằng tuần, xong quest nào báo về DM.",
                                false,
                            ),
                            field("📊 Kiểm tra trạng thái", "Xem tất cả account bạn đã nhập: loại gói, thời hạn, tình trạng token, quest đang chạy.", false),
                            field("⏱ Lưu ý thanh toán", "QR có hạn 10 phút. Chuyển **đúng nội dung** để hệ thống tự xác nhận.", false),
                        ],
                        thumbnail:
                            "https://cdn.discordapp.com/attachments/1245991899450572912/1472842442083532922/1771223400597.png?ex=69e51f2a&is=69e3cdaa&hm=5cd91378b2cb945d82504bede11e04f1aa633510668895d7202b5adb19fe3937&",
                        image:
                            "https://cdn.discordapp.com/attachments/1245991899450572912/1495136698206785597/1776538764448.png?ex=69e5260f&is=69e3d48f&hm=daaf336b476311fe623beaa951ade085c33336ef2c403252bd85b93fc586b23b&",
                    }),
                ],
                components: [[{ slot: "single" }, { slot: "monthly" }], [{ slot: "status" }, { slot: "token" }]],
            },
        },
        "auto.quest.tokenModal": {
            kind: "card",
            group: G.flow,
            label: "Form nhập token",
            vars: {},
            texts: {
                titleNew: "Nhập token Discord",
                titleRefresh: "Nhập lại token Discord",
                titleMonthly: "Nhập token Discord (gói tháng)",
                label: "Discord token",
                placeholder: "Dán token vào đây",
            },
        },

        // ── Nhập token & chọn quest ──────────────────────────────────────────
        "auto.quest.activated": {
            group: G.flow,
            label: "Kích hoạt thành công + chọn quest",
            description: "Sau khi nhập token. {hasQuests} = có quest để chọn (hiện menu) hay chưa.",
            vars: { account: "questAccount", quests: "questItem[]", hasQuests: "boolean", user: "user" },
            slotVars: { pick: "questItem" },
            message: {
                embeds: [
                    embed({ title: "Kích hoạt thành công", color: GREEN, fields: ACC_FIELDS, footer: "Bot đã bắt đầu chạy quest. Dùng /status để theo dõi.", timestamp: true }),
                    { ...embed({ title: "Chọn quest để chạy", description: "Chọn một hoặc nhiều quest bên dưới. Bot chỉ chạy các quest bạn chọn.", color: BLURPLE }), if: "hasQuests" },
                    {
                        ...embed({ title: "Chưa có quest để chọn", description: "Hiện chưa có quest phù hợp. Khi có quest mới, bấm Nhập token để chọn lại.", color: YELLOW }),
                        if: "!hasQuests",
                    },
                ],
            },
            selects: { pick: { placeholder: "Chọn quest muốn chạy (có thể chọn nhiều)", label: "{name}", description: "{taskType}" } },
        },
        "auto.quest.activateFailed": notice(G.flow, "Kích hoạt thất bại", { title: "Kích hoạt thất bại", description: "{reason}" }, { reason: "string" }),
        "auto.quest.error": notice(G.flow, "Lỗi chung", { title: "Có lỗi xảy ra", description: "{error}" }, { error: "string" }),
        "auto.quest.noRefreshable": notice(
            G.flow,
            "Không có account chờ cập nhật token",
            {
                title: "🔑 Cập nhật token",
                color: YELLOW,
                description: "Bạn không có account nào đang chờ cập nhật token. Nút này chỉ dùng khi bot báo token của bạn bị lỗi, hoặc khi bạn đang có gói tháng.",
            },
            { user: "user" },
        ),
        "auto.quest.notWaitingToken": notice(G.flow, "Account không chờ nhập lại token", { title: "Không thể nhập lại token", description: "Account này không còn ở trạng thái chờ nhập lại token." }, { accountId: "id" }),
        "auto.quest.wrongAccount": notice(G.flow, "Nhập token sai account", { title: "Sai account", description: "Bạn chỉ được nhập lại token của account `{accountId}`." }, { accountId: "id" }),
        "auto.quest.noOrderWaiting": notice(
            G.flow,
            "Account không có đơn chờ token",
            { title: "Không thể nhập lại token", description: "Account `{accountId}` không có đơn quest nào đang chờ token. Nếu chưa mua, bấm **Quest lẻ** hoặc **Quest tháng**." },
            { accountId: "id" },
        ),
        "auto.quest.noOrderFound": notice(G.flow, "Không thấy đơn chờ token", { title: "Không thể nhập lại token", description: "Không tìm thấy đơn quest nào đang chờ token cho account này." }, { accountId: "id" }),
        "auto.quest.accountGone": notice(G.flow, "Account không còn chạy (chọn quest)", { title: "Không tìm thấy account", description: "Account này không còn chạy hoặc không thuộc về bạn." }, { accountId: "id" }),
        "auto.quest.staffFree": notice(
            G.flow,
            "Kích hoạt miễn phí (staff)",
            { title: "Đã kích hoạt miễn phí", color: GREEN, description: "Đã mở chạy **{count}** quest đã chọn (miễn phí — Staff).", footer: "Bot bắt đầu chạy quest. Dùng /status để theo dõi.", timestamp: true },
            { count: "number", account: "questAccount" },
        ),
        "auto.quest.tokenUpdated": notice(
            G.flow,
            "Token đã cập nhật (đơn lẻ)",
            {
                title: "Token đã được cập nhật",
                color: GREEN,
                fields: ACC_FIELDS,
                description: "{#if resumed}Bot đang tiếp tục chạy các quest đã chọn trước đó.{#else}Token đã được cập nhật. Hãy chọn lại quest để tiếp tục.{/if}",
                timestamp: true,
            },
            { ...ACC_VARS, resumed: { type: "boolean", label: "Đã chạy tiếp quest cũ", example: true } },
        ),
        "auto.quest.tokenUpdatedPanel": notice(
            G.flow,
            "Token đã cập nhật (đơn panel chạy)",
            { title: "Token đã được cập nhật", color: GREEN, description: "Bot đang chạy tiếp các quest đã mua của account này.", fields: ACC_FIELDS, timestamp: true },
            ACC_VARS,
        ),
        "auto.quest.monthlyTokenUpdated": notice(
            G.flow,
            "Token đã cập nhật (gói tháng, từ nút Cập nhật token)",
            { title: "Token đã được cập nhật (gói tháng)", color: GREEN, description: "Đã cập nhật token mới cho gói tháng (không mất phí). Bot sẽ tiếp tục chạy quest theo lịch.", timestamp: true },
            ACC_VARS,
        ),

        // ── Gói tháng ────────────────────────────────────────────────────────
        "auto.quest.monthly.ownedByOther": notice(G.flow, "Gói tháng: account thuộc người khác", { title: "Không thể đăng ký", description: "Discord account này đã được gán cho user khác." }, ACC_VARS),
        "auto.quest.monthly.tokenRefreshed": notice(
            G.flow,
            "Gói tháng: đã cập nhật token (nút Quest tháng)",
            { title: "Đã cập nhật token gói tháng", color: GREEN, description: `${ACCOUNT}\nGói còn hạn tới: {expiresAt|time:f}\nĐã cập nhật token mới cho gói hiện tại (không mất phí).`, timestamp: true },
            { ...ACC_VARS, expiresAt: { type: "time", label: "Hết hạn lúc" } },
        ),
        "auto.quest.monthly.staffFree": notice(
            G.flow,
            "Gói tháng: kích hoạt miễn phí (staff)",
            {
                title: "Đã kích hoạt gói tháng (miễn phí)",
                color: GREEN,
                description: `${ACCOUNT}\nHạn tới: {expiresAt|time:f}\nĐã kích hoạt gói tháng miễn phí (Staff). Bot chạy toàn bộ quest vào Thứ 3 & Thứ 7.`,
                timestamp: true,
            },
            { ...ACC_VARS, expiresAt: { type: "time", label: "Hết hạn lúc" } },
        ),
        "auto.quest.monthly.payment": {
            group: G.pay,
            label: "QR gói tháng",
            description: "{state} = created (vừa tạo) / existed (đã có đơn chờ).",
            vars: { payment: "monthlyPayment", account: "questAccount", state: { type: "string", label: "created / existed", example: "created" } },
            slots: { cancel: { label: "Hủy đơn", style: "Danger" } },
            message: {
                embeds: [
                    embed({
                        title: "Gia hạn Auto Quest theo tháng",
                        color: PURPLE,
                        description:
                            '{#if state == "existed"}Bạn đã có đơn chờ thanh toán. Thanh toán hoặc chờ hết hạn để tạo đơn mới.{#else}Đã tạo QR gói **{payment.months}** tháng cho account **{account.username}**. Thanh toán xong bot tự kích hoạt.{/if}',
                        fields: [
                            field("Mã đơn", "`{payment.paymentId}`", false),
                            field("Số tháng", "**{payment.months}** tháng"),
                            field("Đơn giá", "{payment.unitPrice|number}đ/tháng"),
                            field("Tổng tiền", "`{payment.amount|number} VNĐ`"),
                            ...BANK_FIELDS,
                        ],
                        image: "{payment.qrUrl}",
                        footer: "Chuyển đúng nội dung để tự động kích hoạt gói. Bot chạy toàn bộ quest vào Thứ 3 & Thứ 7.",
                        timestamp: true,
                    }),
                ],
                components: [[{ slot: "cancel" }]],
            },
        },
        "auto.quest.monthly.cancelInvalid": notice(G.pay, "Hủy gói tháng: đơn không hợp lệ", { title: "Không thể hủy", description: "Đơn này không tồn tại hoặc đã được xử lý." }),
        "auto.quest.monthly.cancelledDm": notice(G.dm, "Đã hủy đơn gói tháng", { title: "Đã hủy đơn gia hạn theo tháng", color: RED }, { user: "user" }),

        // ── Thanh toán quest lẻ ──────────────────────────────────────────────
        "auto.quest.payment": {
            group: G.pay,
            label: "QR quest lẻ",
            description: "{state} = created / existed. Khi đã trả hoặc hủy, tin không còn QR.",
            vars: { payment: "questPayment", account: "questAccount", state: { type: "string", label: "created / existed", example: "created" } },
            slots: { cancel: { label: "Hủy đơn", style: "Danger" } },
            message: {
                embeds: [
                    embed({
                        title: "Thanh toán quest",
                        color: '{#if payment.status == "paid"}#57f287{#else}#5865f2{/if}',
                        description:
                            '{#if state == "existed"}Bạn đã có đơn chờ thanh toán. Thanh toán đơn hiện tại hoặc chờ hết hạn để tạo đơn mới.{#else}Đã tạo QR cho {payment.count} quest. Thanh toán xong bot tự chạy quest.{/if}',
                        fields: [
                            field("Mã đơn", "`{payment.id}`", false),
                            field("Số lượng quest", "{payment.count}"),
                            field("Đơn giá", "{payment.unitPrice|number}đ/quest"),
                            field("Tổng tiền", "`{payment.amount|number} VNĐ`"),
                            ...BANK_FIELDS,
                        ],
                        image: '{#if payment.status == "pending"}{payment.qrUrl}{/if}',
                        footer:
                            '{#if payment.status == "pending"}Chuyển đúng nội dung để tự động xác nhận giao dịch.{#elseif payment.status == "paid"}Đã xác nhận thanh toán. Bot bắt đầu chạy quest đã chọn.{#else}Đơn đã hủy hoặc hết hạn.{/if}',
                        timestamp: true,
                    }),
                ],
                components: [[{ slot: "cancel" }]],
            },
        },
        "auto.quest.payment.notFound": notice(G.pay, "Hủy đơn: không thấy đơn", { title: "Lỗi", description: "Không tìm thấy đơn thanh toán." }),
        "auto.quest.payment.notYours": notice(G.pay, "Hủy đơn của người khác", { title: "Không có quyền", description: "Bạn không thể hủy đơn của người khác." }),
        "auto.quest.payment.handled": notice(G.pay, "Hủy đơn đã xử lý", { title: "Không thể hủy", description: "Đơn này đã được xử lý (paid/expired)." }),
        "auto.quest.payment.cancelledDm": notice(G.dm, "Đã hủy đơn quest lẻ", { title: "Đã hủy đơn thanh toán", color: RED }, { user: "user" }),

        // ── Trạng thái ───────────────────────────────────────────────────────
        "auto.quest.status.empty": notice(
            G.status,
            "Chưa có account",
            { title: "Trạng thái tài khoản", color: YELLOW, description: "{#if panel}Bạn chưa có account nào.{#else}Bạn chưa nhập account nào.{/if}" },
            { user: "user", panel: { type: "boolean", label: "Đang chạy trên panel", example: true } },
        ),
        "auto.quest.status.panel": notice(
            G.status,
            "Trạng thái (quest chạy trên panel)",
            {
                title: "Trạng thái tài khoản — {total} account",
                color: BLURPLE,
                fields: [
                    {
                        each: "accounts",
                        name: "{username}",
                        value:
                            '{#if plan == "monthly"}ID: `{accountId}`\nLoại: ♾️ Quest tháng\n{#if monthlyExpiresAt}Hạn: {monthlyExpiresAt|time:R}\n{/if}Lịch: Thứ 3 & Thứ 7{#else}ID: `{accountId}`\nLoại: ⚡ Quest lẻ\nTrạng thái: {statusText}\n{#if questsTotal}Quest: {questsDone}/{questsTotal}{#else}Đã xong: {completedCount}{/if}{/if}',
                        inline: true,
                    },
                ],
                timestamp: true,
            },
            { user: "user", accounts: "questStatus[]", total: "number" },
        ),
        "auto.quest.status.local": notice(
            G.status,
            "Trạng thái (quest chạy trong bot)",
            {
                title: "Trạng thái tài khoản — {total} account",
                color: BLURPLE,
                description: "{#if total > shown}Hiển thị {shown}/{total} account.{/if}",
                fields: [
                    {
                        each: "accounts",
                        name: "{username}",
                        value:
                            'ID: `{accountId}`\nLoại: {planText}\nToken: {#if tokenAlive}✅ Hoạt động{#else}⚠️ Cần nhập lại{/if}\n{#if plan == "monthly" && monthlyExpiresAt}Hạn: {monthlyExpiresAt|time:R}\n{/if}{#if running}Đang chạy: {runningQuestCount|default:"toàn bộ"} quest | Đã xong: {completedCount}{#if startedAt}\nUptime: {uptime}{/if}{#elseif plan == "monthly"}Trạng thái: ⏳ Chờ lịch (Thứ 3 & Thứ 7){#elseif !tokenAlive}Trạng thái: Tạm dừng — chờ nhập lại token{#else}Trạng thái: Không chạy{/if}',
                        inline: true,
                    },
                ],
                timestamp: true,
            },
            { user: "user", accounts: "questStatus[]", total: "number", shown: "number" },
        ),

        // ── DM cho khách ─────────────────────────────────────────────────────
        "auto.quest.dm.paid": notice(
            G.dm,
            "Đã nhận thanh toán quest lẻ",
            {
                title:
                    '{#if pendingToken}{#if via == "live"}Đã thanh toán — cần cập nhật token{#else}Đã thanh toán — cần nhập lại token{/if}{#elseif via == "recovered"}Đã xác nhận thanh toán (khôi phục){#else}Đã xác nhận thanh toán{/if}',
                color: "{#if pendingToken}#fee75c{#else}#57f287{/if}",
                description:
                    'Mã đơn: `{payment.id}`\nSố tiền: {payment.amount|money}\n{#if pendingToken}{#if via == "live"}⚠️ Token account đã die trong lúc chờ thanh toán. Vào panel Auto Quest và bấm nút **🔑 Cập nhật token** để gửi lại token — bot sẽ tự chạy {payment.count} quest đã mua (đã lưu, không mất).{#else}⚠️ Token account đã die. **Nhập lại token** để chạy quest đã mua (đã lưu, không mất).{/if}{#elseif via == "live"}Đã mở chạy {payment.count} quest đã chọn.{#elseif via == "recovered"}Bot phát hiện thanh toán khi khởi động lại. Đã mở chạy quest đã chọn.{#else}Đã xác nhận thanh toán. Đã mở chạy quest đã chọn.{/if}',
            },
            {
                payment: "questPayment",
                user: "user",
                pendingToken: { type: "boolean", label: "Token chết, chờ nhập lại", example: false },
                via: { type: "string", label: "live (đang chạy) / missed (sau restart) / recovered (lúc khởi động)", example: "live" },
            },
        ),
        "auto.quest.dm.expired": notice(
            G.dm,
            "QR quest lẻ hết hạn",
            {
                title: "QR thanh toán đã hết hạn",
                color: YELLOW,
                description: 'Mã đơn: `{paymentId}`\nSố tiền: {amount|money}\n{#if via == "stale"}Đơn đã quá 10 phút. Hãy chọn lại quest.{#else}QR đã hết hạn. Hãy chọn lại quest để tạo QR mới.{/if}',
            },
            { paymentId: "string", amount: "money", user: "user", via: { type: "string", label: "recovered / stale", example: "recovered" } },
        ),
        "auto.quest.dm.tokenDead": notice(
            G.dm,
            "Token chết — cần cập nhật",
            {
                title: "Cần cập nhật token",
                color: YELLOW,
                description:
                    "Bot phát hiện token không còn hợp lệ.\nAccount bị gỡ: **{account.username}** (`{account.accountId}`)\n{#if reason}Chi tiết: {reason}\n{/if}Vào panel Auto Quest và bấm nút **🔑 Cập nhật token** để gửi lại token — quest đã mua vẫn được giữ, không mất phí.",
                timestamp: true,
            },
            { ...ACC_VARS, reason: "string" },
        ),
        "auto.quest.dm.tokenDeadPanel": notice(
            G.dm,
            "Token chết (quest chạy trên panel)",
            { title: "Cần nhập lại token", color: YELLOW, description: "Token account đã dead. Vào panel nhập token để tiếp tục chạy quest đã mua." },
            ACC_VARS,
        ),
        "auto.quest.dm.batchStarted": notice(
            G.dm,
            "Bắt đầu xử lý quest",
            { title: "Bắt đầu xử lý quest", color: BLURPLE, description: `${ACCOUNT}\nSố quest: {quests.length}\n{#each quests}- {name}{#if taskType} [{taskType}]{/if}{#if !@last}\n{/if}{/each}`, timestamp: true },
            { ...ACC_VARS, quests: "questItem[]" },
        ),
        "auto.quest.dm.accountStarted": notice(
            G.dm,
            "Bắt đầu chạy quest",
            { title: "Bắt đầu chạy quest", color: GREEN, description: `${ACCOUNT}\nDùng \`/status\` để theo dõi tiến trình.`, timestamp: true },
            ACC_VARS,
        ),
        "auto.quest.dm.monthlyActivated": notice(
            G.dm,
            "Đã kích hoạt gói tháng",
            {
                title: "Đã kích hoạt gói tháng",
                color: PURPLE,
                description: `${ACCOUNT}\nSố tháng: **{months}**\nHạn tới: {#if expiresAt}{expiresAt|time:f}{#else}—{/if}\nBot sẽ tự chạy toàn bộ quest vào Thứ 3 & Thứ 7.`,
                timestamp: true,
            },
            { ...ACC_VARS, months: "number", expiresAt: "time?" },
        ),
        "auto.quest.dm.monthlyTokenDead": notice(
            G.dm,
            "Token gói tháng chết",
            {
                title: "Cần cập nhật token (gói tháng)",
                color: YELLOW,
                description: `${ACCOUNT}\nToken của account gói tháng đã hết hạn/không hợp lệ.\nBấm **Gia hạn theo tháng** trên panel và nhập lại token — gói của bạn vẫn còn hạn, không mất phí.`,
                timestamp: true,
            },
            ACC_VARS,
        ),

        // ── Thông báo xong quest (kênh thông báo / DM) ───────────────────────
        "auto.quest.done": notice(
            G.notify,
            "Xong 1 quest",
            {
                title: "✅ Hoàn thành 1 quest",
                color: GREEN,
                description: "> 🎯 **{quest.name}**{#if quest.taskType} · `{quest.taskType}`{/if}",
                fields: [
                    field("👤 Khách hàng", "<@{userId}>"),
                    field("🎮 Account", "{#if account.username}**{account.username}**{#else}`{account.accountId|default:\"?\"}`{/if}"),
                    field("📦 Gói", "{planText}"),
                ],
                footer: 'QUEST • {account.accountId|default:"—"}',
                timestamp: true,
            },
            { userId: "id", account: "questAccount", quest: "questItem", plan: "string", planText: "string" },
        ),
        "auto.quest.orderDone": notice(
            G.notify,
            "Xong cả đơn",
            {
                title: "🏁 Đã xong đơn quest",
                color: GREEN,
                description: "> 🎉 Toàn bộ quest đã chọn đã chạy xong.",
                fields: [
                    field("👤 Khách hàng", "<@{userId}>"),
                    field("🎮 Account", "{#if account.username}**{account.username}**{#else}`{account.accountId|default:\"?\"}`{/if}"),
                    { ...field("✅ Đã xong", "**{completed}** quest"), if: "hasCount" },
                    { ...field("📦 Gói", "{planText}"), if: "!hasCount" },
                ],
                footer: 'QUEST • {account.accountId|default:"—"}',
                timestamp: true,
            },
            { userId: "id", account: "questAccount", completed: "number", hasCount: "boolean", plan: "string", planText: "string" },
        ),

        // ── Log đơn ──────────────────────────────────────────────────────────
        "auto.quest.log.pending": notice(
            G.log,
            "Đơn mới (chờ thanh toán / staff miễn phí)",
            {
                title: "📦 Đơn hàng",
                color: "{#if staffFree}#9b59b6{#else}#5865f2{/if}",
                fields: [...LOG_HEAD, field("📋 Số lượng", "**{count}** quest"), field("📋 Trạng thái", "{#if staffFree}🆓 Miễn phí (Staff) — Đang chạy{#else}⏳ Chờ thanh toán{/if}")],
                footer: LOG_FOOTER,
                timestamp: true,
            },
            { userId: "id", account: "questAccount", count: "number", staffFree: "boolean", footer: "string" },
        ),
        "auto.quest.log.paid": notice(
            G.log,
            "Đã thanh toán — đang chạy",
            { title: "📦 Đơn hàng", color: "#f39c12", fields: [...LOG_HEAD, field("📋 Số lượng", "**{count}** quest"), field("📋 Trạng thái", "✅ Đã thanh toán — Đang chạy quest")], footer: LOG_FOOTER, timestamp: true },
            { userId: "id", account: "questAccount", count: "number", footer: "string" },
        ),
        "auto.quest.log.done": notice(
            G.log,
            "Đã xử lý xong",
            { title: "📦 Đơn hàng", color: GREEN, fields: [...LOG_HEAD, field("✅ Đã xử lý", "**{count}** quest")], footer: LOG_FOOTER, timestamp: true },
            { userId: "id", account: "questAccount", count: "number", footer: "string" },
        ),
        "auto.quest.log.cancelled": notice(
            G.log,
            "Hủy / tạm dừng",
            {
                title: "📦 Đơn hàng",
                color: RED,
                description:
                    '{#if reason == "cancelled"}🚫 Đã hủy bởi khách / Hết hạn{#elseif reason == "expired"}🚫 Đã hủy / Hết hạn thanh toán{#elseif reason == "token_dead"}⏸️ Đơn **tạm dừng**: token account bị dead. Nhập lại token để tiếp tục.{#elseif reason == "token_dead_panel"}⏸️ Token account bị dead. Nhập lại token để tiếp tục.{#else}Đơn **bị hủy**.{/if}',
                footer: LOG_FOOTER,
                timestamp: true,
            },
            { userId: "id", account: "questAccount", reason: { type: "string", label: "cancelled / expired / token_dead / token_dead_panel", example: "cancelled" }, footer: "string" },
        ),

        // ── Lệnh ─────────────────────────────────────────────────────────────
        "auto.quest.cmd.help": notice(G.cmd, "/quest-help", {
            title: "Hướng dẫn sử dụng",
            color: BLURPLE,
            fields: [
                field("/setup", "Gửi panel nhập token vào kênh (admin only)", false),
                field("/status", "Xem trạng thái account đang chạy", false),
                field("/stop <account_id>", "Dừng một account", false),
                field("/stopall", "Dừng tất cả account", false),
                field("/removeaccount <account_id>", "Xóa account khỏi storage", false),
                field("/restart", "Restart tất cả account đã lưu", false),
            ],
        }),
        "auto.quest.cmd.setupDone": { group: G.cmd, label: "/quest-setup: đã gửi panel", vars: {}, message: { content: "✅ Đã gửi panel vào kênh này." } },
        "auto.quest.cmd.removeNotFound": notice(G.cmd, "/quest-removeaccount: không có", { description: "Không tìm thấy account `{accountId}` trong storage." }, { accountId: "id" }),
        "auto.quest.cmd.removed": notice(G.cmd, "/quest-removeaccount: đã xóa", { title: "Đã xóa account", color: RED, fields: ACC_FIELDS, timestamp: true }, ACC_VARS),
        "auto.quest.cmd.stopNotFound": notice(G.cmd, "/quest-stop: không chạy", { title: "Không tìm thấy", description: "Không tìm thấy account `{accountId}` đang chạy." }, { accountId: "id" }),
        "auto.quest.cmd.stopped": notice(G.cmd, "/quest-stop: đã dừng", { title: "Đã dừng account", color: RED, fields: ACC_FIELDS, timestamp: true }, ACC_VARS),
        "auto.quest.cmd.stopAllNone": notice(G.cmd, "/quest-stopall: không có account chạy", { description: "Không có account nào đang chạy.", color: YELLOW }),
        "auto.quest.cmd.stoppedAll": notice(G.cmd, "/quest-stopall: đã dừng", { title: "Đã dừng tất cả", color: RED, description: "Đã dừng {count} account.", timestamp: true }, { count: "number" }),
        "auto.quest.cmd.restartNone": notice(G.cmd, "/quest-restart: chưa có account", { description: "Bạn chưa có account nào để restart.", color: YELLOW }),
        "auto.quest.cmd.restarted": notice(
            G.cmd,
            "/quest-restart: kết quả",
            {
                title: "Restart xong — {ok}/{total}",
                color: "{#if ok > 0}#57f287{#else}#ed4245{/if}",
                description: "{#each results}{#if ok}✅ {username}{#else}❌ {username}: {reason}{/if}{#if !@last}\n{/if}{/each}",
                timestamp: true,
            },
            { results: "restartResult[]", ok: "number", total: "number" },
        ),
    },
};
