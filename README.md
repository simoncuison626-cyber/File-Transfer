# transferfile.com

A "Send Anywhere"-style file transfer website. Open it on two devices, type in a
6-digit code, and the files move **straight between the browsers**. Nothing is
uploaded, there is no account, and there is no backend to pay for.

Hosted for free on GitHub Pages over HTTPS, so it works from any network — your
Wi-Fi, mobile data, a hotel, anywhere.

```
  phone / laptop                          phone / laptop
 ┌───────────────┐   WebRTC (P2P)     ┌───────────────┐
 │   the site    │◀─── file bytes ────▶│   the site    │
 └───────┬───────┘                      └───────────────┘
         │  handshake only                       ▲
         └──────── PeerJS broker (0.peerjs.com) ─┘
```

The PeerJS cloud broker is used **only** to introduce the two browsers to each
other. File bytes never touch it, and never touch any server you control.

---

## Publish it on GitHub Pages

1. Create a repository named **`transferfile.com`** under your account.

2. Push this folder to it:

   ```sh
   git init
   git add .
   git commit -m "Add transferfile.com"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/transferfile.com.git
   git push -u origin main
   ```

   > Name the repo exactly `transferfile.com`. That string becomes the URL:
   > `https://YOUR-USERNAME.github.io/transferfile.com/`
   >
   > Naming it `beam` or `transfer-file` instead gives you a different path, so
   > pick `transferfile.com` if you want the site to read as a domain.

3. **repo → Settings → Pages → Source: _Deploy from a branch_ → `main`, folder
   `/ (root)` → Save.**

4. Wait a minute or two. Your site is live at:

   ```
   https://YOUR-USERNAME.github.io/transferfile.com/
   ```

`.github/workflows/deploy.yml` is included if you'd rather publish via **GitHub
Actions** — set Settings → Pages → Source to _GitHub Actions_ and it handles
itself from then on. You only need one of the two methods.

> There is deliberately **no `CNAME` file.** A `CNAME` is only for a domain you
> own. Since `transferfile.com` here is the *repository name*, not a domain you
> registered, adding one would make GitHub try to serve a domain that isn't
> yours and the site would break.

---

## Use it on your iPhone

1. Open the site URL in **Safari**.
2. Tap **Share → Add to Home Screen** so it behaves like an app.
3. On the computer holding the files: pick your files, tap **Create invite**.
4. A 6-digit code appears (e.g. `481920`), and the URL is copied to your
   clipboard. Either read it out and type it on the phone, or send yourself the
   link.
5. On the iPhone, paste the link into the Receive box — or just type the 6
   digits.
6. Tap **Accept & receive**, then **Save** on each file. Use **Share / AirDrop**
   to push a received file straight to a Mac.

Both devices need to be online at the same time. One direction per session.

---

## Run it on your own Wi-Fi instead

Double-click **`Start-Beam.cmd`** — no Python or extra software needed.

It detects your LAN address, opens the required firewall rule, starts a server
and prints the URL for your phone (also copied to the clipboard). Close the
window to stop it; nothing is left running.

It listens on **port 8001** by default, and prints the address it actually
bound to. Read that address rather than assuming — if 8001 is busy it moves to
the next free port.

```powershell
.\Start-Beam.ps1 -Port 9000       # different port
.\Start-Beam.ps1 -NoBrowser       # do not open a browser
.\Start-Beam.ps1 -SelfTest        # verify every file loads, then stop
.\Start-Beam.ps1 -Diagnose        # why a phone cannot connect
.\Start-Beam.ps1 -CleanFirewall   # remove the firewall rule again
```

> Your router can hand this PC a different address now and then (it has been
> 192.168.1.8, .9 and .6 during development). If the phone suddenly cannot
> reach it, the address has probably changed — re-run Start-Beam and use the
> address it prints now. `.\Start-Beam.ps1 -Diagnose` shows the current one.

Needs Administrator the first time, because Windows won't let a normal account
open a network port or add a firewall rule. If it can't, it says so and stops.

Two honest caveats about the local copy:

- It is plain HTTP, so the browser can't use the modern clipboard API (the
  launcher copies the address for you) and Chrome warns that downloads could be
  intercepted. Expected on a local network — and another reason to prefer the
  hosted version, which is HTTPS.
