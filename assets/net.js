/* Beam transport: PeerJS/WebRTC signalling + a tiny binary framing protocol.
 *
 * The site is 100% static, so the only third-party service involved is the
 * PeerJS broker. It is used purely for WebRTC handshake ("signalling") and
 * never carries a single file byte - those go straight between the browsers.
 *
 * Wire format, one binary frame per data-channel message:
 *
 *   byte 0   type   1 = control (utf8 JSON)   2 = chunk (raw file bytes)
 *   byte 1   slot   file index (chunks only)
 *   byte 2-5 length  payload byte length, uint32 big endian
 *   byte 6.. payload
 */
(function (global) {
  'use strict';

  var T_CTRL = 1;
  var T_CHUNK = 2;
  var HDR = 6;

  var CHUNK_SIZE = 64 * 1024;          // 64 KB per frame
  var HIGH_WATER = 4 * 1024 * 1024;    // pause sending above this buffer level
  var MAX_FILES = 200;

  var enc = new TextEncoder();
  var dec = new TextDecoder();

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function withTimeout(promise, ms, label) {
    var timer;
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        timer = setTimeout(function () { reject(new Error(label || 'Timed out')); }, ms);
      })
    ]).then(function (v) { clearTimeout(timer); return v; },
            function (e) { clearTimeout(timer); throw e; });
  }

  /* ------------------------------------------------------------ framing -- */

  function ctrlFrame(obj) {
    var payload = enc.encode(JSON.stringify(obj));
    var out = new Uint8Array(HDR + payload.length);
    var dv = new DataView(out.buffer);
    out[0] = T_CTRL;
    out[1] = 0;
    dv.setUint32(2, payload.length);
    out.set(payload, HDR);
    return out.buffer;
  }

  function chunkFrame(slot, bytes) {
    var out = new Uint8Array(HDR + bytes.length);
    var dv = new DataView(out.buffer);
    out[0] = T_CHUNK;
    out[1] = slot;
    dv.setUint32(2, bytes.length);
    out.set(bytes, HDR);
    return out.buffer;
  }

  /* Incremental parser. Tolerates frames split across or batched inside
   * messages, which keeps us honest across browsers. */
  function FrameParser(onCtrl, onChunk) {
    this.onCtrl = onCtrl;
    this.onChunk = onChunk;
    this.rest = null;
  }

  FrameParser.prototype.push = function (data) {
    var incoming = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    var buf = incoming;
    if (this.rest && this.rest.length) {
      buf = new Uint8Array(this.rest.length + incoming.length);
      buf.set(this.rest);
      buf.set(incoming, this.rest.length);
    }

    var off = 0;
    while (buf.length - off >= HDR) {
      var dv = new DataView(buf.buffer, buf.byteOffset + off, HDR);
      var type = dv.getUint8(0);
      var slot = dv.getUint8(1);
      var len = dv.getUint32(2);
      if (buf.length - off - HDR < len) break;
      var payload = buf.subarray(off + HDR, off + HDR + len);
      if (type === T_CTRL) {
        this.onCtrl(JSON.parse(dec.decode(payload)));
      } else if (type === T_CHUNK) {
        this.onChunk(slot, payload);
      }
      off += HDR + len;
    }
    // Anything we could not consume yet has to survive until the next push.
    this.rest = off < buf.length ? buf.slice(off) : null;
  };

  /* -------------------------------------------------------------- meters -- */

  function Meter() {
    this.bytes = 0;
    this._lastBytes = 0;
    this._lastAt = performance.now();
    this._speed = 0;
  }

  Meter.prototype.tick = function () {
    var now = performance.now();
    var dt = (now - this._lastAt) / 1000;
    if (dt >= 0.25) {
      var inst = (this.bytes - this._lastBytes) / dt;
      this._speed = this._speed ? this._speed * 0.6 + inst * 0.4 : inst;
      this._lastBytes = this.bytes;
      this._lastAt = now;
    }
    return this._speed;
  };

  /* ------------------------------------------------------------- session -- */

  function Session(hooks) {
    this.on = hooks || {};
    this.peer = null;
    this.conn = null;
    this.opened = null;
    this.aborted = false;
    this.parts = [];
    this.slot = null;
    this.total = 0;
    this.meter = new Meter();
  }

  Session.prototype._fail = function (err) {
    var e = err instanceof Error ? err : new Error((err && (err.message || err.type)) || 'Connection problem');
    e.code = (err && err.type) || e.code;
    if (this.on.error) this.on.error(e);
  };

  Session.prototype._newPeer = function (id) {
    if (!global.Peer) throw new Error('Could not load the WebRTC library (PeerJS). Check your connection.');
    var peer = new global.Peer(id, { debug: 1 });
    var self = this;
    peer.on('error', function (err) {
      // 'peer-unavailable' just means nobody answered that id yet.
      if (err && err.type === 'peer-unavailable') {
        if (self.on.peerMissing) self.on.peerMissing();
        return;
      }
      self._fail(err);
    });
    this.peer = peer;
    return peer;
  };

  Session.prototype._openPeer = function (id) {
    var peer = this._newPeer(id);
    var opened = new Promise(function (resolve, reject) {
      function fail(e) {
        // 'peer-unavailable' only means that id has not answered; peerMissing
        // already reports it and the connect() race handles the rejection.
        if (e && e.type === 'peer-unavailable') return;
        reject(e);
      }
      peer.on('open', resolve);
      peer.on('error', fail);
      peer.on('disconnected', function () { peer.reconnect(); });
    });
    return withTimeout(opened, 25000, 'Signalling server did not respond');
  };

  Session.prototype._attach = function (conn) {
    var self = this;
    if (this.conn) { conn.close(); return; }
    this.conn = conn;

    this.opened = new Promise(function (resolve) { self._resolveOpen = resolve; });
    this.parser = new FrameParser(
      function (msg) { self._onCtrl(msg); },
      function (slot, bytes) { self._onChunk(slot, bytes); }
    );

    conn.on('data', function (data) {
      if (data instanceof Blob) {
        data.arrayBuffer().then(function (ab) { self.parser.push(ab); }, function (e) { self._fail(e); });
      } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        self.parser.push(data);
      } else {
        self._fail(new Error('Unexpected data type on the wire'));
      }
    });
    conn.on('open', function () {
      if (self._resolveOpen) { self._resolveOpen(); self._resolveOpen = null; }
      if (self.on.open) self.on.open();
    });
    conn.on('close', function () { if (self.on.close) self.on.close(self.aborted); });
    conn.on('error', function (e) { self._fail(e); });
  };

  Session.prototype.sendCtrl = function (obj) {
    if (this.conn && this.conn.open) this.conn.send(ctrlFrame(obj));
  };

  /* PeerJS does not surface bufferedAmount on the DataConnection - it is only
     on the underlying RTCDataChannel. Reading conn.bufferedAmount gives
     undefined, the comparison is always false, and the sender happily queues
     the entire file in PeerJS's own buffer. Read the real channel. */
  Session.prototype.buffered = function () {
    try {
      var dc = this.conn && this.conn.dataChannel;
      if (dc && typeof dc.bufferedAmount === 'number') return dc.bufferedAmount;
    } catch (e) { }
    return 0;
  };

  Session.prototype.close = function () {
    this.aborted = true;
    try { if (this.conn) this.conn.close(); } catch (e) {}
    try { if (this.peer) this.peer.destroy(); } catch (e) {}
    this.conn = null;
    this.peer = null;
  };

  /* ---------------------------------------------------------------- send -- */

  function Sender(hooks) { Session.call(this, hooks); }
  Sender.prototype = Object.create(Session.prototype);
  Sender.prototype.constructor = Sender;

  /* `code` is the peer id we must be reachable at. Passing a short code like
   * "481920" is what makes it typeable on a phone. */
  Sender.prototype.invite = function (code) {
    var self = this;
    return this._openPeer(code).then(function (id) {
      self.id = id;
      self.peer.on('connection', function (conn) { self._attach(conn); });
      return id;
    });
  };

  Sender.prototype.setFiles = function (files) {
    if (files.length > MAX_FILES) throw new Error('Too many files (max ' + MAX_FILES + ')');
    this.files = files.slice();
  };

  Sender.prototype._onCtrl = function (msg) {
    if (!msg || !msg.t) return;
    if (msg.t === 'request') {
      // The other side asked what we have. Answer with the manifest and wait
      // for them to confirm; the device holding the files never sends blind.
      this.sendCtrl({
        t: 'manifest',
        files: (this.files || []).map(function (f) {
          return { name: f.name, size: f.size, type: f.type || '' };
        })
      });
      if (this.on.request) this.on.request();
    } else if (msg.t === 'accept') {
      this._pump();
    } else if (msg.t === 'complete') {
      // The receiver has every byte and has assembled the files. Now it is
      // safe to drop the peer.
      this.aborted = false;
      this.state = 'done';
      clearTimeout(this._ackTimer);
      if (this.on.done) this.on.done();
      var self = this;
      setTimeout(function () { self.close(); }, 250);
    } else if (msg.t === 'reject') {
      this.aborted = true;
      if (this.on.rejected) this.on.rejected();
      this.close();
    } else if (msg.t === 'cancel') {
      this.aborted = true;
      if (this.on.remoteCancel) this.on.remoteCancel();
      this.close();
    }
  };

  Sender.prototype._onChunk = function () {
    this._fail(new Error('Received unexpected file data'));
  };

  Sender.prototype._pump = function () {
    var self = this;
    var files = this.files || [];
    var total = files.reduce(function (a, f) { return a + f.size; }, 0);

    this.state = 'sending';
    if (this.on.progress) this.on.progress({ phase: 'sending', done: 0, total: total, speed: 0 });

    this.sendCtrl({ t: 'begin', total: total });

    var i = 0;
    (function nextFile() {
      // Bail out first: a cancel during the hand-off between files must not be
      // reported to the UI as a completed transfer.
      if (self.aborted) return;
      if (i >= files.length) {
        self.sendCtrl({ t: 'done' });
        self.state = 'sent';
        if (self.on.sent) self.on.sent();
        // Hold the peer open until the receiver acknowledges. Tearing it down
        // as soon as we finish writing would strand a slow receiver, which is
        // how large transfers used to freeze part way through.
        clearTimeout(self._ackTimer);
        self._ackTimer = setTimeout(function () { self.close(); }, 120000);
        return;
      }
      var file = files[i];
      var slot = i;
      self.sendCtrl({ t: 'file', slot: slot, name: file.name, size: file.size, type: file.type || '' });

      var offset = 0, lastReport = 0;
      (function nextChunk() {
        if (self.aborted) return;
        if (offset >= file.size) {
          self.sendCtrl({ t: 'endfile', slot: slot });
          i += 1;
          nextFile();
          return;
        }
        if (self.buffered() > HIGH_WATER) { sleep(20).then(nextChunk); return; }

        var end = Math.min(offset + CHUNK_SIZE, file.size);
        file.slice(offset, end).arrayBuffer().then(function (buf) {
          if (self.aborted) return;
          self.conn.send(chunkFrame(slot, new Uint8Array(buf)));
          offset = end;
          self.meter.bytes += buf.byteLength;

          var now = performance.now();
          if (now - lastReport > 90) {
            lastReport = now;
            if (self.on.progress) {
              self.on.progress({
                phase: 'sending', name: file.name, slot: slot,
                done: self.meter.bytes, total: total, speed: self.meter.tick()
              });
            }
          }
          nextChunk();
        }, function (err) { self._fail(err); });
      })();
    })();
  };

  /* ------------------------------------------------------------- receive -- */

  function Receiver(hooks) { Session.call(this, hooks); }
  Receiver.prototype = Object.create(Session.prototype);
  Receiver.prototype.constructor = Receiver;

  Receiver.prototype.connect = function (targetId) {
    var self = this;
    return this._openPeer(undefined).then(function () {
      var conn = self.peer.connect(targetId, {
        reliable: true,
        // 'raw' is PeerJS 1.5's passthrough channel (its .serialization reports
        // as "none"). Nothing is encoded, so our own framing owns the bytes.
        // Raw mode also refuses to chunk, which is why CHUNK_SIZE stays small.
        serialization: 'raw',
        metadata: { role: 'receiver' }
      });
      self._attach(conn);

      // Fail fast when the code simply does not exist, rather than sitting on
      // the open timeout while the sender may never even be online.
      var missing = new Promise(function (_, reject) {
        self.peer.on('error', function (err) {
          if (err && err.type === 'peer-unavailable') {
            reject(new Error('No device is answering that code.'));
          }
        });
      });

      return withTimeout(Promise.race([self.opened, missing]), 25000, 'The sending device did not answer')
        .then(function () {
          self.sendCtrl({ t: 'request' });
        });
    });
  };

  Receiver.prototype.accept = function () {
    this.state = 'receiving';
    this.sendCtrl({ t: 'accept' });
  };

  Receiver.prototype.decline = function () {
    this.sendCtrl({ t: 'reject' });
    this.close();
  };

  Receiver.prototype._onCtrl = function (msg) {
    if (!msg || !msg.t) return;
    if (msg.t === 'manifest') {
      if (this.on.manifest) this.on.manifest(msg.files || []);
    } else if (msg.t === 'reject') {
      if (this.on.rejected) this.on.rejected();
    } else if (msg.t === 'begin') {
      this.total = msg.total || 0;
      this.state = 'receiving';
    } else if (msg.t === 'file') {
      this.slot = { slot: msg.slot, name: msg.name, size: msg.size, type: msg.type || '' };
      this.parts = [];
      if (this.on.fileStart) this.on.fileStart(this.slot);
    } else if (msg.t === 'endfile') {
      var slot = this.slot;
      var blob = new Blob(this.parts, { type: (slot && slot.type) || 'application/octet-stream' });
      this.parts = [];
      this.slot = null;
      if (this.on.fileEnd) this.on.fileEnd(slot, blob);
    } else if (msg.t === 'done') {
      this.state = 'done';
      // Tell the sender we have everything, so it can retire the code and
      // close down instead of guessing that writing to the socket was enough.
      this.sendCtrl({ t: 'complete' });
      if (this.on.done) this.on.done();
    } else if (msg.t === 'cancel') {
      this.aborted = true;
      if (this.on.remoteCancel) this.on.remoteCancel();
    }
  };

  Receiver.prototype._onChunk = function (slot, bytes) {
    if (this.aborted) return;
    if (!this.slot) { this._fail(new Error('File data arrived out of order')); return; }
    var copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.meter.bytes += copy.byteLength;
    this.parts.push(copy);
    if (this.on.chunk) this.on.chunk({ slot: slot, received: this.meter.bytes, total: this.total, speed: this.meter.tick() });
  };

  global.BeamNet = {
    Sender: Sender,
    Receiver: Receiver,
    MAX_FILES: MAX_FILES
  };
})(window);
