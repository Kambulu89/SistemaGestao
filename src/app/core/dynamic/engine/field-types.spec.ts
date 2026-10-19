import type { FieldType } from '../models/field-definition.model';
import {
  fieldCapabilities,
  FIELD_TYPE_CATALOG,
  fieldTypeDefinition,
  isKnownFieldType,
} from './field-types';

/** Verificado em compilação: se `FieldType` ganhar um tipo, esta lista tem de o incluir. */
const ALL_TYPES: Record<FieldType, true> = {
  text: true,
  textarea: true,
  number: true,
  decimal: true,
  currency: true,
  boolean: true,
  checkbox: true,
  date: true,
  datetime: true,
  email: true,
  phone: true,
  url: true,
  select: true,
  multiselect: true,
  radio: true,
  file: true,
  image: true,
  'entity-reference': true,
  'user-reference': true,
  formula: true,
  lookup: true,
  'auto-number': true,
};

describe('catálogo de tipos de campo', () => {
  it('cobre exactamente os 22 tipos, uma vez cada', () => {
    const types = FIELD_TYPE_CATALOG.map((t) => t.type);
    expect(types).toHaveLength(22);
    expect(new Set(types).size).toBe(22);
    expect([...types].sort()).toEqual(Object.keys(ALL_TYPES).sort());
  });

  it('tipos calculados ou atribuídos pelo servidor não são escritos pelo utilizador', () => {
    for (const type of ['formula', 'lookup', 'auto-number'] as const) {
      expect(fieldCapabilities(type), type).toMatchObject({
        writable: false,
        required: false,
        defaultValue: false,
        unique: false,
      });
    }
  });

  it('só os tipos que o backend indexa com facilidade são filtráveis', () => {
    const filterable = FIELD_TYPE_CATALOG.filter((t) => t.capabilities.filterable).map(
      (t) => t.type,
    );
    expect(filterable).toEqual(expect.arrayContaining(['select', 'radio', 'boolean', 'checkbox']));
    for (const type of ['textarea', 'file', 'image', 'formula', 'lookup', 'date']) {
      expect(filterable, type).not.toContain(type);
    }
  });

  it('ficheiros e imagens não são pesquisáveis nem ordenáveis', () => {
    for (const type of ['file', 'image'] as const) {
      expect(fieldCapabilities(type)).toMatchObject({
        searchable: false,
        sortable: false,
        filterable: false,
      });
    }
  });

  it('todos os tipos do catálogo estão prontos (o estado «preview» fica para tipos futuros)', () => {
    const preview = FIELD_TYPE_CATALOG.filter((t) => t.status === 'preview').map((t) => t.type);
    expect(preview).toEqual([]);
    expect(fieldTypeDefinition('text').status).toBe('ready');
  });

  it('só as listas têm opções', () => {
    expect(FIELD_TYPE_CATALOG.filter((t) => t.capabilities.options).map((t) => t.type)).toEqual([
      'select',
      'multiselect',
      'radio',
    ]);
  });
});

describe('tipos desconhecidos', () => {
  it('não rebentam: ficam só de leitura e sem capacidades', () => {
    const caps = fieldCapabilities('hologram' as never);
    expect(caps).toMatchObject({
      writable: false,
      searchable: false,
      filterable: false,
      sortable: false,
    });
    expect(fieldTypeDefinition('hologram' as never).label).toBe('hologram');
    expect(isKnownFieldType('hologram')).toBe(false);
    expect(isKnownFieldType('text')).toBe(true);
  });
});
