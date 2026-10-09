/* Beam UI: file picking, QR pairing, progress, save/share. */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };

  /* ------------------------------------------------------------ helpers -- */

  function fmtBytes(n) {
    if (!isFinite(n) || n < 0) return '--';
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'], i = -1;
    do { n /= 1024; i += 1; } while (n >= 1024 && i < units.length - 1);
    return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + units[i];
  }

  function fmtDuration(sec) {
    if (!isFinite(sec) || sec < 0) return '';
    sec = Math.round(sec);
    if (sec < 60) return sec + 's left';
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + 'm ' + s + 's left';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm left';
  }

  /* Works for both File objects and the {name,size} manifests we receive. */
  function totalOf(list) {
    return list.reduce(function (a, f) { return a + f.size; }, 0);
  }

  var toastTimer;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  function status(el, msg, tone) {
    el.textContent = msg || '';
    el.dataset.tone = tone || 'idle';
    el.hidden = !msg;
  }

  function copyText(text, label) {
    var done = function () { toast(label + ' copied'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (ok) done(); else toast('Copy failed - select the text manually');
  }

  function trapErrors(err, where) {
    var e = err instanceof Error ? err : new Error((err && (err.message || err.type)) || String(err));
    var code = String(e.code || e.type || '');
    var panel = (where === 'Invite' || where === 'Send') ? '#send-status' : '#recv-status';

    if (/No device is answering/i.test(e.message)) {
      status($(panel), 'No device is answering that code. Keep the sending device open and try again.', 'bad');
      return;
    }
    if (/^(server-error|network|unavailable-id|socket-error|disconnected)$/.test(code) ||
        /Signalling server did not respond/i.test(e.message)) {
      status($(panel), 'Signalling server unreachable - check your internet connection.', 'bad');
      return;
    }
    status($(panel), (where ? where + ': ' : '') + e.message, 'bad');
  }

  /* ---------------------------------------------------------------- send -- */

  var sendFiles = [];
  var sender = null;
  var sendInvited = false;

  function renderSendFiles() {
    var ul = $('#send-files');
    ul.innerHTML = '';
    sendFiles.forEach(function (file, idx) {
      var li = document.createElement('li');
      li.innerHTML =
        '<span class="fname"></span>' +
        '<span class="fsize mono"></span>' +
        '<button class="icon-btn" type="button" aria-label="Remove">&times;</button>';
      li.querySelector('.fname').textContent = file.name;
      li.querySelector('.fsize').textContent = fmtBytes(file.size);
      li.querySelector('button').addEventListener('click', function () {
        sendFiles.splice(idx, 1);
        renderSendFiles();
      });
      ul.appendChild(li);
    });

    // A permanent line, not just a toast, so it is obvious the tap registered.
    var picked = $('#send-picked');
    if (sendFiles.length) {
      picked.textContent = sendFiles.length + ' file' + (sendFiles.length > 1 ? 's' : '') +
        ' selected \u00b7 ' + fmtBytes(totalOf(sendFiles));
      picked.hidden = false;
    } else {
      picked.hidden = true;
    }

    var total = totalOf(sendFiles);
    $('#send-go').disabled = sendFiles.length === 0 || sendInvited;
    $('#send-go').textContent = sendFiles.length ? 'Create invite for ' + sendFiles.length + ' file' + (sendFiles.length > 1 ? 's' : '') : 'Create invite';

    var note = $('#send-size-note');
    if (total > 2 * 1024 * 1024 * 1024) {
      note.textContent = 'That is ' + fmtBytes(total) + '. Very large transfers can fail on phones - splitting it up is safer.';
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }

  /* iOS Safari can drop the `change` event for the Photo Library entirely, so
     poll the input for a while after the picker closes. */
  var watchTimer = null;
  function watchInput(input) {
    if (watchTimer) clearInterval(watchTimer);
    var ticks = 0;
    watchTimer = setInterval(function () {
      ticks++;
      if (input.files && input.files.length) {
        clearInterval(watchTimer);
        watchTimer = null;
        syncInput(input);
        return;
      }
      if (ticks > 40) { clearInterval(watchTimer); watchTimer = null; }
    }, 250);
  }

  function addFiles(list) {
    var added = 0;
    for (var i = 0; i < list.length; i++) {
      if (sendFiles.length >= window.BeamNet.MAX_FILES) break;
      var file = list[i];
      var dup = sendFiles.some(function (f) {
        return f.name === file.name && f.size === file.size && f.lastModified === file.lastModified;
      });
      if (!dup) { sendFiles.push(file); added++; }
    }
    renderSendFiles();
    return added;
  }

  /* iOS Safari is inconsistent about firing `change` for the photo library, so
     re-check the input whenever the tab regains focus. Cheap, and it stops
     "I picked a photo and nothing happened". */
  function syncInput(input) {
    if (input.files && input.files.length) {
      var added = addFiles(input.files);
      input.value = '';
      if (added > 0) toast(added + ' file' + (added > 1 ? 's' : '') + ' added');
      scrollListIntoView();
      return true;
    }
    return false;
  }

  function scrollListIntoView() {
    var first = $('#send-files li');
    if (!first) return;
    try { first.scrollIntoView({ block: 'nearest' }); } catch (e) { }
  }

  function renderMeter(prefix, info) {
    var total = info.total || 0;
    var done = info.done || 0;
    var pct = total ? Math.min(100, (done / total) * 100) : 0;
    var verb = prefix === 'send' ? 'Sending' : 'Receiving';

    $('#' + prefix + '-fill').style.width = pct.toFixed(1) + '%';
    $('#' + prefix + '-count').textContent = fmtBytes(done) + ' / ' + fmtBytes(total);

    var rate = info.speed || 0;
    $('#' + prefix + '-rate').textContent = rate > 0 ? fmtBytes(rate) + '/s' : '';

    var eta = rate > 0 && total > done ? fmtDuration((total - done) / rate) : '';
    $('#' + prefix + '-phase').textContent = [info.name ? verb + ' ' + info.name : verb, eta].filter(Boolean).join(' \u00b7 ');
  }

  /* Progress is sampled mid-stream, so the bar can stop a hair short of 100%. */
  function finishMeter(prefix) {
    $('#' + prefix + '-fill').style.width = '100%';
    $('#' + prefix + '-phase').textContent = 'Finished';
    $('#' + prefix + '-rate').textContent = '';
  }

  /* qrcode-generator auto-selects the smallest QR version that fits and emits
   * SVG, which stays crisp on retina screens. */
  function renderQR(text) {
    var host = $('#qr');
    if (!host || !window.qrcode) return false;
    try {
      var code = window.qrcode(0, 'M');
      code.addData(text);
      code.make();
      host.innerHTML = code.createSvgTag(4, 0);
      return true;
    } catch (e) {
      host.textContent = '';
      return false;
    }
  }

  /* Six digits: short enough to dictate or type on a phone keyboard.
     Leading zeros are avoided so it is always read back as a 6-digit number. */
  function makeCode() {
    return String(100000 + Math.floor(Math.random() * 900000));
  }

  function createInvite() {
    if (!sendFiles.length || sendInvited) return;
    sendInvited = true;
    renderSendFiles();
    $('#send-go').disabled = true;
    inviteWith(makeCode(), 0);
  }

  /* A code already in use on the broker comes back as 'unavailable-id', so
     just draw a new one. 900k combinations means this is rare. */
  function inviteWith(code, attempt) {
    status($('#send-status'), attempt ? 'That code was taken, picking another...' : 'Starting up...', 'busy');

    var s = new window.BeamNet.Sender({
      error: function (e) { trapErrors(e, 'Send'); },
      request: function () {
        status($('#send-status'), 'They are reviewing the files...', 'busy');
      },
      rejected: function () {
        status($('#send-status'), 'The other device declined.', 'bad');
      },
      progress: function (info) { renderMeter('send', info); },
      done: function () {
        finishMeter('send');
        status($('#send-status'), 'All files delivered.', 'good');
        toast('Sent ' + sendFiles.length + ' file' + (sendFiles.length > 1 ? 's' : ''));
      },
      remoteCancel: function () {
        status($('#send-status'), 'The other device cancelled.', 'bad');
      }
    });
    sender = s;
    s.setFiles(sendFiles);

    s.invite(code).then(function () {
      var link = location.origin + location.pathname + '?c=' + code;
      $('#send-code').textContent = code;
      $('#invite').hidden = false;
      status($('#send-status'), 'Waiting for the other device...', 'busy');

      if (!renderQR(link)) toast('QR code unavailable - share the link instead');

      $('#copy-link').onclick = function () { copyText(link, 'Invite link'); };
      $('#copy-code').onclick = function () { copyText(code, 'Code'); };
    }).catch(function (e) {
      sender = null;
      if ((e.code || e.type) === 'unavailable-id' && attempt < 6) {
        inviteWith(makeCode(), attempt + 1);
        return;
      }
      trapErrors(e, 'Invite');
      sendInvited = false;
      renderSendFiles();
    });
  }

  /* ------------------------------------------------------------- receive -- */

  var receiver = null;
  var incoming = [];     // metadata from the offer
  var landed = [];       // completed blobs awaiting save

  function renderRecvFiles() {
    var ul = $('#recv-files');
    ul.innerHTML = '';
    incoming.forEach(function (m) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="fname"></span><span class="fsize mono"></span>';
      li.querySelector('.fname').textContent = m.name;
      li.querySelector('.fsize').textContent = fmtBytes(m.size);
      ul.appendChild(li);
    });
    var sum = document.createElement('li');
    sum.className = 'total';
    sum.innerHTML = '<span></span><span class="mono"></span>';
    sum.firstChild.textContent = incoming.length + ' file' + (incoming.length > 1 ? 's' : '');
    sum.lastChild.textContent = fmtBytes(totalOf(incoming));
    ul.appendChild(sum);
  }

  function renderOut() {
    var ul = $('#recv-out');
    ul.innerHTML = '';
    landed.forEach(function (item) {
      var li = document.createElement('li');

      var head = document.createElement('div');
      head.className = 'out-head';
      var name = document.createElement('span');
      name.className = 'fname';
      name.textContent = item.name;
      var size = document.createElement('span');
      size.className = 'fsize mono';
      size.textContent = fmtBytes(item.size);
      head.appendChild(name);
      head.appendChild(size);

      var acts = document.createElement('div');
      acts.className = 'btn-row';

      var save = document.createElement('button');
      save.className = 'btn primary sm';
      save.type = 'button';
      save.textContent = 'Save';
      save.addEventListener('click', function () {
        var a = document.createElement('a');
        a.href = item.url;
        a.download = item.name;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      });

      acts.appendChild(save);

      if (item.shareable) {
        var share = document.createElement('button');
        share.className = 'btn ghost sm';
        share.type = 'button';
        share.textContent = 'Share / AirDrop';
        share.addEventListener('click', function () {
          var file = new File([item.blob], item.name, { type: item.type || 'application/octet-stream' });
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            navigator.share({ files: [file], title: item.name }).catch(function () {});
          } else {
            toast('Sharing files is not supported in this browser');
          }
        });
        acts.appendChild(share);
      }

      li.appendChild(head);
      li.appendChild(acts);
      ul.appendChild(li);
    });
  }

  function canShareFiles() {
    try {
      var probe = new File([new Uint8Array(1)], 'p.txt', { type: 'text/plain' });
      return !!(navigator.canShare && navigator.canShare({ files: [probe] }));
    } catch (e) {
      return false;
    }
  }

  function extractId(value) {
    var raw = (value || '').trim();
    if (!raw) return '';
    var m = raw.match(/[?&]c=([^&#\s]+)/);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    // bare code pasted
    return raw.replace(/^beam:\/\//i, '').trim();
  }

  function connect() {
    var id = extractId($('#recv-input').value);
    if (!id) { status($('#recv-status'), 'Paste the invite link or code first.', 'bad'); return; }
    if (receiver) receiver.close();

    status($('#recv-status'), 'Looking for the sending device...', 'busy');
    $('#recv-go').disabled = true;
    $('#offer').hidden = true;

    receiver = new window.BeamNet.Receiver({
      error: function (e) { $('#recv-go').disabled = false; trapErrors(e, 'Connect'); },
      peerMissing: function () {
        status($('#recv-status'), 'No device is answering that code. Make sure the sender is still on this screen.', 'bad');
      },
      open: function () {
        status($('#recv-status'), 'Connected. Waiting for the file list...', 'busy');
      },
      manifest: function (files) {
        incoming = files;
        renderRecvFiles();
        $('#offer').hidden = false;
        status($('#recv-status'), 'They want to send you ' + files.length + ' file' + (files.length > 1 ? 's' : '') + '.', 'idle');
      },
      fileStart: function (info) {
        $('#recv-meter').hidden = false;
        status($('#recv-status'), 'Receiving...', 'busy');
        renderMeter('recv', { name: info.name, done: 0, total: receiver.total || totalOf(incoming), speed: 0 });
      },
      chunk: function (info) {
        renderMeter('recv', { name: receiver.slot && receiver.slot.name, done: info.received, total: info.total, speed: info.speed });
      },
      fileEnd: function (slot, blob) {
        landed.push({
          name: slot.name,
          size: slot.size || blob.size,
          type: slot.type,
          blob: blob,
          url: URL.createObjectURL(blob),
          shareable: canShareFiles()
        });
        renderOut();
      },
      done: function () {
        finishMeter('recv');
        status($('#recv-status'), 'Received ' + landed.length + ' file' + (landed.length > 1 ? 's' : '') + '. Save them below.', 'good');
        toast('Transfer complete');
      },
      remoteCancel: function () {
        status($('#recv-status'), 'The sending device cancelled.', 'bad');
      },
      rejected: function () {
        status($('#recv-status'), 'The sending device declined.', 'bad');
        $('#recv-go').disabled = false;
      },
      close: function () {
        $('#recv-go').disabled = false;
      }
    });

    receiver.connect(id).catch(function (e) {
      $('#recv-go').disabled = false;
      trapErrors(e, 'Connect');
    });
  }

  function acceptOffer() {
    if (!receiver) return;
    $('#offer').hidden = true;
    $('#recv-meter').hidden = false;
    receiver.accept();
  }

  function declineOffer() {
    if (!receiver) return;
    $('#offer').hidden = true;
    receiver.decline();
    receiver = null;
    status($('#recv-status'), 'Declined.', 'idle');
    $('#recv-go').disabled = false;
  }

  /* ----------------------------------------------------------------- wire -- */

  function init() {
    // ---- send panel
    var drop = $('#drop');
    var input = $('#file-input');

    // The input itself is what the user taps; do not call input.click() from
    // script, because iOS Safari ignores that and opens nothing.
    input.addEventListener('change', function () { syncInput(input); });

    window.addEventListener('focus', function () { watchInput(input); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) watchInput(input);
    });
    // The picker closes without a reliable event on iOS, so start watching as
    // soon as the user touches the zone.
    drop.addEventListener('touchstart', function () { watchInput(input); }, { passive: true });
    drop.addEventListener('pointerdown', function () { watchInput(input); });
    drop.addEventListener('mouseenter', function () { watchInput(input); });

    ['dragenter', 'dragover'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });

    $('#send-go').addEventListener('click', createInvite);
    $('#send-cancel').addEventListener('click', function () {
      if (sender) { sender.sendCtrl({ t: 'cancel' }); sender.close(); sender = null; }
      sendInvited = false;
      renderSendFiles();
      $('#invite').hidden = true;
      $('#send-meter').hidden = true;
      status($('#send-status'), 'Cancelled.', 'idle');
    });

    // ---- receive panel
    $('#recv-go').addEventListener('click', connect);
    $('#recv-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); connect(); }
    });
    $('#recv-accept').addEventListener('click', acceptOffer);
    $('#recv-reject').addEventListener('click', declineOffer);
    $('#recv-cancel').addEventListener('click', function () {
      if (receiver) { receiver.sendCtrl({ t: 'cancel' }); receiver.close(); receiver = null; }
      $('#recv-meter').hidden = true;
      $('#recv-go').disabled = false;
      status($('#recv-status'), 'Cancelled.', 'idle');
    });

    renderSendFiles();

    if (!window.Peer) {
      status($('#send-status'), 'The WebRTC library failed to load. Check your connection and refresh.', 'bad');
      $('#send-go').disabled = true;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Deep link from the QR code: auto-fill and connect.
  window.addEventListener('load', function () {
    var id = extractId(new URLSearchParams(location.search).get('c'));
    if (!id) return;
    $('#recv-input').value = id;
    $('#panel-recv').scrollIntoView({ behavior: 'smooth', block: 'center' });
    connect();
  });
})();
