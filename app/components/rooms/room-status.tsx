import { useTranslation } from 'react-i18next';
import { Check, Circle, Loader2 } from 'lucide-react';

import { ROOM_FAILURE_KEYS, ROOM_REFUSAL_KEYS } from '#app/components/rooms/room-copy-keys';
import type { RoomController } from '#app/components/rooms/use-room';
import { Button } from '#app/components/ui/button';
import { ROOM_STAGES, type RoomStage } from '#app/lib/rooms/view';
import { cn } from '#app/lib/utils';

const STAGE_KEYS = {
  writing: 'rooms.stageWriting',
  checking: 'rooms.stageChecking',
} as const satisfies Record<RoomStage, string>;

type StepState = 'done' | 'active' | 'waiting';

/** Where one step stands, given the stage the build is in. No stage means it is still queued. */
function stepState(step: RoomStage, current: RoomStage | null): StepState {
  if (current === null) return 'waiting';
  const difference = ROOM_STAGES.indexOf(step) - ROOM_STAGES.indexOf(current);
  if (difference < 0) return 'done';
  return difference === 0 ? 'active' : 'waiting';
}

const STEP_ICONS = {
  done: <Check className="size-4 text-brand-ink" aria-hidden="true" />,
  active: <Loader2 className="size-4 animate-spin text-brand-ink" aria-hidden="true" />,
  waiting: <Circle className="size-4 text-muted-foreground" aria-hidden="true" />,
} satisfies Record<StepState, React.ReactNode>;

/** The retry button, with what a press costs beside it when the caller passes `hint`. */
function RetryControls({ controller, hint }: { controller: RoomController; hint?: string }) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={controller.retry}
          pending={controller.isRetrying}
        >
          {controller.isRetrying ? t('rooms.retrying') : t('rooms.retry')}
        </Button>
        {hint !== undefined && <p className="min-w-40 flex-1 text-sm text-muted-foreground">{hint}</p>}
      </div>
      {controller.refusal !== null && (
        <p role="alert" className="text-sm text-destructive">
          {t(ROOM_REFUSAL_KEYS[controller.refusal])}
        </p>
      )}
    </div>
  );
}

/** A build under way: its two steps, what to expect, and a retry once it has stalled. */
export function RoomProgress({ controller }: { controller: RoomController }) {
  const { t } = useTranslation();
  const { stage, canRetry } = controller.room;

  return (
    <section className="flex flex-col gap-4 rounded-2xl border p-4">
      <ol aria-live="polite" className="flex flex-col gap-3">
        {ROOM_STAGES.map((step) => {
          const state = stepState(step, stage);
          return (
            <li
              key={step}
              aria-current={state === 'active' ? 'step' : undefined}
              className={cn('flex items-center gap-3 text-sm', state === 'waiting' && 'text-muted-foreground')}
            >
              {STEP_ICONS[state]}
              <span>{t(STAGE_KEYS[step])}</span>
            </li>
          );
        })}
      </ol>
      <p className="max-w-prose text-sm text-muted-foreground">
        {canRetry ? t('rooms.stalled') : t('rooms.waitHint')}
      </p>
      {canRetry && <RetryControls controller={controller} />}
    </section>
  );
}

/** A build that ended without a room: one line that says why, and the retry. */
export function RoomUnbuilt({ controller }: { controller: RoomController }) {
  const { t } = useTranslation();
  // No reason means an `ok` row whose document no longer decodes.
  const { failureReason, canRetry } = controller.room;

  return (
    <section className="flex flex-col items-start gap-3 rounded-2xl border p-4">
      <p className="max-w-prose text-sm text-muted-foreground">
        {t(failureReason === null ? 'rooms.failedBody' : ROOM_FAILURE_KEYS[failureReason])}
      </p>
      <RetryControls controller={controller} hint={canRetry ? t('rooms.retryHint') : undefined} />
    </section>
  );
}
