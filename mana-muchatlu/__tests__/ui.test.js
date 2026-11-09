/** @jest-environment node */
const UI = require('../web/ui');
const { MOODS } = require('../api/lib/entries');

test.each(['shivani', 'bujjuluu', 'bujji', 'Shivani'])('personalises %s without putting prompts into entry content', (id) => {
  expect(UI.placeholders({ id })).toEqual({
    title: 'Emaina sare, I’ll always love you, bujji ♥️🫂',
    body: 'idi mana safe space bujji… judgement-free. Emaina raskovachu',
  });
});
test.each(['prakyath', 'bangaram', 'bangarammm', 'Prakyath'])('personalises %s', (name) => {
  expect(UI.placeholders({ name })).toEqual({
    title: 'Emaina sare, I’ll always love you, bangaaramm ♥️🫂',
    body: 'idi mana safe space Bangaaramm… judgement-free. Emaina raskovachu',
  });
});
test('matches configured names as well as opaque IDs, without guessing unknown identities', () => {
  expect(UI.identity({ id: 'member-123', name: 'Shivani Reddy' })).toBe('shivani');
  expect(UI.identity({ id: 'member-456', name: 'Prakyath Reddy K' })).toBe('prakyath');
  expect(UI.identity({ id: 'notshivani', name: 'Another member' })).toBe('');
});
test('every visible mood is accepted by the API and retains all original IDs', () => {
  expect(new Set(UI.moods.map(m => m.id))).toEqual(new Set(MOODS));
  expect(UI.moodLabel('sad')).toBe('Badhestundi');
  expect(UI.quickMoods).toEqual(['perfect-day', 'normal-day', 'sad']);
});
