import React from 'react'

// Translated sentences sometimes need a bold word or a code snippet in the middle. A message can
// contain <b>..</b>, <em>..</em> and <code>..</code> and nothing else; everything else is plain
// text, so a translation can never inject markup. Returns React nodes, not an HTML string.
const TAGS = /<(b|em|code)>([\s\S]*?)<\/\1>/g

export function rich(text, styles = {}) {
  const source = String(text)
  const out = []
  let last = 0
  let key = 0
  for (const match of source.matchAll(TAGS)) {
    if (match.index > last) out.push(source.slice(last, match.index))
    const Tag = match[1]
    out.push(<Tag key={key++} style={styles[Tag]}>{match[2]}</Tag>)
    last = match.index + match[0].length
  }
  if (last < source.length) out.push(source.slice(last))
  return out.length === 1 && typeof out[0] === 'string' ? out[0] : out
}

export default function Rich({ children, styles }) {
  return <>{rich(children, styles)}</>
}
