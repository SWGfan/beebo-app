// On-screen keyboard layouts. DOM-free.
//
// A key is { label, value } (types `value`), or { label, action } where action is one of
// 'backspace' | 'clear' | 'space' | 'shift' | 'symbols' | 'done'. `wide` sizes: 1 (normal), 2, 3.

var LETTERS_1 = 'qwertyuiop'.split('')
var LETTERS_2 = 'asdfghjkl'.split('')
var LETTERS_3 = 'zxcvbnm'.split('')

function chars(str, upper) {
  var out = []
  for (var i = 0; i < str.length; i++) out.push({ label: upper ? str.charAt(i).toUpperCase() : str.charAt(i), value: upper ? str.charAt(i).toUpperCase() : str.charAt(i) })
  return out
}
function key(label, action, wide) { return { label: label, action: action, wide: wide || 1 } }

/**
 * @param {'search'|'address'|'text'|'password'} mode
 * @param {{shift?:boolean, symbols?:boolean}} state
 * @returns {Array<Array<{label:string,value?:string,action?:string,wide?:number}>>} rows
 */
export function layoutFor(mode, state) {
  var st = state || {}
  var upper = !!st.shift
  var rows
  if (mode === 'address') {
    rows = [
      chars('1234567890'),
      chars('qwertyuiop'),
      chars('asdfghjkl-'),
      chars('zxcvbnm.:/').slice(0, 7).concat([{ label: '.', value: '.' }, { label: ':', value: ':' }]),
      [key('Delete', 'backspace', 2), key('Clear', 'clear', 2)]
    ]
    return rows
  }
  if (mode === 'search') {
    return [
      chars('abcdefghi'),
      chars('jklmnopqr'),
      chars('stuvwxyz0'),
      chars('123456789'),
      [key('Space', 'space', 2), key('Delete', 'backspace', 2), key('Clear', 'clear', 2)]
    ]
  }
  // 'text' (username) and 'password': full QWERTY with shift and a symbols page.
  if (st.symbols) {
    return [
      chars('1234567890'),
      chars('!@#$%^&*()'),
      chars('-_=+[]{};:'),
      chars('.,?/\\|<>~`\'"').slice(0, 10),
      [key('abc', 'symbols', 2), key('Space', 'space', 2), key('Delete', 'backspace', 2), key('Clear', 'clear', 2)]
    ]
  }
  rows = [
    chars('1234567890'),
    chars(LETTERS_1.join(''), upper),
    chars(LETTERS_2.join(''), upper).concat(chars('@')),
    [key(upper ? 'SHIFT' : 'Shift', 'shift', 2)].concat(chars(LETTERS_3.join(''), upper), chars('.')),
    [key('#+=', 'symbols', 2), key('Space', 'space', 2), key('Delete', 'backspace', 2), key('Clear', 'clear', 2)]
  ]
  return rows
}

/** Apply a key press to a string. Returns { value, shift, symbols }. */
export function applyKey(current, k, state, maxLen) {
  var st = { shift: !!(state && state.shift), symbols: !!(state && state.symbols) }
  var v = String(current || '')
  var cap = maxLen || 128
  if (k.value !== undefined) {
    if (v.length < cap) v += k.value
    st.shift = false // one-shot shift
    return { value: v, shift: st.shift, symbols: st.symbols }
  }
  switch (k.action) {
    case 'backspace': v = v.slice(0, -1); break
    case 'clear': v = ''; break
    case 'space': if (v.length < cap && v.length > 0 && v.charAt(v.length - 1) !== ' ') v += ' '; break
    case 'shift': st.shift = !st.shift; break
    case 'symbols': st.symbols = !st.symbols; break
    default: break
  }
  return { value: v, shift: st.shift, symbols: st.symbols }
}
