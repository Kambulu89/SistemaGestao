import { DRIVER_V1, NOTE_V1, VEHICLE_V2 } from '../../mock/mock-entities';
import { defineEntity } from './define-entity';
import { formatFieldValue } from './format-value';
import { formFieldKeys, generateDefaultForm, resolveForm } from './form-resolver';

const f = (entity: typeof VEHICLE_V2, key: string) => entity.fields.find((x) => x.key === key)!;

describe('formatFieldValue', () => {
  it('shows a dash for empty values', () => {
    for (const v of [null, undefined, '', []])
      expect(formatFieldValue(f(VEHICLE_V2, 'modelo'), v)).toBe('—');
  });

  it('shows option labels instead of stored values', () => {
    expect(formatFieldValue(f(VEHICLE_V2, 'combustivel'), 'eletrico')).toBe('Eléctrico');
    expect(formatFieldValue(f(VEHICLE_V2, 'combustivel'), 'desconhecido')).toBe('desconhecido');
  });

  it('formats numbers, booleans and dates for pt-PT', () => {
    expect(formatFieldValue(f(VEHICLE_V2, 'quilometragem'), 12500)).toMatch(/12\s?500/);
    expect(formatFieldValue(f(NOTE_V1, 'concluida') as never, true)).toBe('Sim');
    expect(formatFieldValue(f(NOTE_V1, 'concluida') as never, false)).toBe('Não');
    expect(formatFieldValue(f(DRIVER_V1, 'validadeCarta'), '2030-01-05')).toContain('2030');
  });

  it('does not shift dates across time zones', () => {
    const text = formatFieldValue(f(DRIVER_V1, 'validadeCarta'), '2030-01-01');
    expect(text).toContain('2030');
    expect(text).not.toContain('2029'); // um fuso a oeste de UTC recuaria para 31/12/2029
  });

  it('formats currency, decimals, multiselect and files', () => {
    const e = defineEntity({
      key: 'x',
      tenantId: 't',
      names: { singular: 'X', plural: 'X' },
      icon: 'cube',
      fields: [
        { type: 'currency', key: 'p', label: 'P', currency: 'EUR' },
        { type: 'decimal', key: 'd', label: 'D', scale: 2 },
        {
          type: 'multiselect',
          key: 'm',
          label: 'M',
          options: [
            { value: 'a', label: 'Alfa' },
            { value: 'b', label: 'Beta' },
          ],
        },
        { type: 'file', key: 'file', label: 'F' },
      ],
    });
    expect(formatFieldValue(e.fields[0]!, 9.5)).toContain('€');
    expect(formatFieldValue(e.fields[1]!, 3)).toMatch(/3,00/);
    expect(formatFieldValue(e.fields[2]!, ['a', 'b'])).toBe('Alfa, Beta');
    expect(
      formatFieldValue(e.fields[3]!, [
        { name: 'doc.pdf', size: 1, contentType: 'application/pdf' },
      ]),
    ).toBe('doc.pdf');
  });
});

describe('form resolution', () => {
  it('uses the form declared for the mode', () => {
    expect(resolveForm(VEHICLE_V2, 'create').key).toBe('vehicle-default');
    expect(formFieldKeys(resolveForm(VEHICLE_V2, 'create'))).toEqual([
      'matricula',
      'marca',
      'modelo',
      'combustivel',
      'quilometragem',
      'numeroChassis',
    ]);
  });

  it('generates a form automatically for entities without one', () => {
    const form = resolveForm(DRIVER_V1, 'edit');
    expect(form.key).toBe('auto');
    expect(formFieldKeys(form)).toEqual(DRIVER_V1.fields.map((x) => x.key));
  });

  it('leaves archived fields out of generated forms', () => {
    const e = defineEntity({
      key: 'x',
      tenantId: 't',
      names: { singular: 'X', plural: 'X' },
      icon: 'cube',
      fields: [
        { type: 'text', key: 'a', label: 'A' },
        { type: 'text', key: 'b', label: 'B', archived: true },
      ],
    });
    expect(formFieldKeys(generateDefaultForm(e))).toEqual(['a']);
  });
});

describe('defineEntity defaults', () => {
  it('derives a list from searchable/filterable fields and statuses', () => {
    expect(VEHICLE_V2.list.searchFields).toEqual(['matricula', 'marca']);
    expect(VEHICLE_V2.list.filters).toEqual(['combustivel', 'status']);
    expect(NOTE_V1.list.filters).toEqual(['prioridade', 'concluida']);
  });

  it('identifies the version of a definition and its scope', () => {
    expect(VEHICLE_V2.id).toBe('vehicle@t-atlas:v2');
    expect(NOTE_V1).toMatchObject({ scope: 'global', tenantId: null });
  });
});
