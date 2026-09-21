// Shared polling helper for the renderer (used by App.jsx and every tab that
// auto-refreshes).
//
// Every one of those used a bare setInterval, which kept firing IPC calls -
// and, for the sidebar counts, a full Movies + TV disk walk in the main
// process - for ever, including while the window sat hidden in the tray.
// startPoll is a drop-in replacement: same interval, but a tick is skipped
// while document.hidden is true, and one immediate refresh runs the moment
// the window becomes visible again so nothing looks stale after a long sleep.
//
//   useEffect(() => {
//     const stop = startPoll(load, 5000)
//     return () => stop()
//   }, [])
export function startPoll(fn, ms) {
  const tick = () => {
    if (document.hidden) return
    fn()
  }
  const id = setInterval(tick, ms)
  const onVisibility = () => {
    if (!document.hidden) fn()
  }
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    clearInterval(id)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
