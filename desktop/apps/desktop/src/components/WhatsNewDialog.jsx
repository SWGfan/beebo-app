import React, { useEffect, useRef } from 'react'
import { useI18n } from '../lib/i18nApp.js'

// "What's new in Beebo": a real modal dialog (native <dialog>: focus stays inside, Escape closes,
// focus returns to the button that opened it). The release notes themselves are written in
// English in App.jsx; only the window around them is translated.
export default function WhatsNewDialog({ changelog, onClose }) {
  const { t } = useI18n()
  const ref = useRef(null)
  // Whatever had focus (the "What's new" link) gets it back when the dialog goes away. The dialog is
  // already out of the page by the time an effect cleans up, so the browser cannot do this itself.
  const opener = useRef(typeof document !== 'undefined' ? document.activeElement : null)
  useEffect(() => {
    const el = ref.current
    if (el && !el.open) el.showModal()
    return () => {
      if (el && el.open) el.close()
      const back = opener.current
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className="confirm-dialog whats-new"
      aria-labelledby="whats-new-title"
      style={{ maxWidth: 520, maxHeight: '80vh', overflow: 'auto', padding: '22px 24px' }}
      onCancel={(e) => { e.preventDefault(); onClose() }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <h2 id="whats-new-title" style={{ margin: 0, fontSize: '1.25rem', color: '#e6e9ef' }}>{t('whatsNew.title')}</h2>
        <button type="button" className="bare" aria-label={t('common.close')} onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 0, color: '#c6d2e9', fontSize: 22, cursor: 'pointer', lineHeight: 1, minWidth: 32, minHeight: 32 }}><span aria-hidden="true">×</span></button>
      </div>
      {changelog.map((rel) => (
        <div key={rel.version} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontWeight: 700, color: '#f5a524' }}>v{rel.version}</span>
            <span style={{ fontSize: 12, color: '#acb6cf' }}>{rel.date}</span>
          </div>
          <ul style={{ margin: '6px 0 0', paddingInlineStart: 20, color: '#c9d1d9', lineHeight: 1.6, fontSize: 14 }}>
            {rel.items.map((it, i) => (<li key={i}>{it}</li>))}
          </ul>
        </div>
      ))}
      <p style={{ margin: '4px 0 0', fontSize: 12, color: '#acb6cf' }}>{t('whatsNew.englishNote')}</p>
    </dialog>
  )
}
