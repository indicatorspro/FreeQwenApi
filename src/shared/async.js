/** Pauses for the specified number of milliseconds. */
export const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wraps a promise with a timeout.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, message = 'Operation timed out') {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}