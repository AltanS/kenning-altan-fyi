import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '#app/components/ui/button';
import { copyText } from '#app/lib/copy-text';

/** What one copy button needs. Every string comes from the caller, so this file holds no copy. */
export interface CopyTextButtonProps {
  /** What lands on the clipboard. Empty disables the button: a control that cannot act says so. */
  text: string;
  /** What the button is for, read by a screen reader. */
  label: string;
  /** The label while the tick is showing, so the state is not colour and shape alone. */
  copiedLabel: string;
  /** The toast on success. DESIGN.md section 7: every data change says so. */
  successMessage: string;
  /** The toast when the clipboard refuses. */
  errorMessage: string;
  /** `ghost` by default. The detail page's action row wants an outline button beside its siblings. */
  variant?: 'ghost' | 'outline';
  /** What the button says beside its icon. Icon only when omitted. */
  children?: React.ReactNode;
}

/**
 * A button that puts one string on the clipboard.
 *
 * IT IS DISABLED ONLY WHEN THERE IS NOTHING TO COPY. It used to probe
 * `navigator.clipboard` after mount and draw itself dead where the API was
 * missing, which on any plain-http origin that is not localhost, the dev server
 * on a phone being the everyday one, meant every copy control on the screen was
 * permanently disabled with nothing saying why. `copyText` carries the fallback
 * those origins do support, so there is no environment left to probe for and no
 * mount effect here at all.
 *
 * A REFUSED CLIPBOARD STILL SAYS SO. `copyText` answers false when both paths
 * failed, and a button that swallowed that would leave the reader believing they
 * hold text they do not.
 */
export function CopyTextButton({
  text,
  label,
  copiedLabel,
  successMessage,
  errorMessage,
  variant = 'ghost',
  children,
}: CopyTextButtonProps) {
  const [isCopied, setIsCopied] = useState(false);
  const canCopy = text !== '';

  // An inner async function rather than a then-chain: the lint gate's
  // `promise(always-return)` rule refuses a `.then` whose body returns nothing,
  // and a copy button's callback has nothing to return.
  const handleCopy = (): void => {
    if (!canCopy) return;
    const copy = async (): Promise<void> => {
      const copied = await copyText(text);
      if (!copied) {
        toast.error(errorMessage);
        return;
      }
      setIsCopied(true);
      toast.success(successMessage);
    };
    void copy().catch(() => {
      toast.error(errorMessage);
    });
  };

  return (
    <Button
      type="button"
      variant={variant}
      size={children === undefined ? 'icon-sm' : 'sm'}
      /* 44px tall below `sm`, compact from `sm` up. The house pattern for a
         secondary control that has to be reachable with a thumb; see
         `explanation-body.tsx`, which sets its term chips the same way. */
      className="min-h-11 sm:min-h-8"
      onClick={handleCopy}
      disabled={!canCopy}
      aria-label={isCopied ? copiedLabel : label}
    >
      {isCopied ?
        <Check className="size-4" aria-hidden="true" />
      : <Copy className="size-4" aria-hidden="true" />}
      {children}
    </Button>
  );
}
