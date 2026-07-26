import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.js'],
        environment: 'node',
        // Логи и файловые операции в тестах пишутся в рабочую директорию проекта,
        // поэтому тесты выполняются последовательно.
        pool: 'forks',
        env: {
            LOG_LEVEL: 'error',
            LOG_CONSOLE: '0'
        }
    }
});
