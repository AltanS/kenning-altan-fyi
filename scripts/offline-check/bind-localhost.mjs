// Preload for the offline check. `server.ts` calls `app.listen(port)` with no
// host, which binds every interface. The harness must listen on 127.0.0.1 only,
// and it may not edit `server.ts`, so this wrapper adds the host argument.
import http from 'node:http';

const HOST = '127.0.0.1';
const original = http.Server.prototype.listen;

http.Server.prototype.listen = function listenOnLoopback(...args) {
  const [first, second] = args;
  const isPort = typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first));
  if (isPort && typeof second !== 'string') {
    args.splice(1, 0, HOST);
  }
  return original.apply(this, args);
};
