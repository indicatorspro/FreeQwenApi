/** Пауза на указанное количество миллисекунд. */
export const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Оборачивает промис таймаутом.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, message = 'Превышено время ожидания') {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
