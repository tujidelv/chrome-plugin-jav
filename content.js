// 内容脚本 - 在网页中注入悬浮弹窗功能

// 全局变量
let popup = null; // 悬浮弹窗元素
let selectedText = ''; // 当前选中的文本
let selectedRange = null; // 当前选中的文本范围
let translateMenuVisible = false; // 翻译菜单是否显示
let currentReadingUtterance = null; // 当前朗读的语音对象
let toastTimer = null; // 轻提示定时器
/** 用户通过弹窗配置的覆盖项（从 chrome.storage 加载，优先于 config.js） */
let userConfigOverrides = {};
// 用于抑制“输入框回车”触发的下一次 keyup 选区检测（避免误关弹窗）
let suppressNextKeyupSelection = false;

chrome.storage.local.get(['kimiConfigOverrides'], (res) => {
  if (res.kimiConfigOverrides) userConfigOverrides = res.kimiConfigOverrides;
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.kimiConfigOverrides && changes.kimiConfigOverrides.newValue) {
    userConfigOverrides = changes.kimiConfigOverrides.newValue;
  }
});

// 初始化：监听文本选择事件
document.addEventListener('mouseup', handleTextSelection);
document.addEventListener('keyup', handleTextSelection);
document.addEventListener('keydown', handleKeydown);

// 点击外部区域关闭弹窗
document.addEventListener('click', handleOutsideClick);

/** 获取 API 超时时间（毫秒）：优先用弹窗配置，否则 config 默认 */
function getApiTimeoutMs() {
  const v = userConfigOverrides.apiTimeoutMs;
  if (v !== undefined && v > 0) return v;
  return (typeof KIMI_CONFIG !== 'undefined' && KIMI_CONFIG.apiTimeoutMs > 0)
    ? KIMI_CONFIG.apiTimeoutMs
    : 60000;
}

/** 按 Esc 关闭弹窗 */
function handleKeydown(e) {
  if (e.key === 'Escape' && popup) {
    hidePopup();
    e.preventDefault();
  }
}

/**
 * 在弹窗内显示轻提示（替代 alert，不打断操作）
 * @param {string} message - 提示文案
 * @param {number} durationMs - 显示时长（毫秒）
 */
function showToast(message, durationMs) {
  if (toastTimer) clearTimeout(toastTimer);
  const existing = document.getElementById('text-assistant-toast');
  if (existing) existing.remove();
  if (!popup) return;
  const toast = document.createElement('div');
  toast.id = 'text-assistant-toast';
  toast.className = 'toast-hint';
  toast.textContent = message;
  popup.appendChild(toast);
  toastTimer = setTimeout(() => {
    toast.remove();
    toastTimer = null;
  }, durationMs || 2000);
}

/**
 * 处理文本选择事件
 */
function handleTextSelection(e) {
  // 按 Esc 松开时不要根据选区重新打开弹窗（keydown 已关闭弹窗，keyup 若仍处理会立刻重建）
  if (e.type === 'keyup' && e.key === 'Escape') {
    return;
  }

  // 输入框回车时会触发一次全局 keyup，且我们可能在 keydown 里禁用了输入框导致 keyup 的 target 变成 body
  // 这里吞掉“下一次 keyup”，避免误判为“无选区→关闭弹窗”
  if (e.type === 'keyup' && suppressNextKeyupSelection) {
    suppressNextKeyupSelection = false;
    return;
  }

  // 如果事件来自弹窗内部（输入框/按钮等），直接忽略
  // 说明：之前在 setTimeout 内再判断，可能在延迟回调时机下误判导致弹窗被关闭
  const clickedInsidePopupNow = popup && e.target && popup.contains(e.target);
  if (clickedInsidePopupNow) {
    return;
  }

  // 延迟执行，确保选择已完成
  setTimeout(() => {
    const selection = window.getSelection();
    const text = selection.toString().trim();

    // 如果点击的是弹窗内部（按钮、结果区等），不要因为选区变化而重建或关闭弹窗
    const clickedInsidePopup = popup && e.target && popup.contains(e.target);
    if (clickedInsidePopup) {
      return;
    }

    // 如果选中了文本且文本不为空
    if (text && text.length > 0 && selection.rangeCount > 0) {
      // 已经是同一段文字且弹窗还在时，不重建弹窗（避免点“解释/翻译”时整块被重建、闪一下没效果）
      if (popup && text === selectedText) {
        return;
      }
      selectedText = text;
      selectedRange = selection.getRangeAt(0);
      showPopup(selectedRange);
    } else {
      // 如果没有选中文本，隐藏弹窗（除非点击的是弹窗本身）
      if (popup && !clickedInsidePopup) {
        hidePopup();
      }
    }
  }, 10);
}

