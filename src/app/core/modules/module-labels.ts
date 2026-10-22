import type { SubscriptionStatus } from '../subscription/subscription.model';
import type { TenantStatus } from '../tenant-context/tenant.model';
import type { FeatureAccessStatus, ModuleAccessStatus } from './module-access';
import type { ModuleKind, ModuleLifecycle, ModuleScope } from './module.model';

/** Textos e tom visual (compatível com o Badge) de cada estado do domínio. */
export type LabelTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

export interface StatusLabel {
  readonly label: string;
  readonly tone: LabelTone;
  readonly hint: string;
}

export const ACCESS_LABELS: Record<ModuleAccessStatus, StatusLabel> = {
  accessible: { label: 'Acessível', tone: 'success', hint: 'Contratado, activo e autorizado.' },
  retired: { label: 'Retirado', tone: 'danger', hint: 'O módulo foi retirado do catálogo.' },
  'subscription-inactive': {
    label: 'Subscrição inactiva',
    tone: 'danger',
    hint: 'A subscrição está suspensa ou cancelada.',
  },
  'not-contracted': {
    label: 'Não contratado',
    tone: 'neutral',
    hint: 'Não está incluído na subscrição.',
  },
  inactive: {
    label: 'Desactivado',
    tone: 'warning',
    hint: 'Contratado, mas o tenant ainda não o activou.',
  },
  'missing-dependency': {
    label: 'Dependência em falta',
    tone: 'warning',
    hint: 'Falta contratar ou activar um módulo de que depende.',
  },
  'flag-disabled': {
    label: 'Feature flag desligada',
    tone: 'neutral',
    hint: 'A funcionalidade está desligada para este tenant.',
  },
  forbidden: {
    label: 'Sem permissão',
    tone: 'danger',
    hint: 'O seu perfil não tem a permissão de acesso.',
  },
};

export const FEATURE_LABELS: Record<FeatureAccessStatus, StatusLabel> = {
  available: { label: 'Disponível', tone: 'success', hint: 'Pode ser usada.' },
  'module-unavailable': {
    label: 'Módulo indisponível',
    tone: 'neutral',
    hint: 'O módulo não está acessível.',
  },
  'not-enabled': {
    label: 'Não incluída',
    tone: 'neutral',
    hint: 'O tenant não a tem disponibilizada.',
  },
  'flag-disabled': {
    label: 'Flag desligada',
    tone: 'neutral',
    hint: 'Controlada por feature flag desligada.',
  },
  forbidden: { label: 'Sem permissão', tone: 'danger', hint: 'Falta a permissão necessária.' },
};

export const LIFECYCLE_LABELS: Record<ModuleLifecycle, { label: string; tone: LabelTone }> = {
  planned: { label: 'Planeado', tone: 'neutral' },
  beta: { label: 'Beta', tone: 'brand' },
  stable: { label: 'Estável', tone: 'success' },
  deprecated: { label: 'Descontinuado', tone: 'warning' },
  retired: { label: 'Retirado', tone: 'danger' },
};

export const KIND_LABELS: Record<ModuleKind, string> = {
  foundation: 'Fundação',
  module: 'Módulo',
};

export const SCOPE_LABELS: Record<ModuleScope, string> = {
  platform: 'Plataforma',
  tenant: 'Tenant',
};

export const SUBSCRIPTION_LABELS: Record<SubscriptionStatus, { label: string; tone: LabelTone }> = {
  active: { label: 'Activa', tone: 'success' },
  trial: { label: 'Em teste', tone: 'brand' },
  past_due: { label: 'Pagamento em atraso', tone: 'warning' },
  suspended: { label: 'Suspensa', tone: 'danger' },
  cancelled: { label: 'Cancelada', tone: 'neutral' },
};

export const TENANT_STATUS_LABELS: Record<TenantStatus, { label: string; tone: LabelTone }> = {
  provisioning: { label: 'Em preparação', tone: 'neutral' },
  active: { label: 'Activo', tone: 'success' },
  trial: { label: 'Teste', tone: 'brand' },
  suspended: { label: 'Suspenso', tone: 'danger' },
  closing: { label: 'Em encerramento', tone: 'danger' },
  closed: { label: 'Encerrado', tone: 'danger' },
};
