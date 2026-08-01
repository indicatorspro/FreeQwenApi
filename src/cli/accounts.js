// Interactive management of Qwen accounts from the console.

import { logError, logInfo } from '../shared/logger.js';
import { prompt } from './prompt.js';
import { initBrowser, shutdownBrowser } from '../browser/browser.js';
import { accountStatus, listAccounts, loadAccounts, removeAccount } from '../core/accounts/store.js';

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

/** Opens the browser, waits for the user to log in, and saves the token as a new account. */
export async function addAccountInteractive() {
    logInfo('Adding a new Qwen account');
    logInfo('A browser will open: log in to the account and return to the console.');

    // initBrowser -> runManualAuthentication already saves the token, cookies
    // and the tokens.json record for the new account. It returns the account id.
    const accountId = await initBrowser(true, true);
    await shutdownBrowser();

    if (typeof accountId !== 'string') {
        logError('No token obtained, account not added.');
        return null;
    }

    const accounts = loadAccounts();
    logInfo(`Account '${accountId}' added. Total accounts: ${accounts.length}`);
    return accountId;
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

    // initBrowser -> runManualAuthentication restores the account session,
    // refreshes cookies/token and marks the account valid.
    const accountId = await initBrowser(true, true, account.id);
    await shutdownBrowser();

    if (typeof accountId !== 'string') {
        logError('Failed to extract token.');
        return;
    }

    logInfo(`Token updated: ${accountId}`);
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

    // removeAccount also deletes the account directory (token.txt/cookies.json).
    removeAccount(account.id);
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