/**
 * 显示悬浮弹窗
 * @param {Range} range - 选中文本的范围对象
 */
function showPopup(range) {
  // 如果弹窗已存在，先移除
  if (popup) {
    popup.remove();
  }

  // 创建弹窗元素
  popup = createPopupElement();
  document.body.appendChild(popup);

  // 计算弹窗位置
  const rect = range.getBoundingClientRect();
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
  const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const popupWidth = popup.offsetWidth;
  const popupHeight = popup.offsetHeight;

  // 垂直：优先在选中文本下方，放不下则在上方
  let top = rect.bottom + scrollTop + 8;
  if (top + popupHeight > scrollTop + viewportHeight) {
    top = rect.top + scrollTop - popupHeight - 8;
  }
  if (top < scrollTop) {
    top = scrollTop + 8;
  }

  // 水平：选中最左侧内容时，弹窗左边缘与选区左边缘对齐，避免遮住选区
  const selectionLeft = rect.left + scrollLeft;
  const margin = 10;
  const leftEdgeThreshold = viewportWidth * 0.25; // 选区偏左时采用“左对齐”策略

  let popupLeft;
  if (rect.left < leftEdgeThreshold) {
    // 选区在左侧：弹窗左边缘对齐选区左边缘，不遮挡选区
    popupLeft = selectionLeft;
    if (popupLeft + popupWidth > scrollLeft + viewportWidth - margin) {
      popupLeft = scrollLeft + viewportWidth - popupWidth - margin;
    }
    if (popupLeft < scrollLeft + margin) {
      popupLeft = scrollLeft + margin;
    }
  } else {
    // 默认：弹窗水平居中于选区
    let centerX = rect.left + scrollLeft + rect.width / 2;
    popupLeft = centerX - popupWidth / 2;
    if (popupLeft + popupWidth > scrollLeft + viewportWidth - margin) {
      popupLeft = scrollLeft + viewportWidth - popupWidth - margin;
    }
    if (popupLeft < scrollLeft + margin) {
      popupLeft = scrollLeft + margin;
    }
  }

  // 设置弹窗位置
  popup.style.top = `${top}px`;
  popup.style.left = `${popupLeft}px`;

  // 添加淡入动画
  popup.style.opacity = '0';
  setTimeout(() => {
    popup.style.transition = 'opacity 0.2s ease-out';
    popup.style.opacity = '1';
  }, 10);
}

/**
 * 创建弹窗元素
 * @returns {HTMLElement} 弹窗DOM元素
 */
