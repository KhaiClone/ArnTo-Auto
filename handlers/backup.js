"use strict";

/**
 * Backup & Restore — xem BACKUP.md để biết toàn bộ quy trình.
 *
 * File này cố ý không phụ thuộc vào bất cứ thứ gì của template (client,
 * configs, discord.js) để copy thẳng sang bot khác được, dù bot đó đã sửa đổi
 * tới đâu. Chỉ dùng module có sẵn của Node 18+ và better-sqlite3.
 *
 *   index.js:
 *     require("./handlers/backup").restore();   // phải ở TRƯỚC dotenv
 *     require("dotenv").config();
 *     require("./handlers/backup").start();
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const ROOT = process.cwd();
const DB_FILE = path.join(ROOT, "json.sqlite");
const ENV_FILE = path.join(ROOT, ".env");
const RESTORE_DIR = path.join(ROOT, "restore");
const TMP_DIR = path.join(ROOT, "backup-tmp");

const CHUNK_SIZE = 9 * 1024 * 1024;
const MAX_CHUNKS = 9; // 10 attachment/message, chừa 1 slot cho env.txt
const FIRST_RUN_DELAY = 60 * 1000;

// <ts>__<hash8>__env.txt  |  <ts>__<hash8>__000-of-004.gz
const NAME_RE =
    /^(\d{8}-\d{4})__([0-9a-f]{8})__(?:env\.txt|(\d{3})-of-(\d{3})\.gz)$/;

const log = (msg) => console.log(`[backup] ${msg}`);
const warn = (msg) => console.warn(`[backup] ${msg}`);

function stamp(date = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return (
        `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
        `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}`
    );
}

function fmtSize(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function rmrf(target) {
    fs.rmSync(target, { recursive: true, force: true });
}

/* ---------------------------------------------------------------- BACKUP */

/**
 * B2-B6 — tạo snapshot, nén, cắt mảnh, đặt tên.
 * Trả về { content, files } sẵn sàng để gửi.
 */
function buildBackup() {
    rmrf(TMP_DIR);
    fs.mkdirSync(TMP_DIR, { recursive: true });

    // B2 — snapshot nhất quán, gộp cả WAL, bỏ page trống.
    const snapshot = path.join(TMP_DIR, "snapshot.sqlite");
    const db = new (require("better-sqlite3"))(DB_FILE);
    try {
        db.exec(`VACUUM INTO '${snapshot.replace(/\\/g, "/").replace(/'/g, "''")}'`);
    } finally {
        db.close();
    }

    const raw = fs.readFileSync(snapshot);

    // B3 — hash tính trên bản CHƯA nén, để restore verify được đầu-cuối.
    const hash8 = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8);

    // B4
    const gz = zlib.gzipSync(raw, { level: 6 });

    // B5
    const chunks = [];
    for (let at = 0; at < gz.length; at += CHUNK_SIZE) {
        chunks.push(gz.subarray(at, at + CHUNK_SIZE));
    }
    if (!chunks.length) chunks.push(Buffer.alloc(0));
    if (chunks.length > MAX_CHUNKS) {
        throw new Error(
            `Database quá lớn: ${fmtSize(raw.length)} → ${chunks.length} mảnh, ` +
            `vượt giới hạn ${MAX_CHUNKS} mảnh của một message Discord. ` +
            `Đã đến lúc chuyển sang hướng lưu trữ khác.`
        );
    }

    // B6
    const ts = stamp();
    const total = String(chunks.length).padStart(3, "0");
    const files = chunks.map((data, i) => ({
        name: `${ts}__${hash8}__${String(i).padStart(3, "0")}-of-${total}.gz`,
        data,
    }));
    if (fs.existsSync(ENV_FILE)) {
        files.unshift({
            name: `${ts}__${hash8}__env.txt`,
            data: fs.readFileSync(ENV_FILE),
        });
    } else {
        warn("Không tìm thấy .env, bản backup này sẽ chỉ có database.");
    }

    const content =
        `Backup • ${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ` +
        `${ts.slice(9, 11)}:${ts.slice(11, 13)} UTC\n` +
        `DB ${fmtSize(raw.length)} → ${fmtSize(gz.length)} (${chunks.length} mảnh)\n` +
        `SHA-256 ${hash8}…`;

    return { content, files };
}

