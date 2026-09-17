/**
 * item-actions-menu.tsx, the one overflow menu behind every per-item action.
 *
 * WHAT IT REPLACED, AND WHY. Each screen that owns a list drew its per-item
 * actions as a row of buttons beside or under the item. The worst of them was
 * `/explanations/:id`, which put four of them across the page, full width and
 * stacked below `sm`: on a 390px phone that is four stacked 44px controls
 * between the question and the answer to it, and the answer starts below the
 * fold. A menu costs one tap and gives the whole width back to the writing,
 * which is DESIGN.md principle 2: the word is the subject.
 *
 * WHAT IT IS. A trigger that names the item it acts on, and a list of rows the
 * caller describes as data. Four kinds of row cover everything in the tree: a
 * plain destination, a click, a copy, and a destructive action behind a
 * confirmation. A caller never reaches around this component to build one of
 * those by hand, because the moment one screen does, the four screens drift.
 *
 * ACCESSIBILITY IS THE THING THIS PATTERN CAN LOSE. A visible button carries a
 * visible name; an icon carries none. So the trigger takes a REQUIRED
 * `aria-label` from the caller that names the item, "Actions for this
 * question" rather than "More", and every row inside keeps its own full
 * sentence. Below `sm` the trigger is 44px square, per DESIGN.md's touch
 * target rule.
 *
 * WHY THE ROOT IS `modal={false}`. A Radix dropdown in modal mode puts
 * `pointer-events: none` on the body while it is open and takes it off when it
 * closes. A confirmation dialog opened FROM a row closes the menu underneath
 * it, and the two cleanups race: the page can be left unclickable behind the
 * dialog. Non-modal has no body lock to leave behind, and the menu still
 * closes on outside press and on Escape.
 */
import { MoreHorizontal, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmAction } from '#app/components/confirm-action';
import { Link } from '#app/components/link';
import { Button } from '#app/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#app/components/ui/dropdown-menu';
import { copyText } from '#app/lib/copy-text';
import { cn } from '#app/lib/utils';

/** What every row carries, whatever it does when it is chosen. */
interface ItemActionBase {
  /** This row's identity within one menu. React's key, and what a test names. */
  key: string;
  /** The sentence the row shows and a screen reader reads. Never an icon alone. */
  label: string;
  /** An optional glyph beside the label. It is decoration: the label is the name. */
  icon?: LucideIcon;
}

/** A place to go. */
export interface ItemActionLink extends ItemActionBase {
  kind: 'link';
  to: string;
}

/** Something to run on this device. */
export interface ItemActionButton extends ItemActionBase {
  kind: 'button';
  onSelect: () => void;
  /** Whether this row destroys something. Destructive rows are drawn in the state colour and sorted last. */
  destructive?: boolean;
  disabled?: boolean;
}

/**
 * A string to put on the clipboard.
 *
 * IT DOES NOT CARRY THE "COPIED" TICK `copy-text-button.tsx` HAS, on purpose.
 * That button stays on screen after the copy, so the tick is the only thing
 * that can report it; a menu row goes away with the menu the instant it is
 * chosen, so the toast is what the reader sees, and a tick on a closing row
 * would be a state nobody can read. The failure path is the same either way:
 * `copyText` answers false when both clipboard paths refused, and a control
 * that swallowed that would leave the reader believing they hold text they do
 * not.
 */
export interface ItemActionCopy extends ItemActionBase {
  kind: 'copy';
  /** What lands on the clipboard. An empty string disables the row. */
  text: string;
  successMessage: string;
  errorMessage: string;
}

/** Something that has to be confirmed first, posted as a form to the current route. */
export interface ItemActionConfirm extends ItemActionBase {
  kind: 'confirm';
  destructive?: boolean;
  title: string;
  description: string;
  confirmText: string;
  confirmPendingText?: string;
  cancelText: string;
  formData?: Record<string, string | number>;
  onSuccess?: () => void;
  onError?: (error: string) => void;
}

export type ItemAction = ItemActionLink | ItemActionButton | ItemActionCopy | ItemActionConfirm;

/** Whether a row destroys something. Only two of the four kinds can. */
export function isDestructiveItemAction(action: ItemAction): boolean {
  if (action.kind === 'button') return action.destructive === true;
  if (action.kind === 'confirm') return action.destructive === true;
  return false;
}

/**
 * Which rows this menu shows, and in what order.
 *
 * IT IS A PLAIN FUNCTION AND NOT A PILE OF `&&`s IN THE JSX, because this repo
 * has no DOM test environment: inside the markup, the rule that a destructive
 * row comes last would be untestable here. Callers hand in `null` for a row
 * this item does not get, which is how "copy the answer" disappears from a
 * question that has no answer yet, and this is the one place that decides what
 * survives.
 *
 * THE ORDER IS OTHERWISE THE CALLER'S. Only the destructive rows move, and they
 * move to the end, so the row a mis-tap lands on is never the one that deletes
 * something.
 */
