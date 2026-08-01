// Script that interactively adds new accounts.
// Run: node scripts/addAccount.js

import { interactiveAccountMenu } from '../src/cli/accounts.js';

(async () => {
    await interactiveAccountMenu();
})();
