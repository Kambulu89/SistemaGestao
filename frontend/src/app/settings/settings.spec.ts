import { type CompanyProfile, profilePayload } from './company-profile';
import { settingsPayload, type TenantSettings } from './company-settings';
import { groupIban, REF_KINDS, weekdaysLabel } from './reference-kinds';

const profile: CompanyProfile = {
  version: 1,
  logoAttachmentId: null,
  displayName: 'Empresa',
  email: null,
  tenant: {
    name: 'Empresa',
    code: 'EMP',
    locale: 'pt-AO',
    timezone: 'Africa/Luanda',
    defaultCurrency: 'AOA',
    countryCode: 'AO',
  },
};

describe('perfil da empresa', () => {
  it('envia só o que mudou, aparado, com vazio como null e a regionalização da empresa', () => {
    expect(
      profilePayload(
        {
          ...profile,
          displayName: ' Empresa ',
          email: ' geral@empresa.ao ',
          sector: '',
          locale: 'pt-AO',
          timezone: 'UTC',
          defaultCurrency: 'AOA',
          logoAttachmentId: 'logo',
        },
        profile,
      ),
    ).toEqual({ email: 'geral@empresa.ao', timezone: 'UTC', logoAttachmentId: 'logo' });
  });
});

describe('configurações', () => {
  const s: TenantSettings = {
    amountScale: 2,
    quantityScale: 3,
    priceScale: 4,
    roundingMode: 'HALF_UP',
    invitationTtlDays: 7,
    notifyApprovalPending: true,
    notifyApprovalDecided: true,
    bankAccountWorkflowId: null,
    version: 0,
  };
  it('converte números vindos do formulário e ignora o que não mudou', () => {
    expect(
      settingsPayload(
        { ...s, amountScale: '2', invitationTtlDays: '3', notifyApprovalPending: false },
        s,
      ),
    ).toEqual({ invitationTtlDays: 3, notifyApprovalPending: false });
  });
});

describe('tabelas de referência', () => {
  it('dados bancários são imutáveis; só "por omissão" se altera', () => {
    const editable = REF_KINDS['bank-accounts'].fields
      .filter((f) => !f.immutable)
      .map((f) => f.key);
    expect(editable).toEqual(['isDefault']);
  });
  it('IBAN em grupos de 4 e dias da semana por extenso', () => {
    expect(groupIban('AO06004000001234567890102')).toBe('AO06 0040 0000 1234 5678 9010 2');
    expect(weekdaysLabel([6, 7])).toBe('Sábado, Domingo');
  });
});
