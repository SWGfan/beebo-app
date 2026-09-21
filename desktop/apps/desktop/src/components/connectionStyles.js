// Shared inline styles for the Connection wizard and Settings > Connection.
// Same tokens as BeeboAddress.jsx / OwnRelay.jsx so the pages look like one app.
export const C = {
  section: { maxWidth: 640, color: '#e9e9ee', fontSize: 14, lineHeight: 1.5 },
  card: { background: '#1b1b22', border: '1px solid #2c2c35', borderRadius: 12, padding: 16, marginTop: 12 },
  h2: { fontSize: 18, fontWeight: 600, margin: '0 0 4px' },
  h3: { fontSize: 16, fontWeight: 600, margin: '0 0 6px' },
  h4: { fontSize: 14, fontWeight: 600, margin: '14px 0 4px', color: '#d6d6de' },
  p: { color: '#a9a9b3', margin: '0 0 8px' },
  small: { color: '#8a8a95', fontSize: 12 },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 },
  btn: { fontSize: 14, fontWeight: 600, padding: '9px 16px', borderRadius: 8, border: '1px solid #33333e', background: '#26262f', color: '#e9e9ee', cursor: 'pointer' },
  btnPrimary: { fontSize: 14, fontWeight: 600, padding: '9px 16px', borderRadius: 8, border: '1px solid #4b6ef5', background: '#4b6ef5', color: '#fff', cursor: 'pointer' },
  btnLink: { fontSize: 14, padding: 0, border: 0, background: 'transparent', color: '#7aa2ff', cursor: 'pointer', textDecoration: 'underline' },
  disabled: { opacity: 0.5, cursor: 'not-allowed' },
  ol: { margin: '6px 0 0 20px', padding: 0 },
  li: { marginBottom: 4 },
  badge: { display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#20233a', color: '#aab8ff', marginLeft: 8, verticalAlign: 'middle' },
  option: (on) => ({ border: '1px solid ' + (on ? '#4b6ef5' : '#2c2c35'), background: on ? '#20233a' : '#16161c', borderRadius: 10, padding: 14, marginTop: 10 }),
  warnBox: { background: '#2a2412', border: '1px solid #5a4a1a', borderRadius: 8, padding: '10px 12px', marginTop: 10, color: '#f0dca0' },
  mono: { fontFamily: 'monospace', fontSize: 15, color: '#fff', wordBreak: 'break-all' },
  // Green: Beebo Relay is free at this time. Same green as the app's "ok" tone.
  freeBadge: { display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#15301f', color: '#6fd08c', border: '1px solid #2f6b45', marginLeft: 8, verticalAlign: 'middle' },
  freeOption: (on) => ({ border: '1px solid ' + (on ? '#6fd08c' : '#2f6b45'), background: on ? '#15301f' : '#122018', borderRadius: 10, padding: 14, marginTop: 10, boxShadow: on ? '0 0 0 1px #2f6b45 inset' : 'none' }),
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 },
  th: { textAlign: 'left', fontWeight: 600, color: '#d6d6de', padding: '7px 8px 7px 0', borderBottom: '1px solid #2c2c35', verticalAlign: 'top' },
  td: { textAlign: 'right', padding: '7px 0', borderBottom: '1px solid #2c2c35', verticalAlign: 'top', whiteSpace: 'nowrap', fontWeight: 600 },
}

export const TONE = { ok: '#6fd08c', warn: '#f5c451', bad: '#ff8080', muted: '#a9a9b3' }