function createPopupElement() {
  const popupDiv = document.createElement('div');
  popupDiv.className = 'text-assistant-popup';
  popupDiv.id = 'text-assistant-popup';

  // 创建工具栏
  const toolbar = document.createElement('div');
  toolbar.className = 'popup-toolbar';

  // 创建功能按钮（带 title 便于悬停提示）
  const explainBtn = createButton('解释', 'explain-btn', '📝');
  explainBtn.title = '解释选中文本的含义';
  const translateBtn = createButton('翻译', 'translate-btn translate-btn-dropdown', '🌐');
  translateBtn.title = '翻译为中文或英文';
  const readBtn = createButton('朗读', 'read-btn', '🔊');
  readBtn.title = '朗读选中文本（再次点击停止）';
  const polishBtn = createButton('润色', 'polish-btn', '✨');
  polishBtn.title = '润色文本并支持一键替换';

  // 绑定按钮事件（mousedown 阻止默认行为，避免点击时页面选区被清掉导致弹窗闪一下）
  explainBtn.addEventListener('mousedown', (e) => e.preventDefault());
  explainBtn.addEventListener('click', (e) => { e.stopPropagation(); handleExplain(); });
  translateBtn.addEventListener('mousedown', (e) => e.preventDefault());
  translateBtn.addEventListener('click', (e) => handleTranslateClick(e));
  readBtn.addEventListener('mousedown', (e) => e.preventDefault());
  readBtn.addEventListener('click', (e) => { e.stopPropagation(); handleRead(); });
  polishBtn.addEventListener('mousedown', (e) => e.preventDefault());
  polishBtn.addEventListener('click', (e) => { e.stopPropagation(); handlePolish(); });

  // 添加按钮到工具栏
  toolbar.appendChild(explainBtn);
  toolbar.appendChild(translateBtn);
  toolbar.appendChild(readBtn);
  toolbar.appendChild(polishBtn);

  // 创建全局请求进度条（解释/翻译/润色请求时显示，提示语从 config 读取）
  const progressBar = document.createElement('div');
  progressBar.className = 'api-progress-bar';
  progressBar.id = 'api-progress-bar';
  const progressText = (userConfigOverrides.progressBarText !== undefined && userConfigOverrides.progressBarText !== '')
    ? userConfigOverrides.progressBarText
    : ((typeof KIMI_CONFIG !== 'undefined' && KIMI_CONFIG.progressBarText) ? KIMI_CONFIG.progressBarText : '正在请求 Kimi API...');
  const progressTextSpan = document.createElement('span');
  progressTextSpan.className = 'api-progress-text';
  progressTextSpan.textContent = progressText;
  const progressTrack = document.createElement('div');
  progressTrack.className = 'api-progress-track';
  progressTrack.innerHTML = '<div class="api-progress-fill"></div>';
  progressBar.appendChild(progressTextSpan);
  progressBar.appendChild(progressTrack);

  // 创建结果显示区域
  const resultsDiv = document.createElement('div');
  resultsDiv.className = 'popup-results';
  resultsDiv.id = 'popup-results';

  // 组装弹窗：工具栏 -> 进度条 -> 结果区
  popupDiv.appendChild(toolbar);
  popupDiv.appendChild(progressBar);
  popupDiv.appendChild(resultsDiv);

  return popupDiv;
}

/**
 * 显示全局请求进度条（让用户明确知道正在请求数据）
 */
function showProgressBar() {
  const bar = document.getElementById('api-progress-bar');
  if (bar) bar.classList.add('visible');
}

/**
 * 隐藏全局请求进度条
 */
function hideProgressBar() {
  const bar = document.getElementById('api-progress-bar');
  if (bar) bar.classList.remove('visible');
}

/**
 * 带超时的 sendMessage，避免长时间无响应
 * @param {object} message - 要发送的消息
 * @param {number} timeoutMs - 超时毫秒数
 * @returns {Promise<object>} 后台返回的 response
 */
function sendMessageWithTimeout(message, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('请求超时，请检查网络或稍后重试'));
    }, timeoutMs);
    chrome.runtime.sendMessage(message, (response) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || '扩展通信失败'));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * 创建按钮元素
 * @param {string} text - 按钮文字
 * @param {string} className - CSS类名
 * @param {string} icon - 图标（可选）
 * @returns {HTMLElement} 按钮DOM元素
 */
function createButton(text, className, icon = '') {
  const btn = document.createElement('button');
  btn.className = `popup-btn ${className}`;
  btn.textContent = icon ? `${icon} ${text}` : text;
  return btn;
}

/**
 * 处理解释功能
 */
async function handleExplain() {
  const btn = document.querySelector('.explain-btn');
  const resultsDiv = document.getElementById('popup-results');
  
  // 检查是否已有解释结果
  let resultItem = document.getElementById('result-explain');
  if (resultItem) {
    // 如果已存在，切换显示/隐藏
    resultItem.style.display = resultItem.style.display === 'none' ? 'block' : 'none';
    return;
  }

  // 设置按钮加载状态并显示进度条
  setButtonLoading(btn, true);
  showProgressBar();
  showLoadingResult('explain', '📝 解释结果：');

  try {
    // 调用后台脚本的 API（60 秒超时）
    const response = await sendMessageWithTimeout({
      action: 'callKimiAPI',
      prompt: selectedText,
      type: 'explain'
    }, getApiTimeoutMs());

    if (response && response.success) {
      showResult('explain', '📝 解释结果：', response.data);
    } else {
      showError('explain', (response && response.error) || '解释失败，请重试');
    }
  } catch (error) {
    console.error('解释功能错误:', error);
    showError('explain', error.message || '解释失败，请检查网络连接和 API 配置');
  } finally {
    setButtonLoading(btn, false);
    hideProgressBar();
  }
}

