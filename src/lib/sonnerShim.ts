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
 */
export * from 'sonner-real';

import { toast as realToast } from 'sonner-real';

const SHARED_ID = 'app-toast';

const withSharedId = (opts) => ({ id: SHARED_ID, ...(opts ?? {}) });

const toast = ((message, opts) => realToast(message, withSharedId(opts)));

toast.success = (message, opts) => realToast.success(message, withSharedId(opts));
toast.error = (message, opts) => realToast.error(message, withSharedId(opts));
toast.warning = (message, opts) => realToast.warning(message, withSharedId(opts));
toast.info = (message, opts) => realToast.info(message, withSharedId(opts));
toast.message = (message, opts) => realToast.message(message, withSharedId(opts));

// Pass-throughs — keep Sonner's own behaviour and id management.
toast.loading = realToast.loading;
toast.promise = realToast.promise;
toast.dismiss = realToast.dismiss;
toast.custom = realToast.custom;

export { toast };
