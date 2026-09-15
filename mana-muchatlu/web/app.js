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
    // Photos attached to the entry currently open in the compose sheet.
    // Each: { localId, key, status: 'uploading'|'done'|'failed', previewUrl }
    draftPhotos: [],
  };

  var MAX_PHOTOS = 10;

  // MediaRecorder gives a different container per browser and will not
  // negotiate: Chrome/Android produce webm/opus, Safari/iOS produce mp4.
  // Ask for what this browser actually supports rather than guessing.
  var AUDIO_TYPES = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];

  var recorder = {
    media: null,      // MediaRecorder
    stream: null,     // MediaStream, so the mic can be released
    chunks: [],
    startedAt: 0,
    timer: null,
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

    if (entry.media && entry.media.length) {
      var images = entry.media.filter(function (m) { return m.kind !== 'audio'; });
      var audio = entry.media.filter(function (m) { return m.kind === 'audio'; });

      if (images.length) card.appendChild(renderPhotoGrid(images));
      audio.forEach(function (item) { card.appendChild(renderVoiceNote(item)); });
    }

    function open() { openSheet(entry); }
    card.addEventListener('click', open);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });

    return card;
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
    $('lightbox').hidden = false;
  }

  function closeLightbox() {
    $('lightbox').hidden = true;
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
      if (photo.previewUrl) URL.revokeObjectURL(photo.previewUrl);
      return false;
    });
    renderDraftPhotos();
  }

  function clearDraftPhotos() {
    state.draftPhotos.forEach(function (photo) {
      if (photo.previewUrl) URL.revokeObjectURL(photo.previewUrl);
    });
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
      remove.setAttribute('aria-label', 'Remove photo');
      remove.addEventListener('click', function () { removeDraftPhoto(photo.localId); });
      chip.appendChild(remove);

      strip.appendChild(chip);
    });

    var remaining = MAX_PHOTOS - state.draftPhotos.length;
    $('add-photo-btn').disabled = remaining <= 0;
    $('add-photo-btn').textContent = remaining <= 0
      ? 'Ten attachments is the limit'
      : (state.draftPhotos.some(function (p) { return p.kind !== 'audio'; })
          ? 'Add more' : 'Add photos');

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
    if (state.draftPhotos.length >= MAX_PHOTOS) {
      toast('Ten attachments is the limit');
      return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var mimeType = supportedAudioType();
      recorder.stream = stream;
      recorder.chunks = [];
      recorder.media = mimeType
        ? new MediaRecorder(stream, { mimeType: mimeType })
        : new MediaRecorder(stream);

      recorder.media.addEventListener('dataavailable', function (event) {
        if (event.data && event.data.size) recorder.chunks.push(event.data);
      });

      recorder.media.addEventListener('stop', function () {
        // The recorder's own mimeType is authoritative - it may differ from
        // what we asked for.
        var type = recorder.media.mimeType || mimeType || 'audio/webm';
        var blob = new Blob(recorder.chunks, { type: type });
        var seconds = (Date.now() - recorder.startedAt) / 1000;

        releaseMicrophone();

        if (blob.size > 0 && seconds >= 0.5) {
          uploadAttachment(blob, { duration: seconds, kind: 'audio' });
        } else {
          toast('That was too short to keep');
        }
      });

      recorder.startedAt = Date.now();
      recorder.media.start();
      renderRecordButton();

      recorder.timer = setInterval(renderRecordButton, 250);
    }).catch(function () {
      // Denied, or no microphone. Either way there is nothing to retry.
      toast('No microphone available');
    });
  }

  function stopRecording() {
    if (isRecording()) recorder.media.stop();
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
        : 'Record a note';
    }
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

    // Existing photos come back already uploaded, so they start as 'done'
    // and their preview is the presigned url the API just handed us.
    clearDraftPhotos();
    if (isEdit && entry.media) {
      state.draftPhotos = entry.media.map(function (item, index) {
        return {
          localId: 'existing' + index,
          key: item.key,
          status: 'done',
          kind: item.kind || 'image',
          duration: item.duration || 0,
          contentType: item.contentType || '',
          previewUrl: item.url || '',
        };
      });
    }
    renderDraftPhotos();

    $('delete-btn').hidden = !isEdit;
    $('entry-error').hidden = true;
    $('sheet-backdrop').hidden = false;

    ($('entry-title')).focus();
  }

  function closeSheet() {
    // Leaving the mic live after the sheet closes would keep the browser's
    // recording indicator on with nothing to show for it.
    if (isRecording()) recorder.media.stop();
    releaseMicrophone();

    $('sheet-backdrop').hidden = true;
    clearDraftPhotos();
    renderDraftPhotos();
  }

  function handleSave(event) {
    event.preventDefault();

    var entryId = $('entry-id').value;

    if (isRecording()) {
      toast('Stop the recording first');
      return;
    }

    // Saving while an attachment is still in flight would silently drop it.
    var stillUploading = state.draftPhotos.some(function (photo) {
      return photo.status === 'uploading';
    });
    if (stillUploading) {
      toast('Still uploading - one moment');
      return;
    }

    var payload = {
      date: $('entry-date').value,
      title: $('entry-title').value,
      body: $('entry-body').value,
      mood: selectedMood(),
      media: draftMediaKeys(),
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

    $('add-photo-btn').addEventListener('click', function () { $('photo-input').click(); });
    $('photo-input').addEventListener('change', handlePhotoPick);

    $('record-btn').addEventListener('click', function () {
      if (isRecording()) stopRecording();
      else startRecording();
    });

    $('lightbox-close').addEventListener('click', closeLightbox);
    $('lightbox').addEventListener('click', function (e) {
      if (e.target === $('lightbox')) closeLightbox();
    });

    $('sheet-backdrop').addEventListener('click', function (e) {
      if (e.target === $('sheet-backdrop')) closeSheet();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      // Topmost layer first: the lightbox sits above the compose sheet.
      if (!$('lightbox').hidden) return closeLightbox();
      if (!$('sheet-backdrop').hidden) closeSheet();
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