/**
 * 处理翻译按钮点击（显示语言选择菜单）
 */
function handleTranslateClick(e) {
  e.stopPropagation();
  
  // 切换翻译菜单显示状态
  translateMenuVisible = !translateMenuVisible;
  
  if (translateMenuVisible) {
    showTranslateMenu();
  } else {
    hideTranslateMenu();
  }
}

/**
 * 显示翻译语言选择菜单
 */
function showTranslateMenu() {
  // 如果菜单已存在，先移除
  const existingMenu = document.querySelector('.translate-menu');
  if (existingMenu) {
    existingMenu.remove();
  }

  const translateBtn = document.querySelector('.translate-btn');
  const menu = document.createElement('div');
  menu.className = 'translate-menu';
  
  const zhOption = document.createElement('div');
  zhOption.className = 'translate-menu-item';
  zhOption.textContent = '翻译为中文';
  zhOption.addEventListener('click', () => {
    hideTranslateMenu();
    handleTranslate('zh');
  });

  const enOption = document.createElement('div');
  enOption.className = 'translate-menu-item';
  enOption.textContent = '翻译为英文';
  enOption.addEventListener('click', () => {
    hideTranslateMenu();
    handleTranslate('en');
  });

  menu.appendChild(zhOption);
  menu.appendChild(enOption);
  
  translateBtn.appendChild(menu);
  
  // 点击外部关闭菜单
  setTimeout(() => {
    document.addEventListener('click', hideTranslateMenuOnOutsideClick, true);
  }, 100);
}

/**
 * 点击外部关闭翻译菜单
 */
function hideTranslateMenuOnOutsideClick(e) {
  const menu = document.querySelector('.translate-menu');
  const translateBtn = document.querySelector('.translate-btn');
  
  if (menu && !menu.contains(e.target) && !translateBtn.contains(e.target)) {
    hideTranslateMenu();
    document.removeEventListener('click', hideTranslateMenuOnOutsideClick, true);
  }
}

/**
 * 隐藏翻译菜单
 */
function hideTranslateMenu() {
  const menu = document.querySelector('.translate-menu');
  if (menu) {
    menu.remove();
  }
  translateMenuVisible = false;
}

/**
 * 处理翻译功能
 * @param {string} targetLang - 目标语言：zh(中文) 或 en(英文)
 */
async function handleTranslate(targetLang) {
  const btn = document.querySelector('.translate-btn');
  const resultsDiv = document.getElementById('popup-results');
  
  const resultId = `translate-${targetLang}`;
  let resultItem = document.getElementById(`result-${resultId}`);
  if (resultItem) {
    resultItem.style.display = resultItem.style.display === 'none' ? 'block' : 'none';
    return;
  }

  setButtonLoading(btn, true);
  showProgressBar();
  showLoadingResult(resultId, `🌐 翻译结果（${targetLang === 'zh' ? '中文' : '英文'}）：`);

  try {
    const response = await sendMessageWithTimeout({
      action: 'callKimiAPI',
      prompt: selectedText,
      type: 'translate',
      targetLang: targetLang
    }, getApiTimeoutMs());

    if (response && response.success) {
      showResult(resultId, `🌐 翻译结果（${targetLang === 'zh' ? '中文' : '英文'}）：`, response.data);
    } else {
      showError(resultId, (response && response.error) || '翻译失败，请重试');
    }
  } catch (error) {
    console.error('翻译功能错误:', error);
    showError(resultId, error.message || '翻译失败，请检查网络连接和 API 配置');
  } finally {
    setButtonLoading(btn, false);
    hideProgressBar();
  }
}

/**
 * 处理朗读功能
 */
