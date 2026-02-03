// Kimi API 默认配置（发布版不写敏感信息）
// 用户需点击扩展图标，在弹窗中配置 API Key 等；配置会保存到 chrome.storage，覆盖此处默认值

const KIMI_CONFIG = {
  apiUrl: 'https://api.moonshot.cn/v1/chat/completions',
  apiKey: '',
  model: 'moonshot-v1-8k',
  maxTokens: 2000,
  temperature: 0.6,
  progressBarText: '正在请求 Kimi API...',
  apiTimeoutMs: 60000
};

// 导出配置（如果使用模块化）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = KIMI_CONFIG;
}
