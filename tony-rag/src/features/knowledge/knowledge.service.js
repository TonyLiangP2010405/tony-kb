import { ValidationError } from '../../shared/errors.js';

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export class KnowledgeService {
  constructor(repository, searchService) {
    this.repository = repository;
    this.searchService = searchService;
  }

  search(payload) {
    const query = typeof payload?.query === 'string' ? payload.query.trim() : '';
    if (query.length < 2 || query.length > 1000) {
      throw new ValidationError('检索问题长度需要在 2 到 1000 个字符之间。', [
        { field: 'query', message: '请输入具体的型号、主题或操作问题。', code: 'INVALID_LENGTH' },
      ]);
    }
    const limit = boundedInteger(payload?.limit, 8, 1, 24);
    const interpretedQuery = this.searchService.interpretQuery(query);
    const results = this.searchService.retrieve(query, limit).map((item) => ({
      chunkId: item.chunk_public_id,
      documentId: item.document_public_id,
      kind: item.chunk_type,
      title: item.source_title,
      section: item.category,
      file: item.file_path,
      fileName: item.file_name,
      locator: item.locator,
      url: item.url || null,
      page: item.slide_number || null,
      excerpt: item.excerpt,
      content: item.content,
      score: Number(item.score.toFixed(4)),
      vectorScore: Number((item.vectorScore || 0).toFixed(4)),
      bm25Score: Number((item.bm25Score || 0).toFixed(4)),
    }));
    return {
      query,
      interpretedQuery,
      results,
      retrieval: {
        mode: 'hybrid-bm25-vector-rrf',
        candidateCount: results.length,
      },
    };
  }
}
