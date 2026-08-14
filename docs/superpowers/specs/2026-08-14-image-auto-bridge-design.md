# 图片自动桥接(Image Auto-Bridge)设计文档

日期:2026-08-14
状态:已确认,待实现
分支:`feature/auto-image-bridge`
Fork:CannonTang/dsh-vision-toolkit(自 Anionex/dsh-vision-toolkit)

## 背景与目标

DSH 的对话模型是纯文本模型。用户在 Web 对话中粘贴图片会被服务端拒绝
(`MODEL_DOES_NOT_SUPPORT_IMAGES`),提示"当前对话模型不支持图片"。

本功能让用户**直接在对话中粘贴图片**,系统自动把图片转发给视觉子模型
(provider 配置的视觉 API)生成文字描述,注入会话上下文;纯文本 Agent 读到
描述即可"看见"图片。Agent 需要深入分析时,仍可调用现有的 10 个视觉工具
(`vision_glance`、`vision_pixel_diff` 等)。

## 宿主机制调研结论(实现依据)

以下结论来自对宿主(npx 缓存内 dsh 0.1.0-rc.6)源码的勘察,实现时如有出入以实测为准:

1. **客户端已完整支持图片粘贴**:格式(PNG/JPG/WebP/GIF)、大小、分辨率校验齐备
   (`dsh-client-ui-conversation`)。无需改客户端。
2. **拒绝关卡在服务端** `dsh-host-apiproxy/lib/index.js`(约 2839-2849 行):
   `llm.resolveModelInfo(provider, model)` 返回的 `inputModalities` 不含 `"image"` 即拒绝。
   deepseek 适配器硬编码 `inputModalities: ["text"]`(`dsh-llm-deepseek/lib/index.js:442`)。
3. **附件管线完备**:`ctx.attachments`(`@deepseek-ai/dsh-attachment`)提供
   `saveImage` / `readImage` / `validateImage`(内容寻址、验证后持久化)。
4. **`llm/stream` 瀑布不可用于改写**:文档明确 agent 循环构建的请求是深冻结的,
   "listeners read it, never rewrite it"(会话日志可重建性不变量)。**本设计不触碰 LLM 层改写。**
5. **会话是事件源式的 append-only 日志**(`@deepseek-ai/dsh-session`):
   `session.append(type, data, surfaceIntent)` 支持带 `sourceEventSeqs` 的**派生事件**,
   日志是唯一真相源,agent 循环的 LLM 请求是日志的纯函数。**本设计在日志层追加派生事件。**
6. **cordis fork 支持拦截机制**:`Context[symbols.intercept]` 存在
   (`@deepseek-ai/cordis` types/context.d.ts),可实现服务方法拦截。
   实现期验证对 `llm/resolveModelInfo` 的精确拦截写法。

## 架构与数据流

```
用户粘贴图片 → 客户端(无需改动,已有校验)
    ↓
服务端关卡(apiproxy 检查 inputModalities)→ 桥接插件放行(见"关卡放行")
    ↓
图片字节经 ctx.attachments 持久化(宿主已有机制)
    ↓
桥接服务监听会话事件 → 对每张图调用视觉 API(复用 provider 配置与凭据)
    ↓
生成文字描述,作为派生事件追加进会话日志(带 sourceEventSeqs 关联原消息)
    ↓
Agent 循环照常从日志构建 LLM 请求 → 纯文本模型读到描述
    ↓
Agent 需要深入时,仍可调用 10 个视觉工具(描述中附带图片引用/路径)
```

设计原则:

1. **不改宿主、不改客户端**,全部以 dsh-vision-toolkit 内的新模块实现。
2. **尊重日志完整性不变量**:原始图片事件留在日志,描述是引用它的派生事件;LLM 层零改写。
3. **模型看到的永远是纯文本**(描述 + 引用),deepseek 适配器无需图片能力。
4. **失败即降级**:视觉 API 失败时派生事件写占位文本,对话不中断。

## 组件划分

| 组件 | 位置 | 职责 |
|---|---|---|
| auto-bridge 服务 | `lib/auto-bridge.js`(新) | 监听带图片引用的用户消息事件 → 逐图调视觉 API → 追加派生事件 |
| 关卡放行 | `lib/auto-bridge.js` 内或独立小模块 | 拦截 `llm/resolveModelInfo`,仅在桥接启用时为当前 provider/model 注入图片模态;fallback:apiproxy 入口内容预转换 |
| 视觉 API 共用函数 | 从 `lib/tools.js` 的 `vision_glance` 提取(如 `analyzeImage()`) | 桥接与 10 个工具共用同一份 HTTP 请求/凭据解析/错误分类实现 |
| 配置扩展 | `lib/config.js` + `lib/client.js` | 新增 `autoBridge` 组:`enabled`(默认开启)、`maxImagesPerMessage`;Settings 面板加开关 |
| 派生事件格式 | 跟随宿主会话事件词汇表 | 文本描述 + 每张图的持久化引用,`sourceEventSeqs` 关联原消息 |

