// Загрузка файлов для последующей отправки в Qwen.

import express from 'express';
import fs from 'fs';
import multer from 'multer';

import { config } from '../../config/index.js';
import { randomHex } from '../../shared/ids.js';
import { logError, logInfo } from '../../shared/logger.js';
import { UPLOADS_DIR, ensureDir } from '../../shared/paths.js';
import { getStsToken, uploadFileToQwen } from '../../core/qwen/files.js';

const router = express.Router();

const storage = multer.diskStorage({
    destination(req, file, callback) {
        callback(null, ensureDir(UPLOADS_DIR));
    },
    filename(req, file, callback) {
        // Оригинальное имя не используем в пути: оно приходит от клиента.
        callback(null, `${Date.now()}-${randomHex(8)}-${file.originalname.replace(/[^\w.-]+/g, '_')}`);
    }
});

const upload = multer({ storage, limits: { fileSize: config.limits.maxFileSize } });

router.post('/files/getstsToken', async (req, res, next) => {
    try {
        const fileInfo = req.body;
        if (!fileInfo?.filename || !fileInfo?.filesize || !fileInfo?.filetype) {
            return res.status(400).json({ error: 'Некорректные данные о файле' });
        }
        return res.json(await getStsToken(fileInfo));
    } catch (error) {
        next(error);
    }
});

router.post('/files/upload', upload.single('file'), async (req, res, next) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не был загружен' });

    try {
        logInfo(`Файл принят: ${req.file.originalname} (${req.file.size} байт)`);
        const result = await uploadFileToQwen(req.file.path);

        if (!result.success) {
            logError(`Не удалось загрузить файл в OSS: ${result.error}`);
            return res.status(502).json({ error: 'Ошибка при загрузке файла', message: result.error });
        }

        logInfo(`Файл загружен в OSS: ${result.fileName}`);
        return res.json({
            success: true,
            file: {
                name: result.fileName,
                url: result.url,
                size: req.file.size,
                type: req.file.mimetype
            }
        });
    } catch (error) {
        next(error);
    } finally {
        // Временный файл нужен только на время аплоада.
        try { fs.unlinkSync(req.file.path); } catch { /* уже удалён */ }
    }
});

export default router;
