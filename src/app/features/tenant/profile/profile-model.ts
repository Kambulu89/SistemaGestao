import type { Severity } from './profile.api';

const EVENT_LABEL: Readonly<Record<string, string>> = {
  LOGIN_SUCCEEDED: 'Sessão iniciada',
  LOGIN_FAILED: 'Tentativa de início de sessão falhada',
  LOGIN_RATE_LIMITED: 'Início de sessão bloqueado por excesso de tentativas',
  LOGOUT: 'Sessão terminada',
  REAUTHENTICATION_FAILED: 'Reautenticação falhada',
  PASSWORD_RESET_REQUESTED: 'Recuperação de palavra-passe pedida',
  PASSWORD_RESET_COMPLETED: 'Palavra-passe redefinida',
  PASSWORD_CHANGED: 'Palavra-passe alterada',
  USER_CREATED: 'Conta criada',
  USER_STATUS_CHANGED: 'Estado da conta alterado',
  CSRF_REJECTED: 'Pedido rejeitado (protecção CSRF)',
  ORIGIN_REJECTED: 'Pedido rejeitado (origem não permitida)',
  TENANT_ACCESS_DENIED: 'Acesso a organização negado',
  PERMISSION_DENIED: 'Operação sem permissão',
};

export const eventLabel = (type: string): string => EVENT_LABEL[type] ?? type;

export const SEVERITY: Readonly<
  Record<Severity, { label: string; tone: 'neutral' | 'brand' | 'danger' }>
> = {
  INFO: { label: 'Informação', tone: 'neutral' },
  WARN: { label: 'Aviso', tone: 'brand' },
  HIGH: { label: 'Grave', tone: 'danger' },
};

/** «Chrome em Linux» a partir do cabeçalho; sem reconhecer, devolve o início do texto original. */
export function describeAgent(agent: string | null): string {
  if (!agent) return 'Dispositivo desconhecido';
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Firefox\//.test(agent)
      ? 'Firefox'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : null;
  const system = /Windows/.test(agent)
    ? 'Windows'
    : /Android/.test(agent)
      ? 'Android'
      : /iPhone|iPad/.test(agent)
        ? 'iOS'
        : /Mac OS X/.test(agent)
          ? 'macOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : null;
  if (browser && system) return `${browser} em ${system}`;
  return browser ?? system ?? agent.slice(0, 60);
}

/** Validação local do formulário de palavra-passe; a política de complexidade é do servidor. */
export function passwordIssue(current: string, next: string, confirm: string): string | null {
  if (!current) return 'Indique a palavra-passe actual.';
  if (!next) return 'Indique a nova palavra-passe.';
  if (next === current) return 'A nova palavra-passe tem de ser diferente da actual.';
  if (next !== confirm) return 'A confirmação não coincide com a nova palavra-passe.';
  return null;
}
