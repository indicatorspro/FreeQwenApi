// Интерактивное управление аккаунтами Qwen из консоли.

import fs from 'fs';
import path from 'path';

import { logError, logInfo } from '../shared/logger.js';
import { ACCOUNTS_DIR, ensureDir, safeJoin } from '../shared/paths.js';
import { formatForgetMeAiWatermark } from '../shared/branding.js';
import { prompt } from './prompt.js';
import { getBrowserContext, initBrowser, shutdownBrowser } from '../browser/browser.js';
import { extractAuthToken } from '../core/qwen/tokens.js';
import { loadAuthToken } from '../browser/session.js';
import { accountStatus, listAccounts, loadAccounts, markValid, removeAccount, saveAccounts } from '../core/accounts/store.js';

const STATUS_LABELS = {
    OK: '✅ OK',
    WAIT: '⏳ Ожидание сброса',
    INVALID: '❌ Недействителен',
    EXPIRED: '⚠️ Токен истёк'
};

export function printAccounts(accounts = listAccounts()) {
    console.log('\nСписок аккаунтов:');
    if (accounts.length === 0) {
        console.log('  (пусто)');
        return;
    }

    accounts.forEach((account, index) => {
        const status = accountStatus(account);
        const label = account.label ? ` | ${account.label}` : '';
        console.log(`${String(index + 1).padStart(2, ' ')} | ${account.id}${label} | ${STATUS_LABELS[status] || status}`);
    });
}

function accountDir(id) {
    const dir = safeJoin(ACCOUNTS_DIR, id);
    if (!dir) throw new Error(`Недопустимый id аккаунта: ${id}`);
    return ensureDir(dir);
}

/** Открывает браузер, ждёт входа пользователя и сохраняет токен как новый аккаунт. */
export async function addAccountInteractive() {
    logInfo('Добавление нового аккаунта Qwen');
    logInfo(formatForgetMeAiWatermark());
    logInfo('Откроется браузер: войдите в аккаунт и вернитесь в консоль.');

    if (!await initBrowser(true, true)) {
        logError('Не удалось запустить браузер.');
        return null;
    }

    let token = await extractAuthToken(getBrowserContext(), true);
    if (!token) {
        token = loadAuthToken();
        if (token) logInfo('Токен взят из сохранённого файла.');
    }

    await shutdownBrowser();

    if (!token) {
        logError('Токен не получен, аккаунт не добавлен.');
        return null;
    }

    const id = `acc_${Date.now()}`;
    fs.writeFileSync(path.join(accountDir(id), 'token.txt'), token, 'utf8');

    const accounts = loadAccounts();
    accounts.push({ id, token, resetAt: null });
    saveAccounts(accounts);

    logInfo(`Аккаунт '${id}' добавлен. Всего аккаунтов: ${accounts.length}`);
    return id;
}

/** Обновляет токен аккаунта, у которого истёк вход. */
export async function reloginAccountInteractive() {
    const accounts = listAccounts();
    const broken = accounts.filter(account => account.invalid);

    if (broken.length === 0) {
        console.log('Нет аккаунтов, требующих повторного входа.');
        await prompt('ENTER — вернуться в меню…');
        return;
    }

    console.log('\nАккаунты с истёкшим токеном:');
    broken.forEach((account, index) => console.log(`${index + 1} - ${account.id}`));

    const choice = Number.parseInt(await prompt('Номер аккаунта для повторного входа: '), 10);
    if (Number.isNaN(choice) || choice < 1 || choice > broken.length) {
        console.log('Неверный выбор.');
        return;
    }

    const account = broken[choice - 1];
    logInfo(`Повторная авторизация: ${account.id}`);

    if (!await initBrowser(true, true)) {
        logError('Не удалось запустить браузер.');
        return;
    }

    const token = await extractAuthToken(getBrowserContext(), true);
    await shutdownBrowser();

    if (!token) {
        logError('Не удалось извлечь токен.');
        return;
    }

    markValid(account.id, token);
    fs.writeFileSync(path.join(accountDir(account.id), 'token.txt'), token, 'utf8');
    logInfo(`Токен обновлён: ${account.id}`);
}

export async function removeAccountInteractive() {
    const accounts = listAccounts();
    if (accounts.length === 0) {
        console.log('Нет сохранённых аккаунтов.');
        await prompt('ENTER — вернуться…');
        return;
    }

    printAccounts(accounts);
    const answer = await prompt('Номер аккаунта для удаления (ENTER — отмена): ');
    if (!answer) return;

    const choice = Number.parseInt(answer, 10);
    if (Number.isNaN(choice) || choice < 1 || choice > accounts.length) {
        console.log('Неверный выбор.');
        return;
    }

    const account = accounts[choice - 1];
    const confirm = await prompt(`Удалить ${account.id}? (y/N): `);
    if (confirm.toLowerCase() !== 'y') return;

    removeAccount(account.id);
    try {
        const dir = safeJoin(ACCOUNTS_DIR, account.id);
        if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
        logError(`Не удалось удалить директорию аккаунта ${account.id}`, error);
    }

    logInfo(`Аккаунт ${account.id} удалён.`);
}

export async function interactiveAccountMenu() {
    for (;;) {
        printAccounts();
        console.log('\n=== Управление аккаунтами ===');
        console.log(formatForgetMeAiWatermark());
        console.log('1 - Добавить аккаунт');
        console.log('2 - Перелогинить аккаунт');
        console.log('3 - Удалить аккаунт');
        console.log('4 - Выход');

        const choice = await prompt('Ваш выбор: ');
        if (choice === '1') await addAccountInteractive();
        else if (choice === '2') await reloginAccountInteractive();
        else if (choice === '3') await removeAccountInteractive();
        else if (choice === '4') break;
        else console.log('Неверный выбор.');
    }
}
