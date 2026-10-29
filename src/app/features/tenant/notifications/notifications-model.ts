import type { Tone } from '../../../shared/ui/badge/badge';
import { detailedErrorMessage } from '../../../core/api/error-message';
import type { Channel, Classification, DeliveryStatus } from './notifications.api';

export const CHANNEL_LABEL: Readonly<Record<Channel, string>> = {
  IN_APP: 'Centro de notificações',
  EMAIL: 'Email',
  SMS: 'SMS',
  WHATSAPP: 'WhatsApp',
  PUSH: 'Notificação push',
};

export const CLASSIFICATION: Readonly<Record<Classification, { label: string; tone: Tone }>> = {
  MANDATORY: { label: 'Obrigatória', tone: 'danger' },
  OPERATIONAL: { label: 'Operacional', tone: 'neutral' },
  PROMOTIONAL: { label: 'Promocional', tone: 'brand' },
};

/** `SENT` quer dizer «aceite pelo fornecedor»; só `DELIVERED` é entrega confirmada. */
export const DELIVERY_STATUS: Readonly<Record<DeliveryStatus, { label: string; tone: Tone }>> = {
  QUEUED: { label: 'Na fila', tone: 'neutral' },
  SENT: { label: 'Aceite pelo fornecedor', tone: 'brand' },
  DELIVERED: { label: 'Entregue', tone: 'success' },
  FAILED: { label: 'Falhou', tone: 'danger' },
};

const NOTIFICATION_ERRORS: Readonly<Record<string, string>> = {
  RESOURCE_ACCESS_REVOKED: 'Já não tem acesso ao recurso desta notificação.',
  NO_RESOURCE: 'Esta notificação não tem um recurso para abrir.',
  MANDATORY_NOTIFICATION: 'Um aviso obrigatório não se desactiva.',
  INVALID_QUIET_HOURS: 'Horas de silêncio inválidas (HH:MM, início diferente do fim).',
  DELIVERY_NOT_FAILED: 'Só se repete uma entrega falhada.',
  PROVIDER_NOT_CONFIGURED: 'Não há fornecedor configurado para este canal.',
  OPTED_OUT: 'O destinatário recusou comunicações promocionais.',
  AMBIGUOUS_NO_DEDUPE:
    'Resultado desconhecido e o fornecedor não deduplica: repetir pode duplicar.',
  UNKNOWN_RECIPIENT: 'O destinatário não é um membro activo.',
};

export function notificationError(error: unknown, fallback: string): string {
  const code = (error as { code?: string } | null)?.code;
  if (code && NOTIFICATION_ERRORS[code]) return NOTIFICATION_ERRORS[code];
  const fields = (error as { fieldErrors?: readonly { code: string; message: string }[] } | null)
    ?.fieldErrors;
  if (fields && fields.length > 0) {
    return fields.map((f) => NOTIFICATION_ERRORS[f.code] ?? f.message).join(' ');
  }
  return detailedErrorMessage(error, fallback);
}

/** Texto curto do erro de uma entrega, em português quando o código é conhecido. */
export const deliveryErrorText = (code: string | null, message: string | null): string =>
  (code && NOTIFICATION_ERRORS[code]) || message || '—';

/** `HH:MM` válido. */
export const isHhmm = (value: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim());
