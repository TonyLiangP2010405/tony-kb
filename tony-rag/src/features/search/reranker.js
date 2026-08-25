// RRF 融合榜的启发式重排：RRF 归一化分数 + 查询词正文覆盖率。
// 源包里还有 SKU 精确命中与 how-to 教程加权，tony-rag 语料只有通用文件 chunk
// （没有产品/SKU/support-page 对象），这两路信号没有作用对象，已删除。
export function phraseCoverage(content, tokens) {
  if (!tokens.length) return 0;
  const haystack = String(content || '').toLowerCase();
  let matches = 0;
  for (const token of new Set(tokens)) {
    if (haystack.includes(token)) matches += 1;
  }
  return Math.min(1, matches / Math.max(3, Math.min(tokens.length, 8)));
}

export function rerankCandidates(candidates, { tokens }) {
  const maxRrf = candidates.reduce((best, item) => Math.max(best, item.rrfScore), 0) || 1;
  return candidates
    .map((item) => {
      const rrfNorm = item.rrfScore / maxRrf;
      const coverage = phraseCoverage(item.row.content, tokens);
      return {
        ...item,
        rerankScore: rrfNorm + coverage * 0.28,
      };
    })
    .sort((left, right) => right.rerankScore - left.rerankScore);
}
