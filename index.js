// ============================================================
// Token & Cache Monitor — SillyTavern Extension
// 实时显示对话 token 用量和提示词缓存命中状态
// ============================================================

import {
    eventSource,
    event_types,
    getGeneratingModel,
    main_api,
    streamingProcessor,
    saveSettingsDebounced,
} from '../../../../script.js';

import {
    extension_settings,
    getContext,
} from '../../../extensions.js';

import {
    getTokenCountAsync,
    getFriendlyTokenizerName,
} from '../../../tokenizers.js';

// ---- Constants ----
const EXTENSION_NAME = 'st-token-monitor';
const PANEL_ID = 'st_token_monitor_panel';
const TOGGLE_BTN_ID = 'st_token_monitor_toggle';

const DEFAULT_SETTINGS = {
    enabled: true,
    collapsed: false,
    position: 'bottom-right',
    showPromptTokens: true,
    showCompletionTokens: true,
    showTotalTokens: true,
    showCacheStatus: true,
    showEstimated: true,
};

// ---- State ----
let state = {
    promptTokens: 0,
    completionTokens: 0,
    estimatedCompletionTokens: 0,
    totalTokens: 0,
    cacheStatus: null,      // 'HIT' | 'MISS' | 'PARTIAL' | null
    cacheDetails: null,     // detailed info (cached_tokens, etc.)
    modelName: null,
    isStreaming: false,
    startTime: null,
    lastPrompt: null,
};

// ---- Settings ----
function loadSettings() {
    extension_settings[EXTENSION_NAME] ??= {};
    const s = extension_settings[EXTENSION_NAME];
    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[key] === undefined) s[key] = val;
    }
}

function getSettings() {
    return extension_settings[EXTENSION_NAME];
}

// ---- Token Formatting ----
function formatNumber(n) {
    return n.toLocaleString();
}

function estimateTokensFromText(text) {
    if (!text || typeof text !== 'string') return 0;
    // Rough estimate: ~4 chars per token for English, ~2 for CJK
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
    const asciiCount = text.length - cjkCount;
    return Math.ceil(cjkCount / 1.5) + Math.ceil(asciiCount / 4);
}

// ---- Cache Detection ----
function detectCacheStatus(usage) {
    if (!usage) return { status: null, details: null };

    // --- Anthropic-style ---
    if (usage.cache_read_input_tokens !== undefined) {
        const read = usage.cache_read_input_tokens || 0;
        const created = usage.cache_creation_input_tokens || 0;
        const input = usage.input_tokens || 0;

        if (read > 0 && created > 0) {
            return {
                status: 'PARTIAL',
                details: `创建 ${formatNumber(created)} · 读取 ${formatNumber(read)} / ${formatNumber(input)}`,
            };
        }
        if (read > 0) {
            const pct = ((read / (input || 1)) * 100).toFixed(0);
            return {
                status: 'HIT',
                details: `${formatNumber(read)} / ${formatNumber(input)} tokens (${pct}%)`,
            };
        }
        if (created > 0) {
            return {
                status: 'MISS',
                details: `创建缓存 ${formatNumber(created)} tokens`,
            };
        }
        return { status: 'MISS', details: '无缓存命中' };
    }

    // --- OpenAI-style ---
    if (usage.prompt_tokens_details?.cached_tokens !== undefined) {
        const cached = usage.prompt_tokens_details.cached_tokens || 0;
        const prompt = usage.prompt_tokens || 0;
        if (cached > 0 && cached < prompt) {
            const pct = ((cached / (prompt || 1)) * 100).toFixed(0);
            return {
                status: 'PARTIAL',
                details: `${formatNumber(cached)} / ${formatNumber(prompt)} tokens (${pct}%)`,
            };
        }
        if (cached > 0) {
            return {
                status: 'HIT',
                details: `${formatNumber(cached)} / ${formatNumber(prompt)} tokens`,
            };
        }
        return { status: 'MISS', details: '无缓存命中' };
    }

    // --- OpenRouter-style ---
    if (usage.native_tokens_prompt !== undefined) {
        // OpenRouter doesn't expose cache reliably yet
        return { status: null, details: 'OpenRouter 缓存状态不可用' };
    }

    // Unknown format
    return { status: null, details: '无法检测缓存状态' };
}

