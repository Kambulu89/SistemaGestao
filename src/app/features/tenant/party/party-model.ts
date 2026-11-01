import type {
  AddressType,
  ContactType,
  DuplicateReason,
  PartyKind,
  PartyStatus,
  PersonDto,
} from './party.api';

export const KIND_LABEL: Record<PartyKind, string> = {
  PERSON: 'Pessoa',
  ORGANIZATION: 'Organização',
};

export const STATUS_LABEL: Record<PartyStatus, string> = {
  ACTIVE: 'Activa',
  INACTIVE: 'Inactiva',
};

export const CONTACT_LABEL: Record<ContactType, string> = {
  EMAIL: 'Email',
  PHONE: 'Telefone',
  WEBSITE: 'Sítio web',
};

export const ADDRESS_LABEL: Record<AddressType, string> = {
  BILLING: 'Facturação',
  DELIVERY: 'Entrega',
  OTHER: 'Outra',
};

export const REASON_LABEL: Record<DuplicateReason, string> = {
  IDENTITY: 'mesma identificação pessoal',
  TAX_ID: 'mesmo NIF',
  CONTACT: 'mesmo contacto',
};

/** Campos sensíveis da pessoa; o servidor omite-os quando uma regra de campo os esconde. */
export const SENSITIVE_PERSON_FIELDS = [
  'birthDate',
  'nationality',
  'identityType',
  'identityNumber',
] as const;

export type SensitivePersonField = (typeof SENSITIVE_PERSON_FIELDS)[number];

/** Um campo escondido não vem na resposta (≠ vir como `null`, que é «sem valor»). */
export function visibleSensitiveFields(person: PersonDto): ReadonlySet<SensitivePersonField> {
  return new Set(SENSITIVE_PERSON_FIELDS.filter((field) => field in person));
}

export function reasonsText(reasons: readonly DuplicateReason[]): string {
  return reasons.map((r) => REASON_LABEL[r]).join(', ');
}

/** Texto vazio → `null` (limpa o campo no servidor); com conteúdo → aparado. */
export function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export const COUNTRY = /^[A-Za-z]{2}$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
