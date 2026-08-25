import http from 'node:http';
import { config } from './config.js';
import { KnowledgeRepository } from './features/knowledge/knowledge.repository.js';
import { KnowledgeService } from './features/knowledge/knowledge.service.js';
import { SearchService } from './features/search/search.service.js';
import { closeDatabase, initializeDatabase } from './shared/database/database.js';
import { NotFoundError } from './shared/errors.js';
import { problemResponse, readJson, requestContext, sendJson } from './shared/http.js';
import { logger } from './shared/logger.js';

const dbMeta = initializeDatabase();
const repository = new KnowledgeRepository();
const searchService = new SearchService(repository);
const knowledgeService = new KnowledgeService(repository, searchService);

const RATE_LIMIT = 240;
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map();

function envelope(data, requestId) {
  return { data, meta: { requestId, timestamp: new Date().toISOString() } };
}

function queryObject(searchParams) {
  return Object.fromEntries(searchParams.entries());
}

function applyRateLimit(request, response) {
  const key = request.socket.remoteAddress || 'local';
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  response.setHeader('X-RateLimit-Limit', String(RATE_LIMIT));
  response.setHeader('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT - bucket.count)));
  return bucket;
}

async function route(request, response, url, context) {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Request-Id',
      'Access-Control-Max-Age': '600',
    });
    response.end();
    return;
  }

  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/api')) {
    sendJson(response, 200, envelope({
      name: 'tony-rag Knowledge Service',
      scope: 'read-only hybrid retrieval over the IPAV document corpus',
      health: '/api/health',
      endpoints: ['GET /api/v1/stats', 'POST /api/v1/search', 'GET /api/v1/documents?q=&limit='],
    }, context.requestId));
    return;
  }
  if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
    sendJson(response, 200, envelope({ status: 'ok' }, context.requestId));
    return;
  }

  const bucket = applyRateLimit(request, response);
  if (bucket.count > RATE_LIMIT) {
    sendJson(response, 429, {
      type: 'https://tony-rag.local/errors/rate-limit',
      title: 'Too Many Requests',
      status: 429,
      detail: '请求过于频繁，请稍后再试。',
      instance: url.pathname,
      requestId: context.requestId,
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/stats') {
    sendJson(response, 200, envelope(repository.stats(), context.requestId));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/documents') {
    sendJson(response, 200, envelope(repository.listDocuments(queryObject(url.searchParams)), context.requestId));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/search') {
    sendJson(response, 200, envelope(knowledgeService.search(await readJson(request)), context.requestId));
    return;
  }
  throw new NotFoundError('接口');
}

const server = http.createServer(async (request, response) => {
  const startedAt = performance.now();
  let requestId = '(pending)';
  let pathname = request.url || '/';
  try {
    const context = requestContext(request, response);
    requestId = context.requestId;
    let url;
    try {
      url = new URL(request.url || '/', `http://${request.headers.host || `${config.host}:${config.port}`}`);
    } catch {
      throw new NotFoundError('接口');
    }
    pathname = url.pathname;
    await route(request, response, url, context);
  } catch (error) {
    const problem = problemResponse(error, pathname, requestId);
    if (problem.status >= 500) {
      logger.error('unexpected RAG request failure', {
        requestId,
        method: request.method,
        path: pathname,
        error: error.message,
      });
    }
    if (!response.headersSent) sendJson(response, problem.status, problem.body);
    else response.end();
  } finally {
    logger.info('RAG request completed', {
      requestId,
      method: request.method,
      path: pathname,
      status: response.statusCode,
      durationMs: Number((performance.now() - startedAt).toFixed(1)),
    });
  }
});

server.requestTimeout = 60_000;
server.headersTimeout = 30_000;

server.listen(config.port, config.host, () => {
  const stats = repository.stats();
  logger.info('tony-rag knowledge service started', {
    url: `http://${config.host}:${config.port}`,
    database: dbMeta.databasePath,
    documents: stats.documentCount,
    chunks: stats.chunkCount,
  });
});

function shutdown(signal) {
  logger.info('RAG shutdown requested', { signal });
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
