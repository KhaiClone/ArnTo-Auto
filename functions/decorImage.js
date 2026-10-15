// Ảnh decor trong giỏ Deco Gift (extensions/AutoDecoGift.js): bot tự ghép bằng
// sharp rồi gửi kèm tin nhắn (attachment://). Trước đây ảnh là link KhaiDevApi
// trên Render free — ngủ sau 15 phút, render chậm, 502/503/429 khi nhiều người
// xem cùng lúc — mà Discord chờ ảnh không lâu nên nhiều ảnh không hiện.
// Cách ghép giữ y hệt KhaiDevApi (controllers/discord/deco.js + frame.js);
// ảnh nền nằm ở assets/decor. Bản sao của functions/decorImage.js bên
// ArnTo-assistant — sửa thì sửa cả hai.
//
// Nhận bản ghi decor hoặc một món trong catalog Gift của bot-panel (catalog
// mang sẵn các trường cần: staticURL, assetURL, backgroundColors, frame,
// previewValid).
//
// Type deco: 0 avatar | 1 profile effect | 2 nameplate | 3 frame | 1000 bundle

const path = require("path");
const sharp = require("sharp");

const BASE_DIR = path.join(__dirname, "..", "assets", "decor");
const BASE = {
    0: path.join(BASE_DIR, "avatar.png"),
    1: path.join(BASE_DIR, "profile.png"),
    2: path.join(BASE_DIR, "nameplate.png"),
};
const FETCH_TIMEOUT = 10000;

const fetchImage = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) throw new Error(`${res.status} khi tải ${url}`);
    return Buffer.from(await res.arrayBuffer());
};

// Avatar / profile: ảnh decor phủ kín ảnh nền. Nameplate: giữ nguyên banner,
// đặt ảnh nền (avatar mẫu) vào ô vuông bên trái.
const renderSingle = async (type, src) => {
    const deco = await fetchImage(src);
    if (type === 2) {
        const { height } = await sharp(deco).metadata();
        const avatar = await sharp(BASE[2])
            .resize(height, height, { fit: "cover" })
            .png()
            .toBuffer();
        return sharp(deco)
            .composite([{ input: avatar, left: 0, top: 0 }])
            .png()
            .toBuffer();
    }
    const base = BASE[type] || BASE[2];
    const { width, height } = await sharp(base).metadata();
    const resized = await sharp(deco)
        .resize(width, height, { fit: "cover" })
        .png()
        .toBuffer();
    return sharp(base)
        .composite([{ input: resized, blend: "over" }])
        .png()
        .toBuffer();
};

// Số nguyên RGB (vd 855309) -> "#rrggbb"
const intToHex = (n) =>
    "#" + ((n >>> 0) & 0xffffff).toString(16).padStart(6, "0");

const gradientSvg = (width, height, hexColors) => {
    const stops = hexColors
        .map((c, i) => {
            const offset =
                hexColors.length > 1
                    ? ((i / (hexColors.length - 1)) * 100).toFixed(1)
                    : 0;
            return `<stop offset="${offset}%" stop-color="${c}"/>`;
        })
        .join("");
    return Buffer.from(
        `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
            `<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">${stops}</linearGradient></defs>` +
            `<rect width="100%" height="100%" fill="url(#g)"/></svg>`,
    );
};

// Bundle: assetURL[1] đè lên assetURL[0] (như decor-site). Bundle 1 lớp thì
// nền là gradient từ backgroundColors, như Discord vẽ.
const renderBundle = async (decor) => {
    const [firstURL, secondURL] = decor.assetURL;
    const first = await fetchImage(firstURL);
    const { width, height } = await sharp(first).metadata();

    if (secondURL) {
        let second = await fetchImage(secondURL);
        const meta = await sharp(second).metadata();
        // sharp từ chối lớp đè lớn hơn ảnh dưới — đưa về cùng cỡ.
        if (meta.width !== width || meta.height !== height) {
            second = await sharp(second)
                .resize(width, height, { fit: "cover" })
                .png()
                .toBuffer();
        }
        return sharp(first)
            .composite([{ input: second, blend: "over" }])
            .png()
            .toBuffer();
    }

    const hexColors = (decor.backgroundColors || [])
        .map(Number)
        .filter(Number.isFinite)
        .map(intToHex);
    if (!hexColors.length) return sharp(first).png().toBuffer();
    const bg = await sharp(gradientSvg(width, height, hexColors))
        .png()
        .toBuffer();
    return sharp(bg)
        .composite([{ input: first, blend: "over" }])
        .png()
        .toBuffer();
};

