import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.js'],
        environment: 'node',
        // Logs and file operations in tests write to the project working directory,
        // so tests run sequentially.
        pool: 'forks',
        env: {
            LOG_LEVEL: 'error',
            LOG_CONSOLE: '0'
        }
    }
});
