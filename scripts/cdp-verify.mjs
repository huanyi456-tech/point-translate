/* 真实 Chrome + CDP 端到端验收：悬停、整页、动态内容、恢复。 */
import { writeFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const DEBUG = process.env.CDP || 'http://127.0.0.1:9333';
const PAGE_URL = process.env.PAGE_URL || 'http://127.0.0.1:8799/';
const OUT = process.env.OUT || 'tests/shots';
const EXT_DIR = resolve(process.env.EXT_PATH || fileURLToPath(new URL('../extension', import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
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
  return (await fetch(`${DEBUG}/json/list`)).json();
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed');
  return result.result.value;
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
}

async function extensionId() {
  const version = await (await fetch(`${DEBUG}/json/version`)).json();
  const browser = await new CDP(version.webSocketDebuggerUrl).connect();
  const { extensions } = await browser.send('Extensions.getExtensions');
  browser.close();
  const wanted = realpathSync(process.env.EXT_PATH ? resolve(process.env.EXT_PATH) : EXT_DIR);
  const ext = extensions.find((item) => {
    try { return realpathSync(item.path) === wanted; } catch (error) { return item.path === wanted; }
  });
  if (!ext) throw new Error('extension not loaded');
  return ext.id;
}


async function tooltipState(cdp) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  let tooltip = null;
  const walk = (node) => {
    if (!node || tooltip) return;
    if (node.nodeName === 'DIV' && node.attributes) {
      const index = node.attributes.indexOf('class');
      const cls = index >= 0 ? node.attributes[index + 1] : '';
      if (cls.includes('zt-tooltip')) { tooltip = node; return; }
    }
    for (const child of node.children || []) walk(child);
    for (const shadow of node.shadowRoots || []) walk(shadow);
  };
  walk(root);
  if (!tooltip) return { visible: false, zh: '' };
  const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId: tooltip.nodeId });
  const zhMatch = outerHTML.match(/id="zt-tt-zh"[^>]*>([\s\S]*?)<\/div>/);
  return {
    visible: /class="zt-tooltip[^"]*zt-visible/.test(outerHTML),
    zh: (zhMatch ? zhMatch[1] : '').trim(),
  };
}

