/** Colaborador (7.1). Os campos sensíveis só vêm preenchidos quando a API diz `sensitiveVisible`. */
export interface Employee {
  id: string;
  version: number;
  code: string;
  fullName: string;
  workEmail: string | null;
  workPhone: string | null;
  legalEntityId: string;
  branchId: string | null;
  departmentId: string | null;
  positionId: string | null;
  managerId: string | null;
  costCenterId: string | null;
  membershipId: string | null;
  hireDate: string;
  status: EmployeeStatus;
  legalEntity: { code: string; name: string };
  branchName: string | null;
  departmentName: string | null;
  positionName: string | null;
  costCenterCode: string | null;
  manager: { code: string; fullName: string } | null;
  sensitiveVisible: boolean;
  directReports?: number;
  access?: { manage: boolean; sensitive: boolean };
  [key: string]: unknown;
}

export type EmployeeStatus = 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
export const EMPLOYEE_STATUS: Record<EmployeeStatus, string> = {
  ACTIVE: 'Activo',
  SUSPENDED: 'Suspenso',
  TERMINATED: 'Cessado',
};

export type RefKind =
  | 'legalEntities'
  | 'branches'
  | 'departments'
  | 'positions'
  | 'costCenters'
  | 'employees'
  | 'members';

export interface EmployeeField {
  key: string;
  label: string;
  type: 'text' | 'date' | 'email' | 'select' | 'ref';
  required?: boolean;
  options?: { value: string; label: string }[];
  ref?: RefKind;
  hint?: string;
}

export interface EmployeeSection {
  id: string;
  title: string;
  description: string;
  sensitive: boolean;
  fields: EmployeeField[];
}

const ID_DOCUMENTS = [
  { value: 'BI', label: 'Bilhete de identidade' },
  { value: 'PASSPORT', label: 'Passaporte' },
  { value: 'RESIDENCE_CARD', label: 'Cartão de residente' },
  { value: 'OTHER', label: 'Outro' },
];
const EDUCATION = [
  { value: 'NONE', label: 'Sem escolaridade' },
  { value: 'PRIMARY', label: 'Ensino primário' },
  { value: 'SECONDARY', label: 'Ensino secundário' },
  { value: 'TECHNICAL', label: 'Ensino técnico-profissional' },
  { value: 'BACHELOR', label: 'Bacharelato' },
  { value: 'LICENTIATE', label: 'Licenciatura' },
  { value: 'MASTER', label: 'Mestrado' },
  { value: 'DOCTORATE', label: 'Doutoramento' },
];

