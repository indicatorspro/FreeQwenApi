// Поиск ссылок на сгенерированные медиа в ответах Qwen.
// Структура ответа нестабильна, поэтому URL ищется рекурсивно по всему объекту.

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

/** Ключи, которые проверяем первыми — так реже попадаем на служебные ссылки. */
const PREFERRED_KEYS = ['video_url', 'image_url', 'url', 'content', 'result', 'output', 'data', 'message'];

function findUrl(value, extensions, seen) {
    if (!value) return null;

    if (typeof value === 'string') {
        const urls = value.match(/https?:\/\/[^\s"'<>]+/g);
        if (!urls) return null;
        return urls.find(url => extensions.some(ext => url.toLowerCase().includes(ext))) || null;
    }

    if (typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);

    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findUrl(item, extensions, seen);
            if (found) return found;
        }
        return null;
    }

    for (const key of PREFERRED_KEYS) {
        if (key in value) {
            const found = findUrl(value[key], extensions, seen);
            if (found) return found;
        }
    }
    for (const item of Object.values(value)) {
        const found = findUrl(item, extensions, seen);
        if (found) return found;
    }
    return null;
}

/**
 * @param {unknown} value — произвольный фрагмент ответа Qwen
 * @param {'video'|'image'|'any'} [type]
 * @returns {string|null}
 */
export function extractMediaUrl(value, type = 'any') {
    const extensions = type === 'video'
        ? VIDEO_EXTENSIONS
        : type === 'image'
            ? IMAGE_EXTENSIONS
            : [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS];
    return findUrl(value, extensions, new Set());
}

/** Идентификатор задачи генерации из ответа Qwen. */
export function extractTaskId(data) {
    const firstMessage = data?.data?.messages?.[0];
    if (firstMessage?.extra?.wanx?.task_id) return firstMessage.extra.wanx.task_id;
    return data?.id || data?.task_id || data?.response_id || data?.data?.message_id || null;
}
