/* 用 CDP 把当前目录的扩展加载到已启动的测试 Chrome。
 * 用法：CDP=http://127.0.0.1:9333 node scripts/load-extension.mjs
 * 仅用于自动化测试；日常安装请按 README 手动“加载已解压的扩展程序”。
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEBUG = process.env.CDP || 'http://127.0.0.1:9333';
const EXT_PATH = resolve(process.env.EXT_PATH || fileURLToPath(new URL('../extension', import.meta.url)));

async function main() {
  const version = await (await fetch(`${DEBUG}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => {
    ws.addEventListener('open', resolvePromise, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });

  const send = (method, params = {}) => new Promise((resolvePromise, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve: resolvePromise, reject });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });

  const result = await send('Extensions.loadUnpacked', { path: EXT_PATH });
  console.log(JSON.stringify(result));
  ws.close();
}

main().catch((error) => {
  console.error('LOAD FAILED', error.message);
  process.exit(1);
});
