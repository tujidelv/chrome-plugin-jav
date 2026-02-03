// 弹窗配置页 - 读取/保存到 chrome.storage.local，覆盖默认 config

const STORAGE_KEY = 'kimiConfigOverrides';

const DEFAULT = {
  apiUrl: 'https://api.moonshot.cn/v1/chat/completions',
  apiKey: '',
  model: 'moonshot-v1-8k',
  maxTokens: 2000,
  temperature: 0.6,
  apiTimeoutMs: 60000,
  progressBarText: '正在请求 Kimi API...'
};

const els = {
  apiUrl: document.getElementById('apiUrl'),
  apiKey: document.getElementById('apiKey'),
  model: document.getElementById('model'),
  maxTokens: document.getElementById('maxTokens'),
  temperature: document.getElementById('temperature'),
  apiTimeoutMs: document.getElementById('apiTimeoutMs'),
  progressBarText: document.getElementById('progressBarText'),
  btnSave: document.getElementById('btnSave'),
  btnReset: document.getElementById('btnReset'),
  saveTip: document.getElementById('saveTip')
};

/** 从 storage 读取并填充表单 */
function load() {
  chrome.storage.local.get([STORAGE_KEY], (res) => {
    const o = res[STORAGE_KEY] || {};
    els.apiUrl.value = o.apiUrl !== undefined ? o.apiUrl : DEFAULT.apiUrl;
    els.apiKey.value = o.apiKey !== undefined ? o.apiKey : DEFAULT.apiKey;
    els.model.value = o.model !== undefined ? o.model : DEFAULT.model;
    els.maxTokens.value = o.maxTokens !== undefined ? o.maxTokens : DEFAULT.maxTokens;
    els.temperature.value = o.temperature !== undefined ? o.temperature : DEFAULT.temperature;
    els.apiTimeoutMs.value = o.apiTimeoutMs !== undefined ? o.apiTimeoutMs : DEFAULT.apiTimeoutMs;
    els.progressBarText.value = o.progressBarText !== undefined ? o.progressBarText : DEFAULT.progressBarText;
  });
}

/** 保存到 storage（只保存有值的项，覆盖默认） */
function save() {
  const o = {
    apiUrl: els.apiUrl.value.trim() || DEFAULT.apiUrl,
    apiKey: els.apiKey.value.trim(),
    model: els.model.value,
    maxTokens: parseInt(els.maxTokens.value, 10) || DEFAULT.maxTokens,
    temperature: parseFloat(els.temperature.value) || DEFAULT.temperature,
    apiTimeoutMs: parseInt(els.apiTimeoutMs.value, 10) || DEFAULT.apiTimeoutMs,
    progressBarText: els.progressBarText.value.trim() || DEFAULT.progressBarText
  };
  chrome.storage.local.set({ [STORAGE_KEY]: o }, () => {
    els.saveTip.style.display = 'block';
    els.saveTip.textContent = '已保存，可关闭此窗口';
    setTimeout(() => {
      els.saveTip.style.display = 'none';
    }, 2000);
  });
}

/** 恢复默认并写回表单（不立刻保存到 storage，用户可再点保存） */
function reset() {
  els.apiUrl.value = DEFAULT.apiUrl;
  els.apiKey.value = DEFAULT.apiKey;
  els.model.value = DEFAULT.model;
  els.maxTokens.value = DEFAULT.maxTokens;
  els.temperature.value = DEFAULT.temperature;
  els.apiTimeoutMs.value = DEFAULT.apiTimeoutMs;
  els.progressBarText.value = DEFAULT.progressBarText;
  els.saveTip.style.display = 'none';
}

load();
els.btnSave.addEventListener('click', save);
els.btnReset.addEventListener('click', reset);
