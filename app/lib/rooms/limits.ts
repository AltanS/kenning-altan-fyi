/**
 * The numbers the Rooms feature runs on, in one place.
 *
 * NO IMPORTS BELONG HERE. The create form reads the topic bounds and the worker
 * reads the timeouts, so this module is reached by the client bundle and by the
 * unit tier.
 *
 * THE FOUR TIME BOUNDS ARE ONE CHAIN, AND `tests/unit/rooms-limits.test.ts` PINS
 * IT. The worst case of one run is the generation deadline plus every attempt of
 * one reviewer (the two reviewers run side by side). The operation timeout sits
 * above that, the pg-boss job expiry above the operation timeout, and the stale
 * threshold above the expiry. Break the order and either a slow run is cut off
 * after it was paid for, or a reader can start a second paid run beside a live
 * one.
 */

/** The pg-boss queue a room build runs on. One worker: a build is the most expensive thing this app does. */
export const ROOM_QUEUE = 'build-room';

/** The shortest topic that is accepted, measured on the trimmed text. */
export const ROOM_TOPIC_MIN_CHARS = 2;

/** The longest topic that is accepted. A longer one is refused, never cut. */
export const ROOM_TOPIC_MAX_CHARS = 80;

/** From this many characters the form counts them out loud. */
export const ROOM_TOPIC_COUNTER_FROM_CHARS = 60;

/** Paid room builds one reader may start per UTC day, retries included. */
export const MAX_ROOM_BUILDS_PER_DAY = 10;

/** The provider timeout of the one generation call. A room is a large document, far past an explain answer. */
export const ROOM_GENERATE_TIMEOUT_MS = 150_000;

/** The provider timeout of one reviewer call. */
export const ROOM_REVIEW_TIMEOUT_MS = 100_000;

/** How many times each reviewer is asked before the run fails. */
export const ROOM_REVIEW_ATTEMPTS = 2;

/**
 * How long past the provider timeout the job waits before it gives a call up.
 *
 * The provider SDK retries some failures with a backoff of its own, which can
 * run far past the timeout it was handed. This margin is the job's own bound.
 */
export const ROOM_CALL_DEADLINE_MARGIN_MS = 5_000;

/** The workflow operation timeout. */
export const ROOM_OPERATION_TIMEOUT_MS = 420_000;

/** The pg-boss job expiry, in seconds. */
export const ROOM_JOB_EXPIRY_SECONDS = 480;

/** A `pending` room that has not moved for this long may be retried. */
export const ROOM_STALE_MS = 600_000;

/** Fewer surviving terms than this and the run fails. */
export const MIN_KEPT_TERMS = 10;

/** Fewer surviving sentences than this and the run fails. */
export const MIN_KEPT_SENTENCES = 5;

/** How often the room page asks where a pending build stands. */
export const ROOM_POLL_INTERVAL_MS = 3_000;

/** How often the rooms list is read again while one of them is pending. */
export const ROOM_LIST_REFRESH_MS = 5_000;
