import { config } from '../config.js';

const priorities = { debug: 10, info: 20, warn: 30, error: 40 };

function write(level, message, fields = {}) {
  if ((priorities[level] ?? 20) < (priorities[config.logLevel] ?? 20)) return;
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  });
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${entry}\n`);
}

export const logger = {
  debug: (message, fields) => write('debug', message, fields),
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
};
