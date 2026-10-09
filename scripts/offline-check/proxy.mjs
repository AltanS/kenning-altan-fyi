// A loopback fault-injection proxy in front of the app. The browser talks to
// the proxy port, so "airplane mode" can be applied to everything at once,
// service worker fetches included, whatever the CDP emulation does.
//
//   online   forward to the app
//   offline  read the request line, record it, then reset the socket
//   hang     accept the request and never answer (a captive portal or a
//            dead mobile link that holds the connection open)
//
// The Host header is forwarded untouched, so the app's CSRF check sees the same
// origin the browser sends.
import http from 'node:http';

export function createProxy({ listenPort, targetPort }) {
  let mode = 'online';
  const sockets = new Set();
  const log = [];

  const server = http.createServer((req, res) => {
    log.push({ at: Date.now(), mode, method: req.method, url: req.url });
    if (mode === 'offline') {
      req.socket.destroy();
      return;
    }
    if (mode === 'hang') return;
    const upstream = http.request(
      { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: req.headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (mode === 'offline') socket.destroy();
  });

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPort, '127.0.0.1', resolve);
      }),
    setMode(next) {
      mode = next;
      for (const socket of sockets) socket.destroy();
    },
    get mode() {
      return mode;
    },
    /** Requests that reached the proxy while it was not online, since `sinceIndex`. */
    blocked(sinceIndex = 0) {
      return log.slice(sinceIndex).filter((entry) => entry.mode !== 'online');
    },
    get logLength() {
      return log.length;
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
