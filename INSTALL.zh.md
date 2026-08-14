# DSH Vision Toolkit 安装与排障说明

本文档适用于 dsh-vision-toolkit **0.1.3+**(CannonTang/dsh-vision-toolkit fork,
`feature/auto-image-bridge` 分支)。上游 0.1.2 及更早版本存在已知安装缺陷,请勿直接安装。

## 1. 前提条件

- DeepSeek Harness(DSH)可用,`npx @deepseek-ai/dsh` 能正常启动
- **Python 3.11+**(托管视觉运行时依赖;Windows 需在 PATH 中)
- GitHub 凭据可访问本 fork:`gh auth login` 或已配置的 git 凭据
- 网络可达 npm registry 与 github(偶发 TLS 中断时重试即可)
- 视觉 API 凭据(如 micuapi 的 key)与可用的 provider 配置

## 2. 全新安装(推荐:直接从 fork 安装)

```powershell
# Windows PowerShell 或 macOS zsh 通用
dsh plugin --profile web add github:CannonTang/dsh-vision-toolkit#feature/auto-image-bridge
npx @deepseek-ai/dsh web
```

安装后确认插件版本为 **0.1.3+**(Web 设置页右上角)。

### 本地 checkout 方式(需要改插件源码时用)

```sh
git clone https://github.com/CannonTang/dsh-vision-toolkit.git
cd dsh-vision-toolkit
git checkout feature/auto-image-bridge

# Windows 必须先关闭行尾转换,防止破坏 vendor 快照的完整性校验
git config core.autocrlf false

# 安装插件自身依赖(Windows 用户必做;否则 link 安装后缺 schemastery)
pnpm install --config.auto-install-peers=false

dsh plugin --profile web add "$PWD"   # Windows PowerShell 用 $PWD 同义
```

## 3. 配置

1. 打开 Web 设置页 → 视觉工具面板
2. 确认顶部徽章:**凭据 configured**(绿色)与 **runtime ready**(绿色)
3. 凭据未配置时:在 DSH 凭据管理中写入 `VISION_API_KEY`
4. 填写 provider:`baseUrl`(如 `https://www.micuapi.ai/v1`)、`model`(如 `gpt-5.4-mini`),
   保存后点 **Test connection** 验证连通
5. 「图片自动桥接」默认开启;关闭后粘贴图片会恢复为"模型不支持图片"的原始行为

## 4. 首次启动

首次启动会在 `~/.dsh/cache/dsh-vision-toolkit/` 用 uv 构建隔离 Python 环境
(pillow / numpy / vtracer),期间终端无输出、页面不可用是**正常现象**,设计上限 10 分钟;
构建完成后再次启动只需几十秒。

## 5. 验收清单

1. `GET http://127.0.0.1:3080/_dsh/vision-toolkit/settings` 返回 **JSON**(不是 HTML 首页)
2. 对话中粘贴一张图片并发送:无"当前模型不支持图片"提示,消息带预览发出
3. Agent 收到图片的文字描述并正常回复(不出现 `UNSUPPORTED_CONTENT` 或 403 错误)
4. 追问深入分析时,Agent 可调用 `vision_glance` 等工具按路径查看同一张图

## 6. 已装用户修复指南(装过 0.1.2 或更早版本的机器)

**情况 A:原先是 github/registry 安装(profile 里没有本地 checkout)**

```powershell
dsh plugin --profile web remove @dsh-external/dsh-vision-toolkit
dsh plugin --profile web add github:CannonTang/dsh-vision-toolkit#feature/auto-image-bridge
npx @deepseek-ai/dsh web
```

**情况 B:原先是本地 checkout + file:/link: 安装(曾报"上游资源完整性校验失败")**

```powershell
cd <checkout 目录>
git fetch origin
git checkout feature/auto-image-bridge
git pull
git config core.autocrlf false
# 关键:gitattributes 不会自动改写已检出文件,必须强制重检出
git rm --cached -r --quiet .
git reset --hard
# 验证:应为 913 字节
(Get-Item vendor\agent-vision-toolkit\CHANGELOG.md).Length

dsh plugin --profile web remove @dsh-external/dsh-vision-toolkit
dsh plugin --profile web add github:CannonTang/dsh-vision-toolkit#feature/auto-image-bridge
```

**两类机器共同收尾**

- 删除 profile 插件 lib 目录下的 `*.vt-probe-backup` 探针备份(如有)
- 确认 `profiles/web/package.json` 中 dependencies 只含一条 vision-toolkit,
  `dsh.profile.bundles` 列表包含 `@dsh-external/dsh-vision-toolkit` 且无重复
- 新 profile 需重新写入 `VISION_API_KEY` 凭据与 provider 配置
- 重启后按第 5 节验收清单验证

## 7. 已知坑与注意事项

| 坑 | 状态 |
|---|---|
| 普通名 `schemastery` 在宿主无源可解(宿主只发布 `@deepseek-ai/schemastery` fork) | ✅ 0.1.3 起以 npm alias 依赖随包安装 |
| Windows `core.autocrlf` 把 vendor 快照转 CRLF,破坏完整性校验 | ✅ 仓库 `.gitattributes` 强制 `vendor/** eol=lf`;已检出的 clone 需按第 6 节重检出 |
| micuapi 等 Cloudflare 前置 provider 拦截 Python urllib 默认 User-Agent(403/1010) | ✅ vendored `vision_client.py` 已带浏览器 UA;**执行 `pnpm run upstream:sync` 后需重打该补丁** |
| `@deepseek-ai/dsh-*` peer 范围 `^0.0.1` 匹配不到已发布版本,令 pnpm 解析硬失败 | ✅ 0.1.3 起放宽为 `*` |
| dsh 的 cordis fork 强制 inject 声明(未声明服务访问直接抛错) | ✅ 插件已声明 `llm/attachments/sessions` 等全部依赖 |
| 失败的中途安装可能把 profile 留在半损坏状态(插件部分移除) | 症状:设置页返回 HTML 而非 JSON。修复:remove 后重新 add,并核对 package.json 状态 |
