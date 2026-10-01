export function targetedFindings(content, values = []) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const text = bytes.toString('utf8');
  const findings = [];
  for (const value of values) {
    if (value.length < 8) continue;
    for (const variant of [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('hex'), encodeURIComponent(value)]) {
      const wide = Buffer.from(variant, 'utf16le');
      if (text.includes(variant) || bytes.includes(wide) || bytes.includes(Buffer.from(wide).swap16())) { findings.push('confidential-value'); break; }
    }
  }
  for (const [rule, pattern] of [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['provider-credential', /\b(?:sk_live_|sk_test_|sk-or-v1-)[a-zA-Z0-9_-]{16,}/],
    ['connection-password', /\b(?:postgres(?:ql)?|mysql):\/\/[^\s:]+:[^\s@]+@/],
  ]) if (pattern.test(text) || (text.includes('\0') && pattern.test(text.replaceAll('\0', '')))) findings.push(rule);
  return [...new Set(findings)];
}
