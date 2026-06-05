# Token & Cache Monitor for SillyTavern

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

在 SillyTavern 对话界面中**实时显示 token 用量和提示词缓存命中状态**的轻量级扩展。

> 这是我第一次编程，也是第一次用 Vibe Coding 把项目推到 GitHub。DeepSeek V4 Pro 经本人实测可用，但缓存命中检测偶尔不稳定——欢迎提 PR 一起打磨。

## 功能

- **实时 Token 计数**：显示每次请求的 Prompt tokens、Completion tokens 和 Total tokens
- **缓存命中检测**：自动检测并显示 Anthropic、OpenAI、DeepSeek API 的缓存命中状态（HIT / PARTIAL / MISS）
- **Streaming 实时估算**：流式生成过程中实时估算输出 token 数
- **浮动面板**：可拖拽、可折叠、可关闭的悬浮面板，不遮挡聊天区域
- **一键复制**：一键复制统计数据到剪贴板
- **一键重置**：清空当前会话统计数据

## 支持的缓存检测

| Provider | 检测方式 | 状态 |
|---|---|---|
| Anthropic Claude | `usage.cache_read_input_tokens` / `cache_creation_input_tokens` | HIT / PARTIAL / MISS |
| OpenAI | `usage.prompt_tokens_details.cached_tokens` | HIT / PARTIAL / MISS |
| DeepSeek | `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` | HIT / PARTIAL / MISS |
| OpenRouter | 暂不支持 | — |
| 其他 | 自动降级 | — |

## 安装

### 方法一：通过 URL 安装（最简单）

1. 打开 SillyTavern，点击顶部栏的 **扩展** 图标（拼图图标）
2. 点击 **安装扩展** 按钮
3. 在弹出的对话框中粘贴仓库 URL：
   ```
   https://github.com/rskzayton/st-token-monitor
   ```
4. （可选）选择安装目标：`为所有用户安装` 或 `仅为我安装`
5. 点击 **安装**，等待克隆完成
6. 在「管理扩展」列表中找到 **Token & Cache Monitor**，点击启用

> 中国用户如 GitHub 连接困难，可使用 Gitee 镜像导入后安装，或通过方法二手动安装。

### 方法二：手动克隆到扩展目录

1. 进入 SillyTavern 的 `data/default/extensions/` 目录
2. 克隆或下载本仓库：
```bash
cd data/default/extensions/
git clone https://github.com/rskzayton/st-token-monitor.git
```
3. 重启 SillyTavern
4. 在扩展菜单中启用 **Token & Cache Monitor**

### 方法三：手动下载

1. 下载本仓库的最新 Release
2. 解压到 `data/default/extensions/st-token-monitor/`
3. 重启 SillyTavern 并在扩展菜单中启用

## 使用方法

### 快速上手

1. 安装启用后，屏幕右下角会出现一个 **Σ** 按钮
2. 点击 **Σ** 展开监控面板
3. 正常开始对话，面板会自动更新每次请求的 token 数据
4. 不需要时点击 `✕` 关闭面板，**Σ** 按钮保留以便随时打开

详细操作：

- **拖拽**：拖拽面板标题栏可移动位置
- **折叠**：点击 `─` 折叠面板，只保留标题栏
- **关闭**：点击 `✕` 关闭面板，点击 **Σ** 按钮重新打开
- **复制**：点击 `📋 复制` 将统计数据复制到剪贴板
- **重置**：点击 `🔄 重置` 清空当前统计

### 面板信息说明

| 图标 | 字段 | 说明 |
|---|---|---|
| 📡 | 模型名称 | 当前使用的模型 ID（如 `claude-sonnet-4-20250514`） |
| 📤 Prompt | 输入 token | 含 system prompt、对话历史、人物卡等所有输入 token |
| 📥 Output | 输出 token | 流式生成中显示实时估算值，完成后显示 API 精确值 |
| 📊 Total | 总计 | Prompt + Output 的总和 |
| 💾 Cache | 缓存状态 | 详见下方缓存状态对照表 |

### 缓存状态对照

