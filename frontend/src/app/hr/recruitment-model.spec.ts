import { describe, expect, it } from 'vitest';
import {
  type Offer,
  activeOffer,
  canOffer,
  offerActions,
  onboardingProgress,
  requisitionPayload,
  STAGE_ACTIONS,
  suggestedChecklist,
  withinRange,
} from './recruitment-model';

const offer = (status: Offer['status'], extra: Partial<Offer> = {}): Offer => ({
  id: 'o',
  version: 1,
  applicationId: 'a',
  currency: 'AOA',
  salary: '100.00',
  startDate: '2030-01-01',
  expiresOn: null,
  conditions: null,
  status,
  approvalRequestId: null,
  rejectionReason: null,
  employeeId: null,
  ...extra,
});

describe('recrutamento (modelo)', () => {
  it('salário dentro da remuneração autorizada sem arredondamentos de float', () => {
    expect(withinRange('0.30', '0.30', '0.30')).toBe(true);
    expect(withinRange('250000.01', '150000', '250000')).toBe(false);
    expect(withinRange('150000', '150000.00', '250000')).toBe(true);
    expect(withinRange('abc', '1', '2')).toBe(false);
    expect(withinRange(null, '1', '2')).toBe(false);
  });

  it('acções da proposta por estado, permissão e modo de aprovação', () => {
    const manage = { manage: true, approve: false };
    expect(offerActions(offer('DRAFT'), manage, 'DIRECT')).toEqual(['edit', 'submit', 'cancel']);
    expect(offerActions(offer('PENDING_APPROVAL', { canApprove: true }), manage, 'DIRECT')).toEqual(
      ['approve', 'reject'],
    );
    // No workflow decide-se na caixa de aprovações, não aqui.
    expect(
      offerActions(offer('PENDING_APPROVAL', { canApprove: true }), manage, 'WORKFLOW'),
    ).toEqual([]);
    expect(offerActions(offer('APPROVED'), manage, 'DIRECT')).toEqual([
      'accept',
      'decline',
      'cancel',
    ]);
    expect(offerActions(offer('ACCEPTED'), manage, 'DIRECT')).toEqual(['hire', 'cancel']);
    expect(offerActions(offer('ACCEPTED'), { manage: false, approve: true }, 'DIRECT')).toEqual([]);
    expect(offerActions(offer('HIRED'), manage, 'DIRECT')).toEqual([]);
  });

  it('uma proposta em curso por candidatura; nova só com vaga aberta e etapa certa', () => {
    const req = { status: 'OPEN' as const } as never;
    expect(activeOffer([offer('DECLINED'), offer('APPROVED', { id: 'x' })])?.id).toBe('x');
    expect(canOffer({ stage: 'INTERVIEW', offers: [offer('DECLINED')], requisition: req })).toBe(
      true,
    );
    expect(canOffer({ stage: 'INTERVIEW', offers: [offer('DRAFT')], requisition: req })).toBe(
      false,
    );
    expect(canOffer({ stage: 'APPLIED', offers: [], requisition: req })).toBe(false);
    expect(
      canOffer({ stage: 'INTERVIEW', offers: [], requisition: { status: 'FILLED' } as never }),
    ).toBe(false);
  });

  it('etapas: contratar nunca é manual e estados finais não têm acções', () => {
    for (const next of Object.values(STAGE_ACTIONS)) expect(next).not.toContain('HIRED');
    expect(STAGE_ACTIONS.REJECTED).toEqual([]);
  });

  it('vaga: só os campos alterados; quantidade como número; vazios a null', () => {
    expect(
      requisitionPayload({ code: ' V1 ', title: 'T', quantity: '2', requirements: '  ' }, null),
    ).toEqual({ code: 'V1', title: 'T', quantity: 2 });
    expect(
      requisitionPayload(
        { code: 'V1', title: 'Novo', quantity: 2, deadline: '' },
        { code: 'V1', title: 'T', quantity: 2, deadline: '2030-01-01' },
      ),
    ).toEqual({ title: 'Novo', deadline: null });
  });

  it('checklist sugerida cobre as quatro categorias e o progresso conta não aplicáveis', () => {
    expect(suggestedChecklist().map((i) => i.category)).toEqual([
      'DOCUMENTS',
      'ACCOUNT',
      'ACCESS',
      'EQUIPMENT',
    ]);
    expect(
      onboardingProgress([{ status: 'DONE' }, { status: 'NOT_APPLICABLE' }, { status: 'PENDING' }]),
    ).toEqual({ done: 2, total: 3, percent: 67 });
    expect(onboardingProgress([])).toEqual({ done: 0, total: 0, percent: 0 });
  });
});