- Phone and computer must be on the same Wi-Fi.

---

## How it works

PeerJS has no built-in file transfer, so `assets/net.js` implements a small
framing layer over a raw (unencoded) data channel. Each message is one frame:

```
byte 0     type    1 = control (UTF-8 JSON)   2 = chunk (raw file bytes)
byte 1     slot    file index (chunks only)
byte 2-5   length  payload byte count, uint32 big-endian
byte 6...  payload
```

- Files are read in **64 KB** slices with `Blob.slice()`, so a large file never
  has to sit in memory on the sending side.
- The sender watches `bufferedAmount` and pauses above 4 MB queued, which keeps
  memory bounded on slow links.
- The receiver assembles one `Blob` per file, then offers a download or a Web
  Share / AirDrop action.
- The parser is incremental, so it tolerates frames split across messages or
  several frames batched into one — which real browsers do both of.

Handshake:

1. Sender draws a **6-digit code** (100000–999999) and claims it as its PeerJS
   ID, showing a QR code containing the invite link.
2. Receiver opens that link or types the 6 digits and dials the sender.
3. Receiver sends `{t:'request'}`; sender replies `{t:'manifest', files:[...]}`.
4. Receiver taps **Accept** (`{t:'accept'}`) or **Decline** (`{t:'reject'}`). The
   sender never transmits anything before that.
5. When the session ends — finished, declined or cancelled — the sender destroys
   its peer, so the code stops being reachable.

### About the short code

Six digits is short enough to read aloud and type on a phone, but it's ~1 in
900,000 rather than a UUID's ~1 in 10^30. Two things limit the exposure:

- The code is destroyed as soon as the session ends, not left listening.
- Nothing is transmitted until the receiver presses **Accept**, so a guessed
  code can at worst reveal a file *listing*, never contents.

To go back to a hard-to-guess ID, change `makeCode()` in `assets/app.js`. It can
return any string PeerJS accepts (`^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$`).

## Files

```
index.html                 markup for both panels
manifest.webmanifest       PWA metadata for Add to Home Screen
assets/style.css           all styling
assets/net.js              WebRTC transport, framing, chunking, backpressure
assets/app.js              UI: file picking, QR pairing, progress, save/share
assets/icon*.png|svg       app icons
assets/vendor/             PeerJS 1.5.4 + qrcode-generator 1.4.4 (both MIT)
Start-Beam.cmd / .ps1      local one-click launcher (optional, not needed for hosting)
```

Both libraries are committed locally on purpose: the page then loads no
third-party scripts at runtime, so a CDN outage or a flaky phone connection
cannot stop the app from starting.

## Limits worth knowing

Measured on this project rather than guessed:

| File size | Result | Receiver memory | Byte-exact |
| --- | --- | --- | --- |
| 3 files, small | works | negligible | verified |
| 300 MB | works, ~65 s | 322 MB | verified |
| 1200 MB | works | ~1.25 GB | verified |
| 2.5 GB | works, ~7.5 min | 2551 MB | transfer completed; checksum step itself ran out of memory |

- **Receiving holds the whole file in memory until you save it**, at roughly
  1.05x the file size, because chunks are collected before the Blob is built.
  The page shows this estimate before you start.
- **A ~2.5 GB transfer will not work on an iPhone.** iOS gives each tab a memory
  budget and terminates the page when it is exceeded. Receive large files on a
  computer.
- Keep both devices awake and unlocked for the whole transfer — a suspended
  tab stops JavaScript, so the transfer freezes. This is the usual cause of
  "it stopped moving".
- Up to 200 files per transfer.
- One direction per session; both devices must be on the page at the same time.
- The signalling broker (0.peerjs.com) is run by PeerJS as a free public
  service. It brokers the handshake only. For anything sensitive, run your own
  broker and pass its host/port to `new Peer(...)` in `assets/net.js`.

## Credits

- [PeerJS](https://peerjs.com/) 1.5.4 — MIT
- [qrcode-generator](https://github.com/kazuhikoarase/jsqrcode) 1.4.4 — MIT