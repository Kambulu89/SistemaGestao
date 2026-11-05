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
};

const TONES: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-800',
  APPROVED: 'bg-green-100 text-green-800',
  TRIALING: 'bg-sky-100 text-sky-800',
  PENDING: 'bg-amber-100 text-amber-800',
  INVITED: 'bg-amber-100 text-amber-800',
  DRAFT: 'bg-slate-100 text-slate-700',
};

export const statusLabel = (code: string | null | undefined) =>
  code ? (STATUS_LABELS[code] ?? code) : '—';
export const statusTone = (code: string | null | undefined) =>
  (code && TONES[code]) || 'bg-slate-100 text-slate-700';

export const SCOPE_LABELS: Record<string, string> = {
  TENANT: 'Toda a empresa',
  OWN: 'Só registos próprios',
  LEGAL_ENTITY: 'Entidade legal',
  BRANCH: 'Filial',
  DEPARTMENT: 'Departamento (e subdepartamentos)',
};