| 图标 | 状态 | 含义 | 典型场景 |
|---|---|---|---|
| 🟢 HIT | 全部命中 | 所有 prompt 都命中缓存 | 连续对话未换角色/设定时 |
| 🟡 PARTIAL | 部分命中 | 部分 prompt 命中缓存，部分未命中 | 对话历史超出缓存窗口 |
| 🔴 MISS | 未命中 | 无缓存命中，全量计费 | 首次对话、更换角色、长时间未发送 |
| — | 无数据 | 无法获取缓存信息 | 不支持缓存的 API、非流式模式 |

### 各 Provider 缓存触发条件

| Provider | 缓存触发条件 | 缓存时长 |
|---|---|---|
| Anthropic Claude | 连续对话中重复使用同一 system prompt 和长对话历史 | 约 5 分钟（cache breakpoint 机制） |
| OpenAI | 使用 `cached_prompt` 或自动缓存（取决于模型版本） | 约 5-10 分钟 |
| DeepSeek | 启用 Context Caching 功能，前缀相同时自动命中 | 约 1 小时 |

## 配置

扩展安装后默认启用。如需调整，在 SillyTavern 中打开本扩展的设置面板可配置：

- **显示 Prompt tokens**：开关输入 token 计数显示
- **显示 Completion tokens**：开关输出 token 计数显示
- **显示 Total tokens**：开关总计显示
- **显示 Cache 状态**：开关缓存命中检测显示
- **显示估算值**：完成后是否同时显示粗略估算值（与精确值对比）
- **面板位置**：预设位置（`top-left` / `top-right` / `bottom-left` / `bottom-right`）

## 常见问题

### 面板不显示任何数据？

1. 确认扩展已在 SillyTavern 扩展菜单中启用
2. 发送一条对话消息触发 API 请求
3. 检查 ST 版本是否 >= 1.12.0（需要 `generateRawData()` 支持）

### 缓存始终显示 MISS？

- 确认你的 API Provider 和模型版本支持 prompt caching
- Anthropic：连续发送消息，每次保持大部分 prompt 不变，缓存约需 1-2 次请求后才会命中
- DeepSeek：需在 API 请求中显式启用 Context Caching
- 流式模式下缓存检测依赖 `generateRawData()`，确认 ST 版本支持

### 显示的 token 数和实际费用不一致？

- Output token 在生成中为估算值（约 3 字/token for 英文，1.5 字/token for 中文）
- 生成完成后会替换为 API 返回的精确值
- Prompt token 在生成前计数，生成后可能被 API 精确值覆盖

### DeepSeek 缓存始终显示 MISS？

DeepSeek 的 Context Caching 与 Anthropic 的自动缓存机制不同：

1. **首次请求必然 MISS**——缓存需要有前缀匹配的历史请求才能命中
2. **同角色连续对话**——保持同一角色、同一 system prompt，连续发送 2-3 条消息后缓存才会建立
3. **缓存有时效**——DeepSeek 缓存有效期约 1 小时，超时后自动失效
4. **确保模型支持**——DeepSeek V3/R1/V4 Pro 支持 Context Caching，旧模型可能不支持

**实测验证**：用同一角色连续对话，观察第二次及后续请求的 `prompt_cache_hit_tokens` 是否 > 0。如果始终为 0，检查 SillyTavern 的 DeepSeek API 适配器是否正确传递了缓存相关参数。

### 面板拖不动或位置跑偏？

- 刷新页面后面板会回到预设位置
- 拖拽过程中不要松开鼠标，直到放到目标位置
- 触摸屏设备同样支持拖拽

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
- **DeepSeek**: 读取 `usage.prompt_cache_hit_tokens` 和 `usage.prompt_cache_miss_tokens`

## 兼容性

- SillyTavern 版本: >= 1.12.0（需要 `generateRawData()` 支持）
- 浏览器: Chrome / Firefox / Edge 最新版本
- API 后端: Anthropic Claude API、OpenAI API、DeepSeek API、兼容 OpenAI 格式的 API

## 开发

```bash
# 克隆仓库
gh repo clone rskzayton/st-token-monitor

# 直接在 data/default/extensions/ 下开发，修改后重启 ST 即可
```

## 许可证

MIT
