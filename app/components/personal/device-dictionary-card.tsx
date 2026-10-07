import { useEffect, useReducer, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '#app/components/ui/alert-dialog';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';
import {
  deviceDictionaryPairKey,
  writeDeviceDictionaryCookie,
} from '#app/lib/dictionary/device-dictionary-cookie';
import { LANGUAGE_NAMES } from '#app/lib/dictionary/language-pair';
import {
  IDLE_CARD_STATE,
  isImportBusy,
  reduceDeviceDictionaryCard,
  type DeviceDictionaryCardAction,
  type DeviceDictionaryCardState,
  type ImportFailureReason,
} from '#app/lib/local-dictionary/card-state';
import {
  WIKDICT_LICENCE,
  WIKDICT_SOURCE_NAME,
  createIndexedDbStorage,
  importDictionary,
  listImportedDictionaries,
  removeDictionary,
  type DictionaryMeta,
  type DictionaryStorage,
} from '#app/lib/local-dictionary/device-dictionary-store';
import { buildWikdictIndex, parseWikdictFileName } from '#app/lib/local-dictionary/wikdict';
import { WIKDICT_HOME_URL, listWikdictDownloads } from '#app/lib/local-dictionary/wikdict-downloads';
import { reportError } from '#app/lib/report-error';

/** The translation key of the line each way an import can fail. */
const FAILURE_KEYS = {
  'file-name': 'settings.deviceDictionary.failedFileName',
  unreadable: 'settings.deviceDictionary.failedUnreadable',
  empty: 'settings.deviceDictionary.failedEmpty',
  storage: 'settings.deviceDictionary.failedStorage',
} as const satisfies Record<ImportFailureReason, string>;

/** The twelve files the reader may download, built once: they never change. */
const DOWNLOADS = listWikdictDownloads();

/** Long enough for the browser to draw the phase that is about to block the thread. */
const PAINT_DELAY_MS = 16;

/** The ids the input points at, so a screen reader reads the hint and the status with it. */
const FILE_INPUT_ID = 'device-dictionary-file';
const FILE_HINT_ID = 'device-dictionary-file-hint';
const STATUS_ID = 'device-dictionary-status';
const LIST_HEADING_ID = 'device-dictionary-list-heading';

/** What the list of dictionaries on this device is showing. */
type Listing = { status: 'loading' } | { status: 'ready'; dictionaries: DictionaryMeta[] } | { status: 'unavailable' };

/** How the import handler reports its steps to the card's reducer. */
type CardDispatch = (action: DeviceDictionaryCardAction) => void;

/** The browser's storage, opened on first use and never during a render. */
let deviceStorage: DictionaryStorage | undefined;

/**
 * The device dictionary's IndexedDB storage.
 *
 * Called from effects and event handlers only. `indexedDB` does not exist while
 * the server renders this route, and `createIndexedDbStorage` reads it when it
 * is CALLED.
 */
function getDeviceStorage(): DictionaryStorage {
  deviceStorage ??= createIndexedDbStorage();
  return deviceStorage;
}

/**
 * Wait one turn of the event loop, or a little longer.
 *
 * @param delayMs How long to wait. Zero lets queued events and a render run.
 */
function waitForTick(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * A storage that hands the event loop back after every batch of an import.
 *
 * The importer writes five thousand words per transaction. Yielding after each
 * one lets the progress bar draw and a tap on the page land, instead of one long
 * task that looks like a frozen tab.
 *
 * @param storage The storage to wrap.
 */
function withEventLoopYield(storage: DictionaryStorage): DictionaryStorage {
  return {
    ...storage,
    async putBatch(batch) {
      await storage.putBatch(batch);
      await waitForTick(0);
    },
  };
}

/**
 * Read what this device holds, and make the cookie say the same.
 *
 * THE COOKIE IS REWRITTEN EVERY TIME, not only after a change. It outlives the
 * IndexedDB database it describes: a reader who cleared site data, or whose
 * browser did, still sends `device-dict=de-en`, and the server would hold back a
 * model call for a dictionary that is gone. Opening settings is the cheapest
 * moment to correct it. When the storage cannot be read at all the cookie is
 * emptied, because a dictionary nobody can read is not one to promise.
 *
 * @returns The listing. It never rejects: a failure is reported and returned as `unavailable`.
 */
async function readListing(): Promise<Listing> {
  try {
    const dictionaries = await listImportedDictionaries(getDeviceStorage());
    writeDeviceDictionaryCookie(dictionaries.map((meta) => meta.pair));
    return { status: 'ready', dictionaries };
  } catch (cause) {
    reportError(cause, { stage: 'list-device-dictionaries' });
    writeDeviceDictionaryCookie([]);
    return { status: 'unavailable' };
  }
}

/**
 * Run one step of an import, and report its failure to the card.
 *
 * @param reason What a failure of this step is called on screen.
 * @param dispatch The card's reducer.
 * @param work The step.
 * @returns The step's result, or `null` after the failure has been reported.
 */
async function attemptStep<T>(reason: ImportFailureReason, dispatch: CardDispatch, work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (cause) {
    reportError(cause, { stage: `import-${reason}` });
    dispatch({ type: 'import-failed', reason });
    return null;
  }
}

/**
 * Drop whatever a failed import left behind.
 *
 * The importer writes the meta last, so a half-written dictionary is already
 * invisible to the list and to a lookup. This removes its words as well, so a
 * failure keeps nothing. If even that fails there is nothing more to do: the
 * failure that brought us here has been reported.
 *
 * @param pair The directed pair key.
 */
async function clearLeftovers(pair: string): Promise<void> {
  try {
    await removeDictionary(getDeviceStorage(), pair);
  } catch {
    // Reported already. The words, if any remain, are unlisted and unreachable.
  }
}

/**
 * Turn a chosen WikDict file into a dictionary on this device.
 *
 * Every byte stays in the browser: the file is read with `arrayBuffer()`,
 * indexed in this tab and written to IndexedDB. The reducer is told each step so
 * the screen shows the order they happen in.
 *
 * @param file The file the reader chose.
 * @param dispatch The card's reducer.
 * @returns The meta of the saved dictionary, or `null` when the file was refused or the import failed.
 */
async function importWikdictFile(file: File, dispatch: CardDispatch): Promise<DictionaryMeta | null> {
  dispatch({ type: 'file-chosen', fileName: file.name });
  const direction = parseWikdictFileName(file.name);
  if (direction === null) return null;
  const pair = deviceDictionaryPairKey(direction.from, direction.to);

  const bytes = await attemptStep('unreadable', dispatch, async () => new Uint8Array(await file.arrayBuffer()));
  if (bytes === null) return null;
  dispatch({ type: 'read-finished' });
  await waitForTick(PAINT_DELAY_MS);

  const entries = await attemptStep('unreadable', dispatch, async () => buildWikdictIndex(bytes, { from: direction.from }));
  if (entries === null) return null;
  if (entries.length === 0) {
    dispatch({ type: 'import-failed', reason: 'empty' });
    return null;
  }
  dispatch({ type: 'index-built', total: entries.length });

  const meta = await attemptStep('storage', dispatch, () =>
    importDictionary(withEventLoopYield(getDeviceStorage()), {
      pair,
      entries,
      source: { name: WIKDICT_SOURCE_NAME, licence: WIKDICT_LICENCE },
      onProgress: (progress) => dispatch({ type: 'save-progress', written: progress.written, total: progress.total }),
    }),
  );
  if (meta === null) {
    await clearLeftovers(pair);
    return null;
  }
  dispatch({ type: 'save-finished', entryCount: meta.entryCount });
  return meta;
}

/**
 * The "Device dictionary" card on `/settings` (M208).
 *
 * THE CARD IS THE ONLY WRITER of the device dictionary store and of the
 * `device-dict` cookie. A reader chooses a WikDict file they downloaded
 * themself, the app indexes it in this tab and keeps it in IndexedDB, and the
 * list below the sentence is what this device holds. Nothing here is sent to
 * the server: there is no fetch, no form and no loader read, and the download
 * links are plain anchors.
 *
 * CLIENT-ONLY WORK STAYS IN EFFECTS AND HANDLERS. This route is server
 * rendered, so a render pass never touches `indexedDB` or `document`. The first
 * paint says the device is being checked, and the mount effect replaces that.
 */
export function DeviceDictionaryCard() {
  const { t, i18n } = useTranslation();
  const [state, dispatch] = useReducer(reduceDeviceDictionaryCard, IDLE_CARD_STATE);
  const [listing, setListing] = useState<Listing>({ status: 'loading' });
  const [removingPair, setRemovingPair] = useState<string | null>(null);
  const isBusy = isImportBusy(state);

  useEffect(() => {
    let ignore = false;
    const load = async (): Promise<void> => {
      const next = await readListing();
      if (!ignore) setListing(next);
    };
    void load();
    return () => {
      ignore = true;
    };
  }, []);

  async function runImport(file: File): Promise<void> {
    const meta = await importWikdictFile(file, dispatch);
    setListing(await readListing());
    if (meta !== null) toast.success(t('settings.deviceDictionary.savedToast'));
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    const [file] = Array.from(input.files ?? []);
    // Cleared so choosing the same file again fires another change event. The
    // File object stays readable after the field forgets it.
    input.value = '';
    if (file === undefined) return;
    void runImport(file);
  }

  async function handleRemove(pair: string): Promise<void> {
    setRemovingPair(pair);
    try {
      await removeDictionary(getDeviceStorage(), pair);
      dispatch({ type: 'dismissed' });
      toast.success(t('settings.deviceDictionary.removedToast'));
    } catch (cause) {
      reportError(cause, { stage: 'remove-device-dictionary' });
      toast.error(t('settings.deviceDictionary.removeFailed'));
    } finally {
      setListing(await readListing());
      setRemovingPair(null);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-6">
      <h2 className="font-display text-base font-semibold">{t('settings.deviceDictionary.title')}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{t('settings.deviceDictionary.body')}</p>

      <section aria-labelledby={LIST_HEADING_ID} className="mt-4">
        <h3 id={LIST_HEADING_ID} className="text-sm font-semibold">
          {t('settings.deviceDictionary.listHeading')}
        </h3>
        {listing.status === 'loading' && (
          <p className="mt-2 text-sm text-muted-foreground">{t('settings.deviceDictionary.listLoading')}</p>
        )}
        {listing.status === 'unavailable' && (
          <p className="mt-2 text-sm text-muted-foreground">{t('settings.deviceDictionary.listUnavailable')}</p>
        )}
        {listing.status === 'ready' && listing.dictionaries.length === 0 && (
          <p className="mt-2 text-sm text-muted-foreground">{t('settings.deviceDictionary.listEmpty')}</p>
        )}
        {listing.status === 'ready' && listing.dictionaries.length > 0 && (
          <ul className="mt-2 divide-y rounded-lg border">
            {listing.dictionaries.map((meta) => (
              <li key={meta.pair} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {t('settings.deviceDictionary.pairLabel', {
                      from: LANGUAGE_NAMES[meta.from],
                      to: LANGUAGE_NAMES[meta.to],
                    })}{' '}
                    <span className="font-mono text-xs font-normal text-muted-foreground">{meta.pair}</span>
                  </p>
                  <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
                    <span>
                      {t('settings.deviceDictionary.entryWords', {
                        words: new Intl.NumberFormat(i18n.language).format(meta.entryCount),
                      })}
                    </span>
                    <span>
                      {t('settings.deviceDictionary.importedOn', {
                        date: new Date(meta.importedAt).toLocaleDateString(i18n.language, {
                          year: 'numeric',
                          month: 'long',
                          day: 'numeric',
                        }),
                      })}
                    </span>
                  </p>
                </div>
                <RemoveDictionaryButton
                  meta={meta}
                  isDisabled={isBusy || removingPair !== null}
                  isRemoving={removingPair === meta.pair}
                  onConfirm={() => void handleRemove(meta.pair)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-6 flex flex-col gap-2">
        <Label htmlFor={FILE_INPUT_ID}>{t('settings.deviceDictionary.fileLabel')}</Label>
        <Input
          id={FILE_INPUT_ID}
          type="file"
          accept=".sqlite3,.sqlite"
          disabled={isBusy}
          onChange={handleFileChange}
          aria-describedby={`${FILE_HINT_ID} ${STATUS_ID}`}
        />
        <p id={FILE_HINT_ID} className="text-xs text-muted-foreground">
          {t('settings.deviceDictionary.fileHint')}
        </p>
        <ImportStatus state={state} />
      </div>

      <section className="mt-6">
        <h3 className="text-sm font-semibold">{t('settings.deviceDictionary.downloadsHeading')}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{t('settings.deviceDictionary.downloadsBody')}</p>
        <ul className="mt-3 grid list-none grid-cols-1 gap-x-6 gap-y-1 pl-0 text-sm sm:grid-cols-2">
          {DOWNLOADS.map((download) => (
            <li key={download.pair}>
              <a href={download.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                {t('settings.deviceDictionary.pairLabel', {
                  from: LANGUAGE_NAMES[download.from],
                  to: LANGUAGE_NAMES[download.to],
                })}
                <span className="sr-only"> ({t('settings.deviceDictionary.downloadNewTab')})</span>
              </a>
              {download.megabytes !== null && (
                <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                  {t('settings.deviceDictionary.downloadSize', { megabytes: download.megabytes })}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-6 text-xs text-muted-foreground">
        {t('settings.deviceDictionary.attributionLead')}{' '}
        <a href={WIKDICT_HOME_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
          {WIKDICT_SOURCE_NAME}
        </a>
        , {t('settings.deviceDictionary.attributionTail', { licence: WIKDICT_LICENCE })}
      </p>
    </div>
  );
}

/**
 * What the import is doing, or why it stopped.
 *
 * The live region is always in the document and only its content changes, which
 * is what lets a screen reader announce a phase that appears after the page
 * loaded. A failure is its own `alert`.
 */
function ImportStatus({ state }: { state: DeviceDictionaryCardState }) {
  const { t, i18n } = useTranslation();

  return (
    <output id={STATUS_ID} aria-live="polite" className="flex flex-col gap-2">
      {state.phase === 'reading' && <BusyLine label={t('settings.deviceDictionary.statusReading')} />}
      {state.phase === 'indexing' && <BusyLine label={t('settings.deviceDictionary.statusIndexing')} />}
      {state.phase === 'saving' && (
        <BusyLine
          label={t('settings.deviceDictionary.statusSaving', {
            written: new Intl.NumberFormat(i18n.language).format(state.written),
            total: new Intl.NumberFormat(i18n.language).format(state.total),
          })}
          value={state.written}
          max={state.total}
        />
      )}
      {state.phase === 'done' && (
        <p className="text-sm text-success">
          {t('settings.deviceDictionary.statusDone', {
            pair: state.pair,
            words: new Intl.NumberFormat(i18n.language).format(state.entryCount),
          })}
        </p>
      )}
      {state.phase === 'failed' && (
        <p role="alert" className="text-sm text-destructive">
          {t(FAILURE_KEYS[state.reason])}
        </p>
      )}
    </output>
  );
}

/** A sentence about the step in flight, with a bar that fills only when the step has a length. */
function BusyLine({ label, value, max }: { label: string; value?: number; max?: number }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-muted-foreground tabular-nums">{label}</p>
      <progress className="h-2 w-full accent-primary" value={value} max={max} aria-hidden="true" />
    </div>
  );
}

interface RemoveDictionaryButtonProps {
  meta: DictionaryMeta;
  isDisabled: boolean;
  isRemoving: boolean;
  onConfirm: () => void;
}

/**
 * The Remove control of one listed dictionary, behind a confirmation.
 *
 * Deleting a hundred thousand words a reader waited to import is destructive
 * enough for the house rule (DESIGN.md section 7): an `AlertDialog`, never a
 * `window.confirm`. This is not `ConfirmAction`, because that component posts a
 * form to the server and nothing about this card may.
 */
function RemoveDictionaryButton({ meta, isDisabled, isRemoving, onConfirm }: RemoveDictionaryButtonProps) {
  const { t } = useTranslation();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isDisabled}
          pending={isRemoving}
          aria-label={t('settings.deviceDictionary.removeLabel', { pair: meta.pair })}
        >
          {isRemoving ? t('settings.deviceDictionary.removePending') : t('settings.deviceDictionary.removeTrigger')}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('settings.deviceDictionary.removeTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('settings.deviceDictionary.removeBody', { pair: meta.pair })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('settings.deviceDictionary.removeCancel')}</AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button type="button" variant="destructive" onClick={onConfirm}>
              {t('settings.deviceDictionary.removeConfirm')}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
