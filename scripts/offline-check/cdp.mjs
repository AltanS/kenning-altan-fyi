// A tiny Chrome DevTools Protocol client with no dependencies. Node 22+ has a
// global WebSocket, so this needs nothing from node_modules.
//
// Why not agent-browser or Playwright for the harness itself:
//  - Playwright is not installed in this repo.
//  - agent-browser `set offline on` only applies Network.emulateNetworkConditions
//    to the page. The service worker runs in its own target, so a page-level
//    toggle can leave the worker online. Here the harness controls both the
//    page, the worker targets and a fault-injecting proxy (see proxy.mjs).
//  - Every scenario needs a fresh profile, a full browser restart and evidence
//    from the worker target, which a CLI session does not give cleanly.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export { sleep };

/** One WebSocket connection to the browser, speaking flat-session CDP. */
class Connection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (event) => this.onMessage(JSON.parse(event.data)));
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot open ${url}`)), { once: true });
    });
    return new Connection(ws);
  }

  onMessage(message) {
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 20000) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

/** A running Chrome with its own profile directory. */
export class Browser {
  constructor({ chromePath, profileDir, ownsProfile }) {
    this.chromePath = chromePath;
    this.profileDir = profileDir;
    this.ownsProfile = ownsProfile;
    this.child = null;
    this.conn = null;
    this.offline = false;
    this.workers = new Map(); // sessionId -> { targetId, url, console: [] }
    this.pages = new Set();
  }

  static async launch({ chromePath, profileDir = null }) {
    const ownsProfile = profileDir === null;
    const dir = profileDir ?? mkdtempSync(join(tmpdir(), 'kenning-offline-check-'));
    const browser = new Browser({ chromePath, profileDir: dir, ownsProfile });
    await browser.start();
    return browser;
  }

  async start() {
    const portFile = join(this.profileDir, 'DevToolsActivePort');
    if (existsSync(portFile)) rmSync(portFile);
    this.child = spawn(
      this.chromePath,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${this.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--window-size=1280,800',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], detached: false },
    );
    this.child.on('exit', () => {
      this.child = null;
    });

    const deadline = Date.now() + 20000;
    while (!existsSync(portFile)) {
      if (Date.now() > deadline) throw new Error('Chrome did not write DevToolsActivePort');
      await sleep(50);
    }
    // The file is written in two steps; wait until both lines are there.
    let lines = [];
    while (lines.length < 2 || !lines[1]) {
      lines = readFileSync(portFile, 'utf8').split('\n');
      if (Date.now() > deadline) throw new Error('DevToolsActivePort is incomplete');
      await sleep(50);
    }
    this.conn = await Connection.open(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
    this.conn.onEvent((message) => this.onBrowserEvent(message));
    await this.conn.send('Target.setDiscoverTargets', { discover: true });
    // Pick up service worker targets that already exist.
    const { targetInfos } = await this.conn.send('Target.getTargets');
    for (const info of targetInfos) if (info.type === 'service_worker') await this.attachWorker(info);
  }

  onBrowserEvent(message) {
    if (message.method === 'Target.targetCreated' && message.params.targetInfo.type === 'service_worker') {
      void this.attachWorker(message.params.targetInfo).catch(() => {});
    }
    if (message.method === 'Target.detachedFromTarget') {
      const worker = this.workers.get(message.params.sessionId);
      if (worker) worker.detached = true;
    }
    if (message.sessionId && this.workers.has(message.sessionId)) {
      const worker = this.workers.get(message.sessionId);
      if (message.method === 'Runtime.consoleAPICalled') {
        worker.console.push({
          type: message.params.type,
          text: message.params.args.map((a) => a.value ?? a.description ?? '').join(' '),
        });
      }
      if (message.method === 'Runtime.exceptionThrown') {
        worker.console.push({ type: 'exception', text: message.params.exceptionDetails.text });
      }
    }
  }

  async attachWorker(info) {
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
    const worker = { targetId: info.targetId, url: info.url, console: [], detached: false };
    this.workers.set(sessionId, worker);
    await this.conn.send('Runtime.enable', {}, sessionId).catch(() => {});
    await this.conn.send('Network.enable', {}, sessionId).catch(() => {});
    if (this.offline) await this.applyOffline(sessionId, true);
  }

  async applyOffline(sessionId, offline) {
    await this.conn
      .send(
        'Network.emulateNetworkConditions',
        { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
        sessionId,
      )
      .catch(() => {});
  }

  /** Emulates airplane mode at the browser level: every page and every worker target. */
  async setOffline(offline) {
    this.offline = offline;
    for (const page of this.pages) await this.applyOffline(page.sessionId, offline);
    for (const [sessionId, worker] of this.workers) if (!worker.detached) await this.applyOffline(sessionId, offline);
  }

  async newPage() {
    const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    await page.init();
    this.pages.add(page);
    if (this.offline) await this.applyOffline(sessionId, true);
    return page;
  }

  /** Evaluates in a live worker session, or null when no worker target is attached. */
  async workerEval(expression) {
    for (const [sessionId, worker] of [...this.workers].reverse()) {
      if (worker.detached) continue;
      try {
        const result = await this.conn.send(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          sessionId,
          8000,
        );
        if (result.exceptionDetails) continue;
        return { value: result.result.value, workerUrl: worker.url };
      } catch {
        // try the next one
      }
    }
    return null;
  }

  workerConsole() {
    return [...this.workers.values()].flatMap((worker) => worker.console);
  }

  async stopWorkers() {
    await this.conn.send('Target.getTargets').catch(() => {});
    // ServiceWorker.stopAllWorkers lives on a page session.
    const page = [...this.pages][0];
    if (page) {
      await page.send('ServiceWorker.enable').catch(() => {});
      await page.send('ServiceWorker.stopAllWorkers').catch(() => {});
    }
  }

  async allCookies() {
    const page = [...this.pages][0];
    if (!page) return [];
    const { cookies } = await page.send('Network.getAllCookies');
    return cookies;
  }

  async setCookies(cookies) {
    const page = [...this.pages][0];
    if (!page || cookies.length === 0) return;
    await page.send('Network.setCookies', {
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        ...(c.session ? {} : { expires: c.expires }),
      })),
    });
  }

  /**
   * A cold start: the whole browser process is closed and started again on the
   * same profile. Service worker registrations, caches, IndexedDB and the HTTP
   * cache survive on disk. Session cookies do not, so they are put back, as an
   * installed app's sign-in would be kept by the OS shell.
   */
  async restart() {
    const cookies = await this.allCookies();
    const wasOffline = this.offline;
    await this.stop({ keepProfile: true });
    this.offline = false;
    this.workers.clear();
    this.pages.clear();
    await this.start();
    const page = await this.newPage();
    await this.setCookies(cookies);
    await page.close();
    if (wasOffline) await this.setOffline(true);
  }

  async stop({ keepProfile = false } = {}) {
    try {
      await this.conn?.send('Browser.close', {}, undefined, 5000);
    } catch {
      // the browser may close the socket before it answers
    }
    this.conn?.close();
    const child = this.child;
    if (child) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (this.ownsProfile && !keepProfile) rmSync(this.profileDir, { recursive: true, force: true });
  }
}

/** One tab. */
export class Page {
  constructor(browser, targetId, sessionId) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.console = [];
    this.requests = new Map();
    this.failed = [];
    this.badResponses = [];
    this.frameNavigations = [];
    this.loadFired = false;
    browser.conn.onEvent((message) => {
      if (message.sessionId === sessionId) this.onEvent(message);
    });
  }

  send(method, params = {}, timeoutMs = 20000) {
    return this.browser.conn.send(method, params, this.sessionId, timeoutMs);
  }

  async init() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    await this.send('Log.enable');
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  onEvent({ method, params }) {
    switch (method) {
      case 'Runtime.consoleAPICalled':
        if (['error', 'warning', 'assert'].includes(params.type)) {
          this.console.push({
            type: params.type,
            text: params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400),
          });
        }
        break;
      case 'Runtime.exceptionThrown':
        this.console.push({
          type: 'exception',
          text: `${params.exceptionDetails.text} ${params.exceptionDetails.exception?.description ?? ''}`.slice(0, 400),
        });
        break;
      case 'Log.entryAdded':
        if (['error', 'warning'].includes(params.entry.level)) {
          this.console.push({
            type: `log-${params.entry.level}`,
            text: `${params.entry.text} ${params.entry.url ?? ''}`.slice(0, 400),
          });
        }
        break;
      case 'Network.requestWillBeSent':
        this.requests.set(params.requestId, { url: params.request.url, type: params.type });
        break;
      case 'Network.responseReceived': {
        const entry = this.requests.get(params.requestId) ?? { url: params.response.url };
        if (params.response.status >= 400) {
          this.badResponses.push({
            url: entry.url,
            status: params.response.status,
            fromServiceWorker: Boolean(params.response.fromServiceWorker),
          });
        }
        break;
      }
      case 'Network.loadingFailed': {
        const entry = this.requests.get(params.requestId) ?? { url: '?' };
        if (params.errorText === 'net::ERR_ABORTED' && !params.blockedReason) break;
        this.failed.push({ url: entry.url, type: entry.type, error: params.errorText });
        break;
      }
      case 'Page.frameNavigated':
        if (!params.frame.parentId) this.frameNavigations.push(params.frame.url);
        break;
      case 'Page.loadEventFired':
        this.loadFired = true;
        break;
      default:
    }
  }

  /** Clears the per-step event buffers, so evidence covers one step only. */
  resetEvidence() {
    this.console = [];
    this.requests = new Map();
    this.failed = [];
    this.badResponses = [];
    this.frameNavigations = [];
  }

  /** Navigates and waits for the load event, but never longer than timeoutMs. */
  async goto(url, { timeoutMs = 15000 } = {}) {
    this.loadFired = false;
    const started = Date.now();
    let navigation;
    try {
      navigation = await this.send('Page.navigate', { url }, timeoutMs);
    } catch (error) {
      return { ok: false, timedOut: true, error: error.message, ms: Date.now() - started };
    }
    if (navigation.errorText) return { ok: false, error: navigation.errorText, ms: Date.now() - started };
    while (!this.loadFired && Date.now() - started < timeoutMs) await sleep(50);
    return { ok: this.loadFired, timedOut: !this.loadFired, ms: Date.now() - started };
  }

  /** Evaluates an expression in the page. Returns { value } or { error }. */
  async eval(expression, timeoutMs = 10000) {
    try {
      const result = await this.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        timeoutMs,
      );
      if (result.exceptionDetails) {
        return { error: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text };
      }
      return { value: result.result.value };
    } catch (error) {
      return { error: error.message };
    }
  }

  /** Polls until the expression is truthy. Returns { ok, ms, value }. */
  async waitFor(expression, { timeoutMs = 10000, intervalMs = 100 } = {}) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeoutMs) {
      last = await this.eval(expression, 3000);
      if (last.value) return { ok: true, ms: Date.now() - started, value: last.value };
      await sleep(intervalMs);
    }
    return { ok: false, ms: Date.now() - started, value: last?.value, error: last?.error };
  }

  async url() {
    return (await this.eval('location.href', 3000)).value ?? '';
  }

  async bodyText(limit = 600) {
    const result = await this.eval(`(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, ${limit})`, 3000);
    return result.value ?? `(no body: ${result.error ?? '?'})`;
  }

  async screenshot(path) {
    try {
      const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, 10000);
      writeFileSync(path, Buffer.from(data, 'base64'));
      return path;
    } catch (error) {
      return `(screenshot failed: ${error.message})`;
    }
  }

  async mouseClickAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  /**
   * A real mouse click on the first element matching the selector.
   *
   * A real click goes to whatever is on top at that point. During a view
   * transition (every in-app link runs one, about 250 ms) the browser paints a
   * pseudo-element tree over the page, and a click there hits the root
   * element and is lost. The page looks ready (the search box exists) well
   * inside that window, so this waits up to 2 s until the point really hits the
   * target, and records a console entry if it never does.
   */
  async click(selector) {
    const probe = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      const covered = !(hit && (hit === el || el.contains(hit)));
      return { x, y, w: r.width, h: r.height, covered, hit: hit ? hit.tagName : null };
    })()`;
    let box = await this.eval(probe);
    for (let waited = 0; box.value && box.value.w !== 0 && box.value.covered && waited < 2000; waited += 50) {
      await sleep(50);
      box = await this.eval(probe);
    }
    if (!box.value || box.value.w === 0) return false;
    if (box.value.covered) {
      this.console.push({ type: 'harness', text: `click on ${selector} lands on <${box.value.hit}>: covered for 2 s, clicking anyway` });
    }
    await this.mouseClickAt(box.value.x, box.value.y);
    return true;
  }

  /** Focuses a field, replaces its content with real text input. */
  async type(selector, text) {
    const focused = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      if (el.select) el.select();
      return document.activeElement === el;
    })()`);
    if (!focused.value) return false;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await this.send('Input.insertText', { text });
    return true;
  }

  async press(key, code, keyCode) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text: key === 'Enter' ? '\r' : undefined });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
  }

  async close() {
    this.browser.pages.delete(this);
    await this.browser.conn.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}
