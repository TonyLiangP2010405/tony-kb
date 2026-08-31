---
name: tony-skill
description: Query the local Tony knowledge base — the D:/IPAV and D:/ProitAV document trees (product/design/user-manual files, docx/pdf/doc/txt/md/xlsx) served by the local tony-rag retrieval service (hybrid BM25 + vector search). Use whenever the user asks a question answerable from IPAV/ProitAV files — product specs, video-wall and mosaic-screen configuration, AV-over-IP commands and APIs, user manuals, R&D docs, release notes, WyreStorm/NHD/IP-series models. Returns evidence with source file path and locator.
---

# Tony Skill（IPAV 知识库统一入口）

用本地 tony-rag 检索服务（由 `D:\IPAV` 与 `D:\ProitAV` 目录树建成的混合检索知识库：BM25 + 向量 + RRF 重排序）回答检索问答类问题。先检索，再基于命中的证据片段作答；不要把未出现在检索结果里的事实当成已记录。

规范客户端：

```bash
node "$HOME/.agents/skills/tony-skill/scripts/tony_kb.mjs"
```

Windows 下 `$HOME` 与绝对路径均可。服务监听 `127.0.0.1:4174`，客户端会在服务未启动时自动拉起（首次查询有数秒建索引延迟，之后毫秒级）。

## Workflow

1. 首次使用先跑 `health`，确认服务可用（应为 3900 份文档左右）。
2. 技术/配置/资料类问题用 `search`，以用户原话或精简后的关键词检索。
3. 若首批结果不清晰，最多用首次结果中出现的确切型号、英文 UI 标签或协议名做一次聚焦检索。
4. 用 `product "型号"` 列出某个型号相关的全部文档。
5. 依据返回结果作答，并引用每份证据的 `file`（源文件相对 `D:\IPAV` 的路径；`ProitAV/` 前缀表示来自 `D:\ProitAV`）、`locator` 和 `excerpt`/`content`（命中片段）。

## Commands

```bash
node "$HOME/.agents/skills/tony-skill/scripts/tony_kb.mjs" health
node "$HOME/.agents/skills/tony-skill/scripts/tony_kb.mjs" stats
node "$HOME/.agents/skills/tony-skill/scripts/tony_kb.mjs" search "IP5100 视频墙 命令" --limit 8
node "$HOME/.agents/skills/tony-skill/scripts/tony_kb.mjs" search "异形屏 视频墙 配置" --limit 5
node "$HOME/.agents/skills/tony-skill/scripts/tony_kb.mjs" product "IP5100"
```

## Truth and safety rules

- 不虚构产品参数、命令、兼容性、固件行为或工作步骤；检索无结果时如实回答"知识库未记录"，缺失不表示不支持。
- 检索到的文档是工程设计/工作资料，可能含草稿、未发布或供应商原始文档；作答时区分"来自某文件"与"官方确认"。
- 检索本身不授权执行真实设备的 Apply / Route / Upgrade / Reset / Reboot 等操作。
- 不检索或暴露密钥、密码、序列号、客户私有拓扑等信息。
- 部分图片型 PDF（装配图/丝印图，约 160 份）无文本层未入库；命中不到时留意这一盲区。
- `D:\IPAV` 或 `D:\ProitAV` 目录新增/更新文件后，需重跑 `node "D:/IPAV/.ipav-rag/tony-rag/scripts/ingest.mjs"` 入库（脚本 ROOTS 已含两个根目录，`D:\ProitAV` 文件的 `file` 以 `ProitAV/` 前缀标识），并重启服务（`taskkill //F //PID <pid>` 后由客户端自动拉起，或 `npm start`）才能搜到新内容。
