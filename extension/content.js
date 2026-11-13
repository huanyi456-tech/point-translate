/* 指译 — content script
 * 悬停翻译 + 整页翻译 + 原文恢复。
 * 所有界面都在 closed shadow DOM 中，避免被网页样式影响，也避免污染网页。
 */

(() => {
  'use strict';

  if (window.__ZT_CONTENT_LOADED__) return;
  window.__ZT_CONTENT_LOADED__ = true;

  const DEFAULT_SETTINGS = {
    hoverEnabled: true,
    showFab: true
  };

  const HOST_ID = 'zh-translator-root';
  const HOVER_DELAY_MS = 280;
  const HIDE_DELAY_MS = 260;
  const MAX_CHUNK_CHARS = 1200;
  const MAX_NODE_CHARS = 1200;
  const MAX_HOVER_CHARS = 320;
  const MAX_CHUNK_ITEMS = 22;

  const BLOCK_BOUNDARY_TAGS = new Set([
    'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'TD', 'TH', 'DD', 'DT', 'BLOCKQUOTE', 'FIGCAPTION', 'CAPTION',
    'SUMMARY', 'BUTTON', 'LABEL', 'LEGEND', 'ADDRESS', 'PRE'
  ]);

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'KBD', 'SAMP', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT',
    'EMBED', 'VIDEO', 'AUDIO', 'MATH', 'TEMPLATE'
  ]);

  const SKIP_SELECTOR = [
    `#${HOST_ID}`,
    'script', 'style', 'noscript', 'textarea', 'input', 'select', 'option',
    'code', 'pre', 'kbd', 'samp', 'svg', 'canvas', 'iframe', 'object', 'embed',
    'video', 'audio', '[contenteditable]:not([contenteditable="false"])',
    '[translate="no"]', '.notranslate', '[aria-hidden="true"]'
  ].join(',');

  const settings = { ...DEFAULT_SETTINGS };

  const pageState = {
    active: false,
    busy: false,
    count: 0,
    runToken: 0,
    totalChunks: 0,
    doneChunks: 0,
    originalText: new Map(),
    originalAttrs: new Map(),
    observer: null,
    supplementTimer: null,
    supplementing: false
  };

  let host = null;
  let shadow = null;
  let ui = {};
  let hoverTimer = null;
  let hideTimer = null;
  let hoverRequestSeq = 0;
  let currentHoverKey = '';
  let lastPointer = { x: 0, y: 0 };
  let lastMoveAt = 0;
  let toastTimer = null;
  let selectionRequestSeq = 0;
  const hoverCache = new Map();

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                           */
  /* ------------------------------------------------------------------ */

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isTranslatable(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (trimmed.length < 2) return false;
    if (!/\p{L}/u.test(trimmed)) return false;
    if (/^(?:https?:\/\/|www\.)\S+$/i.test(trimmed)) return false;
    if (/^\S+@\S+\.\S+$/.test(trimmed)) return false;

    const letters = trimmed.match(/\p{L}/gu) || [];
    const han = trimmed.match(/[\u3400-\u9fff]/g) || [];
    if (letters.length && han.length / letters.length > 0.32) return false;

    return true;
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    try {
      if (typeof element.checkVisibility === 'function') {
        return element.checkVisibility({
          checkOpacity: false,
          checkVisibilityCSS: true
        });
      }
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    } catch (error) {
      return true;
    }
  }

  function isInsideUi(node) {
    return Boolean(node && host && (node === host || host.contains(node)));
  }

  function getBlockForNode(node) {
    let element = node && node.parentElement;
    let fallback = element;
    let depth = 0;

    while (element && element !== document.body && depth < 10) {
      if (SKIP_TAGS.has(element.tagName)) return null;
      if (BLOCK_BOUNDARY_TAGS.has(element.tagName)) return element;

      const display = getComputedStyle(element).display;
      if (display === 'none') return null;
      if (display === 'block' || display === 'list-item' || display === 'table-cell'
        || display === 'table-caption' || display === 'flex' || display === 'grid'
        || display === 'flow-root') {
        return element;
      }

      fallback = element;
      element = element.parentElement;
      depth += 1;
    }

    return fallback;
  }

  function getBlockForElement(element) {
    let current = element;
    let fallback = element;
    let depth = 0;

    while (current && current !== document.body && depth < 10) {
      if (SKIP_TAGS.has(current.tagName)) return null;
      if (BLOCK_BOUNDARY_TAGS.has(current.tagName)) return current;

      const display = getComputedStyle(current).display;
      if (display === 'none') return null;
      if (display === 'block' || display === 'list-item' || display === 'table-cell'
        || display === 'table-caption' || display === 'flex' || display === 'grid'
        || display === 'flow-root') {
        return current;
      }

      fallback = current;
      current = current.parentElement;
      depth += 1;
    }

    return fallback;
  }

  function splitText(text, maxLength) {
    if (text.length <= maxLength) return [text];

    const parts = [];
    let rest = text;

    while (rest.length > maxLength) {
      const windowText = rest.slice(0, maxLength);
      const sentenceMatches = [...windowText.matchAll(/[.!?。！？](?:["'”’）)\]]*)\s/g)];
      let cut = -1;

      if (sentenceMatches.length) {
        const last = sentenceMatches[sentenceMatches.length - 1];
        cut = last.index + last[0].length;
      } else {
        cut = windowText.lastIndexOf(' ');
      }

      if (cut < maxLength * 0.45) cut = maxLength;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }

    if (rest) parts.push(rest);
    return parts;
  }

  function extractSentence(text, offset) {
    const flat = String(text).replace(/\s/g, ' ');
    const position = Math.max(0, Math.min(Number(offset) || 0, flat.length));

    let start = 0;
    for (let index = position - 1; index >= 0; index -= 1) {
      if (/[.!?。！？]/.test(flat[index])) {
        start = index + 1;
        break;
      }
    }

    let end = flat.length;
    for (let index = position; index < flat.length; index += 1) {
      if (/[.!?。！？]/.test(flat[index])) {
        end = index + 1;
        break;
      }
    }

    let sentence = flat.slice(start, end).trim();
    if (sentence.length > MAX_HOVER_CHARS) {
      const aroundStart = Math.max(0, position - Math.floor(MAX_HOVER_CHARS / 2));
      sentence = flat.slice(aroundStart, aroundStart + MAX_HOVER_CHARS).trim();
    }
    return sentence;
  }

  function friendlyError(error) {
    const message = String((error && error.message) || error || '未知错误');
    if (/Failed to fetch|NetworkError|网络/i.test(message)) {
      return '网络连接失败，请检查网络后重试';
    }
    if (/Bing 服务连接失败|Bing 翻译页面/.test(message)) {
      return '翻译服务连接失败，请稍后重试';
    }
    return message.length > 120 ? `${message.slice(0, 120)}…` : message;
  }

  /* ------------------------------------------------------------------ */
  /* 翻译请求                                                            */
  /* ------------------------------------------------------------------ */

  async function requestTranslation(text) {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'translate', text });
        if (!response || !response.ok) {
          throw new Error((response && response.error) || '翻译服务没有返回结果');
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await sleep(500);
      }
    }

    throw lastError || new Error('翻译失败');
  }

  async function requestTranslationBatch(texts) {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'translateMany', texts });
        if (!response || !response.ok || !Array.isArray(response.results)) {
          throw new Error((response && response.error) || '翻译服务没有返回结果');
        }
        return response.results;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await sleep(650);
      }
    }

    throw lastError || new Error('翻译失败');
  }

  /* ------------------------------------------------------------------ */
  /* 收集与翻译页面文字                                                  */
  /* ------------------------------------------------------------------ */

  function collectEntries(root) {
    const entries = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (!isTranslatable(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
        if (pageState.originalText.has(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const block = getBlockForNode(node);
      if (!block) continue;
      entries.push({
        kind: 'text',
        node,
        original: node.nodeValue,
        block,
        parts: null,
        partResults: null,
        applied: false
      });
    }

    const attrNodes = root.querySelectorAll('input[placeholder], textarea[placeholder], img[alt], [title]');
    for (const element of attrNodes) {
      if (element.closest(`#${HOST_ID}, [contenteditable]:not([contenteditable="false"])`)) continue;
      if (!isVisible(element)) continue;

      const attrs = [];
      if (element.matches('input[placeholder], textarea[placeholder]')) attrs.push('placeholder');
      if (element.matches('img[alt]')) attrs.push('alt');
      if (element.hasAttribute('title')) attrs.push('title');

      for (const attr of attrs) {
        const original = element.getAttribute(attr);
        if (!isTranslatable(original)) continue;
        const already = pageState.originalAttrs.get(element);
        if (already && Object.prototype.hasOwnProperty.call(already, attr)) continue;

        entries.push({
          kind: 'attr',
          element,
          attr,
          original,
          block: element,
          parts: null,
          partResults: null,
          applied: false
        });
      }
    }

    return entries;
  }

  function buildChunks(entries) {
    let markerId = 0;
    const chunks = [];
    // 不按 DOM 区块分组：很多网站的导航/页脚有上百个小块，
    // 一块一个请求会非常慢；统一装入接近上限的批次即可。
    let current = { text: '', items: [] };

    for (const entry of entries) {
      const parts = entry.original.length > MAX_NODE_CHARS
        ? splitText(entry.original, MAX_NODE_CHARS)
        : [entry.original];
      entry.parts = parts;
      entry.partResults = new Array(parts.length).fill(null);

      for (let partIndex = 0; partIndex < entry.parts.length; partIndex += 1) {
        const id = `ZT${markerId}`;
        markerId += 1;
        // Bing 对自定义 HTML 标签的处理不稳定，有时会把 <x-t> 整个丢掉。
        // 用纯文本标记更可靠：@@ZT0@@正文@@/ZT0@@。
        let partText = entry.parts[partIndex];
        if (partText.includes('@@')) partText = partText.replace(/@@/g, '@\u200B@');
        const marker = `@@${id}@@${partText}@@/${id}@@`;

        if (current.text && (current.text.length + marker.length + 1 > MAX_CHUNK_CHARS || current.items.length >= MAX_CHUNK_ITEMS)) {
          chunks.push(current);
          current = { text: '', items: [] };
        }

        current.text += current.text ? ` ${marker}` : marker;
        current.items.push({ id, entry, partIndex });
      }
    }

    if (current.text) chunks.push(current);
    return chunks;
  }

  function parseTranslatedMarkers(text, expectedIds) {
    const values = new Map();
    const expected = new Set(expectedIds);
    const pattern = /@@\s*(ZT\d+)\s*@@([\s\S]*?)@@\s*\/\s*\1\s*@@/g;
    let match;

    while ((match = pattern.exec(text))) {
      const id = match[1];
      if (!expected.has(id)) continue;
      values.set(id, (match[2] || '').replace(/\u200B/g, ''));
    }

    return values;
  }

  function applyEntry(entry) {
    if (entry.applied) return;
    if (!entry.partResults || entry.partResults.some((value) => typeof value !== 'string')) return;

    const translated = entry.partResults
      .map((value) => value.trim())
      .filter(Boolean)
      .join(' ');
    if (!translated) return;

    if (entry.kind === 'text') {
      if (!entry.node.isConnected) return;
      const leading = (entry.original.match(/^\s*/) || [''])[0];
      const trailing = (entry.original.match(/\s*$/) || [''])[0];
      pageState.originalText.set(entry.node, entry.original);
      entry.node.nodeValue = leading + translated + trailing;
    } else {
      if (!entry.element.isConnected) return;
      let attrs = pageState.originalAttrs.get(entry.element);
      if (!attrs) {
        attrs = {};
        pageState.originalAttrs.set(entry.element, attrs);
      }
      if (!Object.prototype.hasOwnProperty.call(attrs, entry.attr)) {
        attrs[entry.attr] = entry.original;
      }
      entry.element.setAttribute(entry.attr, translated);
    }

    entry.applied = true;
    pageState.count += 1;
  }

  function applyChunk(chunk, translatedText) {
    const expectedIds = chunk.items.map((item) => item.id);
    const values = parseTranslatedMarkers(translatedText, expectedIds);
    const missing = [];

    for (const item of chunk.items) {
      const value = values.get(item.id);
      if (typeof value !== 'string') {
        missing.push(item);
        continue;
      }
      item.entry.partResults[item.partIndex] = value;
      if (item.entry.partResults.every((part) => typeof part === 'string')) {
        applyEntry(item.entry);
      }
    }

    return { missing, matched: expectedIds.length - missing.length };
  }

  async function translateMissingItems(items, token) {
    let failed = 0;

    for (let start = 0; start < items.length; start += 3) {
      if (token !== pageState.runToken) return { cancelled: true, failed };
      const slice = items.slice(start, start + 3);
      const texts = slice.map((item) => item.entry.parts[item.partIndex]);

      let results;
      try {
        results = await requestTranslationBatch(texts);
      } catch (error) {
        failed += slice.length;
        continue;
      }

      if (token !== pageState.runToken) return { cancelled: true, failed };

      for (let index = 0; index < slice.length; index += 1) {
        const item = slice[index];
        const result = results[index];
        if (!result || !result.ok || typeof result.text !== 'string' || !result.text.trim()) {
          failed += 1;
          continue;
        }
        item.entry.partResults[item.partIndex] = result.text;
        if (item.entry.partResults.every((part) => typeof part === 'string')) {
          applyEntry(item.entry);
        }
      }
    }

    return { cancelled: false, failed };
  }

  function chunkFromItems(items) {
    const text = items.map((item) => {
      let value = item.entry.parts[item.partIndex];
      if (value.includes('@@')) value = value.replace(/@@/g, '@\u200B@');
      return `@@${item.id}@@${value}@@/${item.id}@@`;
    }).join(' ');
    return { text, items };
  }

  async function translateChunk(chunk, token, depth = 0, initialResult = null) {
    let result = initialResult;
    if (!result) {
      try {
        const results = await requestTranslationBatch([chunk.text]);
        result = results[0];
      } catch (error) {
        result = { ok: false, error: error.message || String(error) };
      }
    }

    if (result && result.ok && typeof result.text === 'string') {
      try {
        const applied = applyChunk(chunk, result.text);
        let failed = 0;

        if (applied.missing.length) {
          // 标记被翻译服务吞掉时，逐条重译缺失的片段，保证不静默漏译。
          const fallback = await translateMissingItems(applied.missing, token);
          if (fallback.cancelled) {
            return { cancelled: true, failedChunks: 0, missingMarkers: applied.missing.length };
          }
          failed = fallback.failed;
        }

        return {
          ok: failed === 0,
          failedChunks: failed > 0 ? 1 : 0,
          missingMarkers: applied.missing.length
        };
      } catch (error) {
        result = { ok: false, error: error.message || String(error) };
      }
    }

    const message = String((result && result.error) || '翻译失败');

    // Bing 偶尔对较大的批次返回 400；对半拆分后重试，通常即可成功。
    if (depth < 2 && chunk.items.length > 1 && /HTTP 400|HTTP 413/.test(message)) {
      const middle = Math.ceil(chunk.items.length / 2);
      const left = await translateChunk(chunkFromItems(chunk.items.slice(0, middle)), token, depth + 1);
      if (left.cancelled) return left;
      const right = await translateChunk(chunkFromItems(chunk.items.slice(middle)), token, depth + 1);
      if (right.cancelled) return right;
      return {
        ok: left.ok && right.ok,
        failedChunks: left.failedChunks + right.failedChunks,
        missingMarkers: left.missingMarkers + right.missingMarkers
      };
    }

    return { ok: false, failedChunks: 1, missingMarkers: 0, error: message };
  }

  async function translateChunks(chunks, token, options = {}) {
    const batchSize = 12;
    let failedChunks = 0;
    let missingMarkers = 0;
    let lastError = null;

    for (let start = 0; start < chunks.length; start += batchSize) {
      if (token !== pageState.runToken) return { cancelled: true, failedChunks, missingMarkers, lastError };

      const batch = chunks.slice(start, start + batchSize);
      let results;

      try {
        results = await requestTranslationBatch(batch.map((chunk) => chunk.text));
      } catch (error) {
        lastError = error;
        failedChunks += batch.length;
        pageState.doneChunks += batch.length;
        updateUi();
        continue;
      }

      if (token !== pageState.runToken) return { cancelled: true, failedChunks, missingMarkers, lastError };

      for (let index = 0; index < batch.length; index += 1) {
        const result = results[index];
        if (!result || !result.ok || typeof result.text !== 'string') {
          if (result && result.error) lastError = new Error(result.error);
        }

        const outcome = await translateChunk(batch[index], token, 0, result);
        if (outcome.cancelled) {
          return { cancelled: true, failedChunks, missingMarkers, lastError };
        }
        failedChunks += outcome.failedChunks;
        missingMarkers += outcome.missingMarkers;
        if (!outcome.ok && outcome.error) lastError = new Error(outcome.error);
      }

      pageState.doneChunks += batch.length;
      updateUi();
      if (!options.silent) await sleep(10);
    }

    return { cancelled: false, failedChunks, missingMarkers, lastError };
  }

  async function translatePage() {
    if (pageState.busy) {
      showToast('正在翻译中，请稍候…');
      return { ok: false, busy: true };
    }

    if (pageState.active) await restorePage({ silent: true });

    const token = pageState.runToken + 1;
    pageState.runToken = token;
    pageState.busy = true;
    pageState.active = true;
    pageState.count = 0;
    resetHover();
    pageState.doneChunks = 0;
    pageState.totalChunks = 0;
    updateUi();

    try {
      const entries = collectEntries(document.body);
      if (!entries.length) {
        pageState.active = false;
        pageState.busy = false;
        updateUi();
        showToast('这个页面里没有找到需要翻译的英文内容');
        return { ok: false, error: '没有可翻译的内容' };
      }

      const chunks = buildChunks(entries);
      pageState.totalChunks = chunks.length;
      pageState.doneChunks = 0;
      updateUi();
      showToast('开始翻译，请稍候…', 1600);

      const outcome = await translateChunks(chunks, token, { silent: false });
      if (outcome.cancelled || token !== pageState.runToken) {
        return { ok: false, cancelled: true };
      }

      pageState.busy = false;
      pageState.active = pageState.count > 0;

      if (pageState.active) {
        startObserver();
        const suffix = outcome.failedChunks > 0 ? `（${outcome.failedChunks} 段失败）` : '';
        showToast(`已翻译 ${pageState.count} 处文字${suffix}`, 3000);
      } else {
        showToast(`翻译失败：${friendlyError(outcome.lastError)}`, 4200);
      }

      updateUi();
      return {
        ok: pageState.active,
        count: pageState.count,
        failed: outcome.failedChunks,
        error: pageState.active ? null : friendlyError(outcome.lastError)
      };
    } catch (error) {
      pageState.busy = false;
      pageState.active = pageState.count > 0;
      if (pageState.active) startObserver();
      updateUi();
      showToast(`翻译失败：${friendlyError(error)}`, 4200);
      return { ok: false, error: friendlyError(error) };
    }
  }

  async function supplementPage() {
    pageState.supplementTimer = null;
    if (!pageState.active || pageState.busy || pageState.supplementing) return;

    pageState.supplementing = true;
    const token = pageState.runToken;

    try {
      const entries = collectEntries(document.body).slice(0, 180);
      if (!entries.length) return;
      const chunks = buildChunks(entries);
      if (!chunks.length) return;
      await translateChunks(chunks, token, { silent: true });
      updateUi();
    } catch (error) {
      // 动态内容翻译失败时不打扰用户
    } finally {
      pageState.supplementing = false;
    }
  }

  function scheduleSupplement() {
    if (pageState.supplementTimer) clearTimeout(pageState.supplementTimer);
    pageState.supplementTimer = setTimeout(supplementPage, 900);
  }

  function startObserver() {
    if (pageState.observer || !document.body) return;
    pageState.observer = new MutationObserver((mutations) => {
      if (!pageState.active || pageState.busy) return;
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length) {
          scheduleSupplement();
          return;
        }
      }
    });
    pageState.observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (pageState.observer) {
      pageState.observer.disconnect();
      pageState.observer = null;
    }
    if (pageState.supplementTimer) {
      clearTimeout(pageState.supplementTimer);
      pageState.supplementTimer = null;
    }
  }

  async function restorePage(options = {}) {
    pageState.runToken += 1;
    pageState.busy = false;
    pageState.active = false;
    pageState.count = 0;
    pageState.totalChunks = 0;
    pageState.doneChunks = 0;
    stopObserver();
    resetHover();
    closeSelectionCard();

    for (const [node, original] of pageState.originalText) {
      if (node.isConnected) node.nodeValue = original;
    }
    pageState.originalText.clear();

    for (const [element, attrs] of pageState.originalAttrs) {
      if (!element.isConnected) continue;
      for (const [attr, original] of Object.entries(attrs)) {
        element.setAttribute(attr, original);
      }
    }
    pageState.originalAttrs.clear();

    updateUi();
    if (!options.silent) showToast('已恢复网页原文', 2200);
    return { ok: true };
  }

  /* ------------------------------------------------------------------ */
  /* 悬停翻译                                                            */
  /* ------------------------------------------------------------------ */

  function getCaretSentence(x, y) {
    let node = null;
    let offset = 0;

    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      if (range) {
        node = range.startContainer;
        offset = range.startOffset;
      }
    } else if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(x, y);
      if (position) {
        node = position.offsetNode;
        offset = position.offset;
      }
    }

    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      if (!isTranslatable(node.nodeValue)) return '';
      return extractSentence(node.nodeValue, offset);
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length <= MAX_HOVER_CHARS && isTranslatable(text)) return text;
    }
    return '';
  }

  function getHoverCandidate(x, y) {
    const element = document.elementFromPoint(x, y);
    if (!element || isInsideUi(element)) return null;
    if (element.closest(SKIP_SELECTOR)) return null;

    const block = getBlockForElement(element) || element;
    if (!block || block === document.body || block === document.documentElement) {
      const sentence = getCaretSentence(x, y);
      return sentence && isTranslatable(sentence) ? sentence : null;
    }
    if (!isVisible(block)) return null;

    const raw = (block.innerText || block.textContent || '').replace(/\s+/g, ' ').trim();
    if (raw.length >= 2 && raw.length <= MAX_HOVER_CHARS && isTranslatable(raw)) {
      return raw;
    }

    const sentence = getCaretSentence(x, y);
    if (sentence.length >= 2 && isTranslatable(sentence)) return sentence;

    return null;
  }

  function showTooltipLoading(original) {
    ui.tooltipZh.textContent = '正在翻译…';
    ui.tooltipZh.classList.add('zt-loading');
    ui.tooltipEn.textContent = original.length > 220 ? `${original.slice(0, 220)}…` : original;
    ui.tooltipError.textContent = '';
    ui.tooltipStatus.textContent = '翻译中';
    ui.tooltip.classList.add('zt-visible');
    ui.tooltip.setAttribute('aria-busy', 'true');
  }

  function showTooltipResult(translated, original, provider) {
    ui.tooltipZh.textContent = translated;
    ui.tooltipZh.classList.remove('zt-loading');
    ui.tooltipEn.textContent = original.length > 220 ? `${original.slice(0, 220)}…` : original;
    ui.tooltipError.textContent = '';
    ui.tooltipStatus.textContent = provider === 'mymemory' ? '备用翻译' : 'Bing 翻译';
    ui.tooltip.classList.add('zt-visible');
    ui.tooltip.setAttribute('aria-busy', 'false');
  }

  function showTooltipError(message, original) {
    ui.tooltipZh.textContent = '翻译失败';
    ui.tooltipZh.classList.remove('zt-loading');
    ui.tooltipEn.textContent = original.length > 220 ? `${original.slice(0, 220)}…` : original;
    ui.tooltipError.textContent = message;
    ui.tooltipStatus.textContent = '出错了';
    ui.tooltip.classList.add('zt-visible');
    ui.tooltip.setAttribute('aria-busy', 'false');
  }

  function positionTooltip() {
    if (!ui.tooltip || !ui.tooltip.classList.contains('zt-visible')) return;

    const margin = 12;
    const gapX = 16;
    const gapY = 20;
    const width = ui.tooltip.offsetWidth;
    const height = ui.tooltip.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = lastPointer.x + gapX;
    let top = lastPointer.y + gapY;

    if (left + width > viewportWidth - margin) left = lastPointer.x - width - gapX;
    if (left < margin) left = margin;
    if (top + height > viewportHeight - margin) top = lastPointer.y - height - gapY;
    if (top < margin) top = margin;

    ui.tooltip.style.left = `${Math.round(left)}px`;
    ui.tooltip.style.top = `${Math.round(top)}px`;
  }

  function hideTooltip(immediate = false) {
    if (!ui.tooltip) return;
    clearTimeout(hideTimer);
    hideTimer = null;
    const hide = () => {
      ui.tooltip.classList.remove('zt-visible');
      ui.tooltip.setAttribute('aria-busy', 'false');
    };
    if (immediate) {
      hide();
      return;
    }
    hideTimer = setTimeout(hide, HIDE_DELAY_MS);
  }

  function scheduleHide() {
    if (!currentHoverKey) return;
    currentHoverKey = '';
    hoverRequestSeq += 1;
    hideTooltip(false);
  }

  function resetHover() {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    currentHoverKey = '';
    hoverRequestSeq += 1;
    hideTooltip(true);
  }

  async function showHover(original) {
    const key = original;
    if (!settings.hoverEnabled || !key) return;
    if (!document.documentElement.contains(document.body)) return;

    currentHoverKey = key;
    showTooltipLoading(original);
    positionTooltip();

    const cached = hoverCache.get(key);
    if (cached) {
      showTooltipResult(cached.text, original, cached.provider);
      positionTooltip();
      return;
    }

    const requestId = ++hoverRequestSeq;
    try {
      const result = await requestTranslation(original);
      if (requestId !== hoverRequestSeq || currentHoverKey !== key || !settings.hoverEnabled) return;
      if (hoverCache.size > 200) hoverCache.clear();
      hoverCache.set(key, result);
      showTooltipResult(result.text, original, result.provider);
      positionTooltip();
    } catch (error) {
      if (requestId !== hoverRequestSeq || currentHoverKey !== key) return;
      showTooltipError(friendlyError(error), original);
      positionTooltip();
    }
  }

  function handlePointerMove(event) {
    lastPointer = { x: event.clientX, y: event.clientY };
    if (!settings.hoverEnabled || pageState.busy) return;
    if (isInsideUi(event.target)) return;

    const now = performance.now();
    if (now - lastMoveAt < 90) {
      positionTooltip();
      return;
    }
    lastMoveAt = now;

    const candidate = getHoverCandidate(event.clientX, event.clientY);
    if (!candidate) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
      scheduleHide();
      return;
    }

    if (candidate === currentHoverKey) {
      clearTimeout(hideTimer);
      hideTimer = null;
      positionTooltip();
      return;
    }

    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    hideTimer = null;
    currentHoverKey = candidate;
    hoverRequestSeq += 1;
    hideTooltip(true);

    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      if (settings.hoverEnabled) showHover(candidate);
    }, HOVER_DELAY_MS);
  }

  /* ------------------------------------------------------------------ */
  /* 选中文字翻译                                                        */
  /* ------------------------------------------------------------------ */

  function closeSelectionCard() {
    if (!ui.selectionCard) return;
    ui.selectionCard.classList.remove('zt-visible');
    selectionRequestSeq += 1;
  }

  function positionSelectionCard() {
    if (!ui.selectionCard || !ui.selectionCard.classList.contains('zt-visible')) return;

    const margin = 14;
    const width = ui.selectionCard.offsetWidth;
    const height = ui.selectionCard.offsetHeight;
    let rect = null;
    const selection = window.getSelection();
    if (selection && selection.rangeCount) {
      try {
        rect = selection.getRangeAt(0).getBoundingClientRect();
      } catch (error) {
        rect = null;
      }
    }

    let left = rect ? rect.left : (window.innerWidth - width) / 2;
    let top = rect ? rect.bottom + 12 : 90;

    if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
    if (left < margin) left = margin;
    if (top + height > window.innerHeight - margin) top = rect ? rect.top - height - 12 : window.innerHeight - height - margin;
    if (top < margin) top = margin;

    ui.selectionCard.style.left = `${Math.round(left)}px`;
    ui.selectionCard.style.top = `${Math.round(top)}px`;
  }

  async function showSelectionTranslation(text) {
    const original = String(text || '').trim();
    if (!original || !ui.selectionCard) return;

    closeSelectionCard();
    const requestId = ++selectionRequestSeq;
    ui.selectionOriginal.textContent = original.length > 260 ? `${original.slice(0, 260)}…` : original;
    ui.selectionTranslation.textContent = '正在翻译…';
    ui.selectionTranslation.classList.add('zt-loading');
    ui.selectionError.textContent = '';
    ui.selectionCard.classList.add('zt-visible');
    positionSelectionCard();

    try {
      const result = await requestTranslation(original);
      if (requestId !== selectionRequestSeq) return;
      ui.selectionTranslation.textContent = result.text;
      ui.selectionTranslation.classList.remove('zt-loading');
      ui.selectionError.textContent = '';
      positionSelectionCard();
    } catch (error) {
      if (requestId !== selectionRequestSeq) return;
      ui.selectionTranslation.textContent = '翻译失败';
      ui.selectionTranslation.classList.remove('zt-loading');
      ui.selectionError.textContent = friendlyError(error);
      positionSelectionCard();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 界面                                                                */
  /* ------------------------------------------------------------------ */

  function createUi() {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-zh-translator', '1');
    shadow = host.attachShadow({ mode: 'closed' });

    shadow.innerHTML = `
      <div class="zt-fab" id="zt-fab" role="button" tabindex="0" title="指译：点击翻译整个页面">
        <span class="zt-fab-text">译</span>
      </div>

      <section class="zt-panel" id="zt-panel" aria-label="指译设置">
        <div class="zt-panel-head">
          <div class="zt-logo">译</div>
          <div class="zt-panel-title">
            <strong>指译</strong>
            <span id="zt-panel-status">悬停翻译已开启</span>
          </div>
          <button class="zt-icon-btn" id="zt-panel-close" title="关闭" aria-label="关闭">×</button>
        </div>
        <label class="zt-switch-row">
          <span>
            <strong>鼠标悬停翻译</strong>
            <small>指针停在哪句话，就翻译哪句话</small>
          </span>
          <input type="checkbox" id="zt-panel-hover" class="zt-switch" />
        </label>
        <button class="zt-action" id="zt-panel-action">翻译整个页面</button>
        <p class="zt-shortcut">Alt / Option + A 翻译全页 · Alt / Option + T 开关悬停</p>
      </section>

      <div class="zt-tooltip" id="zt-tooltip" role="status" aria-live="polite">
        <div class="zt-tt-head">
          <span class="zt-tt-badge">译</span>
          <span class="zt-tt-status" id="zt-tt-status">翻译中</span>
        </div>
        <div class="zt-tt-zh" id="zt-tt-zh"></div>
        <div class="zt-tt-en" id="zt-tt-en"></div>
        <div class="zt-tt-error" id="zt-tt-error"></div>
      </div>

      <div class="zt-toast" id="zt-toast" role="status"></div>

      <section class="zt-selection" id="zt-selection" aria-label="选中文字翻译">
        <div class="zt-selection-head">
          <span class="zt-tt-badge">译</span>
          <span>选中文字</span>
          <button class="zt-icon-btn" id="zt-selection-close" title="关闭" aria-label="关闭">×</button>
        </div>
        <div class="zt-selection-zh" id="zt-selection-zh"></div>
        <div class="zt-selection-en" id="zt-selection-en"></div>
        <div class="zt-tt-error" id="zt-selection-error"></div>
      </section>
    `;

    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host {
        all: initial;
        position: fixed;
        inset: auto 0 0 auto;
        width: 0;
        height: 0;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif;
        color-scheme: light dark;
      }
      *, *::before, *::after { box-sizing: border-box; }
      [hidden] { display: none !important; }

      .zt-fab, .zt-panel, .zt-tooltip, .zt-toast, .zt-selection {
        position: fixed;
        font-family: inherit;
        -webkit-font-smoothing: antialiased;
      }

      .zt-fab {
        right: 22px;
        bottom: 22px;
        width: 46px;
        height: 46px;
        border-radius: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(145deg, #0ea5e9 0%, #2563eb 58%, #1d4ed8 100%);
        color: #ffffff;
        font-size: 21px;
        font-weight: 700;
        line-height: 1;
        letter-spacing: 0;
        cursor: pointer;
        user-select: none;
        box-shadow: 0 10px 26px rgba(37, 99, 235, 0.34), inset 0 1px 0 rgba(255,255,255,0.28);
        border: 1px solid rgba(255,255,255,0.18);
        transition: transform 150ms ease, box-shadow 150ms ease, opacity 150ms ease;
      }
      .zt-fab:hover { transform: translateY(-2px); box-shadow: 0 14px 32px rgba(37, 99, 235, 0.42), inset 0 1px 0 rgba(255,255,255,0.28); }
      .zt-fab:active { transform: translateY(0) scale(0.97); }
      .zt-fab:focus-visible { outline: 3px solid rgba(14,165,233,0.45); outline-offset: 3px; }
      .zt-fab.zt-active::after {
        content: "";
        position: absolute;
        right: -2px;
        top: -2px;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #22c55e;
        border: 2px solid #ffffff;
        box-shadow: 0 1px 5px rgba(0,0,0,0.2);
      }
      .zt-fab.zt-busy .zt-fab-text { opacity: 0.25; }
      .zt-fab.zt-busy::before {
        content: "";
        position: absolute;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        border: 2px solid rgba(255,255,255,0.35);
        border-top-color: #ffffff;
        animation: zt-spin 700ms linear infinite;
      }
      .zt-fab.zt-hidden { display: none; }

      .zt-panel {
        right: 22px;
        bottom: 78px;
        width: 274px;
        padding: 14px;
        border-radius: 18px;
        background: rgba(255,255,255,0.98);
        border: 1px solid rgba(15,23,42,0.10);
        box-shadow: 0 18px 48px rgba(15,23,42,0.20);
        color: #0f172a;
        transform-origin: bottom right;
        animation: zt-pop 150ms ease-out;
      }
      .zt-panel.zt-hidden { display: none; }
      .zt-panel-head { display: flex; align-items: center; gap: 9px; margin-bottom: 13px; }
      .zt-logo {
        width: 34px; height: 34px; border-radius: 11px; flex: 0 0 auto;
        display: flex; align-items: center; justify-content: center;
        color: #fff; font-size: 17px; font-weight: 700;
        background: linear-gradient(145deg, #0ea5e9, #2563eb);
        box-shadow: 0 5px 14px rgba(37,99,235,0.24);
      }
      .zt-panel-title { min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
      .zt-panel-title strong { font-size: 14px; font-weight: 700; letter-spacing: 0.2px; }
      .zt-panel-title span { margin-top: 2px; font-size: 11px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .zt-icon-btn {
        margin-left: auto; width: 26px; height: 26px; border: 0; border-radius: 8px;
        background: transparent; color: #64748b; font-size: 19px; line-height: 1;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
      }
      .zt-icon-btn:hover { background: #f1f5f9; color: #0f172a; }
      .zt-switch-row {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 10px 0 12px; border-top: 1px solid #eef2f7;
      }
      .zt-switch-row span { display: flex; flex-direction: column; min-width: 0; }
      .zt-switch-row strong { font-size: 12.5px; font-weight: 600; }
      .zt-switch-row small { margin-top: 2px; font-size: 10.5px; line-height: 1.45; color: #64748b; }
      .zt-switch {
        appearance: none; -webkit-appearance: none; flex: 0 0 auto;
        width: 38px; height: 22px; border-radius: 999px; background: #cbd5e1;
        position: relative; cursor: pointer; transition: background 160ms ease; margin: 0;
      }
      .zt-switch::after {
        content: ""; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
        border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(15,23,42,0.25);
        transition: transform 160ms ease;
      }
      .zt-switch:checked { background: #2563eb; }
      .zt-switch:checked::after { transform: translateX(16px); }
      .zt-switch:focus-visible { outline: 3px solid rgba(37,99,235,0.25); outline-offset: 2px; }
      .zt-action {
        width: 100%; border: 0; border-radius: 11px; padding: 11px 12px;
        color: #fff; background: linear-gradient(135deg, #2563eb, #1d4ed8);
        font-family: inherit; font-size: 13px; font-weight: 700; letter-spacing: 0.2px;
        cursor: pointer; box-shadow: 0 7px 18px rgba(37,99,235,0.24);
      }
      .zt-action:hover { filter: brightness(1.05); }
      .zt-action:active { transform: translateY(1px); }
      .zt-action:disabled { opacity: 0.55; cursor: default; box-shadow: none; }
      .zt-shortcut { margin: 10px 0 0; font-size: 10px; line-height: 1.55; color: #94a3b8; text-align: center; }

      .zt-tooltip {
        left: 0; top: 0;
        width: max-content;
        max-width: min(430px, calc(100vw - 28px));
        padding: 11px 13px 12px;
        border-radius: 14px;
        background: rgba(255,255,255,0.985);
        border: 1px solid rgba(15,23,42,0.10);
        box-shadow: 0 14px 40px rgba(15,23,42,0.20), 0 2px 8px rgba(15,23,42,0.06);
        color: #0f172a;
        opacity: 0;
        visibility: hidden;
        transform: translateY(5px);
        transition: opacity 120ms ease, transform 120ms ease, visibility 120ms;
        pointer-events: none;
      }
      .zt-tooltip.zt-visible { opacity: 1; visibility: visible; transform: translateY(0); }
      .zt-tt-head { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
      .zt-tt-badge {
        width: 19px; height: 19px; border-radius: 6px; flex: 0 0 auto;
        display: inline-flex; align-items: center; justify-content: center;
        background: linear-gradient(145deg, #0ea5e9, #2563eb); color: #fff;
        font-size: 10.5px; font-weight: 700;
      }
      .zt-tt-status { font-size: 10px; color: #94a3b8; letter-spacing: 0.3px; }
      .zt-tt-zh {
        font-size: 15px; line-height: 1.65; font-weight: 500; letter-spacing: 0.05px;
        white-space: pre-wrap; overflow-wrap: anywhere;
        min-height: 1.2em;
      }
      .zt-tt-en {
        margin-top: 7px; padding-top: 7px; border-top: 1px solid #eef2f7;
        font-size: 11px; line-height: 1.5; color: #7c8799;
        white-space: pre-wrap; overflow-wrap: anywhere;
        max-height: 82px; overflow: hidden;
      }
      .zt-tt-en:empty { display: none; }
      .zt-tt-error { margin-top: 6px; font-size: 11px; line-height: 1.45; color: #dc2626; }
      .zt-tt-error:empty { display: none; }
      .zt-loading { color: #94a3b8; }
      .zt-loading::after {
        content: ""; display: inline-block; width: 11px; height: 11px; margin-left: 7px;
        vertical-align: -1px; border-radius: 50%; border: 1.5px solid #cbd5e1;
        border-top-color: #2563eb; animation: zt-spin 700ms linear infinite;
      }

      .zt-toast {
        left: 50%; bottom: 30px; transform: translate(-50%, 8px);
        max-width: min(440px, calc(100vw - 32px));
        padding: 9px 15px; border-radius: 999px;
        background: rgba(15,23,42,0.92); color: #fff;
        font-size: 12px; line-height: 1.5; text-align: center;
        box-shadow: 0 10px 30px rgba(15,23,42,0.24);
        opacity: 0; visibility: hidden; pointer-events: none;
        transition: opacity 160ms ease, transform 160ms ease, visibility 160ms;
      }
      .zt-toast.zt-visible { opacity: 1; visibility: visible; transform: translate(-50%, 0); }

      .zt-selection {
        left: 0; top: 0; width: 430px; max-width: calc(100vw - 28px);
        padding: 12px 14px 13px; border-radius: 16px;
        background: rgba(255,255,255,0.99); border: 1px solid rgba(15,23,42,0.10);
        box-shadow: 0 18px 50px rgba(15,23,42,0.22);
        color: #0f172a; opacity: 0; visibility: hidden; transform: translateY(5px);
        transition: opacity 140ms ease, transform 140ms ease, visibility 140ms;
        pointer-events: auto;
      }
      .zt-selection.zt-visible { opacity: 1; visibility: visible; transform: translateY(0); }
      .zt-selection-head { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; font-size: 10.5px; color: #64748b; }
      .zt-selection-head .zt-icon-btn { width: 22px; height: 22px; font-size: 17px; }
      .zt-selection-zh { font-size: 15px; line-height: 1.65; font-weight: 500; white-space: pre-wrap; overflow-wrap: anywhere; }
      .zt-selection-en {
        margin-top: 8px; padding-top: 8px; border-top: 1px solid #eef2f7;
        font-size: 11.5px; line-height: 1.55; color: #7c8799;
        white-space: pre-wrap; overflow-wrap: anywhere; max-height: 110px; overflow: auto;
      }
      .zt-selection .zt-tt-error { margin-top: 7px; }

      @keyframes zt-spin { to { transform: rotate(360deg); } }
      @keyframes zt-pop { from { opacity: 0; transform: translateY(5px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }

      @media (prefers-color-scheme: dark) {
        .zt-panel, .zt-tooltip, .zt-selection {
          background: rgba(17,24,39,0.985); color: #e5e7eb; border-color: rgba(148,163,184,0.22);
          box-shadow: 0 18px 48px rgba(0,0,0,0.46);
        }
        .zt-panel-title span, .zt-switch-row small, .zt-shortcut, .zt-tt-status { color: #94a3b8; }
        .zt-switch-row, .zt-tt-en, .zt-selection-en { border-color: #273449; }
        .zt-tt-en, .zt-selection-en { color: #a8b3c4; }
        .zt-icon-btn:hover { background: #1f2937; color: #e5e7eb; }
        .zt-switch { background: #475569; }
        .zt-switch:checked { background: #3b82f6; }
        .zt-toast { background: rgba(2,6,23,0.95); }
      }

      @media (prefers-reduced-motion: reduce) {
        .zt-fab, .zt-panel, .zt-tooltip, .zt-toast, .zt-selection, .zt-switch, .zt-switch::after { transition: none !important; animation: none !important; }
      }
      @media print { :host { display: none !important; } }
    `);
    shadow.adoptedStyleSheets = [sheet];

    document.documentElement.appendChild(host);

    ui = {
      fab: shadow.getElementById('zt-fab'),
      panel: shadow.getElementById('zt-panel'),
      panelStatus: shadow.getElementById('zt-panel-status'),
      panelClose: shadow.getElementById('zt-panel-close'),
      panelHover: shadow.getElementById('zt-panel-hover'),
      panelAction: shadow.getElementById('zt-panel-action'),
      tooltip: shadow.getElementById('zt-tooltip'),
      tooltipStatus: shadow.getElementById('zt-tt-status'),
      tooltipZh: shadow.getElementById('zt-tt-zh'),
      tooltipEn: shadow.getElementById('zt-tt-en'),
      tooltipError: shadow.getElementById('zt-tt-error'),
      toast: shadow.getElementById('zt-toast'),
      selectionCard: shadow.getElementById('zt-selection'),
      selectionClose: shadow.getElementById('zt-selection-close'),
      selectionTranslation: shadow.getElementById('zt-selection-zh'),
      selectionOriginal: shadow.getElementById('zt-selection-en'),
      selectionError: shadow.getElementById('zt-selection-error')
    };

    ui.panel.classList.add('zt-hidden');
    ui.tooltip.classList.remove('zt-visible');
    ui.selectionCard.classList.remove('zt-visible');
    ui.toast.classList.remove('zt-visible');

    ui.fab.addEventListener('click', (event) => {
      event.stopPropagation();
      ui.panel.classList.toggle('zt-hidden');
    });
    ui.fab.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        ui.panel.classList.toggle('zt-hidden');
      }
    });
    ui.panelClose.addEventListener('click', () => ui.panel.classList.add('zt-hidden'));
    ui.panelHover.addEventListener('change', () => {
      settings.hoverEnabled = ui.panelHover.checked;
      chrome.storage.local.set({ hoverEnabled: settings.hoverEnabled });
      if (!settings.hoverEnabled) resetHover();
      updateUi();
    });
    ui.panelAction.addEventListener('click', async () => {
      if (pageState.busy) return;
      ui.panelAction.disabled = true;
      try {
        if (pageState.active) await restorePage();
        else await translatePage();
      } finally {
        ui.panelAction.disabled = false;
        updateUi();
      }
    });
    ui.selectionClose.addEventListener('click', closeSelectionCard);

    updateUi();
  }

  function updateUi() {
    if (!ui.fab) return;

    ui.fab.classList.toggle('zt-hidden', !settings.showFab);
    if (!settings.showFab) ui.panel.classList.add('zt-hidden');
    ui.fab.classList.toggle('zt-active', pageState.active);
    ui.fab.classList.toggle('zt-busy', pageState.busy);
    ui.fab.title = pageState.active ? '指译：已翻译，点击可恢复原文' : '指译：点击翻译整个页面';

    ui.panelHover.checked = Boolean(settings.hoverEnabled);
    ui.panelAction.disabled = pageState.busy;
    ui.panelAction.textContent = pageState.active
      ? '恢复网页原文'
      : pageState.busy ? '正在翻译…' : '翻译整个页面';

    if (pageState.busy) {
      const progress = pageState.totalChunks
        ? ` ${Math.min(pageState.doneChunks, pageState.totalChunks)}/${pageState.totalChunks} 段`
        : '';
      ui.panelStatus.textContent = `正在翻译${progress}…`;
    } else if (pageState.active) {
      ui.panelStatus.textContent = `已翻译 ${pageState.count} 处文字`;
    } else {
      ui.panelStatus.textContent = settings.hoverEnabled ? '悬停翻译已开启' : '悬停翻译已关闭';
    }
  }

  function showToast(message, duration = 2600) {
    if (!ui.toast) return;
    clearTimeout(toastTimer);
    ui.toast.textContent = message;
    ui.toast.classList.add('zt-visible');
    toastTimer = setTimeout(() => ui.toast.classList.remove('zt-visible'), duration);
  }

  /* ------------------------------------------------------------------ */
  /* 事件与消息                                                          */
  /* ------------------------------------------------------------------ */

  function handleScroll() {
    resetHover();
    if (ui.selectionCard && ui.selectionCard.classList.contains('zt-visible')) positionSelectionCard();
  }

  function handleKeyDown(event) {
    if (event.key === 'Escape') {
      resetHover();
      closeSelectionCard();
      if (ui.panel) ui.panel.classList.add('zt-hidden');
    }
  }

  async function toggleHover() {
    settings.hoverEnabled = !settings.hoverEnabled;
    await chrome.storage.local.set({ hoverEnabled: settings.hoverEnabled });
    if (!settings.hoverEnabled) resetHover();
    updateUi();
    showToast(settings.hoverEnabled ? '已开启鼠标悬停翻译' : '已关闭鼠标悬停翻译', 1800);
    return { ok: true, hoverEnabled: settings.hoverEnabled };
  }

  function pageStateResponse() {
    return {
      ok: true,
      supported: true,
      active: pageState.active,
      busy: pageState.busy,
      count: pageState.count,
      totalChunks: pageState.totalChunks,
      doneChunks: pageState.doneChunks,
      hoverEnabled: settings.hoverEnabled,
      showFab: settings.showFab
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

    if (message.type === 'getPageState') {
      sendResponse(pageStateResponse());
      return false;
    }

    if (message.type === 'translatePage') {
      translatePage()
        .then((result) => sendResponse({ ...result, state: pageStateResponse() }))
        .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
      return true;
    }

    if (message.type === 'restorePage') {
      restorePage()
        .then((result) => sendResponse({ ...result, state: pageStateResponse() }))
        .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
      return true;
    }

    if (message.type === 'toggleHover') {
      toggleHover()
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
      return true;
    }

    if (message.type === 'translateSelection') {
      showSelectionTranslation(message.text);
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'command') {
      if (message.command === 'translatePage') {
        translatePage()
          .then((result) => sendResponse({ ...result, state: pageStateResponse() }))
          .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
        return true;
      }
      if (message.command === 'toggleHover') {
        toggleHover()
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
        return true;
      }
    }

    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.hoverEnabled) {
      settings.hoverEnabled = Boolean(changes.hoverEnabled.newValue);
      if (!settings.hoverEnabled) resetHover();
    }
    if (changes.showFab) {
      settings.showFab = Boolean(changes.showFab.newValue);
    }
    updateUi();
  });

  async function init() {
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', init, { once: true });
      return;
    }

    try {
      const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
      settings.hoverEnabled = typeof stored.hoverEnabled === 'boolean'
        ? stored.hoverEnabled
        : DEFAULT_SETTINGS.hoverEnabled;
      settings.showFab = typeof stored.showFab === 'boolean'
        ? stored.showFab
        : DEFAULT_SETTINGS.showFab;
    } catch (error) {
      // 使用默认设置
    }

    createUi();

    document.addEventListener('mousemove', handlePointerMove, { passive: true });
    document.addEventListener('mouseleave', resetHover, { passive: true });
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', () => {
      positionTooltip();
      positionSelectionCard();
    }, { passive: true });
  }

  init().catch((error) => {
    console.warn('[指译] 初始化失败：', error);
  });
})();
