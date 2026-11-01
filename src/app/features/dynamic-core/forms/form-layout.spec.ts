import type { FormSectionDto } from '../../../core/dynamic/http/dynamic-dto';
import {
  addItem,
  addSection,
  boundFields,
  moveItem,
  moveSection,
  nextSectionKey,
  removeItem,
  removeSection,
  unassignedFields,
  updateItem,
  updateSection,
} from './form-layout';

const section = (key: string, fields: string[]): FormSectionDto => ({
  key,
  title: key,
  columns: 2,
  items: fields.map((field) => ({ kind: 'field' as const, field })),
});
const layout = () => [section('a', ['x', 'y', 'z']), section('b', ['w'])];
const fieldsOf = (sections: readonly FormSectionDto[]) =>
  sections.map((s) => s.items.map((i) => i.field).join(','));

describe('secções', () => {
  it('as chaves novas não se repetem', () => {
    expect(nextSectionKey([])).toBe('secao');
    expect(nextSectionKey([section('secao', [])])).toBe('secao_2');
    expect(nextSectionKey([section('secao', []), section('secao_2', [])])).toBe('secao_3');
    expect(addSection(layout()).map((s) => s.key)).toEqual(['a', 'b', 'secao']);
  });

  it('actualiza (e retira chaves a undefined), remove e move sem alterar a original', () => {
    const original = [{ ...section('a', ['x']), description: 'd' }, section('b', [])];
    const updated = updateSection(original, 0, { title: 'T', description: undefined });
    expect(updated[0]).toEqual({ key: 'a', title: 'T', columns: 2, items: original[0]!.items });
    expect(original[0]!.description).toBe('d');
    expect(removeSection(original, 0).map((s) => s.key)).toEqual(['b']);
    expect(moveSection(original, 0, 1).map((s) => s.key)).toEqual(['b', 'a']);
    expect(moveSection(original, 0, -1).map((s) => s.key)).toEqual(['a', 'b']);
  });
});

describe('itens', () => {
  it('liga um campo uma só vez', () => {
    const base = layout();
    expect(fieldsOf(addItem(base, 1, 'q'))).toEqual(['x,y,z', 'w,q']);
    expect(fieldsOf(addItem(base, 1, 'x'))).toEqual(['x,y,z', 'w']);
    expect(boundFields(base)).toEqual(new Set(['x', 'y', 'z', 'w']));
    expect(unassignedFields(base, ['x', 'q', 'r'])).toEqual(['q', 'r']);
  });

  it('actualiza a configuração do item e retira as chaves a undefined', () => {
    const next = updateItem(layout(), { section: 0, item: 1 }, { label: 'Y!', span: 2 });
    expect(next[0]!.items[1]).toEqual({ kind: 'field', field: 'y', label: 'Y!', span: 2 });
    const cleared = updateItem(next, { section: 0, item: 1 }, { label: undefined });
    expect(cleared[0]!.items[1]).toEqual({ kind: 'field', field: 'y', span: 2 });
  });

  it('remove e move dentro da mesma secção e entre secções', () => {
    expect(fieldsOf(removeItem(layout(), { section: 0, item: 1 }))).toEqual(['x,z', 'w']);
    // x para o fim da mesma secção
    expect(fieldsOf(moveItem(layout(), { section: 0, item: 0 }, { section: 0, item: 3 }))).toEqual([
      'y,z,x',
      'w',
    ]);
    // z para antes de x
    expect(fieldsOf(moveItem(layout(), { section: 0, item: 2 }, { section: 0, item: 0 }))).toEqual([
      'z,x,y',
      'w',
    ]);
    // y para a secção b, antes de w
    expect(fieldsOf(moveItem(layout(), { section: 0, item: 1 }, { section: 1, item: 0 }))).toEqual([
      'x,z',
      'y,w',
    ]);
    // y para uma secção vazia (fim)
    const withEmpty = [...layout(), section('c', [])];
    expect(fieldsOf(moveItem(withEmpty, { section: 0, item: 1 }, { section: 2, item: 0 }))).toEqual(
      ['x,z', 'w', 'y'],
    );
  });

  it('mover para a posição seguinte da mesma secção troca os dois', () => {
    expect(fieldsOf(moveItem(layout(), { section: 0, item: 0 }, { section: 0, item: 2 }))).toEqual([
      'y,x,z',
      'w',
    ]);
  });
});
