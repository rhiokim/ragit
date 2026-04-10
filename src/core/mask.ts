type Pattern = {
  label: string;
  regex: RegExp;
  replacer: (...args: string[]) => string;
};

const revealPrefix = (value: string, prefix = 6): string => `${value.slice(0, Math.min(prefix, value.length))}***`;

const patterns: Pattern[] = [
  {
    label: "openai_key",
    regex: /sk-[A-Za-z0-9]{20,}/g,
    replacer: (value) => revealPrefix(value),
  },
  {
    label: "github_pat",
    regex: /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/g,
    replacer: (value) => revealPrefix(value),
  },
  {
    label: "aws_access_key",
    regex: /AKIA[0-9A-Z]{16}/g,
    replacer: (value) => revealPrefix(value),
  },
  {
    label: "bearer_token",
    regex: /\b(Bearer\s+)([A-Za-z0-9._-]{20,})/gi,
    replacer: (_value, prefix, token) => `${prefix}${revealPrefix(token, 4)}`,
  },
  {
    label: "jwt",
    regex: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
    replacer: (value) => revealPrefix(value, 10),
  },
  {
    label: "uri_credential",
    regex: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@/\s]+)@/gi,
    replacer: (_value, scheme, username) => `${scheme}${username}:***@`,
  },
  {
    label: "query_param_secret",
    regex: /([?&](?:access_token|api[_-]?key|token|secret)=)([^&#\s]+)/gi,
    replacer: (_value, prefix, secret) => `${prefix}${revealPrefix(secret, 4)}`,
  },
  {
    label: "kv_secret",
    regex: /\b((?:api[_-]?key|token|secret)\s*[:=]\s*["']?)([^\s"']+)/gi,
    replacer: (_value, prefix, secret) => `${prefix}${revealPrefix(secret, 4)}`,
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
    text = text.replace(pattern.regex, (...args) => {
      const matched = String(args[0] ?? "");
      const replaced = pattern.replacer(...(args.slice(0, -2) as string[]));
      if (replaced !== matched) {
        maskedCount += 1;
      }
      return replaced;
    });
  }
  return { text, maskedCount };
};
