#!/usr/bin/env node
/**
 * tony-rag 入库脚本
 * 流程：扫描 D:/IPAV 文本类文件 -> 分派解析（parse.py / Office COM 缓存+补跑）
 *      -> 切块 -> embedText 向量 -> 写入 tony.sqlite 的 file_knowledge_* 三表
 *
 * 增量策略：content_hash = sha256(路径+mtime+size)，未变化文件跳过（不重新抽取），
 * 变化文件删除旧行重插，已删除文件对应行级联删除。
 *
 * 用法：
 *   node scripts/ingest.mjs            # 全量增量入库
 *   node scripts/ingest.mjs --limit N  # 只处理前 N 个待抽取文件（验证管线用）
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { db, initializeDatabase } from '../src/shared/database/database.js';
import { embedText, vectorToBuffer } from '../src/features/search/vector.js';

const ROOT = 'D:/IPAV';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.join(__dirname, '..', 'tmp');
const LEGACY_TMP_DIR = path.resolve(__dirname, '..', '..', 'tmp');
const OFFICE_CACHE = path.join(LEGACY_TMP_DIR, 'office_result.jsonl');
const PARSE_PY = path.resolve(__dirname, '..', '..', 'scripts', 'parse.py');
const OFFICE_PS1 = path.resolve(__dirname, '..', '..', 'scripts', 'office_convert.ps1');

const TEXT_EXTS = new Set(['.docx', '.pdf', '.doc', '.txt', '.md', '.xlsx', '.xls', '.csv', '.tsv']);
const PYTHON_EXTS = new Set(['.docx', '.pdf', '.txt', '.md', '.xlsx', '.csv', '.tsv']);
const OFFICE_EXTS = new Set(['.doc', '.xls']);
const EXCLUDE_DIRS = new Set(['.ipav-rag', '.git', 'node_modules']);

fs.mkdirSync(TMP_DIR, { recursive: true });

// ---------- 扫描 ----------
function collectFiles() {
  const files = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('$') || e.name.startsWith('~')) continue; // Office 临时文件
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        if (TEXT_EXTS.has(path.extname(e.name).toLowerCase())) files.push(full);
      }
    }
  }
  walk(ROOT);
  return files.sort();
}

function relPath(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function contentHash(rel, stat) {
  return crypto.createHash('sha256').update(`${rel}${stat.mtimeMs}:${stat.size}`).digest('hex');
}

function docPublicId(rel) {
  return `doc-${crypto.createHash('sha256').update(rel).digest('hex').slice(0, 24)}`;
}

// ---------- 切块（策略与旧 ingest.mjs 一致） ----------
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;

function chunkText(text) {
  if (!text) return [];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > start + CHUNK_SIZE * 0.6) end = nl;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks.filter((c) => c.length >= 20);
}

// ---------- 解析分派 ----------
function runPythonParse(files) {
  if (!files.length) return new Map();
  const listFile = path.join(TMP_DIR, 'py_list.txt');
  fs.writeFileSync(listFile, files.join('\n'), 'utf8');
  const result = new Map();
  const r = spawnSync('python', [PARSE_PY, listFile], {
    encoding: 'utf8', maxBuffer: 1024 * 1024 * 500,
  });
  if (r.status !== 0) {
    console.error('[python] stderr:', (r.stderr || '').slice(0, 4000));
  }
  for (const line of (r.stdout || '').split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try {
      const rec = JSON.parse(l);
      result.set(path.resolve(rec.path), rec.text || '');
    } catch { /* ignore partial */ }
  }
  return result;
}

function loadOfficeCache() {
  const cache = new Map();
  if (!fs.existsSync(OFFICE_CACHE)) return cache;
  for (const line of fs.readFileSync(OFFICE_CACHE, 'utf8').split('\n')) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    try {
      const rec = JSON.parse(l);
      cache.set(path.resolve(rec.path), rec.text || '');
    } catch { /* ignore */ }
  }
  return cache;
}

function runOfficeConvert(files) {
  if (!files.length) return new Map();
  const listFile = path.join(TMP_DIR, 'office_list.txt');
  const outFile = path.join(TMP_DIR, 'office_result.jsonl');
  fs.writeFileSync(listFile, files.join('\n'), 'utf8');
  const r = spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OFFICE_PS1, listFile, outFile,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 500, timeout: 1_800_000 });
  if (r.stdout) console.log(r.stdout.trim());
  if (r.stderr) console.error('[office]', r.stderr.slice(0, 2000));
  const result = new Map();
  if (fs.existsSync(outFile)) {
    for (const line of fs.readFileSync(outFile, 'utf8').split('\n')) {
      const l = line.trim();
      if (!l.startsWith('{')) continue;
      try {
        const rec = JSON.parse(l);
        result.set(path.resolve(rec.path), rec.text || '');
      } catch { /* ignore */ }
    }
  }
  return result;
}