function handleRead() {
  const btn = document.querySelector('.read-btn');
  
  // 如果正在朗读，则停止
  if (currentReadingUtterance) {
    stopReading();
    return;
  }

  // 检测文本语言（简单检测：如果包含中文字符则为中文，否则为英文）
  const isChinese = /[\u4e00-\u9fa5]/.test(selectedText);
  const lang = isChinese ? 'zh-CN' : 'en-US';

  // 创建语音对象
  const utterance = new SpeechSynthesisUtterance(selectedText);
  utterance.lang = lang;
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;

  // 朗读开始事件
  utterance.onstart = () => {
    btn.textContent = '🔊 停止';
    btn.classList.add('reading');
    currentReadingUtterance = utterance;
  };

  // 朗读结束事件
  utterance.onend = () => {
    btn.textContent = '🔊 朗读';
    btn.classList.remove('reading');
    currentReadingUtterance = null;
  };

  // 朗读错误事件
  utterance.onerror = () => {
    btn.textContent = '🔊 朗读';
    btn.classList.remove('reading');
    currentReadingUtterance = null;
    showToast('朗读失败，请检查浏览器设置或系统音量', 2500);
  };

  // 开始朗读
  window.speechSynthesis.speak(utterance);
}

/**
 * 停止朗读
 */
function stopReading() {
  if (currentReadingUtterance) {
    window.speechSynthesis.cancel();
    const btn = document.querySelector('.read-btn');
    btn.textContent = '🔊 朗读';
    btn.classList.remove('reading');
    currentReadingUtterance = null;
  }
}

/**
 * 处理润色功能
 */
async function handlePolish() {
  const btn = document.querySelector('.polish-btn');
  const resultsDiv = document.getElementById('popup-results');
  
  let resultItem = document.getElementById('result-polish');
  if (resultItem) {
    resultItem.style.display = resultItem.style.display === 'none' ? 'block' : 'none';
    return;
  }

  setButtonLoading(btn, true);
  showProgressBar();
  showLoadingResult('polish', '✨ 润色结果：');

  try {
    const response = await sendMessageWithTimeout({
      action: 'callKimiAPI',
      prompt: selectedText,
      type: 'polish'
    }, getApiTimeoutMs());

    if (response && response.success) {
      showPolishResult(response.data);
    } else {
      showError('polish', (response && response.error) || '润色失败，请重试');
    }
  } catch (error) {
    console.error('润色功能错误:', error);
    showError('polish', error.message || '润色失败，请检查网络连接和 API 配置');
  } finally {
    setButtonLoading(btn, false);
    hideProgressBar();
  }
}

/**
 * 显示加载状态
 */
function showLoadingResult(id, title) {
  const resultsDiv = document.getElementById('popup-results');
  const resultItem = document.createElement('div');
  resultItem.className = 'result-item';
  resultItem.id = `result-${id}`;
  
  const titleDiv = document.createElement('div');
  titleDiv.className = 'result-title';
  titleDiv.textContent = title;
  
  const contentDiv = document.createElement('div');
  contentDiv.className = 'result-content loading-text';
  contentDiv.textContent = '加载中...';
  
  resultItem.appendChild(titleDiv);
  resultItem.appendChild(contentDiv);
  resultsDiv.appendChild(resultItem);
}

/**
 * 显示结果（解释/翻译），带复制按钮
 * 解释结果额外支持"重新提问"功能
 */
