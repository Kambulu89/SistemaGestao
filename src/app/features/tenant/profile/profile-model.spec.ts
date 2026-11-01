import { describe, expect, it } from 'vitest';
import { describeAgent, eventLabel, passwordIssue } from './profile-model';

describe('profile-model', () => {
  it('resume o user agent', () => {
    expect(describeAgent('Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0 Safari/537.36')).toBe(
      'Chrome em Linux',
    );
    expect(describeAgent('Mozilla/5.0 (Windows NT 10.0) Firefox/121.0')).toBe('Firefox em Windows');
    expect(describeAgent(null)).toBe('Dispositivo desconhecido');
    expect(describeAgent('curl/8.0')).toBe('curl/8.0');
  });

  it('traduz tipos conhecidos e mantém os desconhecidos', () => {
    expect(eventLabel('LOGIN_SUCCEEDED')).toBe('Sessão iniciada');
    expect(eventLabel('NOVO_TIPO')).toBe('NOVO_TIPO');
  });

  it('valida a palavra-passe localmente', () => {
    expect(passwordIssue('', 'x', 'x')).toContain('actual');
    expect(passwordIssue('a', '', '')).toContain('nova');
    expect(passwordIssue('a', 'a', 'a')).toContain('diferente');
    expect(passwordIssue('a', 'b', 'c')).toContain('confirmação');
    expect(passwordIssue('a', 'b', 'b')).toBeNull();
  });
});