async function waitForTooltipTranslation(cdp, timeout = 9000) {
  const started = Date.now();
  let state = await tooltipState(cdp);
  while (Date.now() - started < timeout) {
    if (state.visible && state.zh && !state.zh.includes('正在翻译')) return state;
    await sleep(200);
    state = await tooltipState(cdp);
  }
  return state;
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

async function main() {
  const id = await extensionId();
  const list = await targets();
  const page = list.find((t) => t.type === 'page' && !t.url.startsWith('chrome://'));
  if (!page) throw new Error('no page target');

  const cdp = await new CDP(page.webSocketDebuggerUrl).connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1000, height: 760, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.navigate', { url: PAGE_URL });
  await sleep(2200);

  const fresh = await targets();
  const swTarget = fresh.find((t) => t.type === 'service_worker' && t.url.includes(id));
  if (!swTarget) throw new Error('service worker not found');
  const sw = await new CDP(swTarget.webSocketDebuggerUrl).connect();
  await sw.send('Runtime.enable');

  const state = await evaluate(sw, `(async () => {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      try {
        const s = await chrome.tabs.sendMessage(tab.id, { type: 'getPageState' });
        if (s && s.ok) return { tabId: tab.id, state: s };
      } catch (e) {}
    }
    return null;
  })()`);
  assert(state, 'content script not ready');
  const tabId = state.tabId;

  const rect = await evaluate(cdp, `(() => {
    const r = document.querySelector('#p1').getBoundingClientRect();
    return { x: r.x + 80, y: r.y + 12 };
  })()`);
  const moveTo = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none',
    });
  };

  // 1) 悬停翻译（页面仍为英文）
  await moveTo(rect.x, rect.y);
  const hoverFirst = await waitForTooltipTranslation(cdp);
  await shot(cdp, 'hover-before-translate');
  assert(hoverFirst.visible, 'hover tooltip should be visible');
  assert(/[\u4e00-\u9fff]/.test(hoverFirst.zh), `hover translation empty: ${JSON.stringify(hoverFirst)}`);
  console.log('HOVER first done', JSON.stringify(hoverFirst));

  // 2) 移开再回来，同一句应再次显示
  await moveTo(8, 700);
  await sleep(350);
  await moveTo(rect.x, rect.y);
  const hoverSecond = await waitForTooltipTranslation(cdp);
  await shot(cdp, 'hover-second');
  assert(hoverSecond.visible, 'second hover tooltip should be visible');
  assert(/[\u4e00-\u9fff]/.test(hoverSecond.zh), `cached hover translation empty: ${JSON.stringify(hoverSecond)}`);
  console.log('HOVER second done', JSON.stringify(hoverSecond));

  // 3) 关闭悬停后不应出现提示
  const off = await evaluate(sw, `chrome.tabs.sendMessage(${tabId}, { type: 'toggleHover' })`);
  assert(off.ok && off.hoverEnabled === false, 'hover should be off');
  await moveTo(8, 700);
  await sleep(300);
  await moveTo(rect.x + 2, rect.y);
  await sleep(1000);
  await shot(cdp, 'hover-disabled');
  const hoverDisabled = await tooltipState(cdp);
  assert(!hoverDisabled.visible, `hover tooltip should be hidden: ${JSON.stringify(hoverDisabled)}`);
  const on = await evaluate(sw, `chrome.tabs.sendMessage(${tabId}, { type: 'toggleHover' })`);
  assert(on.ok && on.hoverEnabled === true, 'hover should be on');
  console.log('HOVER toggle done');

  // 4) 整页翻译
  const translated = await evaluate(sw, `chrome.tabs.sendMessage(${tabId}, { type: 'translatePage' })`);
  assert(translated.ok, `translate failed: ${JSON.stringify(translated)}`);
  assert(translated.count === 8, `expected 8 entries, got ${translated.count}`);
  assert(translated.failed === 0, `expected 0 failed, got ${translated.failed}`);
  const after = await evaluate(cdp, `(() => ({
    h1: document.querySelector('h1').textContent,
    p1: document.querySelector('#p1').textContent,
    p2: document.querySelector('#p2').textContent,
    p3: document.querySelector('#p3').textContent,
    p4: document.querySelector('#p4').textContent,
    btn: document.querySelector('#btn').textContent,
    btnTitle: document.querySelector('#btn').title,
    placeholder: document.querySelector('#inp').placeholder,
    toast: document.body.innerText.includes('已翻译 8 处文字')
  }))()`);
  console.log('PAGE', JSON.stringify(after, null, 2));
  for (const key of ['h1', 'p1', 'p2', 'p3', 'p4', 'btn', 'btnTitle', 'placeholder']) {
    assert(/[\u4e00-\u9fff]/.test(after[key]), `${key} is not Chinese: ${after[key]}`);
  }
  await shot(cdp, 'page-translated');

  // 5) 动态追加内容应自动补译
  await evaluate(cdp, `(() => {
    const p = document.createElement('p');
    p.id = 'dyn';
    p.textContent = 'This new paragraph appeared after the page was translated, and it should also become Chinese.';
    document.body.appendChild(p);
  })()`);
  await sleep(3200);
  const dyn = await evaluate(cdp, `document.querySelector('#dyn').textContent`);
  console.log('DYNAMIC', dyn);
  assert(/[\u4e00-\u9fff]/.test(dyn), `dynamic paragraph not translated: ${dyn}`);
  await shot(cdp, 'page-dynamic');

  // 6) 恢复原文（含动态段落）
  const restored = await evaluate(sw, `chrome.tabs.sendMessage(${tabId}, { type: 'restorePage' })`);
  assert(restored.ok, 'restore failed');
  const originals = await evaluate(cdp, `(() => ({
    h1: document.querySelector('h1').textContent,
    p1: document.querySelector('#p1').textContent,
    btnTitle: document.querySelector('#btn').title,
    placeholder: document.querySelector('#inp').placeholder,
    dyn: document.querySelector('#dyn').textContent
  }))()`);
  console.log('RESTORED', JSON.stringify(originals, null, 2));
  assert(originals.h1 === 'A Simple Guide to Better Sleep', 'h1 not restored');
  assert(originals.p1.startsWith('Good sleep'), 'p1 not restored');
  assert(originals.btnTitle === 'Click me to learn more', 'title not restored');
  assert(originals.placeholder === 'Search for sleep tips', 'placeholder not restored');
  assert(originals.dyn.startsWith('This new paragraph'), 'dynamic paragraph not restored');
  await shot(cdp, 'page-restored');

  cdp.close(); sw.close();
  console.log('ALL PASS');
}

main().catch((error) => {
  console.error('VERIFY FAILED', error);
  setTimeout(() => process.exit(1), 100);
});
