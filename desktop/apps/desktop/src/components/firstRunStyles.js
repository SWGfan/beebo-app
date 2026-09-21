// Shared look for the Get Started cards and the Connection Doctor, matching GetStarted's own.
export const FR = {
  box: { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 14, padding: 20, marginBottom: 0 },
  head: { display: 'flex', alignItems: 'center', marginBottom: 6 },
  h3: { margin: 0 },
  muted: { color: 'var(--muted)', marginTop: 0 },
  small: { color: 'var(--muted)', fontSize: 13 },
  input: { width: '100%', padding: '11px 12px', margin: '6px 0', borderRadius: 10, border: '1px solid var(--border)', background: '#12151b', color: '#eaeef5', fontSize: 15, boxSizing: 'border-box' },
  btn: { padding: '11px 16px', borderRadius: 10, border: 0, background: '#6b4bd6', color: '#fff', fontWeight: 700, cursor: 'pointer' },
  btnGhost: { padding: '11px 16px', borderRadius: 10, border: '1px solid #3a4150', background: 'transparent', color: '#cbd2df', fontWeight: 700, cursor: 'pointer' },
  linkBtn: { background: 'none', border: 0, padding: 0, color: '#6db3ff', cursor: 'pointer', textDecoration: 'underline', font: 'inherit' },
  ok: { color: '#59d38a', fontWeight: 700 },
  warn: { color: '#f5c76b' },
  bad: { color: '#ff9c9c' },
  row: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 },
  card: { padding: 14, border: '1px solid var(--border)', borderRadius: 12, background: 'rgba(0,0,0,.12)', minWidth: 0 },
  code: { display: 'block', overflowWrap: 'anywhere', fontFamily: 'monospace', fontSize: 13, color: '#eaeef5', margin: '8px 0' },
}

export const badge = (done) => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 30, height: 30, borderRadius: '50%', marginRight: 12, fontWeight: 800,
  background: done ? '#1f9d55' : '#2f3644', color: '#fff', flex: 'none',
})
