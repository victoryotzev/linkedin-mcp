import { describe, expect, it } from 'vitest';
import { redactSecrets } from '@linkedin-mcp/importers';

describe('redaction', () => {
  it('redacts token patterns and reports findings', () => {
    const input = [
      'github: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
      'aws: AKIAIOSFODNN7EXAMPLE',
      'slack: xoxb-123456789012-abcdefghijklmn',
      'jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P',
    ].join('\n');
    const { text, findings } = redactSecrets(input);
    expect(text).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(text).not.toContain('xoxb-123456789012');
    expect(text).toContain('[REDACTED:github_token:');
    expect(text).toContain('[REDACTED:aws_access_key:');
    expect(findings.length).toBeGreaterThanOrEqual(4);
  });

  it('redacts .env-style secret assignments', () => {
    const { text } = redactSecrets(
      'DB_PASSWORD=hunter2secret\nAPI_KEY="sk-longvalue1234"\nNORMAL_VAR=ok',
    );
    expect(text).not.toContain('hunter2secret');
    expect(text).not.toContain('sk-longvalue1234');
    expect(text).toContain('NORMAL_VAR=ok');
  });

  // Every fixture above uses a whitespace-free value, which is exactly why the
  // old value pattern's whitespace bug survived: it stopped at the first space.
  it('redacts secret values that contain whitespace', () => {
    const { text, findings } = redactSecrets(
      [
        'db:',
        '  password: "correct horse battery staple"',
        "  api_key: 'another long secret here'",
        'DB_PASSWORD="my secret phrase"',
        'env:',
        '  API_KEY: my api key here',
      ].join('\n'),
    );
    expect(text).not.toContain('horse battery staple');
    expect(text).not.toContain('another long secret');
    expect(text).not.toContain('my secret phrase');
    expect(text).not.toContain('my api key here');
    expect(findings.filter((f) => f.type === 'env_secret_assignment')).toHaveLength(4);
  });

  it('leaves ordinary prose mentioning a credential word alone', () => {
    const prose = 'My password: is stored safely. The token was rotated.';
    expect(redactSecrets(prose).text).toBe(prose);
  });

  it('redacts PEM private keys', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const { text } = redactSecrets(`before\n${pem}\nafter`);
    expect(text).not.toContain('MIIEpAIBAAKCAQEA');
    expect(text).toContain('[REDACTED:pem_private_key:');
  });

  it('keeps hex digests (sha256, git OIDs) and normal prose untouched', () => {
    const sha = 'a'.repeat(64);
    const prose = `The commit ${sha} fixed the bug. Plain sentence stays.`;
    const { text, findings } = redactSecrets(prose);
    expect(text).toBe(prose);
    expect(findings).toHaveLength(0);
  });

  it('redacts high-entropy base64-ish tokens', () => {
    const noisy = 'value: TW9uZG9fU2VjcmV0X1ZhbHVlXzk4NzY1NDMyMV9BQkNERUZHSElKS0w5OA';
    const { text } = redactSecrets(noisy);
    expect(text).toContain('[REDACTED:high_entropy_token:');
  });
});