function showResult(id, title, content) {
  const resultItem = document.getElementById(`result-${id}`);
  if (!resultItem) {
    const resultsDiv = document.getElementById('popup-results');
    resultItem = document.createElement('div');
    resultItem.className = 'result-item';
    resultItem.id = `result-${id}`;
    resultsDiv.appendChild(resultItem);
  }

  resultItem.innerHTML = '';

  const titleRow = document.createElement('div');
  titleRow.className = 'result-title-row';
  const titleDiv = document.createElement('div');
  titleDiv.className = 'result-title';
  titleDiv.textContent = title;
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = '复制';
  copyBtn.title = '复制到剪贴板';
  copyBtn.addEventListener('mousedown', (e) => e.preventDefault());
  copyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    copyToClipboard(content, copyBtn);
  });
  titleRow.appendChild(titleDiv);
  titleRow.appendChild(copyBtn);

  const contentDiv = document.createElement('div');
  contentDiv.className = 'result-content';
  contentDiv.textContent = content;

  resultItem.appendChild(titleRow);
  resultItem.appendChild(contentDiv);

  // 解释结果额外添加"重新提问"功能
  if (id === 'explain') {
    const reaskContainer = document.createElement('div');
    reaskContainer.className = 'reask-container';
    
    const reaskInput = document.createElement('input');
    reaskInput.type = 'text';
    reaskInput.className = 'reask-input';
    reaskInput.placeholder = '对解释不满意？输入新问题重新提问...';
    reaskInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        // 标记：吞掉紧随其后的 keyup(Enter) 选区检测，避免弹窗被误关闭
        suppressNextKeyupSelection = true;
        handleReask(reaskInput.value.trim());
      }
    });

    const reaskBtn = document.createElement('button');
    reaskBtn.type = 'button';
    reaskBtn.className = 'reask-btn';
    reaskBtn.textContent = '重新提问';
    reaskBtn.addEventListener('click', () => {
      handleReask(reaskInput.value.trim());
    });

    reaskContainer.appendChild(reaskInput);
    reaskContainer.appendChild(reaskBtn);
    resultItem.appendChild(reaskContainer);

    // 通用解释展示完成后，自动把光标定位到输入框，方便立刻追问（无需动鼠标）
    setTimeout(() => {
      if (!popup || reaskInput.disabled) return;
      try {
        reaskInput.focus({ preventScroll: true });
      } catch (_) {
        reaskInput.focus();
      }
      const len = reaskInput.value.length;
      if (typeof reaskInput.setSelectionRange === 'function') {
        reaskInput.setSelectionRange(len, len);
      }
    }, 0);
  }
}

/**
 * 处理重新提问（针对解释功能）
 * @param {string} newQuestion - 用户输入的新问题
 */
async function handleReask(newQuestion) {
  if (!newQuestion || newQuestion.trim() === '') {
    showToast('请输入问题', 1500);
    return;
  }

  const resultItem = document.getElementById('result-explain');
  if (!resultItem) return;

  const reaskBtn = resultItem.querySelector('.reask-btn');
  const reaskInput = resultItem.querySelector('.reask-input');
  // 注意：不要在 keydown(Enter) 里立刻 disable 聚焦的 input，
  // 否则随后的 keyup 事件 target 可能变成 body，触发全局选区监听误关弹窗
  const disableTimer = setTimeout(() => {
    if (reaskBtn) reaskBtn.disabled = true;
    if (reaskInput) reaskInput.disabled = true;
  }, 0);

  showProgressBar();
  const contentDiv = resultItem.querySelector('.result-content');
  if (contentDiv) {
    contentDiv.className = 'result-content loading-text';
    contentDiv.textContent = '正在重新提问...';
  }

  try {
    // 重新提问时，将原始文本和用户新问题一起发送，让 AI 理解上下文
    const enhancedPrompt = `原始文本：${selectedText}\n\n用户追问：${newQuestion}\n\n请基于原始文本，回答用户的新问题。`;
    const response = await sendMessageWithTimeout({
      action: 'callKimiAPI',
      prompt: enhancedPrompt,
      type: 'explain'
    }, getApiTimeoutMs());

    if (response && response.success) {
      if (contentDiv) {
        contentDiv.className = 'result-content';
        contentDiv.textContent = response.data;
      }
      if (reaskInput) reaskInput.value = '';
      showToast('已回答', 1500);
    } else {
      showError('explain', (response && response.error) || '重新提问失败，请重试');
    }
  } catch (error) {
    console.error('重新提问错误:', error);
    showError('explain', error.message || '重新提问失败，请检查网络连接和 API 配置');
  } finally {
    // 防止 disable 的 setTimeout 在 finally 之后才执行，导致输入框又被禁用
    clearTimeout(disableTimer);
    if (reaskBtn) reaskBtn.disabled = false;
    if (reaskInput) reaskInput.disabled = false;
    hideProgressBar();

    // 让用户可以连续追问：请求结束后把光标放回输入框（不需要动鼠标）
    if (reaskInput) {
      setTimeout(() => {
        try {
          reaskInput.focus({ preventScroll: true });
        } catch (_) {
          reaskInput.focus();
        }
        // 光标放到末尾（成功时输入框已清空；失败时保留用户输入便于修改）
        const len = reaskInput.value.length;
        if (typeof reaskInput.setSelectionRange === 'function') {
          reaskInput.setSelectionRange(len, len);
        }
        // 若结果很长导致输入框不在视区内，尽量保持可见
        if (typeof reaskInput.scrollIntoView === 'function') {
          reaskInput.scrollIntoView({ block: 'nearest' });
        }
      }, 0);
    }
  }
}

