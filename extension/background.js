/* 指译 — background service worker
 * 负责：右键菜单、快捷键、翻译请求、Bing 网页翻译接口的会话令牌。
 * 不收集、不上传用户数据；只把待翻译的文字发送给翻译服务。
 */

const DEFAULT_SETTINGS = {
  hoverEnabled: true,
  showFab: true
};

const BING_BASE = 'https://cn.bing.com';
const BING_FALLBACK_BASE = 'https://www.bing.com';
const TARGET_LANG = 'zh-Hans';
const AUTH_TTL_MS = 45 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

const memoryCache = new Map();

let bingAuth = null;
let bingAuthPromise = null;

/* ------------------------------------------------------------------ */
/* 基础工具                                                           */
/* ------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheGet(text) {
  const hit = memoryCache.get(text);
  if (hit) {
    memoryCache.delete(text);
    memoryCache.set(text, hit);
  }
  return hit;
}

function cacheSet(text, translated, provider) {
  if (!text || !translated) return;
  if (text.length > 5000) return;
  memoryCache.set(text, { translated, provider });
  while (memoryCache.size > MAX_CACHE_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    memoryCache.delete(oldest);
  }
}

async function ensureDefaults() {
  const current = await chrome.storage.local.get(['hoverEnabled', 'showFab']);
  const patch = {};
  if (typeof current.hoverEnabled !== 'boolean') patch.hoverEnabled = DEFAULT_SETTINGS.hoverEnabled;
  if (typeof current.showFab !== 'boolean') patch.showFab = DEFAULT_SETTINGS.showFab;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'zt-translate-page',
      title: '翻译整个页面',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'zt-translate-selection',
      title: '翻译选中的文字',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'zt-restore-page',
      title: '恢复网页原文',
      contexts: ['page']
    });
  });
}

/* ------------------------------------------------------------------ */
/* 向标签页发送消息（必要时补注入 content script）                     */
/* ------------------------------------------------------------------ */

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (firstError) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    await sleep(80);
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function handleCommand(command) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || typeof tab.id !== 'number') return;
  if (!/^https?:/i.test(tab.url || '')) return;

  const type = command === 'translate-page' ? 'translatePage'
    : command === 'toggle-hover' ? 'toggleHover'
      : null;
  if (!type) return;

  try {
    await sendToTab(tab.id, { type: 'command', command: type });
  } catch (error) {
    console.warn('[指译] 无法在当前页面执行命令：', error && error.message);
  }
}

/* ------------------------------------------------------------------ */
/* Bing 网页翻译接口                                                   */
/* ------------------------------------------------------------------ */

function parseBingAuth(html) {
  const ig = /IG\s*:\s*"([0-9A-Fa-f]+)"/.exec(html);
  const iid = /data-iid\s*=\s*"(translator\.\d+)"/.exec(html);
  const helper = /params_AbusePreventionHelper\s*=\s*\[(\d+)\s*,\s*"([^"]+)"/.exec(html);

  if (!ig || !iid || !helper) {
    throw new Error('Bing 翻译页面格式已变化');
  }

  return {
    base: BING_BASE,
    ig: ig[1],
    iid: iid[1],
    key: helper[1],
    token: helper[2],
    expiresAt: Date.now() + AUTH_TTL_MS
  };
}

async function fetchBingAuth(base) {
  const response = await fetch(`${base}/translator?setlang=zh-Hans`, {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store',
    headers: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7'
    }
  });
  if (!response.ok) throw new Error(`Bing 翻译页面 HTTP ${response.status}`);
  const html = await response.text();
  return parseBingAuth(html);
}

async function getBingAuth(force = false) {
  if (!force && bingAuth && Date.now() < bingAuth.expiresAt) return bingAuth;
  if (bingAuthPromise) return bingAuthPromise;

  bingAuthPromise = (async () => {
    try {
      return await fetchBingAuth(BING_BASE);
    } catch (firstError) {
      try {
        return await fetchBingAuth(BING_FALLBACK_BASE);
      } catch (secondError) {
        throw new Error(`Bing 服务连接失败：${secondError.message || firstError.message}`);
      }
    }
  })();

  try {
    bingAuth = await bingAuthPromise;
    return bingAuth;
  } finally {
    bingAuthPromise = null;
  }
}

