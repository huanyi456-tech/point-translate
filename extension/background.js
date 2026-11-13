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

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error('翻译服务连接超时');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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

function parseBingAuth(html, base = BING_BASE) {
  const ig = /IG\s*:\s*"([0-9A-Fa-f]+)"/.exec(html);
  const iid = /data-iid\s*=\s*"(translator\.\d+)"/.exec(html);
  const helper = /params_AbusePreventionHelper\s*=\s*\[(\d+)\s*,\s*"([^"]+)"/.exec(html);

  if (!ig || !iid || !helper) {
    throw new Error('Bing 翻译页面格式已变化');
  }

  return {
    base,
    ig: ig[1],
    iid: iid[1],
    key: helper[1],
    token: helper[2],
    expiresAt: Date.now() + AUTH_TTL_MS
  };
}

async function fetchBingAuth(base) {
  const response = await fetchWithTimeout(`${base}/translator?setlang=zh-Hans`, {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store',
    headers: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7'
    }
  }, 20000);
  if (!response.ok) throw new Error(`Bing 翻译页面 HTTP ${response.status}`);

  // 系统代理在中国大陆以外时，cn.bing.com 会 301 到 www.bing.com。
  // 必须记住最终域名；否则后续 POST 会再次被 302 成 GET，响应体为空。
  let finalBase = base;
  try {
    if (response.url) finalBase = new URL(response.url).origin;
  } catch (error) {
    finalBase = base;
  }

  const html = await response.text();
  return parseBingAuth(html, finalBase);
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

function bingHttpError(status) {
  const error = new Error(`Bing 翻译 HTTP ${status}`);
  // 400/413 通常是请求过大，换域名或刷新令牌都没用，立即交给上层处理。
  if (status === 400 || status === 413) error.permanent = true;
  return error;
}

async function bingTranslateOnce(text, auth, base = auth.base) {
  const params = new URLSearchParams();
  params.set('fromLang', 'auto-detect');
  params.set('to', TARGET_LANG);
  params.set('text', text);
  params.set('token', auth.token);
  params.set('key', auth.key);

  const url = `${base}/ttranslatev3?isVertical=1&IG=${encodeURIComponent(auth.ig)}&IID=${encodeURIComponent(auth.iid)}.1`;
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Accept': 'application/json, text/plain, */*'
    },
    body: params.toString()
  }, 20000);

  if (!response.ok) throw bingHttpError(response.status);

  const raw = await response.text();
  if (raw.trim()) return parseBingResponse(raw, response);

  // 经过系统代理时，Bing 可能把 POST 302 成 GET，最终返回 200 + 空 body。
  // 把 response.url 作为下一次 POST 的目标，保留请求体重新提交。
  if (response.redirected && response.url && response.url !== url) {
    const retry = await fetchWithTimeout(response.url, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Accept': 'application/json, text/plain, */*'
      },
      body: params.toString()
    }, 20000);
    if (!retry.ok) throw bingHttpError(retry.status);
    return parseBingResponse(await retry.text(), retry);
  }

  throw new Error(`Bing 翻译返回空响应（HTTP ${response.status}）`);
}

function parseBingResponse(raw, response) {
  if (!raw || !raw.trim()) {
    throw new Error(`Bing 翻译返回空响应（HTTP ${response.status}）`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    const type = response.headers.get('content-type') || '未知类型';
    throw new Error(`Bing 翻译返回了无法解析的内容（HTTP ${response.status}，${type}）`);
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
      const bases = [auth.base];
      const alternate = auth.base.includes('cn.bing.com') ? BING_FALLBACK_BASE : BING_BASE;
      if (alternate !== auth.base) bases.push(alternate);

      for (const base of bases) {
        try {
          const translated = await bingTranslateOnce(text, auth, base);
          if (base !== auth.base) {
            bingAuth = { ...auth, base };
          }
          return translated;
        } catch (error) {
          lastError = error;
          if (error.permanent) throw error;
        }
      }
    } catch (error) {
      if (error.permanent) throw error;
      lastError = error;
    }

    bingAuth = null;
    if (attempt === 0) await sleep(250);
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
  const workerCount = Math.min(12, Math.max(1, texts.length));

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