/**
 * 复制文本到剪贴板，并更新按钮状态与轻提示
 * 优先用 navigator.clipboard，不可用时用 execCommand 兜底（content script 内 clipboard 可能受限）
 */
function copyToClipboard(text, btnEl) {
  if (!text || !btnEl) return;

  function onSuccess() {
    const orig = btnEl.textContent;
    btnEl.textContent = '已复制';
    btnEl.classList.add('copied');
    setTimeout(() => {
      btnEl.textContent = orig;
      btnEl.classList.remove('copied');
    }, 1200);
    showToast('已复制到剪贴板', 1500);
  }

  function onFail() {
    showToast('复制失败，请手动选择复制', 2000);
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(onSuccess).catch(onFail);
      return;
    }
  } catch (err) {
    /* clipboard API 不可用，走兜底 */
  }

  // 兜底：临时 textarea + execCommand('copy')
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (ok) {
      onSuccess();
    } else {
      onFail();
    }
  } catch (err) {
    onFail();
  }
}

/**
 * 显示润色结果（可编辑）
 */
function showPolishResult(content) {
  const resultsDiv = document.getElementById('popup-results');
  let resultItem = document.getElementById('result-polish');
  
  if (!resultItem) {
    resultItem = document.createElement('div');
    resultItem.className = 'result-item';
    resultItem.id = 'result-polish';
    resultsDiv.appendChild(resultItem);
  }

  resultItem.innerHTML = '';
  
  const titleDiv = document.createElement('div');
  titleDiv.className = 'result-title';
  titleDiv.textContent = '✨ 润色结果：';
  
  const contentTextarea = document.createElement('textarea');
  contentTextarea.className = 'result-content editable';
  contentTextarea.value = content;
  contentTextarea.rows = 5;
  
  const replaceBtn = document.createElement('button');
  replaceBtn.type = 'button';
  replaceBtn.className = 'replace-btn';
  replaceBtn.textContent = '一键替换';
  replaceBtn.addEventListener('click', () => {
    replaceSelectedText(contentTextarea.value);
  });
  
  const btnContainer = document.createElement('div');
  btnContainer.style.clear = 'both';
  btnContainer.appendChild(replaceBtn);
  
  resultItem.appendChild(titleDiv);
  resultItem.appendChild(contentTextarea);
  resultItem.appendChild(btnContainer);
}

/**
 * 替换选中文本
 */
function replaceSelectedText(newText) {
  if (selectedRange) {
    try {
      selectedRange.deleteContents();
      const textNode = document.createTextNode(newText);
      selectedRange.insertNode(textNode);
      showToast('已替换成功', 1500);
      setTimeout(() => hidePopup(), 800);
    } catch (error) {
      showToast('替换失败，该区域可能不可编辑', 2500);
    }
  }
}

/**
 * 显示错误信息
 */
function showError(id, errorMsg) {
  const resultItem = document.getElementById(`result-${id}`);
  if (resultItem) {
    const contentDiv = resultItem.querySelector('.result-content');
    if (contentDiv) {
      contentDiv.className = 'result-content error-text';
      contentDiv.textContent = `❌ ${errorMsg}`;
    }
  }
}

/**
 * 设置按钮加载状态
 */
function setButtonLoading(btn, loading) {
  if (loading) {
    btn.classList.add('loading');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.dataset.originalText = originalText;
    btn.textContent = '处理中...';
  } else {
    btn.classList.remove('loading');
    btn.disabled = false;
    if (btn.dataset.originalText) {
      btn.textContent = btn.dataset.originalText;
      delete btn.dataset.originalText;
    }
  }
}

/**
 * 隐藏弹窗
 */
function hidePopup() {
  if (popup) {
    popup.remove();
    popup = null;
  }
  hideTranslateMenu();
  stopReading();
}

/**
 * 处理点击外部区域
 */
function handleOutsideClick(e) {
  if (popup && !popup.contains(e.target)) {
    // 如果点击的不是弹窗内的元素，隐藏弹窗
    const selection = window.getSelection();
    if (!selection.toString().trim()) {
      hidePopup();
    }
  }
}