// ---------- 入库 ----------
function main() {
  const startedAt = Date.now();
  initializeDatabase();
  const limitArg = process.argv.find((a) => a.startsWith('--limit'));
  const limit = limitArg
    ? Number.parseInt(process.argv[process.argv.indexOf(limitArg) + 1] ?? limitArg.split('=')[1], 10)
    : Infinity;

  const allFiles = collectFiles();
  console.log(`[scan] 文本文件总数=${allFiles.length}`);

  // 现有库状态：file_path -> content_hash
  const existing = new Map(
    db.prepare('SELECT file_path, content_hash FROM file_knowledge_documents').all()
      .map((row) => [row.file_path, row.content_hash]),
  );

  const seen = new Set();
  const pending = []; // 需要（重新）抽取的文件
  let unchanged = 0;
  for (const file of allFiles) {
    const rel = relPath(file);
    seen.add(rel);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    const hash = contentHash(rel, stat);
    if (existing.get(rel) === hash) {
      unchanged += 1;
      continue;
    }
    pending.push({ file, rel, hash, ext: path.extname(file).toLowerCase() });
  }

  // 已删除文件：级联删除文档/chunk/向量
  const deleteDoc = db.prepare('DELETE FROM file_knowledge_documents WHERE file_path = ?');
  let removed = 0;
  for (const rel of existing.keys()) {
    if (!seen.has(rel)) {
      deleteDoc.run(rel);
      removed += 1;
    }
  }

  const toProcess = Number.isFinite(limit) ? pending.slice(0, limit) : pending;
  console.log(`[diff] 未变化=${unchanged} 待入库=${pending.length}（本次处理=${toProcess.length}） 已删除=${removed}`);

  // 分派抽取
  const pyFiles = toProcess.filter((item) => PYTHON_EXTS.has(item.ext)).map((item) => item.file);
  const officeItems = toProcess.filter((item) => OFFICE_EXTS.has(item.ext));
  const officeCache = loadOfficeCache();
  const officeMissing = officeItems.filter((item) => !officeCache.has(path.resolve(item.file)));

  console.log(`[extract] python=${pyFiles.length} office(缓存命中=${officeItems.length - officeMissing.length}, 补跑=${officeMissing.length})`);
  const texts = new Map();
  const pyTexts = runPythonParse(pyFiles);
  for (const [k, v] of pyTexts) texts.set(k, v);
  for (const item of officeItems) {
    const cached = officeCache.get(path.resolve(item.file));
    if (cached !== undefined) texts.set(path.resolve(item.file), cached);
  }
  const officeTexts = runOfficeConvert(officeMissing.map((item) => item.file));
  for (const [k, v] of officeTexts) texts.set(k, v);

  // 写库
  const insertDoc = db.prepare(`
    INSERT INTO file_knowledge_documents(
      public_id, source_kind, file_name, file_path, title, section, locator,
      page_number, content_hash, raw_content, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertChunk = db.prepare(`
    INSERT INTO file_knowledge_chunks(public_id, document_id, heading, locator, chunk_index, content)
    VALUES (?, ?, '', ?, ?, ?)
  `);
  const insertVector = db.prepare(`
    INSERT INTO file_knowledge_vectors(chunk_id, dimensions, embedding) VALUES (?, ?, ?)
  `);

  const importedAt = new Date().toISOString();
  const failed = [];
  let docCount = 0;
  let chunkCount = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (let i = 0; i < toProcess.length; i += 1) {
      const item = toProcess[i];
      const text = (texts.get(path.resolve(item.file)) || '').trim();
      if (!text) {
        failed.push(item.rel);
        continue;
      }
      deleteDoc.run(item.rel); // 变化文件先删旧行（级联清 chunk/向量）
      const publicId = docPublicId(item.rel);
      const fileName = path.basename(item.file);
      const section = item.rel.split('/')[0] || '';
      const result = insertDoc.run(
        publicId,
        item.ext.replace('.', ''),
        fileName,
        item.rel,
        fileName,
        section,
        item.rel,
        null,
        item.hash,
        text,
        importedAt,
      );
      const documentId = Number(result.lastInsertRowid);
      const chunks = chunkText(text);
      for (let c = 0; c < chunks.length; c += 1) {
        const chunkResult = insertChunk.run(
          `${publicId}--chunk-${c}`,
          documentId,
          `${item.rel}#chunk-${c}`,
          c,
          chunks[c],
        );
        const chunkId = Number(chunkResult.lastInsertRowid);
        const vector = embedText(chunks[c], config.vectorDimensions);
        insertVector.run(chunkId, config.vectorDimensions, vectorToBuffer(vector));
        chunkCount += 1;
      }
      docCount += 1;
      if (i % 200 === 0) console.log(`[ingest] 第 ${i}/${toProcess.length} 份文档...`);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* keep original error */ }
    throw error;
  }

  const totals = {
    documents: Number(db.prepare('SELECT COUNT(*) AS c FROM file_knowledge_documents').get().c),
    chunks: Number(db.prepare('SELECT COUNT(*) AS c FROM file_knowledge_chunks').get().c),
    vectors: Number(db.prepare('SELECT COUNT(*) AS c FROM file_knowledge_vectors').get().c),
  };
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[ingest] 本次入库：文档 ${docCount} 份，chunk ${chunkCount} 个，耗时 ${elapsed}s`);
  console.log(`[ingest] 库内总计：文档 ${totals.documents} 份，chunk ${totals.chunks} 个，向量 ${totals.vectors} 条`);
  if (pending.length > toProcess.length) {
    console.log(`[ingest] 注意：还有 ${pending.length - toProcess.length} 份待入库（--limit 限制），请再次运行完成全量。`);
  }
  if (failed.length) {
    const failedPath = path.join(TMP_DIR, 'failed_files.txt');
    fs.writeFileSync(failedPath, failed.join('\n'), 'utf8');
    console.log(`[ingest] 抽取为空/失败 ${failed.length} 份，清单：${failedPath}`);
  }
  console.log(`[ingest] 数据库：${config.databasePath}`);
}

main();
