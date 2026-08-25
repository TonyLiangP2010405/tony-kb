const QUERY_EXPANSIONS = new Map([
  ['会议室', 'meeting room conferencing presentation usb-c camera speakerphone'],
  ['教室', 'classroom education presentation camera matrix'],
  ['酒店', 'hotel hospitality av over ip matrix'],
  ['零售', 'retail digital signage av over ip video wall'],
  ['酒吧', 'sports bar multiview video wall low latency'],
  ['数字标牌', 'digital signage video wall splitter'],
  ['视频墙', 'video wall multiview mosaic bezel'],
  ['拼接', 'video wall mosaic bezel'],
  ['矩阵', 'matrix switcher'],
  ['无线', 'wireless casting presentation'],
  ['摄像头', 'camera webcam ptz'],
  ['相机', 'camera webcam ptz'],
  ['麦克风', 'microphone audio pickup'],
  ['音频', 'audio dante aes67 amplifier dsp'],
  ['低延迟', 'low latency'],
  ['无延迟', 'zero latency'],
  ['零延迟', 'zero latency'],
  ['无损', 'lossless'],
  ['网线', 'cat6 ethernet hdbaset utp'],
  ['延长', 'extender transmission distance'],
  ['控制', 'control web gui rs-232 api'],
  ['统一控制', 'controller control management centralized control automatic discovery'],
  ['分配器', 'splitter distribution'],
  ['切换器', 'switcher switching'],
  ['转换器', 'converter adapter'],
  ['显示器', 'monitor screen'],
  ['充电', 'power delivery charging pd'],
  ['投屏', 'casting presentation wireless'],
  ['录播', 'lecture capture recording'],
  ['推荐', 'recommend solution'],
  ['参数', 'specifications features'],
  ['优点', 'advantages features'],
  ['缺点', 'limitations tradeoffs max requires without'],
  ['光纤', 'fiber optic active optical aoc'],
  ['8k', '8k 7680x4320'],
  ['4k', '4k 3840x2160'],
]);

export function expandQuery(query) {
  let expanded = query.trim();
  // SKU 和英文术语在用户输入里大小写不定（USB-C / usb-c、8K / 8k），
  // 扩展表按小写匹配，避免大写查询漏掉领域词。
  const lower = expanded.toLowerCase();
  for (const [term, replacement] of QUERY_EXPANSIONS) {
    if (lower.includes(term.toLowerCase())) expanded += ` ${replacement}`;
  }
  return expanded;
}

export function tokenize(text) {
  const normalized = expandQuery(String(text))
    .toLowerCase()
    .replace(/[×]/g, 'x')
    .replace(/[^\p{L}\p{N}.@+-]+/gu, ' ')
    .trim();
  const tokens = normalized.match(/[a-z0-9]+(?:[.@+-][a-z0-9]+)*|[\p{Script=Han}]/gu) || [];
  const results = [...tokens];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    results.push(`${tokens[index]}_${tokens[index + 1]}`);
  }
  return results;
}

function fnv1a(value, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function embedText(text, dimensions = 384) {
  const vector = new Float32Array(dimensions);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const index = fnv1a(token) % dimensions;
    const sign = fnv1a(token, 0x9e3779b9) & 1 ? 1 : -1;
    const weight = token.includes('_') ? 1.25 : token.length > 5 ? 1.7 : 1;
    vector[index] += sign * weight;

    if (/^[a-z0-9]/.test(token) && token.length >= 4) {
      for (let offset = 0; offset <= token.length - 3; offset += 1) {
        const trigram = token.slice(offset, offset + 3);
        const triIndex = fnv1a(`tri:${trigram}`) % dimensions;
        const triSign = fnv1a(trigram, 0x85ebca6b) & 1 ? 0.42 : -0.42;
        vector[triIndex] += triSign;
      }
    }
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  return vector;
}

export function vectorToBuffer(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function bufferToVector(value) {
  const bytes = value ? Uint8Array.from(value) : new Uint8Array(0);
  if (!bytes.length || bytes.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`Corrupted vector blob: ${bytes.length} bytes is not a valid Float32 payload.`);
  }
  return new Float32Array(bytes.buffer);
}

export function cosineSimilarity(left, right) {
  const length = Math.min(left.length, right.length);
  let score = 0;
  for (let index = 0; index < length; index += 1) score += left[index] * right[index];
  return score;
}
