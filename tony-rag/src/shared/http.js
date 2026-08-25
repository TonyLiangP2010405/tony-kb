import crypto from 'node:crypto';
import { config } from '../config.js';
import { AppError, MalformedJsonError, PayloadTooLargeError } from './errors.js';

export function requestContext(request, response) {
  const incomingId = request.headers['x-request-id'];
  const requestId = typeof incomingId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(incomingId)
    ? incomingId
    : crypto.randomUUID();
  response.setHeader('X-Request-Id', requestId);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
  response.setHeader('Vary', 'Origin');
  return { requestId, startedAt: performance.now() };
}

export function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

export async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > config.maxBodyBytes) throw new PayloadTooLargeError();
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new MalformedJsonError();
  }
}

export function problemResponse(error, pathname, requestId) {
  const operational = error instanceof AppError && error.isOperational;
  const status = operational ? error.status : 500;
  return {
    status,
    body: {
      type: `https://tony-rag.local/errors/${operational ? error.code : 'internal-error'}`,
      title: operational ? error.title : 'Internal Server Error',
      status,
      detail: operational ? error.detail : '服务暂时无法完成请求。',
      instance: pathname,
      requestId,
      ...(operational && error.errors?.length ? { errors: error.errors } : {}),
    },
  };
}
