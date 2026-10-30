import type { Channel, CustomerStatus } from './customers.api';

/** Dinheiro: texto não negativo com até 4 casas (o mesmo formato que o servidor exige; nunca `number`). */
const MONEY = /^\d{1,15}(\.\d{1,4})?$/;
export const isMoney = (value: string): boolean => MONEY.test(value.trim());

export const STATUS_LABEL: Readonly<Record<CustomerStatus, { label: string; tone: string }>> = {
  ACTIVE: { label: 'Activo', tone: 'success' },
  BLOCKED: { label: 'Bloqueado', tone: 'danger' },
  INACTIVE: { label: 'Inactivo', tone: 'neutral' },
};

export const CHANNEL_LABEL: Readonly<Record<Channel, string>> = {
  CALL: 'Chamada',
  EMAIL: 'Email',
  MEETING: 'Reunião',
  NOTE: 'Nota',
};

export const ERROR_TEXT: Readonly<Record<string, string>> = {
  CUSTOMER_EXISTS: 'Esta pessoa ou organização já é cliente desta organização.',
  CUSTOMER_CODE_TAKEN: 'Já existe um cliente com este código.',
  SEGMENT_CODE_TAKEN: 'Já existe um segmento com este código.',
  ALREADY_BLOCKED: 'O cliente já está bloqueado.',
  NOT_BLOCKED: 'O cliente não está bloqueado.',
  PERMISSION_DENIED: 'Não tem permissão para esta operação.',
};

/** Texto de um erro da API: a mensagem própria dos clientes quando há código conhecido. */
export function customerError(error: unknown, fallback: string): string {
  const code = (error as { code?: string } | null)?.code;
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
  // Os erros de validação dizem que campo falhou: mostrar isso, não só «verifique os campos».
  const fields = (error as { fieldErrors?: readonly { message: string }[] } | null)?.fieldErrors;
  if (fields && fields.length > 0) return fields.map((f) => f.message).join(' ');
  const message = (error as { message?: string } | null)?.message;
  return message && message.length > 0 ? message : fallback;
}

/** `datetime-local` (hora local) → ISO 8601 UTC; `null` se vazio ou inválido. */
export function localToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
