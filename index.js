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
    cacheStatus: null,               // 'HIT' | 'MISS' | 'PARTIAL' | null
    cacheDetails: null,              // detailed info (cached_tokens, etc.)
    cacheHitTokens: 0,               // 缓存命中的 token 数
    lastCost: null,                  // {total, hitCost, missCost, outputCost, savings}
    sessionCost: 0,                  // 会话累计费用 (¥)
    modelName: null,
    isStreaming: false,
    startTime: null,
    lastPrompt: null,
    _safetyTimer: null,              // 防止「一直显示生成中」的安全超时
    // rikkahub-style 多轮工具调用累加
    roundNumber: 0,                  // 当前是第几轮 generation
    basePromptTokens: 0,             // 第1轮的 prompt tokens（不累加重入）
    accumulatedCompletionTokens: 0,  // 跨轮累计 completion tokens
    toolCallAccumulating: false,     // 是否在工具调用多轮累加中
    _finalizeTimer: null,            // 多轮结束检测定时器
    // 响应头缓存检测兜底
    _lastBillingHeader: null,        // x-anthropic-billing-header 缓存值
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

// CodeWhale-style 中文紧凑格式（参考 CodeWhale format_token_count_compact）
function formatCompact(n) {
    if (n >= 1_0000_0000) return (n / 1_0000_0000).toFixed(1) + '亿';
    if (n >= 1_0000) return (n / 1_0000).toFixed(1) + '万';
    if (n >= 1000) return formatNumber(n);
    return String(n);
}

// ---- Pricing (人民币 ¥/百万 tokens, 参考 CodeWhale + DeepSeek 官方) ----
const PRICING = {
    'deepseek-v4-pro':   { hit: 0.026, miss: 3.13, output: 6.26 },
    'deepseek-v4-flash': { hit: 0.020, miss: 1.01, output: 2.02 },
    'deepseek-v3':       { hit: 0.1,   miss: 1.0,  output: 2.0  },
    'deepseek-r1':       { hit: 1.0,   miss: 4.0,  output: 16.0 },
    'claude-sonnet-4':   { hit: 1.09,  miss: 10.9, output: 54.5 },
    'claude-sonnet-4-5': { hit: 1.09,  miss: 10.9, output: 54.5 },
    'claude-haiku-4-5':  { hit: 0.073, miss: 0.73, output: 3.64 },
    'gpt-4o':            { hit: 1.82,  miss: 18.2, output: 72.7 },
    'gpt-4o-mini':       { hit: 0.073, miss: 0.73, output: 3.64 },
};

function findPricing(modelName) {
    if (!modelName) return null;
    for (const [key, price] of Object.entries(PRICING)) {
        if (modelName.toLowerCase().includes(key.toLowerCase())) return price;
    }
    return null;
}

function calculateCost(modelName, promptTokens, completionTokens, cacheHitTokens) {
    const price = findPricing(modelName);
    if (!price) return null;

    const hitTokens = cacheHitTokens || 0;
    const missTokens = promptTokens - hitTokens;

    const hitCost = (hitTokens / 1_000_000) * price.hit;
    const missCost = (missTokens / 1_000_000) * price.miss;
    const outputCost = (completionTokens / 1_000_000) * price.output;

    return {
        total: hitCost + missCost + outputCost,
        hitCost,
        missCost,
        outputCost,
        savings: (hitTokens / 1_000_000) * (price.miss - price.hit),  // 缓存节省的金额
    };
}

