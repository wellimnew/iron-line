// Iron Line multiplayer server - no npm install needed, just Node.js 16+.
// Run:  node lan-server.js     (keep iron-line.html in the same folder)
// Works on your Wi-Fi (LAN) and on the internet (Render, Railway, Fly.io, a VPS, or a tunnel).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const PORT = +process.env.PORT || 3000, MAX = 6, FILE = path.join(__dirname, 'iron-line.html');
const rooms = new Map();                       // code -> Map(playerId -> socket)
rooms.set('LAN', new Map());                   // shared room for quick LAN play (no code)

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('iron-line-ok'); return; }
  if (u === '/' || u === '/iron-line.html') {
    fs.readFile(FILE, (e, d) => {
      if (e) { res.writeHead(500); res.end('iron-line.html must be in the same folder as lan-server.js'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(d);
    });
  } else { res.writeHead(404); res.end('Not found'); }
});

function frame(data, op = 1) {
  const p = Buffer.isBuffer(data) ? data : Buffer.from(data), n = p.length;
  let h;
  if (n < 126) h = Buffer.from([128 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 128 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 128 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}
function parse(b) {
  if (b.length < 2) return null;
  const op = b[0] & 15; let len = b[1] & 127, off = 2;
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
  let mask = null;
  if (b[1] & 128) { if (b.length < off + 4) return null; mask = b.slice(off, off + 4); off += 4; }
  if (b.length < off + len) return null;
  const data = Buffer.from(b.slice(off, off + len));
  if (mask) for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
  return { op, data, len: off + len };
}
const toStr = o => typeof o === 'string' ? o : JSON.stringify(o);
function broadcast(room, o, except) {
  const f = frame(toStr(o));
  for (const s of room.values()) if (s !== except && !s.destroyed) s.write(f);
}
function newCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ';          // no I, L, O to avoid confusion
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += A[Math.random() * A.length | 0]; } while (rooms.has(c));
  return c;
}

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  const q = new URL(req.url, 'http://x').searchParams;
  const create = q.get('new') === '1';
  let code = (q.get('room') || 'LAN').toUpperCase().slice(0, 8);
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.on('error', () => {});
  if (create) { code = newCode(); rooms.set(code, new Map()); }
  const room = rooms.get(code);
  if (!room) { sock.write(frame(toStr({ t: 'noroom' }))); sock.end(); return; }
  let id = 0; while (room.has(id)) id++;
  if (id >= MAX) { sock.write(frame(toStr({ t: 'full' }))); sock.end(); return; }
  sock.setNoDelay(true);
  room.set(id, sock);
  console.log('[' + code + '] Player ' + (id + 1) + ' joined (' + room.size + ' in room)');
  sock.write(frame(toStr({ t: 'hello', id, ids: [...room.keys()], room: code })));
  broadcast(room, { t: 'join', id }, sock);
  let buf = Buffer.alloc(0);
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    if (buf.length > 1 << 20) { sock.destroy(); return; }
    let f;
    while ((f = parse(buf))) {
      buf = buf.slice(f.len);
      if (f.op === 8) { sock.end(); return; }
      if (f.op === 9) { sock.write(frame(f.data, 10)); continue; }
      if (f.op === 1 && f.data.length < 65536) broadcast(room, f.data.toString(), sock);
    }
  });
  sock.on('close', () => {
    if (room.get(id) === sock) {
      room.delete(id);
      console.log('[' + code + '] Player ' + (id + 1) + ' left (' + room.size + ' in room)');
      broadcast(room, { t: 'leave', id });
      if (!room.size && code !== 'LAN') rooms.delete(code);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  IRON LINE - multiplayer server running on port ' + PORT + '\n');
  console.log('  Same Wi-Fi? Open one of these on every device:');
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list) if (i.family === 'IPv4' && !i.internal) console.log('    http://' + i.address + ':' + PORT);
  console.log('    http://localhost:' + PORT + '   (this computer)\n');
  console.log('  Online? Put this server on a web host (or use a tunnel) and open its https address.');
  console.log('  Then tap ONLINE MATCH > CREATE ROOM, and friends tap JOIN ROOM and type the code.\n');
});
