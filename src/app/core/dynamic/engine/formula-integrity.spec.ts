import { defineEntity, defineField, type FieldInput } from './define-entity';
import { checkPublishable, diffField } from './definition-compat';
import { validateEntityDefinition } from './definition-integrity';

const formula = (key: string, source: string, extra: object = {}): FieldInput => ({
  type: 'formula',
  key,
  label: key,
  formula: { source },
  scale: 2,
  ...extra,
});

function errors(fields: FieldInput[]): string[] {
  const entity = defineEntity({
    key: 'pedido',
    scope: 'tenant',
    tenantId: 't',
    names: { singular: 'Pedido', plural: 'Pedidos' },
    icon: 'cube',
    fields: [
      { type: 'number', key: 'quantidade', label: 'Quantidade' },
      { type: 'currency', key: 'preco', label: 'Preço', currency: 'EUR' },
      { type: 'currency', key: 'precoUsd', label: 'Preço USD', currency: 'USD' },
      { type: 'text', key: 'nota', label: 'Nota' },
      { type: 'number', key: 'antigo', label: 'Antigo', archived: true },
      {
        type: 'currency',
        key: 'margem',
        label: 'Margem',
        currency: 'EUR',
        sensitivity: 'sensitive',
        permissions: { read: 'p.read', write: 'p.write' },
      },
      ...fields,
    ],
  });
  return validateEntityDefinition(entity)
    .filter((i) => i.severity === 'error')
    .map((i) => i.message);
}

describe('integridade das fórmulas', () => {
  it('aceita fórmulas válidas, incluindo encadeadas', () => {
    expect(
      errors([formula('subtotal', 'quantidade * preco'), formula('total', 'subtotal * 1.23')]),
    ).toEqual([]);
  });

  it('assinala erros de sintaxe com a mensagem do analisador', () => {
    expect(errors([formula('x', 'quantidade +')]).join()).toContain('Fórmula inválida');
    expect(errors([formula('x', 'eval(quantidade)')]).join()).toContain('Função desconhecida');
  });

  it('rejeita referências a campos desconhecidos, arquivados ou não numéricos', () => {
    expect(errors([formula('x', 'quantidade * fantasma')]).join()).toContain(
      'campo desconhecido "fantasma"',
    );
    expect(errors([formula('x', 'antigo + 1')]).join()).toContain('campo arquivado "antigo"');
    expect(errors([formula('x', 'nota + 1')]).join()).toContain('só aceita campos numéricos');
  });

  it('rejeita escalas inválidas', () => {
    expect(errors([formula('x', '1', { scale: 11 })]).join()).toContain('entre 0 e 10');
    expect(errors([formula('x', '1', { scale: 1.5 })]).join()).toContain('entre 0 e 10');
  });

  it('detecta a dependência circular, directa ou indirecta', () => {
    expect(errors([formula('a', 'a + 1')]).join()).toContain('Dependência circular');
    const chain = errors([formula('a', 'b + 1'), formula('b', 'c + 1'), formula('c', 'a + 1')]);
    expect(chain.filter((m) => m.includes('Dependência circular'))).toHaveLength(3);
  });

  it('não deixa misturar moedas', () => {
    expect(errors([formula('x', 'preco + precoUsd')]).join()).toContain(
      'mistura moedas diferentes',
    );
    expect(errors([formula('x', 'preco * quantidade')])).toEqual([]);
  });

  it('o resultado de uma fórmula não revela dados sensíveis', () => {
    expect(errors([formula('x', 'margem * 2')]).join()).toContain('campo sensível "margem"');
    const wrongPermission = formula('y', 'margem * 2', {
      sensitivity: 'sensitive',
      permissions: { read: 'outra.read', write: 'outra.write' },
    });
    expect(errors([wrongPermission]).join()).toContain('mesma permissão de leitura');
    const ok = formula('z', 'margem * 2', {
      sensitivity: 'sensitive',
      permissions: { read: 'p.read', write: 'p.write' },
    });
    expect(errors([ok])).toEqual([]);
  });

  it('uma fórmula não pode ser obrigatória nem ter valor por omissão', () => {
    expect(errors([formula('x', '1', { required: true })]).join()).toContain(
      'não pode ser obrigatório',
    );
    expect(errors([formula('x', '1', { defaultValue: 3 })]).join()).toContain('valor por omissão');
  });
});

describe('alteração de fórmulas entre versões', () => {
  const field = (source: string, scale = 2) => defineField(formula('total', source, { scale }));

  it('mudar a fórmula é um aviso (recalcula), não uma quebra', () => {
    const changes = diffField(field('a * b'), field('a + b'));
    expect(changes.map((c) => c.severity)).toEqual(['warning']);
    expect(changes[0]!.message).toContain('recalculados');
    expect(diffField(field('a * b'), field('a * b'))).toEqual([]);
  });

  it('trocar o tipo de um campo para fórmula (ou ao contrário) é destrutivo', () => {
    const number = defineField({ type: 'number', key: 'total', label: 'total' });
    expect(diffField(number, field('1')).map((c) => c.severity)).toContain('breaking');
    expect(diffField(field('1'), number).map((c) => c.severity)).toContain('breaking');
  });

  it('a publicação continua a exigir integridade (ciclos bloqueiam)', () => {
    const entity = (fields: FieldInput[]) =>
      defineEntity({
        key: 'x',
        scope: 'tenant',
        tenantId: 't',
        state: 'draft',
        names: { singular: 'X', plural: 'Xs' },
        icon: 'cube',
        fields,
      });
    expect(checkPublishable(null, entity([formula('a', 'b'), formula('b', 'a')])).ok).toBe(false);
    expect(
      checkPublishable(
        null,
        entity([{ type: 'number', key: 'n', label: 'N' }, formula('a', 'n * 2')]),
      ).ok,
    ).toBe(true);
  });
});
