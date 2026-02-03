// 后台服务脚本 - 处理Kimi API调用

// 导入配置文件
importScripts('config.js');

// 监听来自content script的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'callKimiAPI') {
    (async () => {
      try {
        const cfg = await getEffectiveConfig();
        const result = await callKimiAPI(cfg, request.prompt, request.type, request.targetLang);
        sendResponse({ success: true, data: result });
      } catch (error) {
        console.error('Kimi API调用失败:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }
});

const STORAGE_KEY = 'kimiConfigOverrides';

/** 从 storage 读取用户配置，与默认 config 合并（用户配置优先） */
function getEffectiveConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (res) => {
      const overrides = res[STORAGE_KEY] || {};
      const base = typeof KIMI_CONFIG !== 'undefined' ? KIMI_CONFIG : {};
      resolve({
        apiUrl: overrides.apiUrl !== undefined && overrides.apiUrl !== '' ? overrides.apiUrl : (base.apiUrl || 'https://api.moonshot.cn/v1/chat/completions'),
        apiKey: overrides.apiKey !== undefined && overrides.apiKey !== '' ? overrides.apiKey : (base.apiKey || ''),
        model: overrides.model !== undefined ? overrides.model : (base.model || 'moonshot-v1-8k'),
        maxTokens: overrides.maxTokens !== undefined ? overrides.maxTokens : (base.maxTokens || 2000),
        temperature: overrides.temperature !== undefined ? overrides.temperature : (base.temperature ?? 0.6)
      });
    });
  });
}

/**
 * 调用Kimi API
 * @param {object} cfg - 合并后的配置（含 apiUrl, apiKey, model, maxTokens, temperature）
 * @param {string} text - 要处理的文本
 * @param {string} type - 功能类型：explain(解释)、translate(翻译)、polish(润色)
 * @param {string} targetLang - 目标语言（仅翻译时使用）：zh(中文)、en(英文)
 * @returns {Promise<string>} API返回的结果文本
 */
async function callKimiAPI(cfg, text, type, targetLang = 'zh') {
  if (!cfg || !cfg.apiKey || cfg.apiKey.trim() === '') {
    throw new Error('请点击扩展图标，在设置中配置 API Key');
  }

  let systemPrompt = '';
  let userPrompt = '';

  switch (type) {
    case 'explain':
      systemPrompt = '你是一个专业的文本解释助手。请用简洁清晰的语言解释用户提供的文本内容，包括关键词的含义、段落的主旨等。';
      userPrompt = `请解释以下文本：\n\n${text}`;
      break;
    case 'translate':
      const targetLanguage = targetLang === 'zh' ? '中文' : 'English';
      systemPrompt = `你是一个专业的翻译助手。请将用户提供的文本翻译成${targetLanguage}，保持原意准确，语言自然流畅。只返回翻译结果，不要添加其他说明。`;
      userPrompt = `请将以下文本翻译成${targetLanguage}：\n\n${text}`;
      break;
    case 'polish':
      systemPrompt = '你是一个专业的文本润色助手。请对用户提供的文本进行润色，使其更加流畅、专业、易读。保持原意不变，只优化表达方式。';
      userPrompt = `请对以下文本进行润色：\n\n${text}`;
      break;
    default:
      throw new Error('未知的功能类型');
  }

  const requestBody = {
    model: cfg.model || 'moonshot-v1-8k',
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    temperature: cfg.temperature ?? 0.6,
    max_tokens: cfg.maxTokens || 2000
  };

  const response = await fetch(cfg.apiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `API请求失败: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (data.choices && data.choices.length > 0 && data.choices[0].message) {
    return data.choices[0].message.content.trim();
  }
  throw new Error('API返回数据格式错误');
}
