/**
 * `GET /api/build`, what this server is running.
 *
 * The browser polls it and compares the commit against the one compiled into
 * the page it is already showing (`app/lib/update-store.ts`). Two consecutive
 * disagreements mean the tab is older than the server, and the reader is
 * offered a reload.
 *
 * PUBLIC AND UNAUTHENTICATED, on purpose. A reader who is signed out still
 * deserves a working reload prompt, and the three values here say nothing about
 * anybody: they are the version, the commit and the build time of software that
 * is published under the MIT licence.
 *
 * NO-STORE, AND THAT IS THE WHOLE ENDPOINT. A cached answer defeats the
 * feature: it would report the build the reader was served the first time,
 * which is the build they already have, forever. The service worker never
 * caches an `/api/` path either (`public/sw.js`), so this header is aimed at
 * the browser's own cache and at anything between it and the container.
 *
 * It answers from `SERVER_BUILD` rather than from the bundle's own `BUILD`, so
 * the server has one stamp whatever is running it. See
 * `app/lib/build-info.server.ts` for why that answer is derived live in
 * development and read from a file in production.
 */
import { SERVER_BUILD } from '#app/lib/build-info.server';

export function loader(): Response {
  return Response.json(SERVER_BUILD, {
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
    },
  });
}