async function extractUsageFromResponse() {
    try {
        const context = getContext();

        // Method 1: generateRawData() (PR #5249+)
        if (typeof context.generateRawData === 'function') {
            const raw = await context.generateRawData();
            if (raw?.usage) return raw.usage;
            // Some APIs nest usage differently
            if (raw?.response?.usage) return raw.response.usage;
        }

        // Method 2: Check if the API module has stored usage data
        if (main_api?.lastResponse?.usage) {
            return main_api.lastResponse.usage;
        }

        // Method 3: Anthropic API response in streamingProcessor
        if (streamingProcessor?.lastResponse?.usage) {
            return streamingProcessor.lastResponse.usage;
        }

        return null;
    } catch (e) {
        console.debug(`[${EXTENSION_NAME}] extractUsage failed:`, e);
        return null;
    }
}

// ---- UI ----
function createPanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
    const existingBtn = document.getElementById(TOGGLE_BTN_ID);
    if (existingBtn) existingBtn.remove();

    // ---- Toggle Button ----
    const toggle = document.createElement('div');
    toggle.id = TOGGLE_BTN_ID;
    toggle.title = '切换 Token 监控面板';
    toggle.innerHTML = `<span style="font-size:18px;line-height:1;">Σ</span>`;
    Object.assign(toggle.style, {
        position: 'fixed',
        zIndex: '9998',
        cursor: 'pointer',
        width: '36px',
        height: '36px',
        borderRadius: '8px',
        background: 'var(--SmartThemeBodyColor, #2a2a2a)',
        color: 'var(--SmartThemeBodyTextColor, #ccc)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        opacity: '0.7',
        transition: 'opacity 0.2s',
        userSelect: 'none',
    });
    toggle.addEventListener('mouseenter', () => toggle.style.opacity = '1');
    toggle.addEventListener('mouseleave', () => toggle.style.opacity = '0.7');
    toggle.addEventListener('click', () => togglePanel());
    document.body.appendChild(toggle);

    // ---- Panel ----
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    document.body.appendChild(panel);

    // ---- Panel HTML ----
    panel.innerHTML = `
        <div id="${PANEL_ID}_header" style="
            cursor: move;
            padding: 8px 12px;
            background: var(--SmartThemeBlurTintColor, #1a1a2e);
            border-bottom: 1px solid var(--SmartThemeBorderColor, #333);
            display: flex;
            justify-content: space-between;
            align-items: center;
            user-select: none;
            border-radius: 10px 10px 0 0;
        ">
            <span style="font-weight:600;font-size:13px;color:var(--SmartThemeBodyTextColor,#ddd);">
                🪙 Token & Cache
            </span>
            <div style="display:flex;gap:6px;">
                <span id="${PANEL_ID}_collapse" style="cursor:pointer;opacity:0.6;font-size:14px;" title="折叠">─</span>
                <span id="${PANEL_ID}_close" style="cursor:pointer;opacity:0.6;font-size:14px;" title="关闭">✕</span>
            </div>
        </div>
        <div id="${PANEL_ID}_body" style="padding:10px 12px;font-size:13px;line-height:1.6;">
            <div id="${PANEL_ID}_model" style="margin-bottom:6px;font-size:12px;opacity:0.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
            <div id="${PANEL_ID}_prompt" style="display:none;"></div>
            <div id="${PANEL_ID}_completion" style="display:none;"></div>
            <div id="${PANEL_ID}_total" style="display:none;"></div>
            <div id="${PANEL_ID}_cache" style="display:none;margin-top:4px;"></div>
            <div id="${PANEL_ID}_status" style="margin-top:6px;font-size:11px;opacity:0.5;"></div>
            <div style="margin-top:6px;display:flex;gap:6px;">
                <button id="${PANEL_ID}_copy" class="menu_button" style="font-size:11px;padding:2px 8px;">📋 复制</button>
                <button id="${PANEL_ID}_reset" class="menu_button" style="font-size:11px;padding:2px 8px;">🔄 重置</button>
            </div>
        </div>
    `;

    // ---- Styling ----
    const pos = getSettings().position || 'bottom-right';
    applyPanelPosition(panel, pos);

    Object.assign(panel.style, {
        position: 'fixed',
        zIndex: '9999',
        minWidth: '220px',
        maxWidth: '340px',
        background: 'var(--SmartThemeBlurTintColor, #1a1a2e)',
        color: 'var(--SmartThemeBodyTextColor, #ccc)',
        border: '1px solid var(--SmartThemeBorderColor, #333)',
        borderRadius: '10px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(10px)',
        fontFamily: 'var(--mainFontFamily, sans-serif)',
        display: getSettings().enabled ? 'block' : 'none',
    });

    // ---- Events ----
    document.getElementById(`${PANEL_ID}_close`).addEventListener('click', () => {
        panel.style.display = 'none';
        toggle.style.display = 'flex';
    });

    document.getElementById(`${PANEL_ID}_collapse`).addEventListener('click', () => {
        const body = document.getElementById(`${PANEL_ID}_body`);
        const collapsed = body.style.display === 'none';
        body.style.display = collapsed ? 'block' : 'none';
        getSettings().collapsed = !collapsed;
        saveSettingsDebounced();
    });

    document.getElementById(`${PANEL_ID}_copy`).addEventListener('click', copyStats);
    document.getElementById(`${PANEL_ID}_reset`).addEventListener('click', resetStats);

    // ---- Drag ----
    makeDraggable(panel, document.getElementById(`${PANEL_ID}_header`));

    // ---- Initial collapse ----
    if (getSettings().collapsed) {
        document.getElementById(`${PANEL_ID}_body`).style.display = 'none';
    }

    return panel;
}

