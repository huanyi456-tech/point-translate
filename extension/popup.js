/* 指译 — 弹窗逻辑 */

const $ = (id) => document.getElementById(id);

const els = {
  badge: $('pageBadge'),
  button: $('translateBtn'),
  buttonText: $('translateBtnText'),
  buttonHint: $('translateBtnHint'),
  error: $('errorText'),
  hover: $('hoverToggle'),
  fab: $('fabToggle'),
  dot: $('statusDot'),
  status: $('statusText'),
  shortcutPage: $('shortcutPage'),
  shortcutHover: $('shortcutHover'),
};

const state = {
  tab: null,
  supported: false,
  pageState: null,
  actionBusy: false,
};

const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
const ALT = isMac ? 'Option' : 'Alt';

init().catch((error) => {
  showError(friendlyError(error));
  setUnsupported();
});

async function init() {
  els.shortcutPage.textContent = `${ALT} + A 翻译全页`;
  els.shortcutHover.textContent = `${ALT} + T 开关悬停`;
  bindEvents();

  let stored = {};
  try {
    stored = await chrome.storage.local.get({ hoverEnabled: true, showFab: true });
  } catch {
    stored = { hoverEnabled: true, showFab: true };
  }
  els.hover.checked = stored.hoverEnabled !== false;
  els.fab.checked = stored.showFab !== false;

  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    setUnsupported('没有找到当前网页，请打开一个普通英文网页后再试。');
    return;
  }

  state.tab = tab;

  // 不依赖 tab.url：某些情况下 activeTab 权限只会开放脚本注入，
  // 不会返回网址。能连上（或能补注入）content script 就说明可以翻译。
  try {
    await ensureContent(tab.id);
    state.pageState = await send(tab.id, { type: 'getPageState' });
    state.supported = true;
    render();
  } catch (error) {
    setUnsupported(
      '这个页面不允许插件修改。请打开普通网页（以 http:// 或 https:// 开头）后再试。'
    );
  }
}

function bindEvents() {
  els.button.addEventListener('click', onPrimaryClick);

  els.hover.addEventListener('change', () => {
    saveSetting('hoverEnabled', els.hover.checked);
  });

  els.fab.addEventListener('change', () => {
    saveSetting('showFab', els.fab.checked);
  });
}

async function onPrimaryClick() {
  if (!state.supported || !state.tab || state.actionBusy) return;

  const mode = els.button.dataset.mode === 'restore' ? 'restore' : 'translate';
  hideError();
  state.actionBusy = true;
  els.button.disabled = true;

  if (mode === 'restore') {
    els.buttonText.textContent = '正在恢复…';
    els.buttonHint.textContent = '马上就把网页变回原文';
    try {
      await ensureContent(state.tab.id);
      await send(state.tab.id, { type: 'restorePage' });
      state.pageState = await send(state.tab.id, { type: 'getPageState' });
    } catch (error) {
      showError(friendlyError(error));
    } finally {
      state.actionBusy = false;
      els.button.disabled = false;
      render();
    }
    return;
  }

  els.buttonText.textContent = '正在翻译…';
  els.buttonHint.textContent = '页面右下角会显示进度';
  try {
    await ensureContent(state.tab.id);
    // 翻译可能持续十几秒。发出请求后关闭弹窗，让页面上的进度提示接管。
    chrome.tabs.sendMessage(state.tab.id, { type: 'translatePage' }, () => {
      void chrome.runtime.lastError;
    });
    setTimeout(() => window.close(), 220);
  } catch (error) {
    state.actionBusy = false;
    els.button.disabled = false;
    showError(friendlyError(error));
    render();
  }
}

function render() {
  if (!state.supported) return;

  const page = state.pageState || {};
  const active = Boolean(page.active);
  const busy = Boolean(page.busy);
  const count = Number(page.count) || 0;
  const totalChunks = Number(page.totalChunks) || 0;
  const doneChunks = Number(page.doneChunks) || 0;

  els.error.hidden = true;

  if (busy) {
    els.badge.textContent = '翻译中';
    els.badge.dataset.state = 'busy';
    els.button.dataset.mode = 'restore';
    els.buttonText.textContent = '停止翻译并恢复原文';
    els.buttonHint.textContent = totalChunks
      ? `已完成 ${Math.min(doneChunks, totalChunks)} / ${totalChunks} 段`
      : '正在准备网页文字…';
    els.dot.dataset.state = 'busy';
    els.status.textContent = '翻译进行中，可随时停止';
    return;
  }

  if (active) {
    els.badge.textContent = '已翻译';
    els.badge.dataset.state = 'active';
    els.button.dataset.mode = 'restore';
    els.buttonText.textContent = '恢复网页原文';
    els.buttonHint.textContent = count
      ? `已翻译 ${count} 处文字，点击可恢复`
      : '网页已翻译，点击可恢复原文';
    els.dot.dataset.state = 'ok';
    els.status.textContent = '译文由 Bing 翻译提供';
    return;
  }

  els.badge.textContent = '可翻译';
  els.badge.dataset.state = 'ready';
  els.button.dataset.mode = 'translate';
  els.buttonText.textContent = '翻译整个页面';
  els.buttonHint.textContent = '一键把英文网页变成中文';
  els.dot.dataset.state = 'ok';
  els.status.textContent = 'Bing 翻译 · 无需登录';
}

function setUnsupported(message) {
  state.supported = false;
  state.pageState = null;
  els.badge.textContent = '不支持';
  els.badge.dataset.state = 'unsupported';
  els.button.dataset.mode = 'translate';
  els.button.disabled = true;
  els.buttonText.textContent = '此页面不能翻译';
  els.buttonHint.textContent = '请打开普通英文网页使用';
  els.dot.dataset.state = 'error';
  els.status.textContent = '只支持 http:// 或 https:// 网页';
  if (message) showError(message);
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
  els.dot.dataset.state = 'error';
}

function hideError() {
  els.error.hidden = true;
}

async function saveSetting(key, value) {
  hideError();
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch (error) {
    showError(`设置保存失败：${friendlyError(error)}`);
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

function send(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

async function ensureContent(tabId) {
  try {
    await send(tabId, { type: 'getPageState' });
    return;
  } catch {
    // content script 还没注入（扩展刚安装、页面在安装前打开），补注入一次。
  }

  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await delay(100);

  try {
    await send(tabId, { type: 'getPageState' });
  } catch {
    throw new Error('插件无法连接这个页面，请刷新网页后再试。');
  }
}

function friendlyError(error) {
  const raw = String((error && error.message) || error || '');
  if (/Receiving end does not exist|Could not establish connection|message port closed/i.test(raw)) {
    return '这个页面还没加载插件，请刷新网页后再试。';
  }
  if (/Cannot access|Cannot script|extensions gallery|Missing host permission/i.test(raw)) {
    return '浏览器不允许插件修改这个页面，请换一个普通网页。';
  }
  if (/QUERY LENGTH LIMIT EXCEEDED/i.test(raw)) {
    return '免费翻译额度今天用完了，请明天再试。';
  }
  if (/Bing|mymemory|translate/i.test(raw)) {
    return `翻译服务暂时不可用：${raw}`;
  }
  return raw || '操作失败，请稍后再试。';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