// Frame có /preview đã chết: ghép các layer quanh ảnh profile mẫu. Mọi offset
// tỉ lệ theo bề rộng profile, giống cách Discord render.
const renderFrame = async (decor) => {
    const f = decor.frame;
    const IW = Number(f.inner_width);
    if (!IW) throw new Error("frame thiếu inner_width");
    const OT = Number(f.overflow_top) || 0;
    const OB = Number(f.overflow_bottom) || 0;
    const OH = Number(f.overflow_horizontal) || 0;

    const profile = await sharp(BASE[1]).png().toBuffer();
    const { width: pw, height: ph } = await sharp(profile).metadata();

    const otPx = Math.round((pw * OT) / IW);
    const obPx = Math.round((pw * OB) / IW);
    const ohPx = Math.round((pw * OH) / IW);
    const layerW = pw + 2 * ohPx;
    const canvasH = otPx + ph + obPx;

    const layers = await Promise.all(
        f.layers.map(async (l) => {
            const buf = await fetchImage(
                `https://cdn.discordapp.com/media/v1/collectibles-shop/${decor.sku_id}/${l.id}/static`,
            );
            if (l.anchor === "center") {
                const input = await sharp(buf)
                    .resize(layerW, ph, { fit: "fill" })
                    .png()
                    .toBuffer();
                return { order: l.order, input, top: otPx };
            }
            const input = await sharp(buf)
                .resize({ width: layerW })
                .png()
                .toBuffer();
            const { height: lh } = await sharp(input).metadata();
            const top = l.anchor === "bottom" ? Math.max(0, canvasH - lh) : 0;
            return { order: l.order, input, top };
        }),
    );

    const at = (p) => ({ input: p.input, left: 0, top: p.top });
    return sharp({
        create: {
            width: layerW,
            height: canvasH,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .composite([
            ...layers.filter((p) => p.order === "back").map(at),
            { input: profile, left: ohPx, top: otPx },
            ...layers.filter((p) => p.order !== "back").map(at),
        ])
        .png()
        .toBuffer();
};

// Ảnh tĩnh trên CDN Discord, không ghép — dùng khi ghép lỗi, và cho frame có
// /preview còn sống (ảnh shop gốc, Discord tự tải được).
const plainURL = (decor) => {
    if (decor.type === 1000)
        return Array.isArray(decor.assetURL) ? decor.assetURL[0] || null : null;
    if (decor.staticURL) return decor.staticURL;
    // Nameplate chỉ có assetURL dạng .webm — không hiện được trong gallery.
    return decor.type === 0 && typeof decor.assetURL === "string"
        ? decor.assetURL
        : null;
};

const needsRender = (decor) => {
    if (decor.type === 1000)
        return Array.isArray(decor.assetURL) && !!decor.assetURL[0];
    if (decor.type === 3)
        return (
            (decor.previewValid === false || !decor.staticURL) &&
            !!decor.frame?.layers?.length
        );
    return !!decor.staticURL;
};

const render = (decor) => {
    if (decor.type === 1000) return renderBundle(decor);
    if (decor.type === 3) return renderFrame(decor);
    return renderSingle(decor.type, decor.staticURL);
};

// Vài ảnh gần nhất, để nhiều người xem cùng decor không phải ghép lại.
const CACHE_MAX = 20;
const cache = new Map();
const cachedRender = (decor) => {
    const key = JSON.stringify([
        decor.sku_id,
        decor.type,
        decor.staticURL,
        decor.assetURL,
        decor.backgroundColors,
        decor.previewValid,
    ]);
    let job = cache.get(key);
    if (job) {
        cache.delete(key);
        cache.set(key, job);
        return job;
    }
    job = render(decor);
    cache.set(key, job);
    job.catch(() => cache.delete(key));
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return job;
};

/**
 * Ảnh hiển thị của một decor, cho MediaGalleryItemBuilder.setURL(url) và
 * `files` của tin nhắn. Ghép được -> file PNG gửi kèm; lỗi -> link CDN gốc.
 * @returns {Promise<{url: string|null, files: Array<{attachment: Buffer, name: string}>}>}
 *   url null = decor không có ảnh nào, bỏ gallery.
 */
const decorMedia = async (decor) => {
    if (needsRender(decor)) {
        const name = `decor-${decor.sku_id}.png`;
        try {
            const attachment = await cachedRender(decor);
            return { url: `attachment://${name}`, files: [{ attachment, name }] };
        } catch (e) {
            console.error(`[decorImage] ${decor.sku_id}: ${e.message}`);
        }
    }
    return { url: plainURL(decor), files: [] };
};

module.exports = { decorMedia, plainURL };
