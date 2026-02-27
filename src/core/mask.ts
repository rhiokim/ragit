const patterns: Array<{ label: string; regex: RegExp; replacer: (value: string) => string }> = [
  {
    label: "openai_key",
    regex: /sk-[A-Za-z0-9]{20,}/g,
    replacer: (value) => `${value.slice(0, 6)}***`,
  },
  {
    label: "github_pat",
    regex: /ghp_[A-Za-z0-9]{20,}/g,
    replacer: (value) => `${value.slice(0, 6)}***`,
  },
  {
    label: "aws_access_key",
    regex: /AKIA[0-9A-Z]{16}/g,
    replacer: (value) => `${value.slice(0, 6)}***`,
  },
  {
    label: "kv_secret",
    regex: /(?<key>api[_-]?key|token|secret)\s*[:=]\s*["']?(?<value>[^\s"']+)/gi,
    replacer: (value) => {
      const segments = value.split(/[:=]/);
      if (segments.length < 2) return value;
      const secret = segments.slice(1).join(":").trim();
      const prefix = segments[0];
      return `${prefix}: ${secret.slice(0, 4)}***`;
    },
  },
];

export interface MaskingResult {
  text: string;
  maskedCount: number;
}

export const maskSecrets = (source: string): MaskingResult => {
  let text = source;
  let maskedCount = 0;
  for (const pattern of patterns) {
    text = text.replace(pattern.regex, (value) => {
      maskedCount += 1;
      return pattern.replacer(value);
    });
  }
  return { text, maskedCount };
};
