// @ts-nocheck
/**
 * Sonner shim.
 *
 * vite.config.ts aliases the bare `sonner` import to this file (and `sonner-real`
 * back to the real package). Every `import { toast } from "sonner"` across the app
 * therefore transparently gets the wrapper below — no per-file import changes, and
 * any future page automatically inherits the same behaviour.
 *
 * What the wrapper does: it funnels every fire-and-forget status toast
 * (success / error / warning / info / plain message) through ONE shared id.
 * Because Sonner replaces a toast that reuses an existing id, firing a new status
 * toast instantly swaps out the previous one — so only a single toast is ever on
 * screen and the old message disappears the moment a new one arrives.
 *
 * `loading`, `promise`, `dismiss` and `custom` are passed straight through to the
 * real Sonner untouched, so existing loading -> success/error flows that capture
 * and reuse their own toast id (e.g. the exit-position spinners) keep working
 * exactly as before.
 *
 * A NEW TOAST STARTS CLEAN (16 Nov 2026). "Replaces" above is not what Sonner
 * does with a reused id: it MERGES the new toast into the old one, field by
 * field — in its own store, which never forgets a toast, and again in the list
 * on screen. So whatever a call did not set, it inherited from an earlier toast,
 * for the rest of the session: the trade guard's refusal came up with "now 92.99
 * · -2.97% on the day" under it, the second line of a market alert from a minute
 * before; a plain message after an error was drawn as an error; a toast after an
 * 8-second one stayed 8 seconds. Found on the ScalpPro bar, whose toasts are two
 * words long and showed someone else's sentence under them. Every field a toast
 * can carry is therefore named here as empty, under whatever the call passes,
 * so a merge has nothing left to bring forward.
 */
export * from 'sonner-real';

import { toast as realToast } from 'sonner-real';

const SHARED_ID = 'app-toast';

const CLEAN = {
  description: undefined, icon: undefined, action: undefined, cancel: undefined,
  duration: undefined, closeButton: undefined, richColors: undefined, invert: undefined,
  onDismiss: undefined, onAutoClose: undefined, style: undefined, className: undefined,
  classNames: undefined, descriptionClassName: undefined, actionButtonStyle: undefined,
  cancelButtonStyle: undefined, unstyled: undefined, position: undefined, jsx: undefined,
  // A toast that was dismissed is marked for deletion on screen; one born with
  // the same id must not be born deleted.
  delete: undefined,
};

const withSharedId = (opts) => ({ id: SHARED_ID, ...CLEAN, ...(opts ?? {}) });

// The plain forms set no type of their own, so the type is cleared here too;
// success / error / warning / info each set theirs after these options.
const toast = ((message, opts) => realToast(message, { type: undefined, ...withSharedId(opts) }));

toast.success = (message, opts) => realToast.success(message, withSharedId(opts));
toast.error = (message, opts) => realToast.error(message, withSharedId(opts));
toast.warning = (message, opts) => realToast.warning(message, withSharedId(opts));
toast.info = (message, opts) => realToast.info(message, withSharedId(opts));
toast.message = (message, opts) => realToast.message(message, { type: undefined, ...withSharedId(opts) });

// Pass-throughs — keep Sonner's own behaviour and id management.
toast.loading = realToast.loading;
toast.promise = realToast.promise;
toast.dismiss = realToast.dismiss;
toast.custom = realToast.custom;

export { toast };
