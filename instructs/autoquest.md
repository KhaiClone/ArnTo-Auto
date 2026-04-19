# AutoQuest — Tài liệu kỹ thuật

`extensions/AutoQuest.js`

File duy nhất chứa toàn bộ logic Auto Quest, chia thành 4 sections:

---

## Sections

| Section | Nội dung |
|---------|---------|
| **Section 1** | Discord Quest Engine — DiscordAPI, QuestAutocompleter |
| **Section 2** | Account Storage — mã hóa token, đọc/ghi DB |
| **Section 3** | Account Management + Run Loop |
| **Section 4** | Payment Lifecycle + AutoBank integration |

---

## Section 1 — Discord Quest Engine

### `DiscordAPI`

```js
const api = new DiscordAPI(token, buildNumber);
await api.get("/quests/@me");
await api.post("/quests/:id/enroll", payload);
```

### `QuestAutocompleter`

```js
const completer = new QuestAutocompleter(api);
const quests = await completer.fetchQuests();
quests = await completer.autoAccept(quests);  // tự enroll quest chưa nhận
await completer.processQuest(quest);           // chạy quest
```

**Task types được hỗ trợ:**
- `WATCH_VIDEO`, `WATCH_VIDEO_ON_MOBILE` — gửi video-progress
- `PLAY_ON_DESKTOP`, `STREAM_ON_DESKTOP` — gửi heartbeat
- `PLAY_ACTIVITY` — gửi activity heartbeat

---

## Section 2 — Account Storage

Accounts được lưu trong DB (`accounts`) dưới dạng `{ [userId]: { [accountId]: record } }`.

Token được mã hóa bằng AES-256-GCM trước khi lưu.

### Các hàm chính

```js
await loadAccounts(client)   // → { [userId]: { [accountId]: { token, username, ... } } }
await saveAccounts(client, data)

await getTokenRefreshRecord(client, userId)  // → record cần nhập lại token
await markTokenRefreshRequired(client, userId, accountId, record)

await getStoredSelectedQuestIds(client, userId, accountId)  // → string[]
await setStoredSelectedQuestIds(client, userId, accountId, ids)

await getOrderLogPending(client, userId, accountId)   // → { messageId, footerText }
await setOrderLogPending(client, userId, accountId, pending)

await getQuestBatchNotification(client, userId, accountId)
await setQuestBatchNotification(client, userId, accountId, notification)
```

### Schema account record (trong DB)

```js
{
    tokenEncrypted: "...",
    tokenIv: "...",
    tokenTag: "...",
    tokenHash: "...",
    username: "...",
    addedAt: "2024-01-01T00:00:00.000Z",
    expiresAt: null,
    month: null,
    needsTokenRefresh: false,      // true khi token dead
    questBatchNotification: null,  // { signature, status }
    orderLogPending: null,         // { messageId, footerText }
    selectedQuestIds: [],          // quest IDs đã chọn
}
```

---

## Section 3 — Account Management + Run Loop

### `startAccount(client, userId, token, options)`

Khởi động một account.

```js
const result = await startAccount(client, userId, token, {
    allowRestartIfRunning: false,
    rejectDuplicateStoredAccount: true,
    notifyStarted: true,
    forceNotifyQuestBatch: true,
    source: "activate",            // "activate" | "refresh" | "restart" | "manual"
    requireQuestSelection: true,   // bắt user chọn quest trước khi chạy
    _storedSelectedQuestIds: [],   // truyền trực tiếp để bỏ qua DB read (dùng khi restore)
});
// result = { ok, accountId, username, buildNumber }
```

**Auto-remove:** 30 phút sau khi `startAccount` được gọi, nếu account không có payment nào (`completedCount === 0` và `allowedQuestIds` rỗng), account sẽ tự động bị xóa khỏi DB và dừng.

### `setAllowedQuests(client, userId, accountId, questIds)`

Unlock các quest để run loop bắt đầu chạy. Gọi sau khi payment được xác nhận.

```js
await setAllowedQuests(client, userId, accountId, ["questId1", "questId2"]);
```

### Account Notifier Events

```js
setAccountNotifier(async ({ type, userId, accountId, username, ... }) => {
    // type = "token_dead" | "account_started" | "quest_batch_started"
    //      | "quest_batch_completed" | "quest_selection"
});
```

| Event | Khi nào | Data thêm |
|-------|---------|-----------|
| `token_dead` | Token hết hạn/sai trong lúc chạy | `source`, `reason` |
| `account_started` | Account bắt đầu chạy | `source` |
| `quest_batch_started` | Batch quest bắt đầu | `quests[]` |
| `quest_batch_completed` | Batch quest xong | `completedQuestNames[]` |

---

## Section 4 — Payment Lifecycle

### Tạo payment

```js
const payment = await createQuestPayment(client, {
    userId: "...",
    accountId: "...",
    questIds: ["id1", "id2"],
});
// payment = { id, transferCode, amount, qrUrl, status: "pending", ... }
```

Hàm này tự động:
1. Tạo `transferCode` unique (`Quest12345`)
2. Lưu vào DB `quest_payments`
3. Đăng ký với `client.autoBank.createQR()`
4. Lưu vào `autobank_pending` để khôi phục sau restart

### Payment lifecycle

```
pending → paid     (AutoBank phát hiện chuyển khoản)
pending → deleted  (cancelPayment hoặc expireStalePayments)
```

> **Lưu ý:** Records được **xóa hoàn toàn** sau khi paid hoặc expired — không giữ lại trong DB.

### Activation

Activation lưu token của user để khởi động lại account sau payment:

```js
await upsertPendingActivation(client, {
    paymentId: payment.id,
    userId, accountId, token, selectedQuestIds,
});
```

Được dùng trong `unlockPaymentIfPaid()` để:
1. Nếu account đang chạy → `setAllowedQuests()`
2. Nếu account không chạy → `startAccount()` rồi `setAllowedQuests()`

---

## Exports

```js
const {
    // Account management
    getRunningMap, setAccountNotifier, setAllowedQuests, getSelectableQuests,
    resolveDiscordAccount, startAccount, stopAccount, stopAllAccounts,
    removeStoredAccount, restoreAccounts,

    // Storage
    loadAccounts, saveAccounts, getTokenRefreshRecord, markTokenRefreshRequired,
    getStoredAccountOwner, hasStoredAccountEntry,
    getQuestBatchNotification, setQuestBatchNotification,
    getOrderLogPending, setOrderLogPending,
    getStoredSelectedQuestIds, setStoredSelectedQuestIds,

    // Payments
    markPaymentAsPaid, createQuestPayment, getPaymentById,
    getOpenPendingPayment, cancelPayment, expireStalePayments,
    upsertPendingActivation, getActivationByPaymentId,
    removeActivationByPaymentId, getRecoverablePaidActivations,
    buildVietQrUrl,
} = require("./extensions/AutoQuest");
```