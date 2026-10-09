// A kill service worker. Swap it in when the real worker (public/sw.js) misbehaves.
//
//   cp docs/sw-kill.js build/client/sw.js   # then redeploy the build/ folder
//
// Browsers check /sw.js for a new version on every page load and at least once a
// day. This file differs from the real worker, so each device installs it, empties
// every cache this origin holds, and reloads its open pages once. After that the
// device behaves like a plain website again.
//
// WHY IT DOES NOT UNREGISTER ITSELF. The app registers /sw.js on every page load
// (app/lib/service-worker.ts). A worker that removed its own registration would
// be installed again by the next load, run again, and reload the page again,
// forever. A registered worker with no fetch handler does nothing and costs
// nothing. To remove it for good, ship the real worker again.
//
// It has no fetch handler on purpose, so every request goes to the network.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clearEverythingThenReload());
});

async function clearEverythingThenReload() {
  const names = await caches.keys();
  await Promise.all(names.map((name) => caches.delete(name)));
  await self.clients.claim();

  // Each open page loads again from the network. A page that refuses is left alone.
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  await Promise.all(pages.map((page) => reloadPage(page)));
}

async function reloadPage(page) {
  try {
    await page.navigate(page.url);
  } catch {
    // The page is gone or cannot be navigated. The reader can reload it by hand.
  }
}
