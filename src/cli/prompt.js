import readline from 'readline';

/**
 * Читает строку из stdin.
 * @param {string} question — текст вопроса
 * @returns {Promise<string>} — ответ без окружающих пробелов
 */
export function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => {
        rl.close();
        resolve(answer.trim());
    }));
}