function applyPanelPosition(panel, position) {
    const margin = 60;
    switch (position) {
        case 'top-left':
            panel.style.top = margin + 'px';
            panel.style.left = margin + 'px';
            panel.style.bottom = 'auto';
            panel.style.right = 'auto';
            break;
        case 'top-right':
            panel.style.top = margin + 'px';
            panel.style.right = margin + 'px';
            panel.style.bottom = 'auto';
            panel.style.left = 'auto';
            break;
        case 'bottom-left':
            panel.style.bottom = margin + 'px';
            panel.style.left = margin + 'px';
            panel.style.top = 'auto';
            panel.style.right = 'auto';
            break;
        case 'bottom-right':
        default:
            panel.style.bottom = margin + 'px';
            panel.style.right = margin + 'px';
            panel.style.top = 'auto';
            panel.style.left = 'auto';
            break;
    }
}

function makeDraggable(panel, handle) {
    let isDragging = false;
    let startX, startY, origX, origY;

    function onStart(e) {
        const ev = e.touches ? e.touches[0] : e;
        const rect = panel.getBoundingClientRect();
        // Switch to absolute positioning for drag
        panel.style.top = rect.top + 'px';
        panel.style.left = rect.left + 'px';
        panel.style.bottom = 'auto';
        panel.style.right = 'auto';
        isDragging = true;
        startX = ev.clientX;
        startY = ev.clientY;
        origX = rect.left;
        origY = rect.top;
    }

    function onMove(e) {
        if (!isDragging) return;
        const ev = e.touches ? e.touches[0] : e;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        panel.style.left = (origX + dx) + 'px';
        panel.style.top = (origY + dy) + 'px';
        e.preventDefault();
    }

    function onEnd() {
        isDragging = false;
    }

    handle.addEventListener('mousedown', onStart);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);

    handle.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
}

function togglePanel() {
    const panel = document.getElementById(PANEL_ID);
    const btn = document.getElementById(TOGGLE_BTN_ID);
    if (!panel || !btn) return;
    const isVisible = panel.style.display !== 'none';
    panel.style.display = isVisible ? 'none' : 'block';
    btn.style.display = isVisible ? 'flex' : 'none';
    getSettings().enabled = !isVisible;
    saveSettingsDebounced();
}

