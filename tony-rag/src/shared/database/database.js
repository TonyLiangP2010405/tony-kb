import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { config } from '../../config.js';
import { embedText, vectorToBuffer } from '../../features/search/vector.js';
import { logger } from '../logger.js';

const migrationDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new DatabaseSync(config.databasePath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
  const migrations = fs
    .readdirSync(migrationDirectory)
    .filter((name) => /^[0-9]+_.*\.sql$/.test(name))
    .sort();
  for (const name of migrations) {
    const version = Number.parseInt(name, 10);
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(migrationDirectory, name), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      const alreadyApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version);
      if (alreadyApplied) {
        db.exec('COMMIT');
        continue;
      }
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(version);
      db.exec('COMMIT');
      logger.info('database migration applied', { version, name });
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // SQLite 已在出错时自动回滚，保留原始错误。
      }
      throw error;
    }
  }
}

// 启动自检：已入库向量维度与当前 VECTOR_DIMENSIONS 配置不一致时按当前配置重嵌，
// 避免余弦相似度在不同维度向量间静默算出错误分数。chunk 正文仍在库里，无需重新抽取。
function ensureKnowledgeVectorDimensions() {
  const mismatched = db.prepare(`
    SELECT c.id AS chunk_id, c.content AS content
    FROM file_knowledge_chunks c
    JOIN file_knowledge_vectors v ON v.chunk_id = c.id
    WHERE v.dimensions != ?
  `).all(config.vectorDimensions);
  if (!mismatched.length) return;
  logger.warn('file knowledge vector dimensions mismatch, re-embedding chunks', {
    expected: config.vectorDimensions,
    mismatched: mismatched.length,
  });
  const update = db.prepare('UPDATE file_knowledge_vectors SET dimensions = ?, embedding = ? WHERE chunk_id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of mismatched) {
      update.run(config.vectorDimensions, vectorToBuffer(embedText(row.content, config.vectorDimensions)), row.chunk_id);
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 保留原始错误。
    }
    throw error;
  }
}

export function initializeDatabase() {
  migrate();
  ensureKnowledgeVectorDimensions();
  return { databasePath: config.databasePath };
}

export function closeDatabase() {
  db.close();
}
