import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function intEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw !== undefined && !/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  const parsed = Number.parseInt(raw ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

export const config = Object.freeze({
  projectRoot,
  host: process.env.HOST || '127.0.0.1',
  port: intEnv('PORT', 4174, { min: 1, max: 65535 }),
  databasePath: resolveFromRoot(process.env.DATABASE_PATH || './data/tony.sqlite'),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  logLevel: process.env.LOG_LEVEL || 'info',
  vectorDimensions: intEnv('VECTOR_DIMENSIONS', 384, { min: 64, max: 2048 }),
  maxBodyBytes: intEnv('MAX_BODY_BYTES', 1_048_576, { min: 1024, max: 4_194_304 }),
});