function updateUI() {
    const s = getSettings();
    const promptEl = document.getElementById(`${PANEL_ID}_prompt`);
    const compEl = document.getElementById(`${PANEL_ID}_completion`);
    const totalEl = document.getElementById(`${PANEL_ID}_total`);
    const cacheEl = document.getElementById(`${PANEL_ID}_cache`);
    const statusEl = document.getElementById(`${PANEL_ID}_status`);
    const modelEl = document.getElementById(`${PANEL_ID}_model`);

    if (!promptEl) return;

    // Model
    if (state.modelName) {
        modelEl.textContent = `📡 ${state.modelName}`;
        modelEl.style.display = 'block';
    } else {
        modelEl.style.display = 'none';
    }

    // Prompt tokens
    if (s.showPromptTokens && state.promptTokens > 0) {
        promptEl.textContent = `📤 Prompt: ${formatNumber(state.promptTokens)} tokens`;
        promptEl.style.display = 'block';
    } else {
        promptEl.style.display = 'none';
    }

    // Completion tokens
    if (s.showCompletionTokens) {
        const est = state.estimatedCompletionTokens;
        const actual = state.completionTokens;
        if (actual > 0) {
            if (s.showEstimated && est > 0 && est !== actual) {
                compEl.textContent = `📥 Output: ${formatNumber(actual)} tokens (粗略 ${formatNumber(est)})`;
            } else {
                compEl.textContent = `📥 Output: ${formatNumber(actual)} tokens`;
            }
            compEl.style.display = 'block';
        } else if (est > 0 && state.isStreaming) {
            compEl.textContent = `📥 Output: ${formatNumber(est)} tokens (实时估算)`;
            compEl.style.display = 'block';
        } else {
            compEl.style.display = 'none';
        }
    } else {
        compEl.style.display = 'none';
    }

    // Total
    if (s.showTotalTokens) {
        const total = state.completionTokens > 0
            ? state.promptTokens + state.completionTokens
            : state.promptTokens + state.estimatedCompletionTokens;
        if (total > 0) {
            totalEl.textContent = `📊 Total: ${formatNumber(total)} tokens`;
            totalEl.style.display = 'block';
        } else {
            totalEl.style.display = 'none';
        }
    } else {
        totalEl.style.display = 'none';
    }

    // Cache status
    if (s.showCacheStatus && state.cacheStatus) {
        const icons = { HIT: '🟢', PARTIAL: '🟡', MISS: '🔴' };
        const icon = icons[state.cacheStatus] || '⚪';
        cacheEl.textContent = `💾 Cache: ${icon} ${state.cacheStatus}${state.cacheDetails ? ' · ' + state.cacheDetails : ''}`;
        cacheEl.style.display = 'block';
    } else {
        cacheEl.style.display = 'none';
    }

    // Status line
    if (state.isStreaming) {
        statusEl.textContent = '⏳ 生成中...';
        statusEl.style.opacity = '0.8';
    } else {
        statusEl.textContent = state.startTime ? '✅ 就绪' : '💤 等待对话';
        statusEl.style.opacity = '0.5';
    }
}

function copyStats() {
    const s = getSettings();
    const lines = [];
    if (state.modelName) lines.push(`Model: ${state.modelName}`);
    if (s.showPromptTokens && state.promptTokens > 0) {
        lines.push(`Prompt tokens: ${formatNumber(state.promptTokens)}`);
    }
    if (s.showCompletionTokens && state.completionTokens > 0) {
        lines.push(`Completion tokens: ${formatNumber(state.completionTokens)}`);
    }
    if (s.showTotalTokens) {
        const total = state.completionTokens > 0
            ? state.promptTokens + state.completionTokens
            : state.promptTokens + state.estimatedCompletionTokens;
        if (total > 0) lines.push(`Total tokens: ${formatNumber(total)}`);
    }
    if (s.showCacheStatus && state.cacheStatus) {
        lines.push(`Cache: ${state.cacheStatus}${state.cacheDetails ? ' (' + state.cacheDetails + ')' : ''}`);
    }
    if (lines.length === 0) lines.push('尚无数据');

    const text = `=== Token & Cache Stats ===\n${lines.join('\n')}\n=========================`;

    navigator.clipboard.writeText(text).catch(() => {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    });

    toastr.success('已复制到剪贴板', 'Token Monitor');
}

