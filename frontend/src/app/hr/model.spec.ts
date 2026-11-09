import { visibleNavigation } from '../shell/navigation';
import { SENSITIVE_FIELD_KEYS, employeePayload } from './model';

describe('colaborador: envio da ficha', () => {
  it('na criação só vão os preenchidos; vazios e espaços ficam de fora', () => {
    expect(
      employeePayload(
        { code: ' C1 ', fullName: 'Ana', workEmail: '', taxId: '123456789' },
        null,
        true,
      ),
    ).toEqual({ code: 'C1', fullName: 'Ana', taxId: '123456789' });
  });

  it('na edição só vão as alterações, e limpar um campo envia null', () => {
    const original = { code: 'C1', fullName: 'Ana', workEmail: 'a@x.ao', taxId: null };
    expect(
      employeePayload({ ...original, fullName: 'Ana M.', workEmail: '' }, original, true),
    ).toEqual({ fullName: 'Ana M.', workEmail: null });
  });

  it('sem acesso a dados pessoais nunca envia campos sensíveis', () => {
    const body = employeePayload({ code: 'C1', taxId: 'X', bankIban: 'Y' }, null, false);
    expect(Object.keys(body)).toEqual(['code']);
    expect(SENSITIVE_FIELD_KEYS).toContain('bankIban');
  });

  it('o menu do RH aparece com hr.read em qualquer âmbito (a API filtra)', () => {
    const tenantOnly = visibleNavigation(
      (p, any) => (any ? p === 'hr.read' : false),
      (f) => f === 'hr',
      true,
      false,
    );
    expect(tenantOnly.find((g) => g.label === 'Pessoas e Talento')?.items[0].label).toBe(
      'Colaboradores',
    );
    const none = visibleNavigation(
      () => false,
      (f) => f === 'hr',
      true,
      false,
    );
    // Sem permissões de RH ficam as áreas do próprio: ausências e entrevistas atribuídas.
    expect(none.find((g) => g.label === 'Pessoas e Talento')?.items.map((i) => i.label)).toEqual([
      'Férias e ausências',
      'As minhas entrevistas',
    ]);
    const recruiter = visibleNavigation(
      (p, any) => (any ? p === 'hr.recruitment.read' : false),
      (f) => f === 'hr',
      true,
      false,
    );
    expect(
      recruiter.find((g) => g.label === 'Pessoas e Talento')?.items.map((i) => i.label),
    ).toEqual(['Férias e ausências', 'Vagas', 'Candidatos', 'As minhas entrevistas']);
    const payroll = visibleNavigation(
      (p, any) => (any ? p === 'hr.compensation.read' : false),
      (f) => f === 'hr',
      true,
      false,
    );
    expect(
      payroll.find((g) => g.label === 'Pessoas e Talento')?.items.map((i) => i.label),
    ).toContain('Compensação');
    const loans = visibleNavigation(
      (p, any) => (any ? p === 'hr.loans.read' : false),
      (f) => f === 'hr',
      true,
      false,
    );
    expect(loans.find((g) => g.label === 'Pessoas e Talento')?.items.map((i) => i.label)).toContain(
      'Adiantamentos e empréstimos',
    );
    const payroll2 = visibleNavigation(
      (p, any) => (any ? p === 'hr.payroll.read' : false),
      (f) => f === 'hr',
      true,
      false,
    );
    expect(
      payroll2.find((g) => g.label === 'Pessoas e Talento')?.items.map((i) => i.label),
    ).toContain('Processamento salarial');
    const noFeature = visibleNavigation(
      () => true,
      () => false,
      true,
      false,
    );
    expect(noFeature.some((g) => g.label === 'Pessoas e Talento')).toBe(false);
  });
});
