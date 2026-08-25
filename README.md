# tony-kb

本地文档知识库 + AI agent skill。把 `D:\IPAV` 目录树下的产品/设计/用户手册文档（docx / pdf / doc / txt / md / xlsx）建成可检索的本地知识库，通过 hybrid 检索（BM25 + 哈希向量 + RRF 融合 + 重排序）提供查询服务，并附带 agent skill 统一入口。

零 npm 依赖，仅需 Node.js ≥ 22.5（用到 `node:sqlite` / `node:http`）。

## 目录结构

```
tony-rag/            # 检索服务 + 入库脚本
  src/               # HTTP 服务（health / stats / search / documents）
  scripts/ingest.mjs # 入库脚本
scripts/             # 文本抽取（parse.py / office_convert.ps1），ingest 依赖
skills/tony-skill/   # agent skill（SKILL.md + tony_kb.mjs 客户端）
```

## 使用

```bash
# 入库（扫描 D:/IPAV，增量）
node tony-rag/scripts/ingest.mjs

# 启动服务（默认 127.0.0.1:4174，PORT/HOST/DATABASE_PATH 可用环境变量覆盖）
node tony-rag/src/rag-server.js

# 查询（服务未启动时客户端会自动拉起）
node skills/tony-skill/scripts/tony_kb.mjs health
node skills/tony-skill/scripts/tony_kb.mjs search "IP5100 视频墙 命令" --limit 8
node skills/tony-skill/scripts/tony_kb.mjs product "IP5100"
```

注意：检索语料在服务启动时载入内存，重新入库后需重启服务才能搜到新内容。

## API

- `GET /api/health`
- `GET /api/v1/stats`
- `POST /api/v1/search` `{ "query": "...", "limit": 8 }`
- `GET /api/v1/documents?q=&limit=&offset=`

## 说明

- 数据库文件（`tony-rag/data/tony.sqlite`）不入库，需本地运行 `ingest.mjs` 生成。
- 抽取依赖：pdf 需 `pdftotext` 在 PATH；老格式 doc/xls 走 Windows Office COM（`office_convert.ps1`）。
- 检索逻辑移植自一个 WyreStorm RAG 项目（BM25 + FNV-1a 哈希向量 + RRF），已去除产品目录相关功能。
