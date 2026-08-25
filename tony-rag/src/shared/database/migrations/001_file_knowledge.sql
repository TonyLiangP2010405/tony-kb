PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS file_knowledge_documents (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  title TEXT NOT NULL,
  section TEXT NOT NULL,
  locator TEXT NOT NULL UNIQUE,
  page_number INTEGER,
  content_hash TEXT NOT NULL,
  raw_content TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS file_knowledge_chunks (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  document_id INTEGER NOT NULL REFERENCES file_knowledge_documents(id) ON DELETE CASCADE,
  heading TEXT NOT NULL DEFAULT '',
  locator TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(document_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS file_knowledge_vectors (
  chunk_id INTEGER PRIMARY KEY REFERENCES file_knowledge_chunks(id) ON DELETE CASCADE,
  dimensions INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_file_knowledge_documents_kind
  ON file_knowledge_documents(source_kind, updated_at);
CREATE INDEX IF NOT EXISTS idx_file_knowledge_documents_path
  ON file_knowledge_documents(file_path);
CREATE INDEX IF NOT EXISTS idx_file_knowledge_chunks_document
  ON file_knowledge_chunks(document_id, chunk_index);
