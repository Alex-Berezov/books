import { areComponentRemovalsConfirmed } from './rights-action.constants';

/**
 * WP-A.4. «Нечего подтверждать» и «не подтверждено» — разные состояния. Профиль без единого
 * компонента, помеченного к удалению, объявлялся неподтверждённым только потому, что в нём нет
 * действий на удаление. Fail-closed сторона (компонент есть, действий нет) сохраняется.
 */
describe('areComponentRemovalsConfirmed', () => {
  it('confirms a profile that has nothing marked for removal', () => {
    expect(areComponentRemovalsConfirmed([], false)).toBe(true);
  });

  it('confirms it even when unrelated actions are still open', () => {
    expect(
      areComponentRemovalsConfirmed([{ actionType: 'VERIFY_EDITION', status: 'PENDING' }], false),
    ).toBe(true);
  });

  it('does not confirm while a component marked for removal has no action at all', () => {
    expect(areComponentRemovalsConfirmed([], true)).toBe(false);
  });

  it('does not confirm while a removal action is still open', () => {
    expect(
      areComponentRemovalsConfirmed(
        [{ actionType: 'REMOVE_GUTENBERG_HEADER', status: 'PENDING' }],
        true,
      ),
    ).toBe(false);
  });

  it('does not accept a cancelled removal action as confirmation', () => {
    expect(
      areComponentRemovalsConfirmed(
        [{ actionType: 'REMOVE_COMPONENT', status: 'CANCELLED' }],
        true,
      ),
    ).toBe(false);
  });

  it('confirms once every removal action is closed', () => {
    expect(
      areComponentRemovalsConfirmed(
        [
          { actionType: 'REMOVE_GUTENBERG_HEADER', status: 'COMPLETED' },
          { actionType: 'REPLACE_COVER', status: 'WAIVED' },
        ],
        true,
      ),
    ).toBe(true);
  });
});
