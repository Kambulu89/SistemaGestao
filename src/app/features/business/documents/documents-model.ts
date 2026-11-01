import { detailedErrorMessage } from '../../../core/api/error-message';
import type { Tone } from '../../../shared/ui/badge/badge';
import type {
  AttachmentStatus,
  TemplateChannel,
  TemplateStatus,
  VariableDef,
  VariableType,
  Visibility,
} from './documents.api';

export const STATUS: Readonly<Record<AttachmentStatus, { label: string; tone: Tone }>> = {
  PENDING: { label: 'Por verificar', tone: 'neutral' },
  QUARANTINED: { label: 'Em quarentena', tone: 'danger' },
  AVAILABLE: { label: 'Disponível', tone: 'success' },
  REJECTED: { label: 'Rejeitado', tone: 'danger' },
  DELETED: { label: 'Apagado', tone: 'neutral' },
};

export const VISIBILITY: Readonly<Record<Visibility, string>> = {
  PRIVATE: 'Privado (só eu)',
  TENANT: 'Toda a organização',
  RESOURCE: 'Quem vê o recurso',
};

export const CHANNEL: Readonly<Record<TemplateChannel, string>> = {
  DOCUMENT: 'Documento (PDF)',
  EMAIL: 'Email',
  SMS: 'SMS',
  WHATSAPP: 'WhatsApp',
  PUSH: 'Notificação push',
};

export const TEMPLATE_STATUS: Readonly<Record<TemplateStatus, { label: string; tone: Tone }>> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  PUBLISHED: { label: 'Publicada', tone: 'success' },
  RETIRED: { label: 'Retirada', tone: 'neutral' },
};

export const VARIABLE_TYPES: readonly { value: VariableType; label: string }[] = [
  { value: 'string', label: 'Texto' },
  { value: 'number', label: 'Número' },
  { value: 'decimal', label: 'Decimal' },
  { value: 'date', label: 'Data (AAAA-MM-DD)' },
];

const ERRORS: Readonly<Record<string, string>> = {
  QUOTA_EXCEEDED: 'O espaço de armazenamento da organização não chega para este ficheiro.',
  FILE_TOO_LARGE: 'O ficheiro excede o tamanho máximo permitido.',
  MIME_NOT_ALLOWED: 'Este tipo de ficheiro não é permitido.',
  MIME_MISMATCH: 'O conteúdo do ficheiro não corresponde ao tipo indicado.',
  SIZE_MISMATCH: 'O tamanho recebido não coincide com o do ficheiro. Tente de novo.',
  CHECKSUM_MISMATCH: 'O ficheiro chegou alterado ao servidor. Tente de novo.',
  ATTACHMENT_UNAVAILABLE: 'O ficheiro não está disponível para descarga.',
  ATTACHMENT_NOT_AVAILABLE: 'O ficheiro ainda não foi verificado.',
  ATTACHMENT_ALREADY_LINKED: 'Este ficheiro já pertence a outra versão.',
  UPLOAD_EXPIRED: 'O pedido de envio expirou. Comece de novo.',
  SCAN_UNAVAILABLE: 'A análise do ficheiro não está disponível. Tente de novo daqui a pouco.',
  DOCUMENT_RETENTION: 'O documento está retido e não pode ser apagado.',
  DOCUMENT_LEGAL_HOLD: 'O documento está em retenção legal e não pode ser apagado.',
  VISIBILITY_WIDENS_ACCESS:
    'Este documento só pode ser visto por quem vê o recurso a que pertence.',
  TEMPLATE_CODE_TAKEN: 'Já existe um modelo com este código.',
  TEMPLATE_SYNTAX: 'O modelo só aceita variáveis simples no formato {{nome}}.',
  TEMPLATE_UNKNOWN_VARIABLE: 'O modelo usa uma variável que não foi declarada.',
  TEMPLATE_NOT_PUBLISHED: 'O modelo ainda não tem uma versão publicada.',
  TEMPLATE_NOT_DOCUMENT: 'Só os modelos de documento geram PDF.',
  TEMPLATE_VERSION_IMMUTABLE: 'Uma versão publicada não se altera. Crie uma nova versão.',
  STALE_VERSION: 'Os dados mudaram entretanto. Recarregue e tente de novo.',
};

export function documentError(error: unknown, fallback: string): string {
  const code = (error as { code?: string } | null)?.code;
  if (code && ERRORS[code]) return ERRORS[code];
  const fields = (error as { fieldErrors?: readonly { code: string; message: string }[] } | null)
    ?.fieldErrors;
  if (fields && fields.length > 0) return fields.map((f) => ERRORS[f.code] ?? f.message).join(' ');
  return detailedErrorMessage(error, fallback);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Texto do estado do envio para a barra de progresso. */
export function uploadLabel(stage: string, percent = 0): string {
  switch (stage) {
    case 'hashing':
      return 'A calcular a impressão digital do ficheiro…';
    case 'preparing':
      return 'A pedir autorização…';
    case 'uploading':
      return `A enviar… ${percent}%`;
    case 'verifying':
      return 'A verificar o conteúdo e a analisar…';
    default:
      return '';
  }
}

/** Mensagem do estado final de um anexo que não ficou disponível (a quarentena é sempre visível). */
export function unavailableText(status: AttachmentStatus, rejectCode: string | null): string {
  if (status === 'QUARANTINED') {
    return 'O ficheiro foi colocado em quarentena e não pode ser usado nem descarregado.';
  }
  if (status === 'REJECTED') return ERRORS[rejectCode ?? ''] ?? 'O ficheiro foi rejeitado.';
  return '';
}

/** Valores de teste → o corpo do pedido (tudo texto; o servidor valida pelo tipo). */
export const VARIABLE_NAME = /^[a-z][A-Za-z0-9_]{0,59}$/;

/** Variáveis `{{nome}}` usadas no corpo, na ordem em que aparecem e sem repetições. */
export function usedVariables(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)) {
    const name = match[1] as string;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** Acrescenta as variáveis usadas no corpo e ainda não declaradas (texto, obrigatórias). */
export function declareUsed(body: string, declared: readonly VariableDef[]): VariableDef[] {
  const missing = usedVariables(body)
    .filter((name) => VARIABLE_NAME.test(name) && !declared.some((v) => v.name === name))
    .map((name): VariableDef => ({ name, label: name, type: 'string', required: true }));
  return [...declared, ...missing];
}
