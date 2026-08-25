import { db } from '../../shared/database/database.js';

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export class KnowledgeRepository {
  getSearchCorpus() {
    return db.prepare(`
      SELECT fkc.id AS chunk_id, fkc.public_id AS chunk_public_id, fkc.content,
        'file-page' AS chunk_type,
        fkv.embedding, fkv.dimensions,
        fkd.public_id AS document_public_id,
        fkd.title AS source_title,
        fkd.section AS category,
        fkd.file_name AS file_name,
        fkd.file_path AS file_path,
        fkc.locator AS locator,
        NULL AS url,
        fkd.page_number AS slide_number
      FROM file_knowledge_chunks fkc
      JOIN file_knowledge_vectors fkv ON fkv.chunk_id = fkc.id
      JOIN file_knowledge_documents fkd ON fkd.id = fkc.document_id
    `).all();
  }

  stats() {
    const documentCount = Number(db.prepare('SELECT COUNT(*) AS count FROM file_knowledge_documents').get().count);
    const chunkCount = Number(db.prepare('SELECT COUNT(*) AS count FROM file_knowledge_chunks').get().count);
    const vectorCount = Number(db.prepare('SELECT COUNT(*) AS count FROM file_knowledge_vectors').get().count);
    const bySourceKind = db.prepare(`
      SELECT source_kind AS kind, COUNT(*) AS documents
      FROM file_knowledge_documents
      GROUP BY source_kind
      ORDER BY documents DESC, kind ASC
    `).all().map((row) => ({ kind: row.kind, documents: Number(row.documents) }));
    const vectorDimensions = Number(
      db.prepare('SELECT dimensions FROM file_knowledge_vectors LIMIT 1').get()?.dimensions || 0,
    );
    const lastImportedAt = db.prepare(
      'SELECT MAX(imported_at) AS ts FROM file_knowledge_documents',
    ).get()?.ts || null;
    return {
      documentCount,
      chunkCount,
      vectorCount,
      bySourceKind,
      vectorDimensions,
      lastImportedAt,
    };
  }

  // 按关键字 LIKE 匹配文件名/路径/标题列出文档（"按型号列文档"）。
  listDocuments({ q = '', limit = 24, offset = 0 } = {}) {
    const safeLimit = boundedInteger(limit, 24, 1, 200);
    const safeOffset = Math.max(0, boundedInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER));
    const search = `%${String(q).toLowerCase().replace(/[%_\\]/g, (match) => `\\${match}`)}%`;
    const where = q
      ? `WHERE LOWER(file_name) LIKE ? ESCAPE '\\' OR LOWER(file_path) LIKE ? ESCAPE '\\' OR LOWER(title) LIKE ? ESCAPE '\\'`
      : '';
    const params = q ? [search, search, search] : [];
    const total = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM file_knowledge_documents ${where}
    `).get(...params).count);
    const rows = db.prepare(`
      SELECT d.public_id AS id, d.source_kind AS kind, d.file_name AS fileName,
        d.file_path AS filePath, d.title, d.section, d.content_hash AS contentHash,
        d.imported_at AS importedAt,
        (SELECT COUNT(*) FROM file_knowledge_chunks c WHERE c.document_id = d.id) AS chunkCount
      FROM file_knowledge_documents d
      ${where}
      ORDER BY d.file_path COLLATE NOCASE
      LIMIT ? OFFSET ?
    `).all(...params, safeLimit, safeOffset);
    return {
      data: rows.map((row) => ({ ...row, chunkCount: Number(row.chunkCount) })),
      pagination: {
        offset: safeOffset,
        limit: safeLimit,
        total,
        hasMore: safeOffset + rows.length < total,
      },
    };
  }
}
