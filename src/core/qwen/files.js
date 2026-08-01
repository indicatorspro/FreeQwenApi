// File upload to Alibaba OSS: STS token from Qwen + upload from browser page.
// Upload performed in browser because OSS endpoint accepts signature
// only from live session — from Node request is rejected.

import fs from 'fs';
import path from 'path';

import { config } from '../../config/index.js';
import { logError, logInfo } from '../../shared/logger.js';
import { getBrowserContext } from '../../browser/browser.js';
import { withPage } from './pagePool.js';
import { postViaBrowser } from './transport.js';
import { resolveAccount } from './tokens.js';

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
const DOCUMENT_EXTENSIONS = ['.pdf', '.doc', '.docx', '.txt'];

function requireContext() {
    const context = getBrowserContext();
    if (!context) throw new Error('Browser not initialized');
    return context;
}

async function requireToken(context) {
    const account = await resolveAccount(context);
    if (!account?.token) throw new Error('Failed to get authorization token');
    return account.token;
}

/** Requests temporary keys from Qwen for OSS upload. */
export async function getStsToken(fileInfo) {
    const context = requireContext();
    const token = await requireToken(context);

    logInfo(`Requesting STS token for file: ${fileInfo.filename}`);

    const result = await withPage(context, (page) => postViaBrowser({
        page,
        url: config.qwen.stsTokenUrl,
        token,
        payload: fileInfo
    }));

    if (result.ok) {
        logInfo(`STS token received: ${fileInfo.filename}`);
        return result.data;
    }

    logError(`Error getting STS token: status=${result.status}, body=${result.errorBody || result.error}`);
    throw new Error(`Error getting STS token: ${result.status || result.error}`);
}

function validateStsData(stsData) {
    const required = ['file_path', 'access_key_id', 'access_key_secret', 'security_token', 'region', 'bucketname'];
    return required.every(field => Boolean(stsData?.[field]));
}

/** Uploads a file to OSS using the SDK loaded onto the page. */
export async function uploadFile(filePath, stsData) {
    const context = requireContext();

    if (!validateStsData(stsData)) {
        throw new Error('Invalid or incomplete STS token data');
    }

    const fileBuffer = fs.readFileSync(filePath);
    logInfo(`[OSS] Uploading ${path.basename(filePath)} (${fileBuffer.length} bytes) to ${stsData.bucketname}/${stsData.region}`);

    const result = await withPage(context, (page) => page.evaluate(async (data) => {
        try {
            if (typeof window.OSS === 'undefined') {
                await new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = data.ossSdkUrl;
                    script.onload = resolve;
                    script.onerror = reject;
                    document.head.appendChild(script);
                });
            }

            const blob = new Blob([Uint8Array.from(atob(data.fileBase64), char => char.charCodeAt(0))]);
            const client = new window.OSS({
                region: data.stsData.region,
                accessKeyId: data.stsData.access_key_id,
                accessKeySecret: data.stsData.access_key_secret,
                stsToken: data.stsData.security_token,
                bucket: data.stsData.bucketname,
                secure: true
            });

            await client.put(data.stsData.file_path, blob);
            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    }, {
        fileBase64: fileBuffer.toString('base64'),
        ossSdkUrl: config.qwen.ossSdkUrl,
        stsData: {
            region: stsData.region,
            bucketname: stsData.bucketname,
            file_path: stsData.file_path,
            access_key_id: stsData.access_key_id,
            access_key_secret: stsData.access_key_secret,
            security_token: stsData.security_token
        }
    }));

    if (!result.success) {
        logError(`[OSS] Upload error: ${result.error}`);
        throw new Error(`OSS upload error: ${result.error}`);
    }

    return {
        success: true,
        fileName: path.basename(filePath),
        url: stsData.file_url,
        fileId: stsData.file_id,
        filePath: stsData.file_path
    };
}

function detectFileType(fileName) {
    const extension = path.extname(fileName).toLowerCase();
    if (IMAGE_EXTENSIONS.includes(extension)) return 'image';
    if (DOCUMENT_EXTENSIONS.includes(extension)) return 'document';
    return 'file';
}

/** Full cycle: STS token → upload to OSS. */
export async function uploadFileToQwen(filePath) {
    try {
        if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

        const fileName = path.basename(filePath);
        const fileInfo = {
            filename: fileName,
            filesize: fs.statSync(filePath).size,
            filetype: detectFileType(fileName)
        };

        const stsData = await getStsToken(fileInfo);
        const uploaded = await uploadFile(filePath, stsData);
        return { ...uploaded, fileInfo, stsData };
    } catch (error) {
        logError(`File upload error: ${error.message}`, error);
        return { success: false, error: error.message };
    }
}
