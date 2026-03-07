import { createHash } from "node:crypto";

const normalizedTokens = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

export const zeroVector = (dimensions: number): number[] => new Array<number>(dimensions).fill(0);

export const embedWithLocalPlaceholder = (text: string, dimensions: number): number[] => {
  const vector = zeroVector(dimensions);
  const tokens = normalizedTokens(text);
  if (tokens.length === 0) return vector;
  for (const token of tokens) {
    const hash = createHash("sha1").update(token).digest();
    for (let index = 0; index < dimensions; index += 1) {
      const source = hash[index % hash.length];
      vector[index] += (source / 255) * 2 - 1;
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
};

export const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    aNorm += a[index] ** 2;
    bNorm += b[index] ** 2;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
};

export const zvecCosineDistanceToSimilarity = (distance: number): number => 1 - distance;
