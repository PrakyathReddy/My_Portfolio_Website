/* Presentation policy. Canonical mood IDs deliberately retain old records. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ManaUI = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  var moods = [
    { id: 'perfect-day', label: 'Perfect day' },
    { id: 'happy', label: 'Happy ga undi' },
    { id: 'normal-day', label: 'Normal day' },
    { id: 'calm', label: 'Peaceful ga undi' },
    { id: 'grateful', label: 'Grateful' },
    { id: 'excited', label: 'Excited' },
    { id: 'silly', label: 'Allari mood' },
    { id: 'tired', label: 'Tired ga undi' },
    { id: 'sad', label: 'Badhestundi' },
    { id: 'irritated', label: 'Chirakuga undi' },
    { id: 'overthinking', label: 'Overthinking' },
    { id: 'missing-you', label: 'Missing you' },
  ];
  function identity(member) {
    var words = [member && member.id, member && member.name]
      .join(' ').toLowerCase().split(/[^a-z]+/);
    if (words.some(function (w) { return ['shivani', 'bujjuluu', 'bujji'].indexOf(w) !== -1; })) return 'shivani';
    if (words.some(function (w) { return ['prakyath', 'bangaram', 'bangarammm', 'bangaaramm', 'bangaaram'].indexOf(w) !== -1; })) return 'prakyath';
    return '';
  }
  function placeholders(member) {
    var person = identity(member);
    if (!person) return {
      title: 'Emaina sare, I’ll always love you ♥️🫂',
      body: 'idi mana safe space… judgement-free. Emaina raskovachu',
    };
    return {
      title: 'Emaina sare, I’ll always love you, ' + (person === 'shivani' ? 'bujji' : 'bangaaramm') + ' ♥️🫂',
      body: 'idi mana safe space ' + (person === 'shivani' ? 'bujji' : 'Bangaaramm') + '… judgement-free. Emaina raskovachu',
    };
  }
  function moodLabel(id) {
    var mood = moods.find(function (item) { return item.id === id; });
    return mood ? mood.label : String(id || '');
  }
  function accent(member) { return identity(member) === 'shivani' ? '#b77f90' : '#44363c'; }
  function initials(member) {
    var person = identity(member);
    return person === 'shivani' ? 'S' : person === 'prakyath' ? 'P' : (member.initials || '?');
  }
  return { moods: moods, quickMoods: ['perfect-day', 'normal-day', 'sad'], identity: identity,
    placeholders: placeholders, moodLabel: moodLabel, accent: accent, initials: initials };
});