export function resolveItemActions(rows: readonly (ItemAction | null)[]): ItemAction[] {
  const present = rows.filter((row): row is ItemAction => row !== null);
  return [
    ...present.filter((row) => !isDestructiveItemAction(row)),
    ...present.filter((row) => isDestructiveItemAction(row)),
  ];
}

/** Shared classes for one row, so the four kinds cannot drift apart. */
const MENU_ROW = 'cursor-pointer py-2';

/** The state colour a destructive row is drawn in, kept on focus so the hover does not wash it out. */
const DESTRUCTIVE_ROW = 'text-destructive focus:text-destructive';

/** The glyph beside a label, or nothing when the caller named none. */
function RowIcon({ icon: Icon }: { icon: LucideIcon | undefined }) {
  if (Icon === undefined) return null;
  return <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

function LinkRow({ action }: { action: ItemActionLink }) {
  return (
    <DropdownMenuItem asChild className={MENU_ROW}>
      <Link to={action.to}>
        <RowIcon icon={action.icon} />
        <span>{action.label}</span>
      </Link>
    </DropdownMenuItem>
  );
}

function ButtonRow({ action }: { action: ItemActionButton }) {
  return (
    <DropdownMenuItem
      className={cn(MENU_ROW, action.destructive === true && DESTRUCTIVE_ROW)}
      disabled={action.disabled === true}
      onSelect={() => action.onSelect()}
    >
      <RowIcon icon={action.icon} />
      <span>{action.label}</span>
    </DropdownMenuItem>
  );
}

function CopyRow({ action }: { action: ItemActionCopy }) {
  const canCopy = action.text !== '';

  // An inner async function rather than a then-chain: the lint gate's
  // `promise(always-return)` rule refuses a `.then` whose body returns nothing,
  // and a copy has nothing to return.
  const handleSelect = (): void => {
    if (!canCopy) return;
    const copy = async (): Promise<void> => {
      const copied = await copyText(action.text);
      if (!copied) {
        toast.error(action.errorMessage);
        return;
      }
      toast.success(action.successMessage);
    };
    void copy().catch(() => {
      toast.error(action.errorMessage);
    });
  };

  return (
    <DropdownMenuItem className={MENU_ROW} disabled={!canCopy} onSelect={handleSelect}>
      <RowIcon icon={action.icon} />
      <span>{action.label}</span>
    </DropdownMenuItem>
  );
}

/**
 * A destructive row and the dialog it opens.
 *
 * `onSelect` IS PREVENTED, AND THAT IS THE WHOLE TRICK. Radix unmounts a closed
 * dropdown's content, and a dialog trigger nested in a row that closes the menu
 * is torn down in the same frame it opened: the confirmation flickers and
 * vanishes. Preventing the default select keeps the menu open, so the dialog
 * lives until the reader answers it. The same line is in `avatar-menu.tsx`'s
 * theme row for the same mechanical reason.
 */
function ConfirmRow({ action }: { action: ItemActionConfirm }) {
  return (
    <ConfirmAction
      trigger={
        <DropdownMenuItem
          className={cn(MENU_ROW, action.destructive === true && DESTRUCTIVE_ROW)}
          onSelect={(event) => event.preventDefault()}
        >
          <RowIcon icon={action.icon} />
          <span>{action.label}</span>
        </DropdownMenuItem>
      }
      title={action.title}
      description={action.description}
      confirmText={action.confirmText}
      confirmPendingText={action.confirmPendingText}
      cancelText={action.cancelText}
      confirmVariant={action.destructive === true ? 'destructive' : 'default'}
      formData={action.formData}
      onSuccess={action.onSuccess}
      onError={action.onError}
    />
  );
}

function ActionRow({ action }: { action: ItemAction }) {
  if (action.kind === 'link') return <LinkRow action={action} />;
  if (action.kind === 'button') return <ButtonRow action={action} />;
  if (action.kind === 'copy') return <CopyRow action={action} />;
  return <ConfirmRow action={action} />;
}

export interface ItemActionsMenuProps {
  /**
   * What a screen reader hears on the trigger. It NAMES THE ITEM, for example
   * "Actions for this question", because the glyph names nothing and a page of
   * rows each labelled "More" is a page a screen reader cannot navigate.
   */
  label: string;
  /** The rows, in the caller's own order. A `null` is a row this item does not get. */
  actions: readonly (ItemAction | null)[];
  /** Extra classes for the trigger, for a caller that has to place it. */
  className?: string;
}

/** Every per-item action on a screen, behind one control. */
export function ItemActionsMenu({ label, actions, className }: ItemActionsMenuProps) {
  const rows = resolveItemActions(actions);
  if (rows.length === 0) return null;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        {/* 44px square below `sm` for a thumb, compact from `sm` up. The house
            pattern for a secondary control, see `copy-text-button.tsx`. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn('min-h-11 min-w-11 sm:min-h-8 sm:min-w-8', className)}
          aria-label={label}
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {rows.map((action) => (
          <ActionRow key={action.key} action={action} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
