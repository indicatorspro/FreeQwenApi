// Скрипт interactively добавляет новые аккаунты.
// Запуск: node scripts/addAccount.js

import { interactiveAccountMenu } from '../src/cli/accounts.js';

(async () => {
    await interactiveAccountMenu();
})(); 