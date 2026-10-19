import { DRIVER_V1, NOTE_V1, VEHICLE_V2 } from '../../core/mock/mock-entities';
import {
  buildEntityForm,
  collectSubmitValues,
  dependentFieldKeys,
  initialFormValues,
} from './build-entity-form';

const ctx = {
  mode: () => 'create' as const,
  status: () => null,
  access: () => ({ canRead: () => true, canWrite: () => true }),
};

describe('build-entity-form', () => {
  it('creates one control per active field', () => {
    expect(Object.keys(buildEntityForm(VEHICLE_V2, ctx).controls)).toEqual([
      'matricula',
      'marca',
      'modelo',
      'combustivel',
      'quilometragem',
      'numeroChassis',
    ]);
  });

  it('applies default values only when creating', () => {
    expect(initialFormValues(VEHICLE_V2, null, 'create')['quilometragem']).toBe(0);
    expect(initialFormValues(VEHICLE_V2, null, 'edit')['quilometragem']).toBeNull();
    expect(initialFormValues(NOTE_V1, null, 'create')).toMatchObject({
      prioridade: 'media',
      concluida: false,
    });
  });

  it('leaves fields added after a record was written empty (no data loss, no crash)', () => {
    const legacy = { matricula: 'AA-00-AA', marca: 'Volvo' }; // criado na v1: sem numeroChassis
    expect(initialFormValues(VEHICLE_V2, legacy, 'edit')).toMatchObject({
      matricula: 'AA-00-AA',
      numeroChassis: null,
    });
  });

  it('detects fields that depend on other fields', () => {
    expect([...dependentFieldKeys(DRIVER_V1)]).toEqual(['numeroCap']);
    expect([...dependentFieldKeys(VEHICLE_V2)]).toEqual([]);
  });

  it('validates through the engine: required and min', () => {
    const form = buildEntityForm(VEHICLE_V2, ctx);
    form.reset(initialFormValues(VEHICLE_V2, null, 'create'));
    expect(form.controls['matricula']?.errors).toEqual({
      dynamic: { message: 'Campo obrigatório.', rule: 'required' },
    });
    form.controls['quilometragem']?.setValue(-5);
    expect(form.controls['quilometragem']?.errors?.['dynamic']).toMatchObject({ rule: 'min' });
    expect(form.invalid).toBe(true);
  });

  it('collects only visible, editable fields and turns empty text into null', () => {
    const raw = {
      nome: 'Rui',
      numeroCarta: '1',
      categoria: 'B',
      numeroCap: 'stale',
      validadeCarta: '2030-01-01',
      telefone: '',
      email: null,
      viatura: null,
    };
    const values = collectSubmitValues(DRIVER_V1, raw, ctx);
    expect(values).toEqual({
      nome: 'Rui',
      numeroCarta: '1',
      categoria: 'B',
      validadeCarta: '2030-01-01',
      telefone: null,
      email: null,
      viatura: null,
    });
    expect('numeroCap' in values).toBe(false); // escondido pela condição: não é enviado
  });

  it('sends false for an unset checkbox', () => {
    expect(collectSubmitValues(NOTE_V1, { titulo: 'x', concluida: null }, ctx)['concluida']).toBe(
      false,
    );
  });
});
