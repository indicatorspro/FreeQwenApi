// Runs the proxy with a TCP bridge to its stdin, so Enter / input can be
// forwarded from another process (e.g. to confirm manual auth/captcha).
// Usage: node scripts/headless-supervisor.mjs [stdinPort]
import { spawn } from 'child_process';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const stdinPort = Number(process.argv[2] || 3270);
const prefix = `[supervisor:${process.pid}]`;

const child = spawn(process.execPath, ['index.js'], {
    cwd: projectRoot,
    env: { ...process.env, SKIP_ACCOUNT_MENU: 'true' },
    stdio: ['pipe', 'inherit', 'inherit']
});
console.log(`${prefix} server pid ${child.pid}, stdin bridge on 127.0.0.1:${stdinPort}`);

const server = net.createServer((socket) => {
    console.log(`${prefix} stdin client connected`);
    socket.on('data', (data) => {
        if (child.stdin && !child.stdin.destroyed) {
            child.stdin.write(data);
            console.log(`${prefix} forwarded ${data.length} byte(s) to server stdin`);
        }
    });
    socket.on('error', () => {});
    socket.on('end', () => console.log(`${prefix} stdin client disconnected`));
});

server.listen(stdinPort, '127.0.0.1');

child.on('exit', (code) => {
    console.log(`${prefix} server exited (code ${code}), supervisor exiting`);
    server.close();
    process.exit(code ?? 0);
});
