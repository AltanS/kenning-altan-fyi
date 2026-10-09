/**
 * A Node module-loader hook that turns a stylesheet import into an empty module.
 *
 * `app/root.tsx` imports CSS for its side effects and `./app.css?url` for a
 * URL string. Vite handles both; bare Node cannot load a `.css` file. A unit
 * test that needs to import the root route registers this hook first, then
 * imports it. See `root-offline-fallback-flag.test.ts`.
 */
export async function load(url, context, nextLoad) {
  const path = url.split('?')[0];
  if (path.endsWith('.css')) {
    return { format: 'module', source: 'export default "";', shortCircuit: true };
  }
  return nextLoad(url, context);
}
