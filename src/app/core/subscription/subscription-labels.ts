import {
  SUBSCRIPTION_LABELS,
  TENANT_STATUS_LABELS,
  type LabelTone,
} from '../modules/module-labels';
import {
  SUBSCRIPTION_STATUS,
  type BackendSubscriptionStatus,
  type BillingInterval,
} from './subscription-dto';

export const subscriptionLabel = (status: BackendSubscriptionStatus) =>
  SUBSCRIPTION_LABELS[SUBSCRIPTION_STATUS[status]];

const LIFECYCLE: Record<string, keyof typeof TENANT_STATUS_LABELS> = {
  PROVISIONING: 'provisioning',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CLOSING: 'closing',
  CLOSED: 'closed',
};

export const tenantLifecycleLabel = (status: string) =>
  TENANT_STATUS_LABELS[LIFECYCLE[status] ?? 'suspended'];

export const PLAN_STATUS_LABELS: Record<
  'DRAFT' | 'PUBLISHED' | 'RETIRED',
  { label: string; tone: LabelTone }
> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  PUBLISHED: { label: 'Publicado', tone: 'success' },
  RETIRED: { label: 'Retirado', tone: 'danger' },
};

export const CHANGE_LABELS: Record<string, string> = {
  ASSIGNED: 'Plano atribuído',
  UPGRADED: 'Upgrade',
  DOWNGRADED: 'Downgrade',
  PLAN_CHANGED: 'Mudança de plano',
  STATUS_CHANGED: 'Mudança de estado',
};

const INTERVAL: Record<BillingInterval, string> = { MONTH: 'mês', YEAR: 'ano' };

/** O preço é um decimal em string: apresenta-se tal como veio, nunca convertido para número. */
export const formatPrice = (price: string, currency: string, interval: BillingInterval): string =>
  `${price} ${currency} / ${INTERVAL[interval]}`;

export const formatLimit = (limit: number | null): string =>
  limit === null ? 'Ilimitado' : String(limit);
