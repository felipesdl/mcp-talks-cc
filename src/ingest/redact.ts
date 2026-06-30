const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'openai_key', re: /sk-(?:proj-)?[A-Za-z0-9_\-]{20,}/g },
  { name: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_\-]{20,}/g },
  { name: 'github_pat', re: /ghp_[A-Za-z0-9]{20,}/g },
  { name: 'github_oauth', re: /gho_[A-Za-z0-9]{20,}/g },
  { name: 'github_app', re: /(ghu_|ghs_|ghr_)[A-Za-z0-9]{20,}/g },
  { name: 'aws_access', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9_\-\.=]{20,}/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g },
  { name: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'env_secret', re: /\b(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)\s*=\s*['"]?[^\s'"]{8,}/gi },
];

export function redact(text: string): string {
  let out = text;
  for (const { re } of PATTERNS) {
    out = out.replace(re, '<redacted>');
  }
  return out;
}
