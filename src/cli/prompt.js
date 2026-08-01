import readline from 'readline';

/**
 * Reads a line from stdin.
 * @param {string} question — prompt text
 * @returns {Promise<string>} — answer without surrounding whitespace
 */
export function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => {
        rl.close();
        resolve(answer.trim());
    }));
}
