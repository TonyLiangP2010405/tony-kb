import { config } from '../../config.js';
import { logger } from '../../shared/logger.js';
import { bm25Scores, buildBM25Index } from './bm25.js';
import { rerankCandidates } from './reranker.js';
import { bufferToVector, cosineSimilarity, embedText, expandQuery, tokenize } from './vector.js';

function normalizedText(value) {
  return String(value).toLowerCase().replace(/\s+/g, ' ');
}

function asciiWords(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .match(/[a-z0-9]+/g) || [];
}

function compactWindows(value, maxWords = 3) {
  const words = asciiWords(value);
  const windows = new Set();
  for (let start = 0; start < words.length; start += 1) {
    let compact = '';
    for (let width = 1; width <= maxWords && start + width <= words.length; width += 1) {
      compact += words[start + width - 1];
      if (compact.length >= 5 && /[a-z]/.test(compact)) windows.add(compact);
    }
  }
  return [...windows];
}

function editDistance(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function fuzzyWindowScore(queryWindows, candidateWindows) {
  let best = 0;
  for (const queryWindow of queryWindows) {
    for (const candidateWindow of candidateWindows) {
      const longest = Math.max(queryWindow.length, candidateWindow.length);
      if (Math.min(queryWindow.length, candidateWindow.length) / longest < 0.65) continue;
      const score = 1 - editDistance(queryWindow, candidateWindow) / longest;
      if (score > best) best = score;
    }
  }
  return best;
}

// 预计算每个语料标签（文档标题/文件名）的 compact 窗口，避免每次查询都对全部标签重新分词。
// 用于把错拼/缩写查询模糊扩展回语料里真实出现的标题词。
function buildFuzzyLabels(corpus) {
  const labels = [...new Set(corpus.map((row) => String(row.source_title || '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  return labels.map((label) => ({ label, windows: compactWindows(label) }));
}

function expandWithFuzzyLabels(query, labels) {
  const queryWindows = compactWindows(query);
  if (!queryWindows.length) return query;
  // 带数字的查询窗口按型号写法处理（IP5100、NHD500TX），需要能映射回标题里
  // 带连字符的官方拼写；纯单词查询走下面的精确命中短路，避免稀释成邻近标题词。
  const hasSkuLikeWindow = queryWindows.some((window) => /\d/.test(window));
  if (!hasSkuLikeWindow
    && labels.some(({ windows }) => windows.some((window) => queryWindows.includes(window)))) {
    return query;
  }
  const candidateWindows = hasSkuLikeWindow
    ? [asciiWords(query).join('')].filter(Boolean)
    : queryWindows;
  if (!candidateWindows.length) return query;
  if (hasSkuLikeWindow) {
    const queryLower = query.toLocaleLowerCase('en-US');
    if (labels.some(({ label }) => queryLower.includes(label.toLocaleLowerCase('en-US')))) return query;
  }
  const candidates = new Map();
  for (const { label, windows } of labels) {
    if (label.length > 160) continue;
    const score = fuzzyWindowScore(candidateWindows, windows);
    if (score < 0.82 || score > 1) continue;
    // 型号别名只接受字符级精确对应：分隔符写法不同（IP5100 vs IP-5100）
    // 才应互相映射；编辑距离容差会把 SC010-A00 引向 SC010-A01。
    if (hasSkuLikeWindow && score !== 1) continue;
    if (!hasSkuLikeWindow && score >= 1) continue;
    candidates.set(label, Math.max(score, candidates.get(label) || 0));
  }
  const aliases = [...candidates]
    .sort((left, right) => right[1] - left[1] || left[0].length - right[0].length)
    .slice(0, 4)
    .map(([label]) => label);
  return aliases.length ? `${query} ${aliases.join(' ')}` : query;
}

function excerptFor(content, tokens) {
  const low = content.toLowerCase();
  let position = tokens.map((token) => low.indexOf(token)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  position = Math.max(0, position - 100);
  const excerpt = content.slice(position, position + 360).replace(/\s*\|\s*/g, ' · ');
  return `${position ? '…' : ''}${excerpt}${position + 360 < content.length ? '…' : ''}`;
}

// Top-K 多样性：同一文件最多占 2 个席位，避免长文档被切成多个相邻 chunk
// 后霸占整页结果。
const DIVERSE_PER_SOURCE = 2;

function diversityKey(item) {
  return `file:${String(item.file || item.locator || item.source_title || '').split(/[#·]/)[0].trim()}`;
}

function diverseTopK(items, limit) {
  const perSource = new Map();
  const diverse = [];
  for (const item of items) {
    const key = diversityKey(item);
    const count = perSource.get(key) || 0;
    if (count >= DIVERSE_PER_SOURCE) continue;
    perSource.set(key, count + 1);
    diverse.push(item);
    if (diverse.length >= limit) break;
  }
  return diverse;
}

// RRF 融合的标准 k 值；排名从 1 开始，分数 <= 0 的行排名为 Infinity（贡献 0）。
const RRF_K = 60;

function rankPositions(scored, field) {
  const order = scored
    .filter((item) => item[field] > 0)
    .sort((left, right) => right[field] - left[field]);
  const ranks = new Float64Array(scored.length).fill(Infinity);
  order.forEach((item, position) => {
    ranks[item.index] = position + 1;
  });
  return ranks;
}

export class SearchService {
  constructor(repository) {
    this.repository = repository;
    this.corpus = null;
    this.fuzzyLabels = null;
    this.bm25Index = null;
  }

  loadCorpus() {
    if (!this.corpus) {
      const rows = this.repository.getSearchCorpus();
      const usable = [];
      let skippedDimensions = 0;
      for (const row of rows) {
        const vector = bufferToVector(row.embedding);
        // 维度与当前配置不一致的向量（例如改过 VECTOR_DIMENSIONS 后未重建）
        // 会让余弦相似度静默算出错误分数，直接排除并计数告警。
        if (vector.length !== config.vectorDimensions) {
          skippedDimensions += 1;
          continue;
        }
        usable.push({ ...row, vector });
      }
      if (skippedDimensions) {
        logger.warn('search corpus rows skipped due to vector dimension mismatch', {
          skipped: skippedDimensions,
          expected: config.vectorDimensions,
        });
      }
      this.corpus = usable;
      this.fuzzyLabels = buildFuzzyLabels(usable);
      this.bm25Index = buildBM25Index(usable);
    }
    return this.corpus;
  }

  invalidateCorpus() {
    this.corpus = null;
    this.fuzzyLabels = null;
    this.bm25Index = null;
  }

  interpretQuery(query) {
    this.loadCorpus();
    return expandWithFuzzyLabels(String(query || ''), this.fuzzyLabels);
  }

  retrieve(query, limit = 16) {
    const corpus = this.loadCorpus();
    const expanded = expandQuery(this.interpretQuery(query));
    const queryVector = embedText(expanded, config.vectorDimensions);
    const allTokens = tokenize(expanded);
    const tokens = allTokens.filter((token) => token.length > 1 && !token.includes('_'));
    // 双榜召回：BM25 榜与向量榜各取 Top-K，并集作为 RRF 候选池。
    const topK = Math.max(20, limit * 3);
    const bm25All = bm25Scores(this.bm25Index, allTokens);
    const scored = corpus.map((row, index) => ({
      row,
      index,
      vectorScore: Math.max(0, cosineSimilarity(queryVector, row.vector)),
      bm25Score: bm25All[index] || 0,
    }));
    const vectorRanks = rankPositions(scored, 'vectorScore');
    const bm25Ranks = rankPositions(scored, 'bm25Score');
    const fused = scored
      .filter((item) => vectorRanks[item.index] < topK || bm25Ranks[item.index] < topK)
      .map((item) => ({
        ...item,
        rrfScore: (vectorRanks[item.index] < Infinity ? 1 / (RRF_K + vectorRanks[item.index]) : 0)
          + (bm25Ranks[item.index] < Infinity ? 1 / (RRF_K + bm25Ranks[item.index]) : 0),
      }))
      .sort((left, right) => right.rrfScore - left.rrfScore)
      .slice(0, topK);
    const reranked = rerankCandidates(fused, { tokens });
    // max 归一化到 0–1。
    const maxScore = reranked.reduce((best, item) => Math.max(best, item.rerankScore), 0) || 1;
    const results = reranked.map((item) => ({
      ...item.row,
      score: item.rerankScore / maxScore,
      vectorScore: item.vectorScore,
      bm25Score: item.bm25Score,
      excerpt: excerptFor(item.row.content, tokens),
    }));
    return diverseTopK(results, limit);
  }
}