接口边界:

- `tools.js` 只做提取共用函数的小重构,10 个工具的 schema 与行为不变。
- 桥接任何异常绝不阻断消息发送(降级为占位文本)。
- Settings 关闭桥接后行为完全回到现状(关卡照旧拒绝图片)。
- 模态拦截只在桥接启用时注册,注销后无残留;只影响目标 provider/model。

## 错误处理

| 失败 | 行为 |
|---|---|
| 视觉 API 超时/限流/鉴权/网络错误 | 派生事件写"图片自动分析失败(原因)"占位文本,消息照常 |
| 图片超限(字节/像素) | 同上,原因注明 |
| 附件读取失败 | 同上 |
| 桥接自身异常 | 记录日志,不阻断消息;绝不吞掉会话事件 |

## 测试与验收

1. **单元测试**(仓库现有 vitest 基建):`autoBridge` 配置解析与默认值;派生事件构造与
   `sourceEventSeqs` 关联;视觉 API 失败分类 → 占位文本映射。
2. **集成测试**(mock 视觉 API):粘贴图片 → 会话日志出现派生描述事件;API 失败 → 降级
   文本且消息照常;桥接关闭 → 恢复关卡拒绝;模态拦截只影响目标模型。
3. **手动验收**(真实环境):`dsh web` 启动 → 粘贴图片 → 消息带预览正常发出、Agent 收到
   描述 → Agent 可继续调 `vision_pixel_diff` 深入;Settings 开关即时生效。
4. **回归**:本仓库 vitest 全绿;10 个视觉工具行为不变。
   (README 说明完整测试需在 harness 源码树内运行;本 checkout 独立跑 vitest 作为底线。)

## 交付流程(fork 规划)

1. 实现开始前:`gh repo fork Anionex/dsh-vision-toolkit` → CannonTang/dsh-vision-toolkit。
2. 在本地分支 `feature/auto-image-bridge` 开发并推送到 fork。
3. 完成后 commit 并推送:功能代码与本设计文档一起提交;**不含** `pnpm-lock.yaml`
   (本地环境修复产生的未跟踪文件,不属于功能变更)。
4. 默认不向上游提 PR;如需提 PR 由用户决定。

## 实现期需验证的关键点(已逐一勘察,结论如下)

- [x] **`ctx.intercept` 不支持方法拦截**(此 fork 中 intercept 只做 service config 合并)。改用运行时补丁 `llm.resolveModelInfo` 注入图片模态;proxy 可写性由 Task 1 spike 验证,不可写则退回原型链补丁
- [x] **图片原消息的模型历史投影**:deepseek 适配器对图片块是**显式拒绝**(`assertTextOnly` 抛 `UNSUPPORTED_CONTENT`),不是静默丢弃。因此必须用 surface 替换:桥接追加带 `{op:'replace',start,end}` 意图的 `user/message` 事件(纯文本版),原事件保留在日志、仅模型历史被遮蔽——宿主明确支持该机制(compaction 同款,"replacement copies stay model-only")
- [x] 事件词汇表:`user/message`(数据即 dsh-llm `UserMessage`,`content` 为 `ContentBlock[]`,`image` 块为 `{type:'image', attachment: ImageAttachmentRef}`);`Session.append(type, data, SurfaceIntent)`;监听 `ctx.on('session/event', (session, event) => ...)`
- [x] 图片载荷:`session.prompt` RPC 的 `content` 中图片块为内联 base64(`{type:'image', data, mediaType, name?}`),由 `durablePromptContent` 经 `ctx.attachments.saveImage` 落库为引用块;关卡检查在其之前
- [x] **RPC 拦截不可用于协作插件**:`dsh-client-connection` 每个 channel 只保留一个拦截器(Map 按 channel 键),注册即接管整个 `/api`,需自行转发全部端点——放弃该路线
- [x] 视觉分析复用:`vision_glance` 最终走 `VisionToolkitRuntime.glance({images: [path]})`(上游 Python CLI);桥接将附件字节写入临时文件后调用同一 `glance`,返回 `{answer, ...}` 结构
- [x] 每张图分析与并发:串行逐图,受 `autoBridge.maxImagesPerMessage` 限制,超出部分附注说明
- [x] **Task 1 spike 结论(surface replace)**:宿主真实 `dsh-session` 上 `user/message` 替换事件(`{op:'replace',start:0,end:0}`)确实遮蔽模型历史——替换后 `deriveMessages()` 只返回桥接纯文本版消息,原图片块不再进入模型历史
- [x] **Task 1 spike 结论(模态补丁)**:cordis proxy 实例属性可直接赋值,`ctx.llm.resolveModelInfo = ...` 方式生效(`instance-patch=true`),无需原型链补丁;投影方法确切名为 `Session.deriveMessages()`(无参,返回 `Message[]`)