// B7
async function send(webhook, content, files) {
    const form = new FormData();
    form.append("content", content);
    files.forEach((file, i) => {
        form.append(`files[${i}]`, new Blob([file.data]), file.name);
    });

    const res = await fetch(webhook, { method: "POST", body: form });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Webhook trả về ${res.status} ${body.slice(0, 200)}`);
    }
}

let running = false;

/** Chạy một lượt backup. Không bao giờ ném lỗi ra ngoài. */
async function backupOnce() {
    if (running) {
        warn("Lượt backup trước còn đang chạy, bỏ qua lượt này.");
        return false;
    }
    running = true;
    try {
        // B1
        const webhook = process.env.WEBHOOK_BACKUP;
        if (!webhook) {
            warn("Thiếu WEBHOOK_BACKUP, bỏ qua lượt backup.");
            return false;
        }
        if (!fs.existsSync(DB_FILE)) {
            warn("Không tìm thấy json.sqlite, bỏ qua lượt backup.");
            return false;
        }

        const { content, files } = buildBackup();
        await send(webhook, content, files);
        log(`Đã gửi backup — ${files.length} file.`);
        return true;
    } catch (err) {
        // B9 — backup hỏng không bao giờ được làm chết bot.
        warn(`Backup thất bại: ${err.message}`);
        return false;
    } finally {
        rmrf(TMP_DIR); // B8
        running = false;
    }
}

/** Hẹn giờ backup. Không phụ thuộc sự kiện ready — chạy cả khi bot không login được. */
function start() {
    if (!process.env.WEBHOOK_BACKUP) {
        log("Chưa cấu hình WEBHOOK_BACKUP, không hẹn giờ backup.");
        return;
    }

    const hours = Number(process.env.BACKUP_INTERVAL_HOURS) || 1;
    const interval = Math.max(0.1, hours) * 60 * 60 * 1000;

    setTimeout(() => {
        backupOnce();
        setInterval(backupOnce, interval);
    }, FIRST_RUN_DELAY);

    log(`Hẹn giờ backup: lần đầu sau 1 phút, sau đó mỗi ${hours} giờ.`);
}

/* --------------------------------------------------------------- RESTORE */

function collect() {
    const entries = fs
        .readdirSync(RESTORE_DIR, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name);

    const groups = new Map();
    const recognized = [];

    for (const name of entries) {
        const match = NAME_RE.exec(name);
        if (!match) {
            warn(`Bỏ qua file không đúng định dạng: ${name}`);
            continue;
        }
        recognized.push(name);

        const [, ts, hash8, index, total] = match;
        const key = `${ts}__${hash8}`;
        if (!groups.has(key)) {
            groups.set(key, { key, hash8, env: null, parts: new Map(), total: 0 });
        }
        const group = groups.get(key);
        if (index === undefined) {
            group.env = name;
        } else {
            group.parts.set(Number(index), name);
            group.total = Number(total);
        }
    }

    return { groups, recognized };
}

function runRestore() {
    // R1
    if (!fs.existsSync(RESTORE_DIR)) {
        fs.mkdirSync(RESTORE_DIR, { recursive: true });
        return false;
    }

    // R2, R3
    const { groups, recognized } = collect();
    if (!groups.size) return false;

    const keys = [...groups.keys()].sort();
    const group = groups.get(keys[keys.length - 1]);
    if (keys.length > 1) {
        warn(
            `Có ${keys.length} bản backup trong restore/, dùng bản mới nhất: ${group.key}`
        );
    }

    // R4 — thiếu mảnh thì không đụng vào gì cả.
    if (!group.total) {
        warn(`Bản ${group.key} không có mảnh database nào. Không restore.`);
        return false;
    }
    const missing = [];
    for (let i = 0; i < group.total; i++) {
        if (!group.parts.has(i)) missing.push(String(i).padStart(3, "0"));
    }
    if (missing.length) {
        warn(
            `Bản ${group.key} thiếu mảnh ${missing.join(", ")} (cần đủ ${group.total}). ` +
            `Không restore, bot chạy tiếp với dữ liệu hiện có.`
        );
        return false;
    }

    // R5
    const parts = [];
    for (let i = 0; i < group.total; i++) {
        parts.push(fs.readFileSync(path.join(RESTORE_DIR, group.parts.get(i))));
    }

    // R6
    let data;
    try {
        data = zlib.gunzipSync(Buffer.concat(parts));
    } catch (err) {
        warn(`Giải nén thất bại (${err.message}). Không restore.`);
        return false;
    }

    // R7 — chốt chặn cuối, verify toàn bộ chuỗi nén → cắt → gửi → tải → nối.
    const actual = crypto.createHash("sha256").update(data).digest("hex").slice(0, 8);
    if (actual !== group.hash8) {
        warn(
            `Checksum không khớp (tên file ${group.hash8}, thực tế ${actual}). ` +
            `File hỏng hoặc tải thiếu. Không restore.`
        );
        return false;
    }

    // R8 — từ đây mới động vào file thật.
    const now = stamp();
    if (fs.existsSync(DB_FILE)) {
        fs.renameSync(DB_FILE, `${DB_FILE}.bak-${now}`);
        log(`Đã cất json.sqlite cũ → json.sqlite.bak-${now}`);
    }
    if (group.env && fs.existsSync(ENV_FILE)) {
        fs.renameSync(ENV_FILE, `${ENV_FILE}.bak-${now}`);
        log(`Đã cất .env cũ → .env.bak-${now}`);
    }

    // R9 — WAL cũ thuộc về database cũ, để lại sẽ đọc phải trạng thái không khớp.
    rmrf(`${DB_FILE}-wal`);
    rmrf(`${DB_FILE}-shm`);

    // R10
    fs.writeFileSync(DB_FILE, data);
    if (group.env) {
        fs.copyFileSync(path.join(RESTORE_DIR, group.env), ENV_FILE);
    } else {
        warn("Bản backup không có env.txt — giữ nguyên .env hiện tại.");
    }

    // R11 — chỉ xóa sau khi đã ghi kết quả thành công.
    for (const name of recognized) rmrf(path.join(RESTORE_DIR, name));

    log(
        `Restore xong từ bản ${group.key} — ${fmtSize(data.length)}` +
        `${group.env ? " + .env" : ""}. Đã xóa file nguồn trong restore/.`
    );
    return true;
}

/** Chạy trước dotenv. Đồng bộ, và không bao giờ ném lỗi ra ngoài. */
function restore() {
    try {
        return runRestore();
    } catch (err) {
        warn(`Restore lỗi, bỏ qua: ${err.message}`);
        return false;
    }
}

module.exports = { restore, start, backupOnce, buildBackup };