/** Secções da ficha 360; as sensíveis só aparecem a quem tem `hr.sensitive` no âmbito do colaborador. */
export const EMPLOYEE_SECTIONS: EmployeeSection[] = [
  {
    id: 'identificacao',
    title: 'Identificação',
    description: 'Código interno, nome e contactos profissionais.',
    sensitive: false,
    fields: [
      { key: 'code', label: 'Código', type: 'text', required: true },
      { key: 'fullName', label: 'Nome completo', type: 'text', required: true },
      { key: 'workEmail', label: 'Email profissional', type: 'email' },
      { key: 'workPhone', label: 'Telefone profissional', type: 'text' },
      { key: 'hireDate', label: 'Data de admissão', type: 'date', required: true },
    ],
  },
  {
    id: 'organizacao',
    title: 'Organização',
    description: 'Tudo da mesma entidade legal (o servidor verifica).',
    sensitive: false,
    fields: [
      {
        key: 'legalEntityId',
        label: 'Entidade legal',
        type: 'ref',
        ref: 'legalEntities',
        required: true,
      },
      { key: 'branchId', label: 'Filial', type: 'ref', ref: 'branches' },
      { key: 'departmentId', label: 'Departamento', type: 'ref', ref: 'departments' },
      { key: 'positionId', label: 'Cargo', type: 'ref', ref: 'positions' },
      { key: 'managerId', label: 'Superior hierárquico', type: 'ref', ref: 'employees' },
      { key: 'costCenterId', label: 'Centro de custo', type: 'ref', ref: 'costCenters' },
      {
        key: 'membershipId',
        label: 'Conta de utilizador (opcional)',
        type: 'ref',
        ref: 'members',
        hint: 'Liga a ficha a um membro da empresa (self-service). O colaborador não precisa de conta.',
      },
    ],
  },
  {
    id: 'pessoais',
    title: 'Dados pessoais',
    description: 'Reservado: só quem tem acesso a dados pessoais deste colaborador.',
    sensitive: true,
    fields: [
      { key: 'birthDate', label: 'Data de nascimento', type: 'date' },
      { key: 'nationality', label: 'Nacionalidade (ISO, ex.: AO)', type: 'text' },
      {
        key: 'idDocumentType',
        label: 'Documento de identificação',
        type: 'select',
        options: ID_DOCUMENTS,
      },
      { key: 'idDocumentNumber', label: 'N.º do documento', type: 'text' },
      { key: 'idDocumentExpiry', label: 'Validade do documento', type: 'date' },
      { key: 'taxId', label: 'NIF', type: 'text' },
      { key: 'socialSecurityNumber', label: 'N.º de segurança social (INSS)', type: 'text' },
      { key: 'personalEmail', label: 'Email pessoal', type: 'email' },
      { key: 'personalPhone', label: 'Telefone pessoal', type: 'text' },
    ],
  },
  {
    id: 'morada',
    title: 'Morada',
    description: 'Residência do colaborador.',
    sensitive: true,
    fields: [
      { key: 'addressLine', label: 'Morada', type: 'text' },
      { key: 'city', label: 'Cidade / município', type: 'text' },
      { key: 'province', label: 'Província', type: 'text' },
      { key: 'countryCode', label: 'País (ISO)', type: 'text' },
    ],
  },
  {
    id: 'emergencia',
    title: 'Contacto de emergência',
    description: 'Pessoa a contactar em caso de urgência.',
    sensitive: true,
    fields: [
      { key: 'emergencyName', label: 'Nome', type: 'text' },
      { key: 'emergencyPhone', label: 'Telefone', type: 'text' },
      { key: 'emergencyRelation', label: 'Relação', type: 'text' },
    ],
  },
  {
    id: 'formacao',
    title: 'Formação',
    description: 'Escolaridade e área de formação.',
    sensitive: true,
    fields: [
      { key: 'educationLevel', label: 'Nível', type: 'select', options: EDUCATION },
      { key: 'educationField', label: 'Área', type: 'text' },
    ],
  },
  {
    id: 'banco',
    title: 'Dados bancários',
    description: 'Conta para pagamento do salário (IBAN verificado).',
    sensitive: true,
    fields: [
      { key: 'bankName', label: 'Banco', type: 'text' },
      { key: 'bankIban', label: 'IBAN', type: 'text' },
    ],
  },
];

export const ALL_FIELDS = EMPLOYEE_SECTIONS.flatMap((s) => s.fields);
export const SENSITIVE_FIELD_KEYS = EMPLOYEE_SECTIONS.filter((s) => s.sensitive).flatMap((s) =>
  s.fields.map((f) => f.key),
);

/** Só os campos alterados (em edição) ou preenchidos (em criação); vazios passam a `null`. */
export function employeePayload(
  form: Record<string, unknown>,
  original: Record<string, unknown> | null,
  includeSensitive: boolean,
) {
  const out: Record<string, unknown> = {};
  for (const f of ALL_FIELDS) {
    if (!includeSensitive && SENSITIVE_FIELD_KEYS.includes(f.key)) continue;
    let v = form[f.key];
    if (typeof v === 'string') v = v.trim();
    if (v === '' || v === undefined) v = null;
    if (original) {
      if ((original[f.key] ?? null) !== v) out[f.key] = v;
    } else if (v !== null) out[f.key] = v;
  }
  return out;
}
