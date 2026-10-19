import { VEHICLE_V2 } from '../../mock/mock-entities';
import { AUDIT_ACTION_LABELS, describeChange } from './audit-summary';

describe('describeChange', () => {
  it('uses field labels and formatted values, not stored codes', () => {
    expect(
      describeChange(VEHICLE_V2, { field: 'combustivel', from: 'gasoleo', to: 'eletrico' }),
    ).toEqual({
      label: 'Combustível',
      from: 'Gasóleo',
      to: 'Eléctrico',
    });
  });

  it('uses status names for the status key', () => {
    expect(
      describeChange(VEHICLE_V2, { field: 'status', from: 'available', to: 'maintenance' }),
    ).toEqual({
      label: 'Estado',
      from: 'Disponível',
      to: 'Em manutenção',
    });
  });

  it('keeps working for fields that no longer exist in the definition', () => {
    expect(describeChange(VEHICLE_V2, { field: 'removido', from: 'a', to: null })).toEqual({
      label: 'removido',
      from: 'a',
      to: '—',
    });
  });

  it('labels every audit action', () => {
    expect(Object.keys(AUDIT_ACTION_LABELS).sort()).toEqual([
      'create',
      'delete',
      'transition',
      'update',
    ]);
  });
});
