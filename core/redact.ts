// Masks secrets with reversible placeholders before any text reaches the LLM.
// The mapping stays in memory, so the agent's answer can be shown with real values
// to the user without the model ever seeing them.
export interface Redactor {
  mask(text: string): string;
  unmask(text: string): string;
}

const RULES: { kind: string; re: RegExp; group?: number }[] = [
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g },
  // provider API keys: OpenAI-style, boxapi, GitHub, AWS access keys, Slack
  { kind: 'KEY', re: /\b(?:sk-[A-Za-z0-9_-]{16,}|box-ai-[A-Fa-f0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,})/g },
  // values after secret-looking names: api_key=..., password: ..., token="..."
  { kind: 'SECRET', re: /(?<=\b(?:api[_-]?key|secret|password|passwd|token|auth)["']?\s*[:=]\s*["']?)[^\s"',;&]{6,}/gi },
  { kind: 'TOKEN', re: /(?<=Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi },
  // password part of scheme://user:password@host
  { kind: 'PASSWORD', re: /(?<=[a-z+]+:\/\/[^:@/\s]+:)[^@\s]+(?=@)/gi },
  { kind: 'EMAIL', re: /[\w.+-]+@[\w-]+\.[\w.]+/g },
  { kind: 'IP', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
];

export function createRedactor(knownSecrets: string[] = []): Redactor {
  const toPlaceholder = new Map<string, string>();
  const fromPlaceholder = new Map<string, string>();
  const counters: Record<string, number> = {};

  const placeholder = (kind: string, value: string) => {
    let p = toPlaceholder.get(value);
    if (!p) {
      counters[kind] = (counters[kind] ?? 0) + 1;
      p = `[${kind}_${counters[kind]}]`;
      toPlaceholder.set(value, p);
      fromPlaceholder.set(p, value);
    }
    return p;
  };

  // Longest first so a value that contains another one is masked whole.
  const secrets = knownSecrets.filter((s) => s && s.length >= 4).sort((a, b) => b.length - a.length);

  return {
    mask(text: string) {
      let out = text;
      for (const s of secrets) out = out.split(s).join(placeholder('SECRET', s));
      for (const rule of RULES) out = out.replace(rule.re, (m) => placeholder(rule.kind, m));
      return out;
    },
    unmask(text: string) {
      return text.replace(/\[[A-Z]+_\d+\]/g, (p) => fromPlaceholder.get(p) ?? p);
    },
  };
}
