/* 用真实 Chrome + CDP 验证指译扩展。仅用于本地测试。 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const DEBUG = process.env.CDP || 'http://127.0.0.1:9333';
const PAGE_URL = process.env.PAGE_URL || 'http://127.0.0.1:8799/';
const OUT = process.env.OUT || 'tests/shots';
const EXT_DIR = resolve(fileURLToPath(new URL('../extension', import.meta.url)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    });
    return this;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function targets() {
  const res = await fetch(`${DEBUG}/json/list`);
  return res.json();
}

async function evaluate(cdp, expression, awaitPromise = true) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'evaluate failed');
  }
  return result.result.value;
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
}

async function getExtensionId() {
  const version = await (await fetch(`${DEBUG}/json/version`)).json();
  const browser = await new CDP(version.webSocketDebuggerUrl).connect();
  const { extensions } = await browser.send('Extensions.getExtensions');
  browser.close();
  const wanted = process.env.EXT_PATH ? resolve(process.env.EXT_PATH) : EXT_DIR;
  const ext = extensions.find((item) => item.path === wanted);
  if (!ext) throw new Error('point-translate extension is not loaded');
  return ext.id;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const list = await targets();
  const page = list.find((t) => t.type === 'page' && !t.url.startsWith('chrome'));
  if (!page) throw new Error('no page target');

  const pageCdp = await new CDP(page.webSocketDebuggerUrl).connect();
  await pageCdp.send('Page.enable');
  await pageCdp.send('Runtime.enable');
  await pageCdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1000, height: 760, deviceScaleFactor: 1, mobile: false,
  });
  await pageCdp.send('Page.navigate', { url: PAGE_URL });
  await sleep(2200);

  const before = await evaluate(pageCdp, `(() => {
    const p = document.querySelector('#p1');
    return {
      title: document.title,
      text: p && p.textContent,
      host: !!document.getElementById('zh-translator-root'),
      hostCount: document.querySelectorAll('#zh-translator-root').length,
      rect: p && (() => { const r = p.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })(),
      ready: document.readyState,
      lang: document.documentElement.lang,
      body: document.body.innerText.slice(0, 300)
    };
  })()`);
  console.log('BEFORE', JSON.stringify(before, null, 2));

  const extId = await getExtensionId();
  const fresh = await targets();
  const sw = fresh.find((t) => t.type === 'service_worker' && t.url.includes(extId));
  if (!sw) throw new Error(`extension service worker not found: ${extId}`);

  const swCdp = await new CDP(sw.webSocketDebuggerUrl).connect();
  await swCdp.send('Runtime.enable');

  const tabs = await evaluate(swCdp, `(async () => {
    const tabs = await chrome.tabs.query({});
    const out = [];
    for (const t of tabs) {
      try {
        const state = await chrome.tabs.sendMessage(t.id, { type: 'getPageState' });
        if (state && state.ok) out.push({ id: t.id, state });
      } catch (e) {}
    }
    return out;
  })()`);
  console.log('CONTENT TABS', JSON.stringify(tabs, null, 2));
  if (!tabs.length) throw new Error('no tab with content script');

  const tabId = tabs[0].id;
  const translateResult = await evaluate(swCdp, `chrome.tabs.sendMessage(${tabId}, { type: 'translatePage' })`);
  console.log('TRANSLATE RESULT', JSON.stringify(translateResult, null, 2));

  await sleep(600);
  const after = await evaluate(pageCdp, `(() => ({
    h1: document.querySelector('h1').textContent,
    p1: document.querySelector('#p1').textContent,
    p2: document.querySelector('#p2').textContent,
    p3: document.querySelector('#p3').textContent,
    p4: document.querySelector('#p4').textContent,
    btn: document.querySelector('#btn').textContent,
    btnTitle: document.querySelector('#btn').title,
    placeholder: document.querySelector('#inp').placeholder,
    hostCount: document.querySelectorAll('#zh-translator-root').length,
    bodyStart: document.body.innerText.slice(0, 500)
  }))()`);
  console.log('AFTER', JSON.stringify(after, null, 2));
  await shot(pageCdp, 'page-translated');

  // 悬停测试：移到第一段，等 2 秒
  const rect = before.rect;
  await pageCdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: Math.round(rect.x + 40), y: Math.round(rect.y + 10), button: 'none',
  });
  await sleep(2500);
  await shot(pageCdp, 'hover-translated');

  // 恢复原文
  const restoreResult = await evaluate(swCdp, `chrome.tabs.sendMessage(${tabId}, { type: 'restorePage' })`);
  console.log('RESTORE RESULT', JSON.stringify(restoreResult, null, 2));
  await sleep(500);
  const restored = await evaluate(pageCdp, `(() => ({
    h1: document.querySelector('h1').textContent,
    p1: document.querySelector('#p1').textContent,
    btnTitle: document.querySelector('#btn').title,
    placeholder: document.querySelector('#inp').placeholder
  }))()`);
  console.log('RESTORED', JSON.stringify(restored, null, 2));
  await shot(pageCdp, 'page-restored');

  // 弹窗外观
  const pages = await targets();
  const popupTarget = pages.find((t) => t.type === 'page' && t.url === 'about:blank') || page;
  if (popupTarget) {
    const popupCdp = popupTarget === page ? pageCdp : await new CDP(popupTarget.webSocketDebuggerUrl).connect();
    await popupCdp.send('Page.enable');
    await popupCdp.send('Runtime.enable');
    await popupCdp.send('Page.navigate', { url: `chrome-extension://${extId}/popup.html` });
    await sleep(900);
    await shot(popupCdp, 'popup');
    console.log('POPUP URL', await evaluate(popupCdp, 'location.href'));
  }

  pageCdp.close();
  swCdp.close();
}

main().catch((error) => {
  console.error('TEST FAILED', error);
  setTimeout(() => process.exit(1), 100);
});
