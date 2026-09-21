import React, { useEffect, useRef } from 'react'
import { useI18n } from '../lib/i18nApp.js'

export default function ConfirmDialog({ title, children, confirmLabel, busy, onConfirm, onCancel }) {
  const { t } = useI18n()
  const ref = useRef(null)
  // Focus goes back to the button that opened the dialog (the dialog is gone from the page before the browser could do it).
  const opener = useRef(typeof document !== 'undefined' ? document.activeElement : null)
  useEffect(() => {
    const el = ref.current
    el.showModal()
    return () => {
      el.close()
      const back = opener.current
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus()
    }
  }, [])
  return <dialog ref={ref} className="confirm-dialog" aria-labelledby="confirm-title" onCancel={(e) => { e.preventDefault(); if (!busy) onCancel() }}>
    <h2 id="confirm-title">{title}</h2><div className="dialog-description">{children}</div>
    <div className="dialog-actions"><button autoFocus disabled={busy} onClick={onCancel}>{t('common.cancel')}</button>
      <button className="primary" disabled={busy} onClick={onConfirm}>{busy ? t('common.pleaseWait') : confirmLabel}</button></div>
  </dialog>
}
