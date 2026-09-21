// focusTrap.js - what Tab and Shift+Tab do inside a dialog. Pure, so it is tested without a DOM
// (test/a11y-helpers.test.js); the React hook that applies it is components/useFocusTrap.js.

/**
 * The index to focus next inside a dialog with `count` focusable controls, or -1 to let the
 * browser move focus by itself. `current` is where focus is now (-1: outside the dialog).
 * Tab on the last control wraps to the first; Shift+Tab on the first wraps to the last; focus
 * that has escaped the dialog is pulled back in.
 */
export function trapTarget(count, current, shift) {
  if (!count) return -1
  if (current < 0) return shift ? count - 1 : 0
  if (!shift && current === count - 1) return 0
  if (shift && current === 0) return count - 1
  return -1
}

export const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
].join(',')
