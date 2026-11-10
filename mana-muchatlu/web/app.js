/* Mana Muchatlu. The same private journal, with a phone-first home. */
(function () {
  'use strict';
  var API = (window.MANA_CONFIG && window.MANA_CONFIG.apiBase) || '';
  var UI = window.ManaUI;
  var TOKEN_KEY = 'mana.token';
  var MEMBER_KEY = 'mana.member';
  var $ = function (id) { return document.getElementById(id); };
  var state = {
    token: null, member: null, members: [], pendingMember: null,
    month: null, entries: [], summary: {}, selectedDay: null,
    view: 'today', authorFilter: '', loading: false, loadError: '', loadSerial: 0,
    draftPhotos: [], draftMood: '', saving: false, savedNewDraft: null, editBaseline: '',
  };
  var MAX_PHOTOS = 10;
  var AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  var recorder = { media: null, stream: null, chunks: [], startedAt: 0, timer: null,
    requesting: false, stopping: false, generation: 0 };
  var dialogFocus = {};
  var reminders = null;
  /* --- Storage (never throws) ---------------------------------------------
     Private-mode Safari throws on localStorage access rather than returning
     null, so every touch is wrapped. A storage failure should cost you the
     "stay signed in" convenience, not the whole app. */
  function store(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* ignore */ }
  }
  function recall(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  /* --- Dates ---------------------------------------------------------------
     All date handling is local-calendar, never UTC. toISOString() would shift
     an 11pm entry into tomorrow for anyone east of Greenwich, which is exactly
     the kind of bug you find six months later in the wrong calendar cell. */
  function isoDate(d) {
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  function isoMonth(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function monthShift(month, delta) {
    var parts = month.split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1 + delta, 1);
    return isoMonth(d);
  }
  function monthTitle(month) {
    var parts = month.split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  function dayTitle(date) {
    var p = date.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return d.toLocaleDateString(undefined, {
      weekday: 'long', day: 'numeric', month: 'long',
    });
  }

  /* --- API ----------------------------------------------------------------- */
  function api(path, options) {
    options = options || {};
    var requestToken = state.token;
    var headers = { 'content-type': 'application/json' };
    if (state.token) headers.authorization = 'Bearer ' + state.token;

    return fetch(API + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (res) {
      if (res.status === 401 && state.token && state.token === requestToken) {
        signOut('Your session expired - sign in again');
        throw new Error('unauthorized');
      }
      return res.json()
        .catch(function () { return {}; })
        .then(function (data) {
          if (!res.ok) throw new Error(data.error || 'Something went wrong');
          return data;
        });
    });
  }

  /* --- Toast --------------------------------------------------------------- */
  var toastTimer = null;
  function toast(message) {
    var el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function memberById(id) {
    return state.members.find(function (m) { return m.id === id; }) ||
      { id: id, name: id || 'Us', initials: (id || '?').slice(0, 1).toUpperCase() };
  }
  function makeAvatar(member, extraClass) {
    var el = document.createElement('span');
    el.className = 'avatar' + (extraClass ? ' ' + extraClass : '');
    el.style.setProperty('--avatar-accent', UI.accent(member));
    el.textContent = UI.initials(member);
    el.title = member.name;
    return el;
  }
  function icon(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  /* Dialogs keep keyboard focus in the topmost open layer. */
  function activeDialog() {
    return ['lightbox', 'mood-backdrop', 'account-backdrop', 'sheet-backdrop'].find(function (id) {
      return !$(id).hidden;
    });
  }
  function syncDialogState() {
    var top = activeDialog();
    document.body.classList.toggle('has-dialog', Boolean(top));
    $('app-view').inert = Boolean(top);
    ['lightbox', 'mood-backdrop', 'account-backdrop', 'sheet-backdrop'].forEach(function (id) {
      $(id).inert = Boolean(top && top !== id);
    });
  }
  function showDialog(id, focusId) {
    dialogFocus[id] = document.activeElement;
    $(id).hidden = false;
    syncDialogState();
    $(focusId).focus();
  }
  function hideDialog(id) {
    $(id).hidden = true;
    syncDialogState();
    var previous = dialogFocus[id];
    if (previous && previous.isConnected) previous.focus();
    delete dialogFocus[id];
  }

  /* Sign-in: existing identities, passphrases and session keys are unchanged. */
  function renderMemberPicker() {
    var picker = $('member-picker');
    picker.textContent = '';
    state.members.forEach(function (member) {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'member-btn';
      btn.appendChild(makeAvatar(member, 'avatar-lg'));
      var name = document.createElement('span');
      name.className = 'member-btn-name'; name.textContent = member.name;
      btn.appendChild(name);
      btn.addEventListener('click', function () {
        state.pendingMember = member;
        $('signin-name').textContent = member.name;
        picker.hidden = true; $('signin-form').hidden = false;
        $('signin-error').hidden = true; $('passphrase').focus();
      });
      picker.appendChild(btn);
    });
  }
  function handleSignIn(event) {
    event.preventDefault();
    if (!state.pendingMember) return;
    var submit = $('signin-submit');
    submit.disabled = true; submit.textContent = 'Opening…';
    $('signin-error').hidden = true;
    api('/auth/login', { method: 'POST', body: {
      memberId: state.pendingMember.id, passphrase: $('passphrase').value,
    }}).then(function (data) {
      state.token = data.token; state.member = data.member;
      store(TOKEN_KEY, data.token); store(MEMBER_KEY, JSON.stringify(data.member));
      $('passphrase').value = ''; showApp();
    }).catch(function (err) {
      $('signin-error').textContent = err.message; $('signin-error').hidden = false;
      $('passphrase').select();
    }).finally(function () {
      submit.disabled = false; submit.textContent = 'Open our journal';
    });
  }
  function signOut(message) {
    state.loadSerial++;
    if (reminders) reminders.signedOut();
    state.token = null; state.member = null; state.entries = []; state.summary = {};
    state.month = null; state.authorFilter = ''; state.pendingMember = null;
    recorder.generation++; recorder.requesting = false;
    if (recorder.media) { recorder.media.onstop = null; recorder.media = null; }
    releaseMicrophone();
    if (state.savedNewDraft) {
      state.savedNewDraft.photos.forEach(revokePreview);
      state.savedNewDraft = null;
    }
    clearDraftPhotos();
    $('composer-home').appendChild($('entry-form'));
    ['lightbox', 'mood-backdrop', 'account-backdrop', 'sheet-backdrop'].forEach(function (id) { $(id).hidden = true; });
    syncDialogState();
    resetComposer(isoDate(new Date()));
    store(TOKEN_KEY, null); store(MEMBER_KEY, null);
    $('app-view').hidden = true; $('signin-view').hidden = false;
    $('signin-form').hidden = true; $('member-picker').hidden = false;
    $('passphrase').value = '';
    if (message) toast(message);
  }
  function showApp() {
    $('signin-view').hidden = true; $('app-view').hidden = false;
    var copy = UI.placeholders(state.member);
    $('entry-title').placeholder = copy.title; $('entry-body').placeholder = copy.body;
    $('member-pair').textContent = ''; $('calendar-legend').textContent = '';
    state.members.forEach(function (member) {
      $('member-pair').appendChild(makeAvatar(member, member.id === state.member.id ? 'is-current' : ''));
      var label = document.createElement('span'); label.className = 'legend-member';
      var dot = document.createElement('i'); dot.className = 'dot';
      dot.style.setProperty('--dot-accent', UI.accent(member));
      label.appendChild(dot); label.appendChild(document.createTextNode(' ' + member.name));
      $('calendar-legend').appendChild(label);
    });
    $('account-name').textContent = 'Signed in as ' + state.member.name;
    $('account-btn').setAttribute('aria-label', 'Account: ' + state.member.name);
    state.lastToday = isoDate(new Date());
    state.month = isoMonth(new Date()); state.selectedDay = isoDate(new Date());
    resetComposer(isoDate(new Date())); renderAuthorFilters(); setView('today'); loadMonth();
    if (reminders) reminders.signedIn();
  }

  /* Three views share a single month query; changing tabs never resets a draft. */
  function setView(view) {
    state.view = view;
    ['today', 'memories', 'calendar'].forEach(function (name) { $(name + '-page').hidden = name !== view; });
    document.querySelectorAll('[data-view]').forEach(function (button) {
      var active = button.dataset.view === view;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }
  function changeMonth(month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return;
    state.month = month;
    state.selectedDay = month === isoMonth(new Date()) ? isoDate(new Date()) : month + '-01';
    loadMonth();
  }
  function renderAuthorFilters() {
    var wrap = $('author-filters'); wrap.textContent = '';
    [{ id: '', name: 'Maniddaram' }].concat(state.members).forEach(function (member) {
      var button = document.createElement('button');
      button.type = 'button'; button.className = 'author-filter';
      button.textContent = member.id ? UI.initials(member) : member.name;
      button.setAttribute('aria-label', member.id ? member.name + ' entries' : 'Both of us');
      button.setAttribute('aria-pressed', String(state.authorFilter === member.id));
      button.addEventListener('click', function () {
        state.authorFilter = member.id; renderAuthorFilters(); renderFeed();
      });
      wrap.appendChild(button);
    });
  }
  function renderCalendar() {
    var grid = $('calendar-grid'); grid.textContent = '';
    $('month-label').textContent = monthTitle(state.month);
    $('memories-month-label').textContent = monthTitle(state.month);
    document.querySelectorAll('.month-input').forEach(function (input) { input.value = state.month; });
    var parts = state.month.split('-');
    var year = Number(parts[0]), month = Number(parts[1]) - 1;
    var leading = (new Date(year, month, 1).getDay() + 6) % 7;
    for (var b = 0; b < leading; b++) {
      var blank = document.createElement('span'); blank.className = 'day is-blank'; grid.appendChild(blank);
    }
    var count = new Date(year, month + 1, 0).getDate();
    for (var day = 1; day <= count; day++) {
      (function (date, number) {
        var cell = document.createElement('button'); cell.type = 'button'; cell.className = 'day';
        cell.classList.toggle('is-today', date === isoDate(new Date()));
        cell.classList.toggle('is-selected', date === state.selectedDay);
        cell.setAttribute('aria-pressed', String(date === state.selectedDay));
        var num = document.createElement('span'); num.textContent = number; cell.appendChild(num);
        var dots = document.createElement('span'); dots.className = 'day-dots'; dots.setAttribute('aria-hidden', 'true');
        var summary = state.summary[date];
        if (summary) (summary.authors || []).forEach(function (id) {
          var dot = document.createElement('i'); dot.className = 'dot';
          dot.style.setProperty('--dot-accent', UI.accent(memberById(id))); dots.appendChild(dot);
        });
        cell.appendChild(dots);
        cell.setAttribute('aria-label', dayTitle(date) + (summary ? ', ' + summary.total + ' entries by ' + (summary.authors || []).map(function (id) { return memberById(id).name; }).join(' and ') : ''));
        cell.addEventListener('click', function () {
          state.selectedDay = date; renderCalendar(); renderCalendarFeed();
          // Re-rendering replaced this button; keep keyboard focus on the selected day.
          var selected = grid.querySelector('[aria-pressed="true"]');
          if (selected) selected.focus({ preventScroll: true });
        });
        grid.appendChild(cell);
      })(state.month + '-' + String(day).padStart(2, '0'), day);
    }
  }
  function renderEmpty(feed, headline, detail, retry) {
    var empty = document.createElement('div'); empty.className = 'empty';
    var head = document.createElement('p'); head.className = 'empty-headline'; head.textContent = headline;
    var sub = document.createElement('p'); sub.className = 'empty-sub'; sub.textContent = detail;
    empty.appendChild(head); empty.appendChild(sub);
    if (retry) {
      var button = document.createElement('button'); button.type = 'button'; button.className = 'text-btn';
      button.textContent = 'Try again'; button.addEventListener('click', loadMonth); empty.appendChild(button);
    }
    feed.appendChild(empty);
  }
  function renderFeed() {
    var feed = $('feed'); feed.textContent = '';
    feed.setAttribute('aria-busy', String(state.loading));
    $('feed-label').textContent = monthTitle(state.month);
    if (state.loading) return renderEmpty(feed, 'Gnapakalu vasthunnayi…', 'One little moment.');
    if (state.loadError) return renderEmpty(feed, 'Couldn’t load our memories.', state.loadError, true);
    var entries = state.entries.filter(function (entry) { return !state.authorFilter || entry.author === state.authorFilter; });
    if (!entries.length) return renderEmpty(feed, 'Inka raayaledu.', 'Oka chinna gnapakam tho start cheddam.');
    var previous = '';
    entries.forEach(function (entry) {
      if (entry.date !== previous) {
        var heading = document.createElement('h3'); heading.className = 'date-heading'; heading.textContent = dayTitle(entry.date);
        feed.appendChild(heading); previous = entry.date;
      }
      feed.appendChild(renderEntry(entry));
    });
  }
  function renderCalendarFeed() {
    var feed = $('calendar-feed'); feed.textContent = '';
    var date = state.selectedDay || state.month + '-01';
    $('calendar-day-label').textContent = dayTitle(date);
    if (state.loading) return renderEmpty(feed, 'Gnapakalu vasthunnayi…', 'One little moment.');
    if (state.loadError) return renderEmpty(feed, 'Couldn’t load this day.', state.loadError, true);
    var entries = state.entries.filter(function (entry) { return entry.date === date; });
    if (!entries.length) return renderEmpty(feed, 'Ee roju inka blank.', 'Oka note raaddama?');
    entries.forEach(function (entry) { feed.appendChild(renderEntry(entry, true)); });
  }
  function renderEntry(entry, compact) {
    var card = document.createElement('article'); card.className = 'entry' + (compact ? ' is-compact' : ''); card.tabIndex = 0;
    card.setAttribute('aria-label', 'Read or edit ' + (entry.title || 'entry') + ', ' + dayTitle(entry.date));
    var author = memberById(entry.author);
    var head = document.createElement('div'); head.className = 'entry-head'; head.appendChild(makeAvatar(author, 'avatar-sm'));
    var meta = document.createElement('div'); meta.className = 'entry-meta';
    var name = document.createElement('div'); name.className = 'entry-author'; name.textContent = author.name; meta.appendChild(name);
    var when = document.createElement('div'); when.className = 'entry-when'; when.textContent = dayTitle(entry.date);
    if (entry.updatedAt - entry.createdAt > 1000) when.appendChild(document.createTextNode(' · edited'));
    meta.appendChild(when); head.appendChild(meta);
    if (entry.mood) {
      var mood = document.createElement('span'); mood.className = 'entry-mood'; mood.textContent = UI.moodLabel(entry.mood); head.appendChild(mood);
    }
    var edit = document.createElement('button'); edit.type = 'button'; edit.className = 'icon-btn entry-edit';
    edit.setAttribute('aria-label', 'Edit ' + (entry.title || 'entry')); edit.appendChild(icon('edit')); head.appendChild(edit); card.appendChild(head);
    if (entry.title) {
      var title = document.createElement('h3'); title.className = 'entry-title'; title.textContent = entry.title; card.appendChild(title);
    }
    if (entry.body) {
      var body = document.createElement('p'); body.className = 'entry-body is-clamped'; body.textContent = entry.body; card.appendChild(body);
    }
    if (entry.media && entry.media.length) {
      var images = entry.media.filter(function (item) { return item.kind !== 'audio'; });
      if (images.length && !compact) card.appendChild(renderPhotoGrid(images));
      entry.media.filter(function (item) { return item.kind === 'audio'; }).forEach(function (item) { card.appendChild(renderVoiceNote(item)); });
      if (images.length && compact) {
        var note = document.createElement('p'); note.className = 'entry-when'; note.textContent = images.length + ' photo' + (images.length === 1 ? '' : 's'); card.appendChild(note);
      }
    }
    card.addEventListener('click', function () { openSheet(entry); });
    card.addEventListener('keydown', function (event) {
      if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openSheet(entry); }
    });
    return card;
  }
  function loadMonth() {
    var serial = ++state.loadSerial;
    state.loading = true; state.loadError = ''; renderCalendar(); renderFeed(); renderCalendarFeed();
    return api('/entries?month=' + encodeURIComponent(state.month)).then(function (data) {
      if (serial !== state.loadSerial || !state.token) return;
      state.entries = data.entries || []; state.summary = data.summary || {};
    }).catch(function (err) {
      if (serial === state.loadSerial && err.message !== 'unauthorized') state.loadError = err.message;
    }).finally(function () {
      if (serial !== state.loadSerial || !state.token) return;
      state.loading = false; renderCalendar(); renderFeed(); renderCalendarFeed();
    });
  }

  /* One composer, inline for today and temporarily moved into the edit dialog.
     Its draft and attachment URLs are restored after editing another entry. */
  function draftSnapshot() {
    return { date: $('entry-date').value, title: $('entry-title').value,
      body: $('entry-body').value, mood: state.draftMood, photos: state.draftPhotos };
  }
  function draftFingerprint() {
    return JSON.stringify({ date: $('entry-date').value, title: $('entry-title').value,
      body: $('entry-body').value, mood: state.draftMood,
      media: state.draftPhotos.map(function (p) { return [p.localId, p.key, p.status]; }) });
  }
  function hasDraft() {
    return Boolean($('entry-title').value.trim() || $('entry-body').value.trim() ||
      state.draftMood || state.draftPhotos.length || recorder.requesting || isRecording() || recorder.stopping);
  }
  function hasPendingMedia() {
    return recorder.requesting || isRecording() || recorder.stopping ||
      state.draftPhotos.some(function (p) { return p.status === 'uploading'; });
  }
  function revokePreview(photo) {
    if (photo.previewUrl && photo.previewUrl.indexOf('blob:') === 0) URL.revokeObjectURL(photo.previewUrl);
  }
  function resetComposer(date) {
    clearDraftPhotos();
    $('entry-id').value = ''; $('entry-date').value = date; $('entry-date').disabled = false;
    $('entry-title').value = ''; $('entry-body').value = ''; state.draftMood = '';
    $('delete-btn').hidden = true; $('cancel-btn').hidden = true; $('entry-error').hidden = true;
    renderComposer();
  }
  function renderComposer() {
    $('today-date').textContent = dayTitle($('entry-date').value || isoDate(new Date()));
    renderMoodChips(); renderDraftPhotos(); updateSaveState();
  }
  function startNewEntry(date) {
    if (state.saving || hasPendingMedia()) { toast('Finish the recording or upload first.'); return; }
    if ($('entry-date').value !== date && hasDraft() && !window.confirm('Replace your unsaved draft with a note for this day?')) return;
    if ($('entry-date').value !== date) resetComposer(date);
    setView('today'); $('entry-body').focus();
  }
  function openSheet(entry) {
    if (state.saving || hasPendingMedia()) { toast('Finish the recording or upload first.'); return; }
    if (!$('sheet-backdrop').hidden) return;
    state.savedNewDraft = draftSnapshot();
    state.draftPhotos = []; // Detach; the new-entry draft still owns its object URLs.
    $('editor-slot').appendChild($('entry-form'));
    $('entry-id').value = entry.entryId;
    $('entry-date').value = entry.date; $('entry-date').disabled = true;
    $('entry-title').value = entry.title || ''; $('entry-body').value = entry.body || '';
    state.draftMood = entry.mood || '';
    state.draftPhotos = (entry.media || []).map(function (item, index) {
      return { localId: 'existing' + index, key: item.key, status: 'done',
        kind: item.kind || 'image', duration: item.duration || 0,
        contentType: item.contentType || '', previewUrl: item.url || '' };
    });
    $('cancel-btn').hidden = false; $('delete-btn').hidden = false; $('entry-error').hidden = true;
    renderComposer(); state.editBaseline = draftFingerprint();
    showDialog('sheet-backdrop', 'entry-body');
  }
  function closeSheet(force) {
    if ($('sheet-backdrop').hidden) return;
    if (force !== true) {
      if (state.saving || hasPendingMedia()) { toast('Finish the recording or upload first.'); return; }
      if (draftFingerprint() !== state.editBaseline && !window.confirm('Discard your unsaved edits?')) return;
    }
    clearDraftPhotos();
    $('composer-home').appendChild($('entry-form'));
    var draft = state.savedNewDraft; state.savedNewDraft = null;
    $('entry-id').value = ''; $('entry-date').disabled = false;
    $('entry-date').value = draft.date; $('entry-title').value = draft.title; $('entry-body').value = draft.body;
    state.draftMood = draft.mood; state.draftPhotos = draft.photos;
    $('cancel-btn').hidden = true; $('delete-btn').hidden = true; $('entry-error').hidden = true;
    renderComposer(); hideDialog('sheet-backdrop');
  }
  function validMood() {
    return UI.moods.some(function (mood) { return mood.id === state.draftMood; }) ||
      (Boolean($('entry-id').value) && (UI.legacyMoods || []).indexOf(state.draftMood) !== -1);
  }
  function updateSaveState() {
    var unfinished = hasPendingMedia();
    var failed = state.draftPhotos.some(function (p) { return p.status === 'failed'; });
    var content = $('entry-title').value.trim() || $('entry-body').value.trim() || state.draftPhotos.length;
    $('save-btn').disabled = !validMood() || !content || unfinished || failed || state.saving || !$('entry-date').value;
    $('save-btn').textContent = state.saving ? 'Saving…' : 'Save entry';
    $('delete-btn').disabled = state.saving || unfinished;
    $('add-photo-btn').disabled = state.saving || state.draftPhotos.length >= MAX_PHOTOS;
    $('record-btn').disabled = state.saving || recorder.requesting || recorder.stopping || (state.draftPhotos.length >= MAX_PHOTOS && !isRecording());
    document.querySelectorAll('.photo-remove').forEach(function (button) { button.disabled = state.saving; });
    $('entry-title').readOnly = state.saving; $('entry-body').readOnly = state.saving;
    $('mood-help').textContent = !validMood() ? 'Oka mood choose chesko, save cheyyadaniki.' :
      unfinished ? 'Recording or uploading… finish before saving.' :
      failed ? 'An attachment didn’t upload. Remove it and try again.' : 'Ee gnapakam manake sontham.';
    $('mood-help').classList.toggle('is-required', !validMood());
  }
  function renderMoodChips() {
    var quick = UI.quickMoods.slice();
    if (state.draftMood && quick.indexOf(state.draftMood) === -1) quick.push(state.draftMood);
    function render(wrap, ids) {
      wrap.textContent = '';
      ids.forEach(function (id) {
        var chip = document.createElement('button'); chip.type = 'button'; chip.className = 'mood-chip';
        chip.dataset.mood = id; chip.textContent = UI.moodLabel(id);
        chip.setAttribute('aria-pressed', String(id === state.draftMood));
        chip.disabled = state.saving;
        chip.addEventListener('click', function () {
          state.draftMood = id;
          // Keep the sheet open for comparison and announce the current choice.
          renderMoodChips(); updateSaveState();
          var replacement = wrap.querySelector('[data-mood="' + id + '"]');
          if (replacement) replacement.focus({ preventScroll: true });
        });
        wrap.appendChild(chip);
      });
    }
    render($('mood-chips'), quick);
    render($('all-moods'), UI.moods.map(function (mood) { return mood.id; }));
  }
  function handleSave(event) {
    event.preventDefault();
    if (state.saving) return;
    if (!validMood()) { toast('Oka mood choose chesko.'); $('more-moods').focus(); return; }
    if (hasPendingMedia()) { toast('Finish the recording or upload first.'); return; }
    if (state.draftPhotos.some(function (p) { return p.status !== 'done'; })) { toast('Remove the failed attachment and try again.'); return; }
    var entryId = $('entry-id').value;
    var payload = { date: $('entry-date').value, title: $('entry-title').value,
      body: $('entry-body').value, mood: state.draftMood, media: draftMediaKeys() };
    var token = state.token;
    state.saving = true; $('entry-error').hidden = true; updateSaveState(); renderMoodChips();
    var path = entryId ? '/entries/' + payload.date + '/' + entryId : '/entries';
    api(path, { method: entryId ? 'PATCH' : 'POST', body: payload }).then(function () {
      if (state.token !== token) return;
      if (entryId) closeSheet(true);
      else {
        resetComposer(isoDate(new Date()));
        state.month = payload.date.slice(0, 7); state.selectedDay = payload.date;
        state.authorFilter = ''; renderAuthorFilters(); setView('memories');
      }
      toast('Mana gnapakam, saved ♥');
      return loadMonth();
    }).catch(function (err) {
      if (state.token !== token || err.message === 'unauthorized') return;
      $('entry-error').textContent = err.message; $('entry-error').hidden = false;
    }).finally(function () { state.saving = false; updateSaveState(); renderMoodChips(); });
  }
  function handleDelete() {
    var id = $('entry-id').value, date = $('entry-date').value;
    if (!id || state.saving || hasPendingMedia()) return;
    if (!window.confirm('Delete this entry? This cannot be undone.')) return;
    state.saving = true; updateSaveState();
    api('/entries/' + date + '/' + id, { method: 'DELETE' }).then(function () {
      closeSheet(true); toast('Entry deleted'); return loadMonth();
    }).catch(function (err) { if (err.message !== 'unauthorized') toast(err.message); })
      .finally(function () { state.saving = false; updateSaveState(); });
  }
  /* --- Photos -------------------------------------------------------------- */

  function renderPhotoGrid(images) {
    var grid = document.createElement('div');
    grid.className = 'entry-photos' + (images.length === 1 ? ' is-single' : '');

    images.forEach(function (item, index) {
      if (!item.url) return;

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'entry-photo';
      button.setAttribute('aria-label', 'Photo ' + (index + 1) + ' of ' + images.length);

      var img = document.createElement('img');
      img.src = item.url;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      button.appendChild(img);

      button.addEventListener('click', function (event) {
        // Without this the click also opens the entry for editing.
        event.stopPropagation();
        openLightbox(item.url);
      });

      grid.appendChild(button);
    });

    return grid;
  }

  /**
   * A voice note on an entry card.
   *
   * The browser's own <audio> control, deliberately - it is keyboard
   * accessible, it handles seeking and buffering, and on a phone it hooks
   * into the lock screen and the system volume. A hand-built player would be
   * prettier and worse.
   */
  function renderVoiceNote(item) {
    var wrap = document.createElement('div');
    wrap.className = 'entry-voice';

    var label = document.createElement('div');
    label.className = 'entry-voice-label';
    label.textContent = item.duration
      ? 'Voice note \u00b7 ' + formatDuration(item.duration)
      : 'Voice note';
    wrap.appendChild(label);

    var player = document.createElement('audio');
    player.controls = true;
    player.preload = 'none'; // do not pull every recording on a month's load
    player.src = item.url || '';
    player.className = 'entry-voice-player';
    // Playing must not also open the entry for editing.
    player.addEventListener('click', function (e) { e.stopPropagation(); });
    wrap.appendChild(player);

    wrap.addEventListener('click', function (e) { e.stopPropagation(); });
    return wrap;
  }

  function openLightbox(url) {
    $('lightbox-image').src = url;
    showDialog('lightbox', 'lightbox-close');
  }

  function closeLightbox() {
    hideDialog('lightbox');
    // Drop the reference so a large image is not held in memory while closed.
    $('lightbox-image').src = '';
  }

  /**
   * Upload one file and track it in state.
   *
   * Two steps: ask the API for a presigned PUT, then send the bytes straight
   * to storage. The file never passes through the API, which is what keeps
   * large photos from hitting request size limits.
   *
   * Uploads start as soon as a file is picked rather than on save, so by the
   * time the entry is written the photos are usually already there.
   */
  function uploadAttachment(file, options) {
    options = options || {};
    var localId = 'p' + Date.now() + Math.random().toString(36).slice(2, 8);
    var record = {
      localId: localId,
      key: null,
      status: 'uploading',
      kind: options.kind || (String(file.type).indexOf('audio/') === 0 ? 'audio' : 'image'),
      duration: options.duration || 0,
      contentType: file.type,
      // A local preview plays or shows instantly, before any byte has left
      // the device.
      previewUrl: URL.createObjectURL(file),
    };
    state.draftPhotos.push(record);
    renderDraftPhotos();

    return api('/media/presign', {
      method: 'POST',
      body: {
        contentType: file.type,
        size: file.size,
        month: ($('entry-date').value || '').slice(0, 7),
      },
    })
      .then(function (presigned) {
        return fetch(presigned.uploadUrl, {
          method: presigned.method || 'PUT',
          headers: { 'content-type': file.type },
          body: file,
        }).then(function (response) {
          if (!response.ok) throw new Error('upload failed');
          record.key = presigned.key;
          record.status = 'done';
          renderDraftPhotos();
        });
      })
      .catch(function (err) {
        record.status = 'failed';
        renderDraftPhotos();
        if (err.message !== 'unauthorized') {
          toast(err.message === 'upload failed'
            ? (record.kind === 'audio' ? 'That recording did not upload' : 'A photo did not upload')
            : err.message);
        }
      });
  }

  function removeDraftPhoto(localId) {
    state.draftPhotos = state.draftPhotos.filter(function (photo) {
      if (photo.localId !== localId) return true;
      // Release the object URL; the browser will not do it for us.
      revokePreview(photo);
      return false;
    });
    renderDraftPhotos();
  }

  function clearDraftPhotos() {
    if (previewAudio) { previewAudio.pause(); previewAudio = null; }
    state.draftPhotos.forEach(revokePreview);
    state.draftPhotos = [];
  }

  function renderDraftPhotos() {
    var strip = $('photo-strip');
    strip.textContent = '';

    state.draftPhotos.forEach(function (photo) {
      var isAudio = photo.kind === 'audio';
      var chip = document.createElement('div');
      chip.className = 'photo-chip'
        + (isAudio ? ' is-audio' : '')
        + (photo.status === 'uploading' ? ' is-uploading' : '')
        + (photo.status === 'failed' ? ' is-failed' : '');

      if (isAudio) {
        // A voice note has nothing to show, so the chip carries its length
        // and a play control instead of a thumbnail.
        var glyph = document.createElement('span');
        glyph.className = 'chip-glyph';
        glyph.textContent = '\u25B6';
        glyph.setAttribute('aria-hidden', 'true');
        chip.appendChild(glyph);

        var length = document.createElement('span');
        length.className = 'chip-length';
        length.textContent = formatDuration(photo.duration);
        chip.appendChild(length);

        chip.addEventListener('click', function (event) {
          if (event.target.closest('.photo-remove')) return;
          playPreview(photo.previewUrl);
        });
        chip.title = 'Voice note, ' + formatDuration(photo.duration);
      } else {
        var img = document.createElement('img');
        img.src = photo.previewUrl || '';
        img.alt = '';
        chip.appendChild(img);
      }

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'photo-remove';
      remove.textContent = '\u00d7';
      remove.setAttribute('aria-label', isAudio ? 'Remove voice note' : 'Remove photo');
      remove.addEventListener('click', function () { if (!state.saving) removeDraftPhoto(photo.localId); });
      chip.appendChild(remove);

      strip.appendChild(chip);
    });

    var remaining = MAX_PHOTOS - state.draftPhotos.length;
    $('add-photo-btn').disabled = remaining <= 0;
    $('photo-label').textContent = remaining <= 0
      ? 'Ten attachments is the limit'
      : (state.draftPhotos.some(function (p) { return p.kind !== 'audio'; })
          ? 'Add more' : 'Photo');

    $('record-btn').hidden = !canRecord();
    $('record-btn').disabled = remaining <= 0 && !isRecording();
    renderRecordButton();
  }

  /** Play a draft recording back before it is saved. */
  var previewAudio = null;
  function playPreview(url) {
    if (!url) return;
    if (previewAudio) previewAudio.pause();
    previewAudio = new Audio(url);
    previewAudio.play().catch(function () { toast('Could not play that'); });
  }

  function handlePhotoPick(event) {
    var files = Array.prototype.slice.call(event.target.files || []);
    // Reset immediately so picking the same file twice still fires a change.
    event.target.value = '';

    var room = MAX_PHOTOS - state.draftPhotos.length;
    if (files.length > room) {
      toast('Only ' + room + ' more photo' + (room === 1 ? '' : 's') + ' will fit');
      files = files.slice(0, room);
    }

    files.forEach(function (file) { uploadAttachment(file); });
  }

  /**
   * The attachments that finished uploading, as the API expects them.
   * Objects rather than bare keys, so a voice note keeps its length - the
   * player can label itself before the audio has loaded.
   */
  function draftMediaKeys() {
    return state.draftPhotos
      .filter(function (photo) { return photo.status === 'done' && photo.key; })
      .map(function (photo) {
        return {
          key: photo.key,
          contentType: photo.contentType || '',
          duration: photo.duration || 0,
        };
      });
  }

  /* --- Voice notes --------------------------------------------------------- */

  function supportedAudioType() {
    if (typeof MediaRecorder === 'undefined') return '';
    for (var i = 0; i < AUDIO_TYPES.length; i++) {
      if (MediaRecorder.isTypeSupported(AUDIO_TYPES[i])) return AUDIO_TYPES[i];
    }
    // Some browsers support recording but report nothing; let the default win.
    return '';
  }

  function canRecord() {
    return Boolean(
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia &&
      typeof MediaRecorder !== 'undefined'
    );
  }

  function formatDuration(seconds) {
    var total = Math.max(0, Math.round(seconds));
    var mins = Math.floor(total / 60);
    var secs = total % 60;
    return mins + ':' + String(secs).padStart(2, '0');
  }

  function isRecording() {
    return Boolean(recorder.media && recorder.media.state === 'recording');
  }

  function startRecording() {
    if (state.draftPhotos.length >= MAX_PHOTOS || recorder.requesting || recorder.stopping) return;
    recorder.requesting = true;
    var generation = ++recorder.generation;
    renderRecordButton();
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      if (generation !== recorder.generation || !state.token) {
        stream.getTracks().forEach(function (track) { track.stop(); }); return;
      }
      var mimeType = supportedAudioType();
      recorder.stream = stream; recorder.chunks = []; recorder.requesting = false;
      var media = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream);
      recorder.media = media;
      media.addEventListener('dataavailable', function (event) {
        if (generation === recorder.generation && event.data && event.data.size) recorder.chunks.push(event.data);
      });
      media.addEventListener('stop', function () {
        if (generation !== recorder.generation) return;
        var blob = new Blob(recorder.chunks, { type: media.mimeType || mimeType || 'audio/webm' });
        var seconds = (Date.now() - recorder.startedAt) / 1000;
        releaseMicrophone();
        if (blob.size > 0 && seconds >= 0.5) uploadAttachment(blob, { duration: seconds, kind: 'audio' });
        else toast('That was too short to keep');
      });
      recorder.startedAt = Date.now(); media.start(); renderRecordButton();
      recorder.timer = setInterval(renderRecordButton, 250);
    }).catch(function () {
      if (generation !== recorder.generation) return;
      releaseMicrophone(); toast('No microphone available');
    });
  }

  function stopRecording() {
    if (isRecording()) { recorder.stopping = true; recorder.media.stop(); }
    clearInterval(recorder.timer);
    recorder.timer = null;
    renderRecordButton();
  }

  /** Release the mic so the browser's recording indicator goes away. */
  function releaseMicrophone() {
    if (recorder.stream) {
      recorder.stream.getTracks().forEach(function (track) { track.stop(); });
    }
    recorder.stream = null;
    recorder.requesting = false; recorder.stopping = false;
    recorder.media = null;
    recorder.chunks = [];
    clearInterval(recorder.timer);
    recorder.timer = null;
    renderRecordButton();
  }

  function renderRecordButton() {
    var button = $('record-btn');
    var label = $('record-label');
    if (!button) return;

    if (isRecording()) {
      button.classList.add('is-recording');
      label.textContent = 'Stop ' + formatDuration((Date.now() - recorder.startedAt) / 1000);
    } else {
      button.classList.remove('is-recording');
      label.textContent = state.draftPhotos.some(function (p) { return p.kind === 'audio'; })
        ? 'Record another'
        : (recorder.requesting ? 'Opening mic…' : recorder.stopping ? 'Finishing…' : 'Voice note');
    }
    button.disabled = state.saving || recorder.requesting || recorder.stopping || (state.draftPhotos.length >= MAX_PHOTOS && !isRecording());
    updateSaveState();
  }


  /* Wiring and safe PWA updates. No journal content is stored in shell caches. */
  function bindEvents() {
    $('signin-form').addEventListener('submit', handleSignIn);
    $('signin-back').addEventListener('click', function () {
      state.pendingMember = null; $('signin-form').hidden = true;
      $('member-picker').hidden = false; $('signin-error').hidden = true; $('passphrase').value = '';
    });
    $('show-password').addEventListener('click', function () {
      var showing = $('passphrase').type === 'password';
      $('passphrase').type = showing ? 'text' : 'password';
      $('show-password').textContent = showing ? 'Hide' : 'Show';
      $('show-password').setAttribute('aria-label', (showing ? 'Hide' : 'Show') + ' passphrase');
    });
    $('account-btn').addEventListener('click', function () { showDialog('account-backdrop', 'account-close'); if (reminders) reminders.refresh(); });
    $('signout-btn').addEventListener('click', function () {
      if (state.saving || hasPendingMedia()) { toast('Finish the recording or upload first.'); return; }
      if (hasDraft() && !window.confirm('Sign out and discard your unsaved draft?')) return;
      if (reminders && reminders.isBusy()) { toast('Finish the reminder update first.'); return; }
      if (reminders) reminders.disable().catch(function () {}).finally(function () { signOut('Signed out'); });
      else signOut('Signed out');
    });
    document.querySelectorAll('[data-view]').forEach(function (button) {
      button.addEventListener('click', function () { setView(button.dataset.view); });
    });
    document.querySelectorAll('[data-month-shift]').forEach(function (button) {
      button.addEventListener('click', function () { changeMonth(monthShift(state.month, Number(button.dataset.monthShift))); });
    });
    document.querySelectorAll('.month-input').forEach(function (input) {
      input.addEventListener('change', function () { changeMonth(input.value); });
    });
    $('today-history').addEventListener('click', function () {
      state.month = $('entry-date').value.slice(0, 7); state.selectedDay = $('entry-date').value;
      setView('calendar'); loadMonth();
    });
    $('compose-btn').addEventListener('click', function () { startNewEntry(isoDate(new Date())); });
    $('calendar-compose').addEventListener('click', function () { startNewEntry(state.selectedDay || state.month + '-01'); });
    $('sheet-close').addEventListener('click', function () { closeSheet(false); });
    $('cancel-btn').addEventListener('click', function () { closeSheet(false); });
    $('delete-btn').addEventListener('click', handleDelete);
    $('entry-form').addEventListener('submit', handleSave);
    ['entry-title', 'entry-body'].forEach(function (id) { $(id).addEventListener('input', updateSaveState); });
    $('entry-date').addEventListener('change', function () {
      if ($('entry-date').value) $('today-date').textContent = dayTitle($('entry-date').value);
      updateSaveState();
    });
    $('more-moods').addEventListener('click', function () { showDialog('mood-backdrop', 'mood-close'); });
    $('clear-mood').addEventListener('click', function () {
      if (state.saving) return;
      state.draftMood = ''; renderMoodChips(); updateSaveState();
    });
    ['mood-close', 'mood-done'].forEach(function (id) { $(id).addEventListener('click', function () { hideDialog('mood-backdrop'); }); });
    $('account-close').addEventListener('click', function () { hideDialog('account-backdrop'); });
    $('add-photo-btn').addEventListener('click', function () { if (!state.saving) $('photo-input').click(); });
    $('photo-input').addEventListener('change', handlePhotoPick);
    $('record-btn').addEventListener('click', function () {
      if (state.saving || recorder.requesting || recorder.stopping) return;
      if (isRecording()) stopRecording(); else startRecording();
    });
    $('lightbox-close').addEventListener('click', closeLightbox);
    ['lightbox', 'sheet-backdrop', 'mood-backdrop', 'account-backdrop'].forEach(function (id) {
      $(id).addEventListener('click', function (event) {
        if (event.target !== $(id)) return;
        if (id === 'lightbox') closeLightbox();
        else if (id === 'sheet-backdrop') closeSheet(false);
        else hideDialog(id);
      });
    });
    document.addEventListener('keydown', function (event) {
      var id = activeDialog(); if (!id) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (id === 'lightbox') closeLightbox();
        else if (id === 'sheet-backdrop') closeSheet(false);
        else hideDialog(id);
      }
      if (event.key === 'Tab') {
        var controls = Array.prototype.filter.call($(id).querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), audio[controls], [tabindex="0"]'), function (el) {
          return !el.hidden && !el.closest('[hidden]') && el.type !== 'hidden';
        });
        if (!controls.length) return;
        var first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !$(id).contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !$(id).contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    });
    window.addEventListener('beforeunload', function (event) {
      if (state.token && (hasDraft() || state.savedNewDraft || state.saving)) {
        event.preventDefault(); event.returnValue = '';
      }
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.token && !state.saving) {
        var today = isoDate(new Date());
        if (today !== state.lastToday && !hasDraft() && $('sheet-backdrop').hidden && $('entry-date').value === state.lastToday) resetComposer(today);
        state.lastToday = today; loadMonth();
      }
    });
  }
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    var hadController = Boolean(navigator.serviceWorker.controller), reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloading) return;
      // Never trade an unsaved memory for a fresh shell.
      if (hasDraft() || state.savedNewDraft || state.saving || (reminders && reminders.isBusy())) {
        toast('An update is ready. Reopen after saving your entry.'); return;
      }
      reloading = true; window.location.reload();
    });
    navigator.serviceWorker.register('sw.js').then(function (registration) {
      registration.update().catch(function () {});
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) registration.update().catch(function () {});
      });
    }).catch(function () {});
  }
  function init() {
    bindEvents();
    if (window.ManaReminders) { reminders = window.ManaReminders.create({ request: api, notify: toast }); reminders.bind(); }
    resetComposer(isoDate(new Date()));
    if (!API) { $('signin-view').hidden = false; toast('Cannot connect to the journal. Try again shortly.'); return; }
    api('/members').then(function (data) {
      state.members = data.members || []; renderMemberPicker();
      var token = recall(TOKEN_KEY), saved = recall(MEMBER_KEY);
      if (token && saved) {
        try {
          var member = JSON.parse(saved);
          if (member && state.members.some(function (m) { return m.id === member.id; })) {
            state.token = token; state.member = memberById(member.id); showApp(); return;
          }
        } catch (e) { /* fall through to sign-in */ }
      }
      $('signin-view').hidden = false;
    }).catch(function () {
      $('signin-view').hidden = false;
      $('signin-error').textContent = 'Cannot reach our journal. Please refresh to try again.';
      $('signin-error').hidden = false;
    });
    registerServiceWorker();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
