import { tokenize } from './vector.js';

export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

// 语料行的可检索文本：SKU 与标题并入正文，替代旧管线里独立的 titleLexical 加权。
export function corpusText(row) {
  return `${row.sku || ''} ${row.source_title || ''} ${row.content || ''}`;
}

export function buildBM25Index(rows) {
  const docs = rows.map((row) => {
    const frequencies = new Map();
    let length = 0;
    for (const token of tokenize(corpusText(row))) {
      frequencies.set(token, (frequencies.get(token) || 0) + 1);
      length += 1;
    }
    return { frequencies, length };
  });
  const docFreq = new Map();
  for (const doc of docs) {
    for (const token of doc.frequencies.keys()) {
      docFreq.set(token, (docFreq.get(token) || 0) + 1);
    }
  }
  const totalLength = docs.reduce((sum, doc) => sum + doc.length, 0);
  return {
    size: docs.length,
    avgLength: docs.length ? totalLength / docs.length : 0,
    docs,
    docFreq,
  };
}

export function bm25Scores(index, queryTokens, { k1 = BM25_K1, b = BM25_B } = {}) {
  const scores = new Float64Array(index.size);
  if (!index.size || !index.avgLength) return scores;
  for (const term of new Set(queryTokens)) {
    const df = index.docFreq.get(term) || 0;
    if (!df) continue;
    const idf = Math.log(1 + (index.size - df + 0.5) / (df + 0.5));
    for (let docIndex = 0; docIndex < index.size; docIndex += 1) {
      const doc = index.docs[docIndex];
      const tf = doc.frequencies.get(term) || 0;
      if (!tf) continue;
      scores[docIndex] += (idf * (tf * (k1 + 1)))
        / (tf + k1 * (1 - b + (b * doc.length) / index.avgLength));
    }
  }
  return scores;
}
