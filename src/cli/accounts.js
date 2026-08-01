// Interactive management of Qwen accounts from the console.

import fs from 'fs';
import path from 'path';

import { logError, logInfo } from '../shared/logger.js';
import { ACCOUNTS_DIR, ensureDir, safeJoin } from '../shared/paths.js';
import { prompt } from './prompt.js';
import { getBrowserContext, initBrowser, shutdownBrowser } from '../browser/browser.js';
import { extractAuthToken } from '../core/qwen/tokens.js';
import { loadAuthToken } from '../browser/session.js';
import { accountStatus, listAccounts, loadAccounts, markValid, removeAccount, saveAccounts } from '../core/accounts/store.js';

const STATUS_LABELS = {
    OK: '✅ OK',
    WAIT: '⏳ Waiting for reset',
    INVALID: '❌ Invalid',
    EXPIRED: '⚠️ Token expired'
};

export function printAccounts(accounts = listAccounts()) {
    console.log('\nAccount list:');
    if (accounts.length === 0) {
        console.log('  (empty)');
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
    if (!dir) throw new Error(`Invalid account id: ${id}`);
    return ensureDir(dir);
}

/** Opens the browser, waits for the user to log in, and saves the token as a new account. */
export async function addAccountInteractive() {
    logInfo('Adding a new Qwen account');
    logInfo('A browser will open: log in to the account and return to the console.');

    if (!await initBrowser(true, true)) {
        logError('Failed to launch the browser.');
        return null;
    }

    let token = await extractAuthToken(getBrowserContext(), true);
    if (!token) {
        token = loadAuthToken();
        if (token) logInfo('Token taken from the saved file.');
    }

    await shutdownBrowser();

    if (!token) {
        logError('No token obtained, account not added.');
        return null;
    }

    const id = `acc_${Date.now()}`;
    fs.writeFileSync(path.join(accountDir(id), 'token.txt'), token, 'utf8');

    const accounts = loadAccounts();
    accounts.push({ id, token, resetAt: null });
    saveAccounts(accounts);

    logInfo(`Account '${id}' added. Total accounts: ${accounts.length}`);
    return id;
}

/** Updates the token of an account whose login has expired. */
export async function reloginAccountInteractive() {
    const accounts = listAccounts();
    const broken = accounts.filter(account => account.invalid);

    if (broken.length === 0) {
        console.log('No accounts require re-login.');
        await prompt('ENTER — return to the menu…');
        return;
    }

    console.log('\nAccounts with expired tokens:');
    broken.forEach((account, index) => console.log(`${index + 1} - ${account.id}`));

    const choice = Number.parseInt(await prompt('Account number to re-login: '), 10);
    if (Number.isNaN(choice) || choice < 1 || choice > broken.length) {
        console.log('Invalid choice.');
        return;
    }

    const account = broken[choice - 1];
    logInfo(`Re-authentication: ${account.id}`);

    if (!await initBrowser(true, true)) {
        logError('Failed to launch the browser.');
        return;
    }

    const token = await extractAuthToken(getBrowserContext(), true);
    await shutdownBrowser();

    if (!token) {
        logError('Failed to extract token.');
        return;
    }

    markValid(account.id, token);
    fs.writeFileSync(path.join(accountDir(account.id), 'token.txt'), token, 'utf8');
    logInfo(`Token updated: ${account.id}`);
}

export async function removeAccountInteractive() {
    const accounts = listAccounts();
    if (accounts.length === 0) {
        console.log('No saved accounts.');
        await prompt('ENTER — return…');
        return;
    }

    printAccounts(accounts);
    const answer = await prompt('Account number to remove (ENTER — cancel): ');
    if (!answer) return;

    const choice = Number.parseInt(answer, 10);
    if (Number.isNaN(choice) || choice < 1 || choice > accounts.length) {
        console.log('Invalid choice.');
        return;
    }

    const account = accounts[choice - 1];
    const confirm = await prompt(`Remove ${account.id}? (y/N): `);
    if (confirm.toLowerCase() !== 'y') return;

    removeAccount(account.id);
    try {
        const dir = safeJoin(ACCOUNTS_DIR, account.id);
        if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
        logError(`Failed to delete account directory ${account.id}`, error);
    }

    logInfo(`Account ${account.id} removed.`);
}

export async function interactiveAccountMenu() {
    for (;;) {
        printAccounts();
        console.log('\n=== Account management ===');
        console.log('1 - Add account');
        console.log('2 - Re-login account');
        console.log('3 - Remove account');
        console.log('4 - Exit');

        const choice = await prompt('Your choice: ');
        if (choice === '1') await addAccountInteractive();
        else if (choice === '2') await reloginAccountInteractive();
        else if (choice === '3') await removeAccountInteractive();
        else if (choice === '4') break;
        else console.log('Invalid choice.');
    }
}
