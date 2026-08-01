// File uploads for later sending to Qwen.

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
        // Do not use the original name in the path: it comes from the client.
        callback(null, `${Date.now()}-${randomHex(8)}-${file.originalname.replace(/[^\w.-]+/g, '_')}`);
    }
});

const upload = multer({ storage, limits: { fileSize: config.limits.maxFileSize } });

router.post('/files/getstsToken', async (req, res, next) => {
    try {
        const fileInfo = req.body;
        if (!fileInfo?.filename || !fileInfo?.filesize || !fileInfo?.filetype) {
            return res.status(400).json({ error: 'Invalid file data' });
        }
        return res.json(await getStsToken(fileInfo));
    } catch (error) {
        next(error);
    }
});

router.post('/files/upload', upload.single('file'), async (req, res, next) => {
    if (!req.file) return res.status(400).json({ error: 'File was not uploaded' });

    try {
        logInfo(`File received: ${req.file.originalname} (${req.file.size} bytes)`);
        const result = await uploadFileToQwen(req.file.path);

        if (!result.success) {
            logError(`Failed to upload file to OSS: ${result.error}`);
            return res.status(502).json({ error: 'File upload error', message: result.error });
        }

        logInfo(`File uploaded to OSS: ${result.fileName}`);
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
        // Temporary file is only needed for the duration of the upload.
        try { fs.unlinkSync(req.file.path); } catch { /* already removed */ }
    }
});

export default router;
