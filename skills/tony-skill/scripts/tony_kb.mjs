#!/usr/bin/env node
/**
 * Tony 知识库查询客户端（tony-rag 本地检索服务，hybrid BM25 + vector）
 *
 * 用法：
 *   node tony_kb.mjs health
 *   node tony_kb.mjs stats
 *   node tony_kb.mjs search "IP5100 视频墙 命令" [--limit 8]
 *   node tony_kb.mjs product "IP5100" [--limit 24]   # 按型号/关键词列文档
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BASE_URL = 'http://127.0.0.1:4174';
const DEFAULT_PROJECT_ROOT = 'D:/IPAV/.ipav-rag/tony-rag';
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
let startAttempted = false;

class ClientError extends Error {
  constructor(message, { status = null, details = null, kind = null } = {}) {
    super(message);
    this.status = status;
    this.details = details;
    this.kind = kind;
  }
}

function readConfig() {
  const configPath = path.join(os.homedir(), '.tony-kb', 'config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function isServiceRoot(candidate) {
  return Boolean(candidate)
    && fs.existsSync(path.join(candidate, 'src', 'rag-server.js'));
}

function resolveProjectRoot() {
  const config = readConfig();
  const candidates = [
    process.env.TONY_KB_PROJECT_ROOT,
    config.projectRoot,
    DEFAULT_PROJECT_ROOT,
    path.resolve(scriptDirectory, '../../..'),
  ];
  const found = candidates.find(isServiceRoot);
  if (!found) {
    throw new ClientError(
      'Cannot locate the tony-rag package. Set TONY_KB_PROJECT_ROOT or ~/.tony-kb/config.json.',
      { details: { checked: candidates.filter(Boolean) } },
    );
  }
  return path.resolve(found);
}

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function positionalArgs(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    if (['--limit', '--offset', '--base-url'].includes(args[index])) {
      index += 1;
      continue;
    }
    if (args[index] === '--no-auto-start') continue;
    result.push(args[index]);
  }
  return result;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

class KnowledgeClient {
  constructor({ baseUrl, autoStart }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.autoStart = autoStart && ['127.0.0.1', 'localhost', '::1'].includes(new URL(this.baseUrl).hostname);
  }

  async request(method, requestPath, payload) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}${requestPath}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new ClientError(`tony-rag service is unreachable: ${error.message}`, { kind: 'unreachable' });
    }
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      throw new ClientError(
        body?.detail || body?.title || `tony-rag service returned HTTP ${response.status}`,
        { status: response.status, details: body },
      );
    }
    return body && typeof body === 'object' && Object.hasOwn(body, 'data') ? body.data : body;
  }

  async requestWithAutoStart(method, requestPath, payload) {
    try {
      return await this.request(method, requestPath, payload);
    } catch (error) {
      if (error.kind !== 'unreachable' || !this.autoStart || startAttempted) throw error;
      startAttempted = true;
      const projectRoot = resolveProjectRoot();
      const runtimeDirectory = path.join(projectRoot, '.runtime');
      fs.mkdirSync(runtimeDirectory, { recursive: true });
      const logPath = path.join(runtimeDirectory, 'rag-service.log');
      const logFd = fs.openSync(logPath, 'a');
      try {
        const child = spawn(process.execPath, ['src/rag-server.js'], {
          cwd: projectRoot,
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: { ...process.env, HOST: '127.0.0.1' },
          windowsHide: true,
        });
        child.unref();
        fs.writeFileSync(path.join(runtimeDirectory, 'rag-service.pid'), String(child.pid), { encoding: 'utf8', mode: 0o600 });
      } finally {
        fs.closeSync(logFd);
      }
      const deadline = Date.now() + 25_000;
      let lastError = error;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        try {
          await this.request('GET', '/api/health');
          return this.request(method, requestPath, payload);
        } catch (nextError) {
          lastError = nextError;
        }
      }
      throw new ClientError('tony-rag service did not become healthy after automatic startup.', {
        details: { projectRoot, logPath, lastError: lastError.message },
      });
    }
  }

  get(requestPath, params = {}) {
    const query = new URLSearchParams(
      Object.entries(params)
        .filter(([, value]) => value !== '' && value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
    return this.requestWithAutoStart('GET', `${requestPath}${query.size ? `?${query}` : ''}`);
  }

  post(requestPath, payload) {
    return this.requestWithAutoStart('POST', requestPath, payload);
  }
}

function usage() {
  return `Usage:
  tony_kb.mjs health|stats
  tony_kb.mjs search QUERY [--limit N]
  tony_kb.mjs product KEYWORD [--limit N]`;
}

async function run() {
  const rawArgs = process.argv.slice(2);
  const command = rawArgs[0];
  const args = rawArgs.slice(1);
  if (!command) throw new ClientError(usage());
  const baseUrl = optionValue(args, '--base-url', process.env.TONY_KB_URL || DEFAULT_BASE_URL);
  const autoStart = !args.includes('--no-auto-start') && process.env.TONY_KB_AUTOSTART !== '0';
  const positionals = positionalArgs(args);
  const client = new KnowledgeClient({ baseUrl, autoStart });

  if (command === 'health') {
    return {
      baseUrl,
      health: await client.get('/api/health'),
      stats: await client.get('/api/v1/stats'),
    };
  }
  if (command === 'stats') return client.get('/api/v1/stats');
  if (command === 'search') {
    const query = positionals.join(' ').trim();
    if (!query) throw new ClientError('search requires a query');
    return client.post('/api/v1/search', {
      query,
      limit: boundedInteger(optionValue(args, '--limit', 8), 8, 1, 24),
    });
  }
  if (command === 'product') {
    const query = positionals.join(' ').trim();
    if (!query) throw new ClientError('product requires a keyword (model, SKU, series)');
    return client.get('/api/v1/documents', {
      q: query,
      limit: boundedInteger(optionValue(args, '--limit', 24), 24, 1, 100),
      offset: boundedInteger(optionValue(args, '--offset', 0), 0, 0, 100_000),
    });
  }
  throw new ClientError(`Unsupported command: ${command}\n${usage()}`);
}

try {
  const data = await run();
  process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error.message,
    status: error.status ?? null,
    details: error.details ?? null,
  }, null, 2)}\n`);
  process.exitCode = 1;
}