async function bingTranslateOnce(text, auth) {
  const params = new URLSearchParams();
  params.set('fromLang', 'auto-detect');
  params.set('to', TARGET_LANG);
  params.set('text', text);
  params.set('token', auth.token);
  params.set('key', auth.key);

  const url = `${auth.base}/ttranslatev3?isVertical=1&IG=${encodeURIComponent(auth.ig)}&IID=${encodeURIComponent(auth.iid)}.1`;
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Accept': 'application/json, text/plain, */*'
    },
    body: params.toString()
  });

  if (!response.ok) throw new Error(`Bing 翻译 HTTP ${response.status}`);

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error('Bing 翻译返回了无法解析的内容');
  }

  const translated = data
    && Array.isArray(data)
    && data[0]
    && Array.isArray(data[0].translations)
    && data[0].translations[0]
    && data[0].translations[0].text;

  if (typeof translated === 'string' && translated.trim()) return translated;

  const code = data && data.statusCode;
  throw new Error(`Bing 翻译失败${code ? `（${code}）` : ''}`);
}

async function bingTranslate(text) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const auth = await getBingAuth(attempt > 0);
      return await bingTranslateOnce(text, auth);
    } catch (error) {
      lastError = error;
      bingAuth = null;
      if (attempt === 0) await sleep(250);
    }
  }

  throw lastError || new Error('Bing 翻译失败');
}

/* ------------------------------------------------------------------ */
/* MyMemory 备用接口                                                   */
/* ------------------------------------------------------------------ */

function splitMarkedText(text, maxLength) {
  if (text.length <= maxLength) return [text];

  // 整页翻译使用纯文本标记 @@ZT0@@正文@@/ZT0@@；
  // MyMemory 单次最多约 500 字符，必须按完整标记边界切分。
  const markerPattern = /@@\s*ZT\d+\s*@@[\s\S]*?@@\s*\/\s*ZT\d+\s*@@/g;
  const markers = text.match(markerPattern);

  if (!markers) {
    // 悬停翻译的单段长文本没有标记，按句子切成不超过上限的小段。
    const sentences = text.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
    if (sentences.length <= 1) return null;
    const chunks = [];
    let current = '';
    for (const sentence of sentences) {
      if (sentence.length > maxLength) return null;
      if (current && current.length + sentence.length + 1 > maxLength) {
        chunks.push(current);
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }
    if (current) chunks.push(current);
    return chunks.length > 1 ? chunks : null;
  }

  const leftovers = text.replace(markerPattern, '').replace(/\s+/g, '');
  if (leftovers) return null;

  const parts = [];
  let current = '';

  for (const marker of markers) {
    if (marker.length > maxLength) return null;
    if (current && current.length + marker.length + 1 > maxLength) {
      parts.push(current);
      current = marker;
    } else {
      current = current ? `${current} ${marker}` : marker;
    }
  }
  if (current) parts.push(current);
  return parts;
}

async function mymemoryTranslatePart(text) {
  const url = new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q', text);
  url.searchParams.set('langpair', 'autodetect|zh-CN');

  const response = await fetch(url.toString(), {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`MyMemory HTTP ${response.status}`);

  const data = await response.json();
  const translated = data && data.responseData && data.responseData.translatedText;
  const status = Number(data && data.responseStatus);

  if (typeof translated !== 'string' || !translated.trim()) {
    throw new Error(data && data.responseDetails ? String(data.responseDetails) : 'MyMemory 翻译失败');
  }
  if (/QUERY LENGTH LIMIT EXCEEDED|MYMEMORY WARNING|INVALID SOURCE LANGUAGE|INVALID TARGET LANGUAGE/i.test(translated)) {
    throw new Error('MyMemory 今日免费额度已用完或请求过长');
  }
  if (status !== 200) {
    throw new Error(`MyMemory 翻译失败（${status || '未知'}）`);
  }

  return translated;
}

async function mymemoryTranslate(text) {
  if (text.length <= 480) return mymemoryTranslatePart(text);

  const parts = splitMarkedText(text, 460);
  if (!parts) throw new Error('备用翻译接口不支持这段过长的文字');

  const translated = [];
  for (const part of parts) {
    translated.push(await mymemoryTranslatePart(part));
    await sleep(120);
  }
  return translated.join(' ');
}

/* ------------------------------------------------------------------ */
/* 对外翻译入口                                                        */
/* ------------------------------------------------------------------ */

async function translateOne(text) {
  const cached = cacheGet(text);
  if (cached) {
    return { text: cached.translated, provider: cached.provider, cached: true };
  }

  try {
    const translated = await bingTranslate(text);
    cacheSet(text, translated, 'bing');
    return { text: translated, provider: 'bing' };
  } catch (bingError) {
    try {
      const translated = await mymemoryTranslate(text);
      cacheSet(text, translated, 'mymemory');
      return { text: translated, provider: 'mymemory' };
    } catch (fallbackError) {
      throw new Error(`翻译服务暂时不可用：${bingError.message || 'Bing 失败'}；${fallbackError.message || '备用服务失败'}`);
    }
  }
}

async function translateMany(texts) {
  const results = new Array(texts.length);
  let cursor = 0;
  const workerCount = Math.min(3, Math.max(1, texts.length));

  async function worker() {
    while (cursor < texts.length) {
      const index = cursor;
      cursor += 1;
      try {
        const result = await translateOne(texts[index]);
        results[index] = { ok: true, ...result };
      } catch (error) {
        results[index] = { ok: false, error: error.message || String(error) };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/* ------------------------------------------------------------------ */
/* 生命周期与消息                                                      */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaults().catch(() => {});
  createMenus();
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaults().catch(() => {});
});

chrome.commands.onCommand.addListener((command) => {
  handleCommand(command).catch((error) => {
    console.warn('[指译] 快捷键处理失败：', error && error.message);
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || typeof tab.id !== 'number') return;

  try {
    if (info.menuItemId === 'zt-translate-page') {
      await sendToTab(tab.id, { type: 'translatePage' });
    } else if (info.menuItemId === 'zt-restore-page') {
      await sendToTab(tab.id, { type: 'restorePage' });
    } else if (info.menuItemId === 'zt-translate-selection') {
      const selection = typeof info.selectionText === 'string' ? info.selectionText.trim() : '';
      if (selection) await sendToTab(tab.id, { type: 'translateSelection', text: selection });
    }
  } catch (error) {
    console.warn('[指译] 右键菜单执行失败：', error && error.message);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'translate') {
    const text = typeof message.text === 'string' ? message.text : '';
    if (!text.trim()) {
      sendResponse({ ok: false, error: '没有可翻译的文字' });
      return false;
    }

    translateOne(text)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'translateMany') {
    const texts = Array.isArray(message.texts)
      ? message.texts.filter((text) => typeof text === 'string' && text.trim())
      : [];
    if (!texts.length) {
      sendResponse({ ok: false, error: '没有可翻译的文字' });
      return false;
    }

    translateMany(texts)
      .then((results) => sendResponse({ ok: true, results }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === 'settingsUpdated') {
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
