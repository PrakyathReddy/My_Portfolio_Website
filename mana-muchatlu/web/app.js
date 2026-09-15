/* ===========================================================================
   Mana Muchatlu - client
   Vanilla JS, no build step, matching the portfolio it lives beside.
   At this size a framework would cost more in bytes than it saves in lines.
   =========================================================================== */
(function () {
  'use strict';

  var API = (window.MANA_CONFIG && window.MANA_CONFIG.apiBase) || '';
  var TOKEN_KEY = 'mana.token';
  var MEMBER_KEY = 'mana.member';

  var MOOD_GLYPHS = {
    happy: '😊', calm: '🌿', grateful: '🙏', silly: '😜',
    sad: '🥺', tired: '😴', excited: '✨', 'missing-you': '💌',
  };

  var state = {
    token: null,
    member: null,
    members: [],
    month: null,       // 'YYYY-MM'
    entries: [],
    summary: {},
    selectedDay: null, // 'YYYY-MM-DD' or null for the whole month
    pendingMember: null,
  };

  var $ = function (id) { return document.getElementById(id); };

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
    var headers = { 'content-type': 'application/json' };
    if (state.token) headers.authorization = 'Bearer ' + state.token;

    return fetch(API + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (res) {
      if (res.status === 401 && state.token) {
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
    for (var i = 0; i < state.members.length; i++) {
      if (state.members[i].id === id) return state.members[i];
    }
    return { id: id, name: id, initials: (id || '?').slice(0, 1).toUpperCase(), accent: '#8b7355' };
  }

  function makeAvatar(member, extraClass) {
    var el = document.createElement('div');
    el.className = 'avatar' + (extraClass ? ' ' + extraClass : '');
    el.style.setProperty('--avatar-accent', member.accent);
    el.textContent = member.initials;
    el.title = member.name;
    return el;
  }

  /* --- Sign in ------------------------------------------------------------- */
  function renderMemberPicker() {
    var picker = $('member-picker');
    picker.textContent = '';

    state.members.forEach(function (member) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'member-btn';
      btn.appendChild(makeAvatar(member));

      var name = document.createElement('span');
      name.className = 'member-btn-name';
      name.textContent = member.name;
      btn.appendChild(name);

      btn.addEventListener('click', function () {
        state.pendingMember = member;
        $('signin-name').textContent = member.name;
        picker.hidden = true;
        $('signin-form').hidden = false;
        $('signin-error').hidden = true;
        $('passphrase').focus();
      });

      picker.appendChild(btn);
    });
  }

  function handleSignIn(event) {
    event.preventDefault();
    if (!state.pendingMember) return;

    var submit = $('signin-submit');
    var errorEl = $('signin-error');
    submit.disabled = true;
    submit.textContent = 'Opening...';
    errorEl.hidden = true;

    api('/auth/login', {
      method: 'POST',
      body: { memberId: state.pendingMember.id, passphrase: $('passphrase').value },
    }).then(function (data) {
      state.token = data.token;
      state.member = data.member;
      store(TOKEN_KEY, data.token);
      store(MEMBER_KEY, JSON.stringify(data.member));
      $('passphrase').value = '';
      showApp();
    }).catch(function (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      $('passphrase').select();
    }).finally(function () {
      submit.disabled = false;
      submit.textContent = 'Open our journal';
    });
  }

  function signOut(message) {
    state.token = null;
    state.member = null;
    state.entries = [];
    store(TOKEN_KEY, null);
    store(MEMBER_KEY, null);

    $('app-view').hidden = true;
    $('signin-view').hidden = false;
    $('signin-form').hidden = true;
    $('member-picker').hidden = false;
    if (message) toast(message);
  }

  /* --- Calendar ------------------------------------------------------------ */
  function renderCalendar() {
    var grid = $('calendar-grid');
    grid.textContent = '';
    $('month-label').textContent = monthTitle(state.month);

    var parts = state.month.split('-');
    var year = Number(parts[0]);
    var monthIndex = Number(parts[1]) - 1;

    var first = new Date(year, monthIndex, 1);
    var daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    // JS weeks start Sunday; this calendar starts Monday.
    var leading = (first.getDay() + 6) % 7;
    var today = isoDate(new Date());

    for (var b = 0; b < leading; b++) {
      var blank = document.createElement('div');
      blank.className = 'day is-blank';
      grid.appendChild(blank);
    }

    for (var day = 1; day <= daysInMonth; day++) {
      var date = state.month + '-' + String(day).padStart(2, '0');
      var cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'day';
      cell.setAttribute('role', 'gridcell');
      if (date === today) cell.classList.add('is-today');
      if (date === state.selectedDay) cell.classList.add('is-selected');

      var num = document.createElement('span');
      num.textContent = String(day);
      cell.appendChild(num);

      var dots = document.createElement('span');
      dots.className = 'day-dots';
      var summary = state.summary[date];
      if (summary) {
        summary.authors.forEach(function (authorId) {
          var dot = document.createElement('span');
          dot.className = 'dot';
          dot.style.setProperty('--dot-accent', memberById(authorId).accent);
          dots.appendChild(dot);
        });
        cell.setAttribute('aria-label', dayTitle(date) + ', ' + summary.total + ' entries');
      } else {
        cell.setAttribute('aria-label', dayTitle(date));
      }
      cell.appendChild(dots);

      (function (thisDate) {
        cell.addEventListener('click', function () {
          state.selectedDay = state.selectedDay === thisDate ? null : thisDate;
          renderCalendar();
          renderFeed();
        });
      })(date);

      grid.appendChild(cell);
    }
  }

  /* --- Feed ---------------------------------------------------------------- */
  function renderFeed() {
    var feed = $('feed');
    feed.textContent = '';

    var visible = state.selectedDay
      ? state.entries.filter(function (e) { return e.date === state.selectedDay; })
      : state.entries;

    $('feed-label').textContent = state.selectedDay
      ? dayTitle(state.selectedDay)
      : monthTitle(state.month);
    $('clear-filter').hidden = !state.selectedDay;

    if (!visible.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';

      var headline = document.createElement('p');
      headline.className = 'empty-headline';
      headline.textContent = state.selectedDay
        ? 'Nothing written on this day'
        : 'This month is still blank';
      empty.appendChild(headline);

      var sub = document.createElement('p');
      sub.className = 'empty-sub';
      sub.textContent = 'Tap + to write the first one.';
      empty.appendChild(sub);

      feed.appendChild(empty);
      return;
    }

    visible.forEach(function (entry) {
      feed.appendChild(renderEntry(entry));
    });
  }

  function renderEntry(entry) {
    var author = memberById(entry.author);

    var card = document.createElement('article');
    card.className = 'entry';
    card.style.setProperty('--entry-accent', author.accent);
    card.tabIndex = 0;

    var head = document.createElement('div');
    head.className = 'entry-head';
    head.appendChild(makeAvatar(author, 'avatar-sm'));

    var meta = document.createElement('div');
    meta.className = 'entry-meta';

    var name = document.createElement('div');
    name.className = 'entry-author';
    name.textContent = author.name;
    meta.appendChild(name);

    var when = document.createElement('div');
    when.className = 'entry-when';
    when.textContent = dayTitle(entry.date);
    if (entry.updatedAt && entry.createdAt && entry.updatedAt - entry.createdAt > 1000) {
      var edited = document.createElement('span');
      edited.className = 'entry-edited';
      edited.textContent = ' · edited';
      when.appendChild(edited);
    }
    meta.appendChild(when);
    head.appendChild(meta);

    if (entry.mood && MOOD_GLYPHS[entry.mood]) {
      var mood = document.createElement('span');
      mood.className = 'entry-mood';
      mood.textContent = MOOD_GLYPHS[entry.mood];
      mood.title = entry.mood;
      head.appendChild(mood);
    }
    card.appendChild(head);

    if (entry.title) {
      var title = document.createElement('h3');
      title.className = 'entry-title';
      // textContent, never innerHTML: entry text is user input and this is the
      // one place a stray <script> could otherwise get a foothold.
      title.textContent = entry.title;
      card.appendChild(title);
    }

    if (entry.body) {
      var body = document.createElement('p');
      body.className = 'entry-body is-clamped';
      body.textContent = entry.body;
      card.appendChild(body);
    }

    function open() { openSheet(entry); }
    card.addEventListener('click', open);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });

    return card;
  }

  /* --- Loading ------------------------------------------------------------- */
  function loadMonth() {
    return api('/entries?month=' + encodeURIComponent(state.month))
      .then(function (data) {
        state.entries = data.entries || [];
        state.summary = data.summary || {};
        renderCalendar();
        renderFeed();
      })
      .catch(function (err) {
        if (err.message !== 'unauthorized') toast(err.message);
      });
  }

  /* --- Compose sheet ------------------------------------------------------- */
  function renderMoodChips(selected) {
    var wrap = $('mood-chips');
    wrap.textContent = '';

    Object.keys(MOOD_GLYPHS).forEach(function (mood) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'mood-chip';
      chip.dataset.mood = mood;
      chip.textContent = MOOD_GLYPHS[mood] + ' ' + mood.replace('-', ' ');
      chip.setAttribute('aria-pressed', String(mood === selected));

      chip.addEventListener('click', function () {
        var nowOn = chip.getAttribute('aria-pressed') !== 'true';
        wrap.querySelectorAll('.mood-chip').forEach(function (other) {
          other.setAttribute('aria-pressed', 'false');
        });
        chip.setAttribute('aria-pressed', String(nowOn));
      });

      wrap.appendChild(chip);
    });
  }

  function selectedMood() {
    var on = $('mood-chips').querySelector('.mood-chip[aria-pressed="true"]');
    return on ? on.dataset.mood : '';
  }

  function openSheet(entry) {
    var isEdit = Boolean(entry);

    $('sheet-title').textContent = isEdit ? 'Edit entry' : 'New entry';
    $('entry-id').value = isEdit ? entry.entryId : '';
    $('entry-date').value = isEdit ? entry.date : (state.selectedDay || isoDate(new Date()));
    $('entry-date').disabled = isEdit; // date is part of the key
    $('entry-title').value = isEdit ? entry.title : '';
    $('entry-body').value = isEdit ? entry.body : '';
    renderMoodChips(isEdit ? entry.mood : '');

    $('delete-btn').hidden = !isEdit;
    $('entry-error').hidden = true;
    $('sheet-backdrop').hidden = false;

    ($('entry-title')).focus();
  }

  function closeSheet() {
    $('sheet-backdrop').hidden = true;
  }

  function handleSave(event) {
    event.preventDefault();

    var entryId = $('entry-id').value;
    var payload = {
      date: $('entry-date').value,
      title: $('entry-title').value,
      body: $('entry-body').value,
      mood: selectedMood(),
    };

    var errorEl = $('entry-error');
    var saveBtn = $('save-btn');
    errorEl.hidden = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    var request = entryId
      ? api('/entries/' + payload.date + '/' + entryId, { method: 'PATCH', body: payload })
      : api('/entries', { method: 'POST', body: payload });

    request.then(function () {
      closeSheet();
      toast(entryId ? 'Saved' : 'Written down');
      // The entry may belong to a month other than the one on screen.
      var entryMonth = payload.date.slice(0, 7);
      if (entryMonth !== state.month) state.month = entryMonth;
      return loadMonth();
    }).catch(function (err) {
      if (err.message === 'unauthorized') return;
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }).finally(function () {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    });
  }

  function handleDelete() {
    var entryId = $('entry-id').value;
    var date = $('entry-date').value;
    if (!entryId) return;
    if (!window.confirm('Delete this entry? This cannot be undone.')) return;

    api('/entries/' + date + '/' + entryId, { method: 'DELETE' })
      .then(function () {
        closeSheet();
        toast('Deleted');
        return loadMonth();
      })
      .catch(function (err) {
        if (err.message !== 'unauthorized') toast(err.message);
      });
  }

  /* --- Views --------------------------------------------------------------- */
  function showApp() {
    $('signin-view').hidden = true;
    $('app-view').hidden = false;

    var avatar = $('current-avatar');
    var member = memberById(state.member.id);
    avatar.style.setProperty('--avatar-accent', member.accent);
    avatar.textContent = member.initials;
    avatar.title = 'Signed in as ' + member.name;

    state.month = state.month || isoMonth(new Date());
    loadMonth();
  }

  function showSignIn() {
    $('signin-view').hidden = false;
    $('app-view').hidden = true;
  }

  /* --- Wiring -------------------------------------------------------------- */
  function bindEvents() {
    $('signin-form').addEventListener('submit', handleSignIn);
    $('signin-back').addEventListener('click', function () {
      state.pendingMember = null;
      $('signin-form').hidden = true;
      $('member-picker').hidden = false;
      $('signin-error').hidden = true;
    });
    $('signout-btn').addEventListener('click', function () { signOut('Signed out'); });

    $('prev-month').addEventListener('click', function () {
      state.month = monthShift(state.month, -1);
      state.selectedDay = null;
      loadMonth();
    });
    $('next-month').addEventListener('click', function () {
      state.month = monthShift(state.month, 1);
      state.selectedDay = null;
      loadMonth();
    });
    $('clear-filter').addEventListener('click', function () {
      state.selectedDay = null;
      renderCalendar();
      renderFeed();
    });

    $('compose-btn').addEventListener('click', function () { openSheet(null); });
    $('sheet-close').addEventListener('click', closeSheet);
    $('cancel-btn').addEventListener('click', closeSheet);
    $('delete-btn').addEventListener('click', handleDelete);
    $('entry-form').addEventListener('submit', handleSave);

    $('sheet-backdrop').addEventListener('click', function (e) {
      if (e.target === $('sheet-backdrop')) closeSheet();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('sheet-backdrop').hidden) closeSheet();
    });

    // Refresh on return rather than polling. At ~10 entries a week, a socket
    // would hold a connection open for an event that fires twice a day.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.token) loadMonth();
    });
  }

  /* --- Boot ---------------------------------------------------------------- */
  function init() {
    bindEvents();

    if (!API) {
      showSignIn();
      toast('config.js is missing - run infra/deploy.sh');
      return;
    }

    api('/members').then(function (data) {
      state.members = data.members || [];
      renderMemberPicker();

      var token = recall(TOKEN_KEY);
      var savedMember = recall(MEMBER_KEY);
      if (token && savedMember) {
        try {
          state.token = token;
          state.member = JSON.parse(savedMember);
          showApp();
          return;
        } catch (e) { /* fall through to sign-in */ }
      }
      showSignIn();
    }).catch(function () {
      showSignIn();
      toast('Cannot reach the journal right now');
    });

    registerServiceWorker();
  }

  /* Register the worker, and reload once when a new one takes over.
   *
   * Without this, a browser that has already opened the app keeps running the
   * old page until it is closed and reopened - which for an installed PWA can
   * be weeks. The guard on `hadController` means this only fires when one
   * worker replaces another, never on a first install, where a reload would
   * just be a visible flicker for no gain. */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    var hadController = Boolean(navigator.serviceWorker.controller);
    var reloading = false;

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloading) return;
      reloading = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('sw.js').then(function (registration) {
      // Ask explicitly rather than relying on the browser's own update
      // heuristics, which are throttled and vary between engines. An
      // installed PWA can sit for weeks without a cold start, so the
      // foreground check is what actually delivers updates in practice.
      registration.update().catch(function () { /* offline: try again later */ });

      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
          registration.update().catch(function () { /* non-fatal */ });
        }
      });
    }).catch(function () { /* non-fatal */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
