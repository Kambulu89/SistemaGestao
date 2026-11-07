export interface PlatformTenant {
  id: string;
  code: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  countryCode: string;
  defaultCurrency: string;
  locale: string;
  timezone: string;
  version: number;
  subscriptionStatus?: string;
}

export interface FeatureDefinition {
  code: string;
  module: string;
  kind: 'BOOLEAN' | 'LIMIT';
  description: string;
}

export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  trialDays: number;
  publishedAt: string | null;
  version: number;
  features: { featureCode: string; enabled: boolean; limitValue: number | null }[];
}

export interface TenantSubscriptionAdmin {
  subscription: {
    id: string;
    planId: string;
    planCode: string;
    status: string;
    startsAt: string;
    trialEndsAt: string | null;
    endsAt: string | null;
    version: number;
  } | null;
  effectiveStatus: string;
  entitlements: { code: string; enabled: boolean; limit: number | null; source: string }[];
  overrides: {
    featureCode: string;
    enabled: boolean;
    limitValue: number | null;
    reason: string;
    expiresAt: string | null;
  }[];
  history: {
    id: string;
    action: string;
    fromStatus: string | null;
    toStatus: string;
    planCode: string;
    reason: string | null;
    createdAt: string;
  }[];
}
