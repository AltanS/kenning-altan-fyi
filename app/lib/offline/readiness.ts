/**
 * readiness.ts, the small browser facts behind the "Offline use" card in settings.
 *
 * Two jobs, both best effort and neither able to throw:
 *
 *   1. {@link requestPersistentStorage} asks the browser not to evict this
 *      origin's storage. A device dictionary of a few hundred thousand words is
 *      worth having only if it is still there next week, and a browser under
 *      storage pressure deletes an origin that never asked. The worker module
 *      asks once, on the first online launch. An import is the moment the stored
 *      data becomes valuable, and the browser is likelier to say yes to an origin
 *      the reader just used, so the card asks again here.
 *   2. {@link needsHomeScreenAdvice} decides whether to show the iPhone sentence.
 *      Safari deletes the script-writable storage of a site the reader has not
 *      opened for seven days, UNLESS the site was added to the Home Screen. So the
 *      advice matters on iOS in a browser tab and nowhere else.
 *
 * The decision is a pure function over plain inputs so it can be tested with no
 * browser. The two readers around it touch `navigator`.
 */

/**
 * Ask the browser to keep this origin's storage, and report what it said.
 *
 * It asks only when the browser has not already agreed, so a granted request is
 * never repeated.
 *
 * @returns True when storage is persistent, false when the browser declined, and
 *   null when the browser has no such API or it threw.
 */
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    const storage = globalThis.navigator?.storage;
    if (storage?.persist === undefined || storage.persisted === undefined) return null;
    if (await storage.persisted()) return true;
    return await storage.persist();
  } catch {
    return null;
  }
}

/**
 * Whether the browser has agreed to keep this origin's storage, without asking.
 *
 * @returns True or false when the browser answers, null when it cannot.
 */
export async function readStoragePersisted(): Promise<boolean | null> {
  try {
    const storage = globalThis.navigator?.storage;
    if (storage?.persisted === undefined) return null;
    return await storage.persisted();
  } catch {
    return null;
  }
}

/** What {@link needsHomeScreenAdvice} reads. */
export interface HomeScreenAdviceInputs {
  /** `navigator.userAgent`. */
  userAgent: string;
  /** `navigator.platform`. An iPad that asks for desktop sites reports `MacIntel`. */
  platform: string;
  /** `navigator.maxTouchPoints`. A Mac has none, an iPad has several. */
  maxTouchPoints: number;
  /** Whether the page runs as an installed web app, with no browser chrome. */
  isStandalone: boolean;
}

/** An iPhone, an iPod or an iPad that names itself. */
const IOS_USER_AGENT = /iPad|iPhone|iPod/u;

/**
 * Whether the reader is on iOS in a browser tab, where saved data expires.
 *
 * An iPad in "desktop site" mode sends a Mac user agent, so a touch screen on a
 * `MacIntel` platform counts as iOS too.
 *
 * @param inputs The user agent, platform, touch points and standalone flag.
 * @returns True when the Home Screen sentence is worth showing.
 */
export function needsHomeScreenAdvice({
  userAgent,
  platform,
  maxTouchPoints,
  isStandalone,
}: HomeScreenAdviceInputs): boolean {
  if (isStandalone) return false;
  if (IOS_USER_AGENT.test(userAgent)) return true;
  return platform === 'MacIntel' && maxTouchPoints > 1;
}

/**
 * Read the inputs of {@link needsHomeScreenAdvice} from the browser.
 *
 * @returns The inputs, or null when there is no browser (a server render).
 */
export function readHomeScreenAdviceInputs(): HomeScreenAdviceInputs | null {
  const nav = globalThis.navigator;
  if (nav === undefined) return null;
  // iOS Safari exposes the installed state as a non-standard `navigator.standalone`.
  const iosStandalone = 'standalone' in nav && nav.standalone === true;
  const displayModeStandalone = globalThis.matchMedia?.('(display-mode: standalone)').matches === true;
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    isStandalone: iosStandalone || displayModeStandalone,
  };
}
