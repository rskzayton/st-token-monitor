# Token & Cache Monitor for SillyTavern

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

在 SillyTavern 对话界面中**实时显示 token 用量和提示词缓存命中状态**的轻量级扩展。

## 功能

- **实时 Token 计数**：显示每次请求的 Prompt tokens、Completion tokens 和 Total tokens
- **缓存命中检测**：自动检测并显示 Anthropic 和 OpenAI API 的缓存命中状态（HIT / PARTIAL / MISS）
- **Streaming 实时估算**：流式生成过程中实时估算输出 token 数
- **浮动面板**：可拖拽、可折叠、可关闭的悬浮面板，不遮挡聊天区域
- **一键复制**：一键复制统计数据到剪贴板
- **一键重置**：清空当前会话统计数据

## 支持的缓存检测

| Provider | 检测方式 | 状态 |
|---|---|---|
| Anthropic Claude | `usage.cache_read_input_tokens` / `cache_creation_input_tokens` | HIT / PARTIAL / MISS |
| OpenAI | `usage.prompt_tokens_details.cached_tokens` | HIT / PARTIAL / MISS |
| OpenRouter | 暂不支持 | — |
| 其他 | 自动降级 | — |

## 安装

### 方法一：通过扩展目录安装（推荐）

1. 进入 SillyTavern 的 `data/default/extensions/` 目录
2. 克隆或下载本仓库：
```bash
cd data/default/extensions/
git clone https://github.com/cherrystudio-community/st-token-monitor.git
```
3. 重启 SillyTavern
4. 在扩展菜单中启用 **Token & Cache Monitor**

### 方法二：手动安装

1. 下载本仓库的最新 Release
2. 解压到 `data/default/extensions/st-token-monitor/`
3. 重启 SillyTavern 并在扩展菜单中启用

## 使用方法

安装启用后，屏幕右下角会出现一个 **Σ** 按钮，点击即可展开监控面板。

- **拖拽**：拖拽面板标题栏可移动位置
- **折叠**：点击 `─` 折叠面板，只保留标题栏
- **关闭**：点击 `✕` 关闭面板，点击 **Σ** 按钮重新打开
- **复制**：点击 `📋 复制` 将统计数据复制到剪贴板
- **重置**：点击 `🔄 重置` 清空当前统计

### 面板信息说明

- `📡` — 当前使用的模型名称
- `📤 Prompt` — 输入 token 数（含 system prompt、对话历史、人物卡等）
- `📥 Output` — 输出 token 数。流式生成中显示实时估算值，生成完成后显示 API 返回的精确值
- `📊 Total` — 输入 + 输出总和
- `💾 Cache` — 缓存命中状态
  - `🟢 HIT` — 全部命中
  - `🟡 PARTIAL` — 部分命中
  - `🔴 MISS` — 未命中
- `⏳ 生成中...` / `✅ 就绪` — 当前状态

## 文件结构

```
st-token-monitor/
├── manifest.json    # 扩展元数据
├── index.js         # 主逻辑（事件监听、token 计数、缓存检测、UI）
├── style.css        # 面板样式
└── README.md        # 本文件
```

## 工作原理

### Token 计数

1. **GENERATION_STARTED** 事件触发时：
   - 获取当前对话的完整 prompt 文本
   - 调用 `getTokenCountAsync()` 进行精确计数
   - 若失败则使用 CJK-aware 启发式估算

2. **STREAM_TOKEN_RECEIVED** 事件触发时：
   - 每收到一个流式 chunk，累加估算的 token 数
   - 实时更新 UI

3. **GENERATION_ENDED** 事件触发时：
   - 通过 `generateRawData()` 或 `main_api.lastResponse` 获取 API 返回的精确用量数据
   - 用精确值覆盖估算值

### 缓存检测

- **Anthropic**: 读取 `usage.cache_read_input_tokens` 和 `usage.cache_creation_input_tokens`
- **OpenAI**: 读取 `usage.prompt_tokens_details.cached_tokens`

## 兼容性

- SillyTavern 版本: >= 1.12.0（需要 `generateRawData()` 支持）
- 浏览器: Chrome / Firefox / Edge 最新版本
- API 后端: Anthropic Claude API、OpenAI API、兼容 OpenAI 格式的 API

## 开发

```bash
# 克隆仓库
gh repo clone cherrystudio-community/st-token-monitor

# 直接在 data/default/extensions/ 下开发，修改后重启 ST 即可
```

## 许可证

MIT
