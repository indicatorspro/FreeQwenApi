import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: ['node_modules/**', 'logs/**', 'session/**', 'uploads/**', 'examples/**', 'legacy/**', 'scripts/*.mjs']
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.browser
            }
        },
        rules: {
            // ignoreRestSiblings: `const { index, ...rest } = call` — standard
            // way to drop a field from an object, not a forgotten variable.
            'no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrors: 'none',
                ignoreRestSiblings: true
            }],
            'no-console': 'off',
            eqeqeq: ['error', 'smart'],
            'prefer-const': 'error',
            'no-var': 'error'
        }
    },
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            globals: { ...globals.node }
        }
    }
];