function resetStats() {
    state.promptTokens = 0;
    state.completionTokens = 0;
    state.estimatedCompletionTokens = 0;
    state.totalTokens = 0;
    state.cacheStatus = null;
    state.cacheDetails = null;
    state.modelName = null;
    state.isStreaming = false;
    state.startTime = null;
    state.lastPrompt = null;
    updateUI();
}

// ---- Event Handlers ----

async function onGenerationStarted() {
    try {
        const context = getContext();
        state.startTime = Date.now();
        state.isStreaming = true;
        state.estimatedCompletionTokens = 0;
        state.completionTokens = 0;
        state.cacheStatus = null;
        state.cacheDetails = null;

        // Get model info
        try {
            const model = getGeneratingModel();
            state.modelName = model?.label || model?.id || model || null;
        } catch {
            // ignore
        }

        // Count prompt tokens
        try {
            // Get the full prompt text
            let promptText = '';

            // Combine the chat into a single prompt
            if (typeof context.getPrompt === 'function') {
                promptText = await context.getPrompt();
            }

            if (!promptText && context.chat) {
                promptText = context.chat.map(m => (m.name || '') + ': ' + (m.mes || '')).join('\n');
            }

            if (promptText) {
                state.lastPrompt = promptText;
                state.promptTokens = await getTokenCountAsync(promptText) || estimateTokensFromText(promptText);
            }
        } catch {
            // Fallback estimate
            if (context.chat) {
                const text = context.chat.map(m => (m.mes || '')).join('');
                state.promptTokens = estimateTokensFromText(text);
            }
        }

        updateUI();
    } catch (e) {
        console.debug(`[${EXTENSION_NAME}] onGenerationStarted error:`, e);
    }
}

function onStreamTokenReceived(token) {
    if (!state.isStreaming) return;
    // Rough estimate: each stream chunk is roughly one token
    if (token && typeof token === 'string') {
        state.estimatedCompletionTokens += estimateTokensFromText(token);
    } else {
        state.estimatedCompletionTokens += 1;
    }
    updateUI();
}

async function onGenerationEnded(message) {
    try {
        state.isStreaming = false;

        // Get actual usage from API response
        const usage = await extractUsageFromResponse();

        if (usage) {
            // Extract token counts
            if (usage.input_tokens !== undefined) {
                state.promptTokens = usage.input_tokens;
            } else if (usage.prompt_tokens !== undefined) {
                state.promptTokens = usage.prompt_tokens;
            }

            if (usage.output_tokens !== undefined) {
                state.completionTokens = usage.output_tokens;
            } else if (usage.completion_tokens !== undefined) {
                state.completionTokens = usage.completion_tokens;
            }

            // Detect cache
            const cache = detectCacheStatus(usage);
            state.cacheStatus = cache.status;
            state.cacheDetails = cache.details;
        } else {
            // If no API data, use estimated completion
            state.completionTokens = state.estimatedCompletionTokens;
            state.cacheStatus = null;
            state.cacheDetails = '无法获取 API 用量数据';
        }

        updateUI();
    } catch (e) {
        console.debug(`[${EXTENSION_NAME}] onGenerationEnded error:`, e);
        state.isStreaming = false;
        updateUI();
    }
}

function onGenerationStopped() {
    state.isStreaming = false;
    state.completionTokens = state.estimatedCompletionTokens;
    updateUI();
}

// ---- Init ----
async function init() {
    loadSettings();
    createPanel();
    updateUI();
    registerEventListeners();
}

function registerEventListeners() {
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamTokenReceived);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);
}

// ---- Start ----
jQuery(() => {
    init();
});