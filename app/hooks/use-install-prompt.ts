import { useEffect, useState } from 'react';
import { reportError } from '#app/lib/report-error';

/**
 * WHAT THIS DEVICE CAN BE OFFERED, AS ONE ANSWER FOR EVERY SURFACE.
 *
 * Two places ask: the card on `/settings` (`app/components/install-app.tsx`)
 * and the row in the navigation (`app-sidebar.tsx` and the drawer in
 * `app-wrapper.tsx`). The detection lives here so they cannot disagree about
 * whether this browser can install the app.
 *
 * NOTHING TOUCHES `window` AT MODULE SCOPE, AND THE FIRST ANSWER IS ALWAYS
 * `pending`. That is the whole point of the hook rather than a function
 * called during render. Reading `navigator` or `matchMedia` while rendering
 * gives the server one answer and the browser another; React keeps the server's
 * markup and never repairs the difference, so the reader is left with a control
 * that can never do anything. Here the server renders nothing, the effect runs
 * after mount, and the offer appears only once it is real.
 *
 * FOUR STATES, NOT THREE. Chromium's own `beforeinstallprompt` is not the only
 * way to install: iOS, Firefox and Samsung Internet never fire it, and even a
 * Chromium browser can fire it before this hook's `useEffect` runs (see the
 * capture script in `root.tsx`). `unavailable` used to mean both of those
 * cases AND "nothing to see here", which meant most of the app's readers found
 * no install control anywhere. `manual` replaces it: it always has a written
 * set of steps, so the card is never empty.
 */
export type InstallOffer =
  | { kind: 'pending' }
  | { kind: 'installed' }
  | { kind: 'ready'; install: () => void }
  | { kind: 'manual'; platform: 'ios' | 'android' | 'desktop' };

/**
 * The install prompt Chromium browsers hand the page, as the members used here.
 *
 * IT IS DECLARED BECAUSE `lib.dom` DOES NOT CARRY IT. `beforeinstallprompt` is
 * a Chromium extension to the platform rather than a standard event, so no
 * ambient type exists for it. Naming only `preventDefault`, `prompt` and
 * `userChoice` keeps this declaration a statement about what the code depends
 * on, not a guess at the browser's full object.
 */
interface BeforeInstallPromptEvent {
  /** Stops the browser showing its own mini-infobar, so the page owns the moment. */
  preventDefault(): void;
  /** Opens the browser's install dialog. One event may do this ONCE. */
  prompt(): Promise<void>;
  /** Settles once the reader has answered the dialog. */
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * The event map augmentation is what makes `addEventListener` hand back the
 * type above with no assertion at the call site. Narrowing a plain `Event` with
 * `in` checks would not do it: `in` produces an intersection that still is not
 * this interface, so the narrowing would end in the cast it was meant to avoid.
 *
 * `Window.__installPromptEvent` is the other half of the same declaration: the
 * inline script in `root.tsx`'s `<head>` writes it before React exists, and
 * this is what lets the hook below read it back with no assertion either.
 */
declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }

  interface Window {
    __installPromptEvent: BeforeInstallPromptEvent | null;
  }
}

/** The internal state, which holds the event the public offer only spends. */
type InstallState =
  | { kind: 'pending' }
  | { kind: 'installed' }
  | { kind: 'ready'; event: BeforeInstallPromptEvent }
  | { kind: 'manual'; platform: 'ios' | 'android' | 'desktop' };

/**
 * Whether the app is already running as an installed app.
 *
 * TWO CHECKS, BECAUSE iOS ANSWERS A DIFFERENT QUESTION. Every browser that
 * supports installation reports the standalone display mode through
 * `matchMedia`. iOS Safari reports it through `navigator.standalone`, which is
 * non-standard and therefore absent from `lib.dom`, so it is read through the
 * accessor below rather than through a cast.
 */
function isInstalled(): boolean {
  if (globalThis.matchMedia('(display-mode: standalone)').matches) return true;
  return readIosStandalone(globalThis.navigator);
}

/**
 * iOS Safari's own "am I installed" flag, read without asserting anything.
 *
 * The `in` check both proves the property is there and narrows the parameter
 * enough for the comparison to typecheck, so the value is compared rather than
 * coerced: anything other than the literal `true` reads as not installed.
 */
function readIosStandalone(candidate: Navigator): boolean {
  if (!('standalone' in candidate)) return false;
  return candidate.standalone === true;
}

/**
 * Whether this is an iOS device, which is the one platform with no install API
 * at all.
 *
 * WebKit is the only engine iOS permits, and it never fires
 * `beforeinstallprompt`. iPadOS 13 and later report themselves as a Macintosh,
 * so the touch-point count is what separates an iPad from a desktop Mac, which
 * has none.
 */
