/** Textos apresentados para códigos estáveis da API. */
export const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Activo',
  INACTIVE: 'Inactivo',
  INVITED: 'Convidado',
  SUSPENDED: 'Suspenso',
  REVOKED: 'Revogado',
  ARCHIVED: 'Arquivado',
  DRAFT: 'Rascunho',
  RETIRED: 'Retirado',
  TRIALING: 'Período experimental',
  CANCELLED: 'Cancelado',
  EXPIRED: 'Expirado',
  NONE: 'Sem subscrição',
  PENDING: 'Pendente',
  APPROVED: 'Aprovado',
  REJECTED: 'Rejeitado',
  PENDING_APPROVAL: 'Aguarda aprovação',
  CLOSED: 'Fechada',
  DISPOSED: 'Abatido',
  OPEN: 'Aberta',
  FILLED: 'Preenchida',
  ACCEPTED: 'Aceite',
  DECLINED: 'Recusada',
  HIRED: 'Contratado',
};

const TONES: Record<string, string> = {
  ACTIVE: 'bg-success-soft text-success-text',
  APPROVED: 'bg-success-soft text-success-text',
  TRIALING: 'bg-info-soft text-info-text',
  PENDING: 'bg-warning-soft text-warning-text',
  PENDING_APPROVAL: 'bg-warning-soft text-warning-text',
  INVITED: 'bg-warning-soft text-warning-text',
  DRAFT: 'bg-surface-2 text-fg',
  OPEN: 'bg-success-soft text-success-text',
  FILLED: 'bg-info-soft text-info-text',
  ACCEPTED: 'bg-success-soft text-success-text',
  HIRED: 'bg-success-soft text-success-text',
};

export const statusLabel = (code: string | null | undefined) =>
  code ? (STATUS_LABELS[code] ?? code) : '—';
export const statusTone = (code: string | null | undefined) =>
  (code && TONES[code]) || 'bg-surface-2 text-fg';

export const SCOPE_LABELS: Record<string, string> = {
  TENANT: 'Toda a empresa',
  OWN: 'Só registos próprios',
  LEGAL_ENTITY: 'Entidade legal',
  BRANCH: 'Filial',
  DEPARTMENT: 'Departamento (e subdepartamentos)',
};
