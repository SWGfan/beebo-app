import React from 'react'
const paths = {
 getstarted: 'M4 10l8-7 8 7v10h-6v-6h-4v6H4Z', movies: 'M3 5h18v15H3ZM3 10h18M7 5l3 5m4-5 3 5',
 tvshows: 'M3 4h18v13H3ZM8 21h8m-4-4v4', trailers: 'M4 4h16v16H4ZM10 8.5l6 3.5-6 3.5Z', photos: 'M3 4h18v16H3ZM3 16l6-6 5 5 3-3 4 4M16 8h.01',
 podcasts: 'M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3ZM6 11a6 6 0 0 0 12 0M12 17v4m-3 0h6',
 radio: 'M3 9h18v12H3ZM7 9l10-6M8 15h4m3 0h.01M15 18h.01',
 playlists: 'M9 6h12M9 12h12M9 18h12M3 5l3 1-3 1ZM3 11l3 1-3 1ZM3 17l3 1-3 1Z',
 upload: 'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6', migrate: 'M3 12h13m-5-5 5 5-5 5M21 4v16', dashboard: 'M3 12h7V3H3ZM14 3h7v5h-7ZM3 16h7v5H3ZM14 12h7v9h-7Z',
 admin: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7ZM8 12l3 3 5-6', users: 'M8 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM1 21v-3a7 7 0 0 1 14 0v3m1-17a4 4 0 0 1 0 8m2 3c3 1 4 3 4 6',
 history: 'M3 10a9 9 0 1 1 1 8M3 4v6h6m3-4v6l4 3', flags: 'M5 22V3h14l-3 4 3 4H5',
 converted: 'M4 8h16l-4-4m4 12H4l4 4', requests: 'M3 5h18v15H3ZM3 14h5l2 3h4l2-3h5',
 surprise: 'M16 3h5v5m0-5L3 21M3 3l7 7m4 4 7 7m-5 0h5v-5', school: 'M2 8l10-5 10 5-10 5ZM6 10v8l6 3 6-3v-8m4-2v8',
 gamehost: 'M4 10h16v10H4Zm3 0V6h10v4m-8 4h6m-3-3v6M3 20h18',
 settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM10 2h4l1 3 3 1 3 2-1 4 1 4-3 2-3 1-1 3h-4l-1-3-3-1-3-2 1-4-1-4 3-2 3-1Z',
 logout: 'M9 4H3v16h6m5-12 4 4-4 4m-6-4h13'
}
export default function NavIcon({ name }) { return <svg viewBox="0 0 24 24" className="nav-icon" aria-hidden="true"><path d={paths[name] || paths.getstarted} /></svg> }