function isIosDevice(nav: Navigator): boolean {
  const agent = nav.userAgent;
  if (/iPhone|iPad|iPod/.test(agent)) return true;
  return agent.includes('Macintosh') && nav.maxTouchPoints > 1;
}

/**
 * The written-steps platform for a browser with no `beforeinstallprompt` in
 * hand, iOS included. `manual` never means "cannot be installed", only "this
 * hook has no button to offer"; the steps are what make that still a real
 * offer instead of an empty card.
 */
function manualPlatform(nav: Navigator): 'ios' | 'android' | 'desktop' {
  if (isIosDevice(nav)) return 'ios';
  if (/Android/.test(nav.userAgent)) return 'android';
  return 'desktop';
}

/**
 * What this device can be offered right now.
 *
 * `pending` is the server render and the instant before the effect below has
 * run; nothing renders for it. `installed` covers an app already running
 * standalone and the moment an install finishes. `ready` carries a live prompt
 * event, captured either by this hook's own listener or, more often, by the
 * head script in `root.tsx` before hydration ever started. `manual` is every
 * other case, iOS included, and always carries the written steps for its
 * platform: there is no state past `pending` that renders nothing.
 *
 * @returns The current offer. Never `ready` or `manual` before mount.
 */
export function useInstallPrompt(): InstallOffer {
  const [state, setState] = useState<InstallState>({ kind: 'pending' });

  useEffect(() => {
    // Already installed: there is nothing to offer, and no listener is worth
    // holding, because neither event can fire in an installed app.
    if (isInstalled()) {
      setState({ kind: 'installed' });
      return;
    }

    const platform = manualPlatform(globalThis.navigator);

    // The head script in `root.tsx` may already hold a captured event: it
    // runs before hydration, so a `beforeinstallprompt` that fired between
    // `load` and this effect is not lost. Absent that, the honest first offer
    // is the written steps for this platform, never an empty card.
    const captured = globalThis.window.__installPromptEvent;
    setState(captured ? { kind: 'ready', event: captured } : { kind: 'manual', platform });

    // The default is the browser's own mini-infobar. Preventing it is what
    // moves the moment into the app, where the reader chose to look. This
    // listener stays mounted even after a `manual` start, because a later
    // firing (a browser that decided only after more engagement) must still
    // upgrade the card from steps to a button.
    const onPrompt = (event: BeforeInstallPromptEvent): void => {
      event.preventDefault();
      globalThis.window.__installPromptEvent = event;
      setState({ kind: 'ready', event });
    };

    // The offer has done its job. Chromium fires this whether the install came
    // from our button or from the browser's own menu, so it is the one signal
    // that covers both.
    const onInstalled = (): void => {
      globalThis.window.__installPromptEvent = null;
      setState({ kind: 'installed' });
    };

    globalThis.addEventListener('beforeinstallprompt', onPrompt);
    globalThis.addEventListener('appinstalled', onInstalled);
    return () => {
      globalThis.removeEventListener('beforeinstallprompt', onPrompt);
      globalThis.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (state.kind === 'pending') return { kind: 'pending' };
  if (state.kind === 'installed') return { kind: 'installed' };
  if (state.kind === 'manual') return { kind: 'manual', platform: state.platform };

  const { event } = state;
  return {
    kind: 'ready',
    install: () => {
      void runInstallPrompt(event, () => {
        globalThis.window.__installPromptEvent = null;
        setState({ kind: 'manual', platform: manualPlatform(globalThis.navigator) });
      });
    },
  };
}

/**
 * Show the browser's install dialog once, then let the event go.
 *
 * A PROMPT EVENT IS SINGLE USE. Calling `prompt()` a second time on the same
 * event rejects, so the offer is withdrawn BEFORE the dialog opens rather than
 * after the reader answers: the dialog is modal in practice, but a withdrawn
 * button cannot be clicked twice by any route, including a keyboard repeat.
 *
 * SPENDING THE EVENT MOVES THE STATE TO `manual`, NOT AWAY ENTIRELY. Chromium
 * fires `beforeinstallprompt` again on a later visit and the listener is
 * still mounted, so a `ready` offer can return on its own; until then the card
 * must still show the written steps rather than nothing, the same as any other
 * browser with no live event in hand.
 *
 * A DISMISSAL IS NOT AN ERROR AND NOTHING IS SAID ABOUT IT. Nagging a reader
 * who just said no is the one thing this must not do.
 *
 * @param event - the prompt event to spend.
 * @param discard - withdraws the offer, called before the dialog opens.
 */
async function runInstallPrompt(event: BeforeInstallPromptEvent, discard: () => void): Promise<void> {
  discard();
  try {
    await event.prompt();
    await event.userChoice;
  } catch (cause) {
    reportError(cause, { scope: 'install-app' });
  }
}