function formatCost(cost) {
    if (cost === null || cost === undefined) return null;
    if (cost >= 1) return `¥${cost.toFixed(2)}`;
    if (cost >= 0.01) return `¥${cost.toFixed(3)}`;
    return `¥${cost.toFixed(5)}`;
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

    // --- DeepSeek-style (Context Caching) ---
    if (usage.prompt_cache_hit_tokens !== undefined || usage.prompt_cache_miss_tokens !== undefined) {
        const hit = usage.prompt_cache_hit_tokens || 0;
        const miss = usage.prompt_cache_miss_tokens || 0;
        const prompt = usage.prompt_tokens || (hit + miss);

        if (hit > 0 && miss > 0) {
            const pct = ((hit / (hit + miss || 1)) * 100).toFixed(0);
            return {
                status: 'PARTIAL',
                details: `命中 ${formatNumber(hit)} · 未命中 ${formatNumber(miss)} (${pct}%)`,
            };
        }
        if (hit > 0) {
            return {
                status: 'HIT',
                details: `${formatNumber(hit)} / ${formatNumber(prompt)} tokens 缓存命中`,
            };
        }
        return {
            status: 'MISS',
            details: `全部未命中 (${formatNumber(miss)} tokens) · 首次请求或缓存已过期，后续同前缀请求将命中`,
        };
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
            <div id="${PANEL_ID}_cost" style="display:none;margin-top:4px;"></div>
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

    // Prompt tokens — 格式: "总tokens(缓存命中tokens)"
    if (s.showPromptTokens && state.promptTokens > 0) {
        if (state.cacheHitTokens > 0) {
            promptEl.textContent = `📤 Prompt: ${formatNumber(state.promptTokens)} tokens (${formatNumber(state.cacheHitTokens)} 缓存命中)`;
        } else {
            promptEl.textContent = `📤 Prompt: ${formatNumber(state.promptTokens)} tokens`;
        }
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

    // Cost (CodeWhale-style 人民币计价)
    const costEl = document.getElementById(`${PANEL_ID}_cost`);
    if (costEl && state.lastCost) {
        let costText = `💰 本次: ${formatCost(state.lastCost.total)}`;
        if (state.lastCost.savings > 0.0001) {
            costText += ` · 缓存节省 ${formatCost(state.lastCost.savings)}`;
        }
        if (state.sessionCost > 0) {
            costText += ` · 累计 ${formatCost(state.sessionCost)}`;
        }
        costEl.textContent = costText;
        costEl.style.display = 'block';
        costEl.style.color = state.lastCost.savings > 0.0001
            ? (state.lastCost.savings > state.lastCost.total * 0.5 ? '#4ade80' : 'inherit')
            : 'inherit';
    } else if (costEl) {
        costEl.style.display = 'none';
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
    if (state.toolCallAccumulating && !state.isStreaming) {
        statusEl.textContent = `⚙️ 含工具调用 (${state.roundNumber}轮) · 总计 ${formatNumber(state.accumulatedCompletionTokens)} tokens`;
        statusEl.style.opacity = '0.7';
    } else if (state.isStreaming) {
        statusEl.textContent = state.roundNumber >= 2
            ? `⏳ 生成中 (第${state.roundNumber}轮工具调用)...`
            : '⏳ 生成中...';
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
    if (state.lastCost) {
        lines.push(`Cost: ${formatCost(state.lastCost.total)}`);
        if (state.lastCost.savings > 0.0001) {
            lines.push(`Cache savings: ${formatCost(state.lastCost.savings)}`);
        }
        if (state.sessionCost > 0) {
            lines.push(`Session cost: ${formatCost(state.sessionCost)}`);
        }
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
    state.cacheHitTokens = 0;
    state.lastCost = null;
    state.sessionCost = 0;
    state.modelName = null;
    state.isStreaming = false;
    state.startTime = null;
    state.lastPrompt = null;
    state.roundNumber = 0;
    state.basePromptTokens = 0;
    state.accumulatedCompletionTokens = 0;
    state.toolCallAccumulating = false;
    state._lastBillingHeader = null;
    if (state._finalizeTimer) { clearTimeout(state._finalizeTimer); state._finalizeTimer = null; }
    updateUI();
}

// ---- Event Handlers ----

async function onGenerationStarted() {
    try {
        const context = getContext();

        // rikkahub-style: 新轮次开始，取消上一轮的结束定时器
        if (state._finalizeTimer) { clearTimeout(state._finalizeTimer); state._finalizeTimer = null; }

        state.roundNumber++;
        state.startTime = Date.now();
        state.isStreaming = true;
        state.estimatedCompletionTokens = 0;
        state.cacheStatus = null;
        state.cacheDetails = null;
        state.cacheHitTokens = 0;

        // 第2轮起标记为工具调用多轮累加
        if (state.roundNumber >= 2) {
            state.toolCallAccumulating = true;
        }

        // 安全超时：如果 GENERATION_ENDED 在 3 分钟内未触发，自动复位
        if (state._safetyTimer) clearTimeout(state._safetyTimer);
        state._safetyTimer = setTimeout(() => {
            if (state.isStreaming) {
                console.debug(`[${EXTENSION_NAME}] safety timeout: force reset`);
                state.isStreaming = false;
                if (state.estimatedCompletionTokens > 0) {
                    // 累加到总计数
                    state.accumulatedCompletionTokens += state.estimatedCompletionTokens;
                    state.completionTokens = state.accumulatedCompletionTokens;
                }
                updateUI();
            }
        }, 3 * 60 * 1000);

        // Get model info
        try {
            const model = getGeneratingModel();
            state.modelName = model?.label || model?.id || model || null;
        } catch {
            // ignore
        }

        // Count prompt tokens — 仅第 1 轮（工具调用后续轮次是追加内容，不计入 base）
        if (state.roundNumber === 1) {
            try {
                let promptText = '';
                if (typeof context.getPrompt === 'function') {
                    promptText = await context.getPrompt();
                }
                if (!promptText && context.chat) {
                    promptText = context.chat.map(m => (m.name || '') + ': ' + (m.mes || '')).join('\n');
                }
                if (promptText) {
                    state.lastPrompt = promptText;
                    state.promptTokens = await getTokenCountAsync(promptText) || estimateTokensFromText(promptText);
                    state.basePromptTokens = state.promptTokens;
                }
            } catch {
                if (context.chat) {
                    const text = context.chat.map(m => (m.mes || '')).join('');
                    state.promptTokens = estimateTokensFromText(text);
                    state.basePromptTokens = state.promptTokens;
                }
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
        if (state._safetyTimer) { clearTimeout(state._safetyTimer); state._safetyTimer = null; }

        // Get actual usage from API response
        const usage = await extractUsageFromResponse();

        if (usage) {
            // 本轮的 completion tokens
            const roundCompletion = usage.output_tokens !== undefined
                ? usage.output_tokens
                : usage.completion_tokens || 0;

            // rikkahub-style: 跨轮累计 completion tokens
            state.accumulatedCompletionTokens += roundCompletion;
            state.completionTokens = state.accumulatedCompletionTokens;

            // 第1轮保存 base prompt，后续轮不覆盖
            if (state.roundNumber === 1) {
                const promptCount = usage.input_tokens !== undefined
                    ? usage.input_tokens
                    : usage.prompt_tokens || state.promptTokens;
                state.promptTokens = promptCount;
                state.basePromptTokens = promptCount;
            }

            // 缓存检测 — 尝试兜底（响应体 + 响应头 billing header）
            let cache = detectCacheStatus(usage);

            // Claude 流式响应兜底：如果响应体没有缓存数据，检查 billing header
            if (!cache.status || cache.status === 'MISS') {
                const billing = state._lastBillingHeader || window.__st_tm_billing_header;
                if (billing && typeof billing === 'string') {
                    const cchMatch = billing.match(/cch=([^;]+)/);
                    if (cchMatch && cchMatch[1] !== '00000') {
                        // billing header 指示了缓存活动，但响应体没体现
                        // 说明是流式 SSE 缺失缓存 tokens —— 从响应体补充
                        if (!usage.cache_read_input_tokens && !usage.prompt_cache_hit_tokens) {
                            cache.status = cache.status === 'MISS' ? 'PARTIAL' : cache.status;
                            if (!cache.details) {
                                const total = usage.input_tokens || usage.prompt_tokens || 0;
                                cache.details = `检测到缓存活动 (header) · ${total} tokens prompt`;
                            }
                        }
                    }
                }
            }

            state.cacheStatus = cache.status;
            state.cacheDetails = cache.details;

            // 提取缓存命中 token 数（用于 Prompt 显示格式）
            state.cacheHitTokens =
                usage.cache_read_input_tokens
                || usage.prompt_cache_hit_tokens
                || (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)
                || 0;

            // CodeWhale-style 人民币计价 + 缓存节省计算
            const cost = calculateCost(
                state.modelName,
                state.promptTokens,
                state.completionTokens,
                state.cacheHitTokens
            );
            state.lastCost = cost;
            if (cost) state.sessionCost += cost.total;

            // 持久化 billing header（供后续请求比较）
            if (window.__st_tm_billing_header) {
                state._lastBillingHeader = window.__st_tm_billing_header;
            }
        } else {
            // 无法获取 API 数据，使用估算值累加
            state.accumulatedCompletionTokens += state.estimatedCompletionTokens;
            state.completionTokens = state.accumulatedCompletionTokens;
            state.cacheStatus = null;
            state.cacheDetails = '无法获取 API 用量数据';
        }

        // rikkahub-style: 多轮检测 — 3秒内无新轮次则视为结束
        if (state._finalizeTimer) clearTimeout(state._finalizeTimer);
        state._finalizeTimer = setTimeout(() => {
            state.toolCallAccumulating = false;
            state.roundNumber = 0;
            state.completionTokens = state.accumulatedCompletionTokens;
            state.promptTokens = state.basePromptTokens;
            updateUI();
        }, 3000);

        updateUI();
    } catch (e) {
        console.debug(`[${EXTENSION_NAME}] onGenerationEnded error:`, e);
        state.isStreaming = false;
        updateUI();
    }
}

function onGenerationStopped() {
    state.isStreaming = false;
    if (state._safetyTimer) { clearTimeout(state._safetyTimer); state._safetyTimer = null; }
    // 用户手动停止：累加当前轮的估算值
    state.accumulatedCompletionTokens += state.estimatedCompletionTokens;
    state.completionTokens = state.accumulatedCompletionTokens;
    updateUI();
}

// ---- Init ----
async function init() {
    loadSettings();
    createPanel();
    installFetchInterceptor();
    updateUI();
    registerEventListeners();
}

// rikkahub-style: 拦截 fetch 捕获 Anthropic billing header 作为缓存检测兜底
function installFetchInterceptor() {
    if (window.__st_tm_fetch_patched) return;
    window.__st_tm_fetch_patched = true;

    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
        return originalFetch.call(window, input, init).then((response) => {
            try {
                const billing = response.headers.get('x-anthropic-billing-header');
                if (billing) {
                    window.__st_tm_billing_header = billing;
                }
            } catch {
                // best-effort
            }
            return response;
        });
    };
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