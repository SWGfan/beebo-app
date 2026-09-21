'use strict'
// Preset themes. Each is a named set of values for the variables in themeTokens.js.
//
// midnight is the stylesheet's own defaults (browserTheme.css :root), so it carries no values here and
// produces no CSS: choosing it, or having no setting at all, renders exactly what the site always did.
// Every other preset overrides EVERY variable that is not `derived` (a derived variable follows another
// one until set). A test enforces that, so a preset can never silently fall back to midnight colors.
//
// The rules are `:root[data-theme="<id>"]`: more specific than the plain `:root` defaults and than the
// phone override that swaps in a second set of core colors, so a preset wins at every screen size.
//
// The designer fills these in. Keep text pairs at WCAG AA (4.5:1 body text, 3:1 large text and borders);
// test/theme-presets.test.js checks the pairs that matter for every non-default preset.

const PRESETS = {
  midnight: {
    label: 'Midnight',
    description: 'The original Beebo look: deep navy with purple and gold.',
    scheme: 'dark',
    themeColor: '#182033',
    vars: null // the stylesheet defaults
  },

  graphite: {
    label: 'Graphite',
    description: 'A neutral dark theme: charcoal greys with a quiet steel-blue accent.',
    scheme: 'dark',
    themeColor: '#1a1b1e',
    vars: {
      '--bg': '#101113', '--panel': '#1a1b1e', '--raised': '#222327', '--text': '#ececef', '--muted': '#a9abb2',
      '--line': '#383a40', '--purple': '#8b93a6', '--gold': '#e8c15a', '--link': '#a9c4f5',
      '--text-strong': '#ffffff', '--on-accent': '#ffffff', '--on-gold': '#101113', '--soft-text': '#b8bac1',
      '--page-glow': 'none',
      '--sidebar-bg': 'linear-gradient(165deg,#1d1e22,#141518 48%,#101113)',
      '--sidebar-brand-sub': '#b3b5bc', '--sidebar-label': '#9a9da6', '--sidebar-link': '#c4c6cc',
      '--sidebar-foot': '#a3a5ac', '--sidebar-foot-strong': '#dcdde1',
      '--sheet-bg': 'linear-gradient(150deg,#232428,#17181b)', '--sheet-border': '#45474e',
      '--mark-grad': 'linear-gradient(145deg,#7f8799,#3f4757)', '--mark-border': '#a2a9b8',
      '--hover-bg': '#2a2b30', '--nav-hover-border': '#44464d',
      '--nav-active-grad-1': '#3c5a8a', '--nav-active-grad-2': '#2f4a73',
      '--accent-grad-1': '#45689f', '--accent-grad-2': '#33507e', '--accent-border': '#7d97c4',
      '--input-bg': '#0c0d0f', '--control-border': '#62656d', '--placeholder': '#9a9da5', '--search-bg': '#17181b',
      '--btn-secondary-bg': '#26272b', '--menu-bg': '#26272b', '--menu-border': '#4c4f56',
      '--tab-border': '#45474e', '--tab-text': '#c0c2c8', '--tab-active-bg': '#3c5a8a', '--tab-active-border': '#7d97c4',
      '--logout-text': '#d0d2d7',
      '--card-bg': 'linear-gradient(155deg,#1f2023,#17181b)', '--card-border': '#34363b', '--card-hover-border': '#7d97c4',
      '--poster-bg': '#0c0d0f', '--noposter-text': '#c2c4ca',
      '--noposter-bg': 'linear-gradient(145deg,#2c2e34,#1a1b1f)',
      '--icon-btn-bg': '#0b0c0ecc', '--icon-btn-border': '#9a9da566', '--overlay-bg': '#0e0f11f5',
      '--empty-border': '#4b4d54', '--empty-bg': '#1a1b1e77',
      '--alpha-bar-bg': '#17181b', '--alpha-bar-text': '#ececef', '--alpha-bar-off': '#6a6d75',
      '--mobilebar-bg': 'linear-gradient(110deg,#1d1e22,#17181b)', '--mobilebar-border': '#3a3c42',
      '--brand-eyebrow': '#c9b77a', '--round-btn-bg': '#1f2024', '--round-btn-border': '#55575e', '--logout-border': '#55575e',
      '--bottomnav-bg': '#1a1b1ef7', '--bottomnav-border': '#3a3c42', '--bottomnav-hover': '#2a2b30',
      '--tab-selected-text': '#f0d98a', '--tab-selected-bg': 'linear-gradient(105deg,#3c5a8a,#2f4a73)',
      '--tab-selected-border': '#8fa5c9', '--phone-search-border': '#5a5d65',
      '--chip-border': '#45474e', '--chip-active-bg': '#33445f', '--chip-active-border': '#c9a94e', '--chip-active-text': '#f0d98a',
      '--alphabet-bg': '#1a1b1ef5', '--alphabet-border': '#3a3c42', '--alphabet-disabled': '#7c7f87', '--scrollbar': '#6a6d75',
      '--radius-card': '13px', '--radius-control': '10px', '--radius-button': '9px'
    }
  },

  daylight: {
    label: 'Daylight',
    description: 'A light theme built for contrast: near-black text on white and pale grey, deep violet accents.',
    scheme: 'light',
    themeColor: '#ffffff',
    vars: {
      '--bg': '#f5f6fa', '--panel': '#ffffff', '--raised': '#eceef5', '--text': '#15181f', '--muted': '#4b5266',
      '--line': '#c5cad8', '--purple': '#5b3fb0', '--gold': '#8a5a00', '--link': '#4a2fb0',
      '--text-strong': '#0b0d12', '--on-accent': '#ffffff', '--on-gold': '#ffffff', '--soft-text': '#4b5266',
      '--page-glow': 'radial-gradient(ellipse at 100% 0,#e6e9f7 0,transparent 55%)',
      '--sidebar-bg': 'linear-gradient(165deg,#ffffff,#f0f2f9 55%,#e8ebf5)',
      '--sidebar-brand-sub': '#4b5266', '--sidebar-label': '#535c75', '--sidebar-link': '#2b3450',
      '--sidebar-foot': '#4b5266', '--sidebar-foot-strong': '#1d2333',
      '--sheet-bg': 'linear-gradient(150deg,#ffffff,#eef0f8)', '--sheet-border': '#c5cad8',
      '--mark-grad': 'linear-gradient(145deg,#efe9ff,#d6e2f7)', '--mark-border': '#a48be0',
      '--hover-bg': '#e4e8f4', '--nav-hover-border': '#b9c1d6',
      '--nav-active-grad-1': '#5b3fb0', '--nav-active-grad-2': '#35569a',
      '--accent-grad-1': '#6a45c2', '--accent-grad-2': '#3a5fa3', '--accent-border': '#4a2f96',
      '--input-bg': '#ffffff', '--control-border': '#7a8399', '--placeholder': '#5c6478', '--search-bg': '#ffffff',
      '--btn-secondary-bg': '#4b5266', '--menu-bg': '#e6e9f3', '--menu-border': '#a8b0c6',
      '--tab-border': '#b9c1d6', '--tab-text': '#2b3450', '--tab-active-bg': '#5b3fb0', '--tab-active-border': '#3f2a80',
      '--logout-text': '#2b3450',
      '--card-bg': 'linear-gradient(155deg,#ffffff,#f1f3fa)', '--card-border': '#c5cad8', '--card-hover-border': '#6a45c2',
      '--poster-bg': '#dfe3ee', '--noposter-text': '#3a2a70',
      '--noposter-bg': 'linear-gradient(145deg,#e7defa,#d5e3f7)',
      '--icon-btn-bg': '#0b1020cc', '--icon-btn-border': '#ffffff66', '--overlay-bg': '#0b1327f5',
      '--empty-border': '#8f98b0', '--empty-bg': '#ffffffaa',
      '--alpha-bar-bg': '#e8ebf5', '--alpha-bar-text': '#2b3450', '--alpha-bar-off': '#7a8399',
      '--mobilebar-bg': 'linear-gradient(110deg,#ffffff,#eef1fa)', '--mobilebar-border': '#c5cad8',
      '--brand-eyebrow': '#6b4a00', '--round-btn-bg': '#ffffff', '--round-btn-border': '#a8b0c6', '--logout-border': '#a8b0c6',
      '--bottomnav-bg': '#fffffff7', '--bottomnav-border': '#c5cad8', '--bottomnav-hover': '#e6e9f3',
      '--tab-selected-text': '#3f2a80', '--tab-selected-bg': 'linear-gradient(105deg,#e3daf8,#d3e0f5)',
      '--tab-selected-border': '#7a5fd0', '--phone-search-border': '#7a8399',
      '--chip-border': '#b9c1d6', '--chip-active-bg': '#e3daf8', '--chip-active-border': '#5b3fb0', '--chip-active-text': '#3a2470',
      '--alphabet-bg': '#fffffff5', '--alphabet-border': '#c5cad8', '--alphabet-disabled': '#7a8399', '--scrollbar': '#8a7fbf',
      '--radius-card': '13px', '--radius-control': '10px', '--radius-button': '9px'
    }
  },

  ember: {
    label: 'Ember',
    description: 'The dark layout with a warm accent: charcoal-brown surfaces and copper-orange highlights.',
    scheme: 'dark',
    themeColor: '#1e1712',
    vars: {
      '--bg': '#120e0b', '--panel': '#1e1712', '--raised': '#271e17', '--text': '#f6efe8', '--muted': '#c4b6a6',
      '--line': '#4a3a2d', '--purple': '#d9772b', '--gold': '#f2b84b', '--link': '#ffc58a',
      '--text-strong': '#ffffff', '--on-accent': '#ffffff', '--on-gold': '#1a1108', '--soft-text': '#d0c3b3',
      '--page-glow': 'radial-gradient(ellipse at 100% 0,#3a2214 0,transparent 50%)',
      '--sidebar-bg': 'linear-gradient(165deg,#2a1a10,#1a110b 48%,#120e0b)',
      '--sidebar-brand-sub': '#d2bfa9', '--sidebar-label': '#b39d85', '--sidebar-link': '#e0cfbd',
      '--sidebar-foot': '#bfad98', '--sidebar-foot-strong': '#ecdcc9',
      '--sheet-bg': 'linear-gradient(150deg,#2e1d12,#1c130d)', '--sheet-border': '#5b4636',
      '--mark-grad': 'linear-gradient(145deg,#f08a3c,#a3441a)', '--mark-border': '#ffb27a',
      '--hover-bg': '#33241a', '--nav-hover-border': '#5a4230',
      '--nav-active-grad-1': '#a84d16', '--nav-active-grad-2': '#8a3a14',
      '--accent-grad-1': '#b8531a', '--accent-grad-2': '#8f3b14', '--accent-border': '#e0925a',
      '--input-bg': '#0d0a08', '--control-border': '#7d6650', '--placeholder': '#b3a08d', '--search-bg': '#1a130e',
      '--btn-secondary-bg': '#33241a', '--menu-bg': '#33241a', '--menu-border': '#6a5240',
      '--tab-border': '#5a4230', '--tab-text': '#dccbb8', '--tab-active-bg': '#a84d16', '--tab-active-border': '#f0a468',
      '--logout-text': '#e6d6c4',
      '--card-bg': 'linear-gradient(155deg,#2a1f17,#1c1410)', '--card-border': '#4a3a2d', '--card-hover-border': '#f0a468',
      '--poster-bg': '#0d0a08', '--noposter-text': '#f0c9a3',
      '--noposter-bg': 'radial-gradient(ellipse at 85% 0,#5a3620,transparent 65%),linear-gradient(145deg,#3d2214,#241610)',
      '--icon-btn-bg': '#0c0805cc', '--icon-btn-border': '#c9a98a66', '--overlay-bg': '#120e0bf5',
      '--empty-border': '#6a5240', '--empty-bg': '#1e171277',
      '--alpha-bar-bg': '#1e1712', '--alpha-bar-text': '#f6efe8', '--alpha-bar-off': '#86745f',
      '--mobilebar-bg': 'linear-gradient(110deg,#2e1d12,#1e1510)', '--mobilebar-border': '#5a4230',
      '--brand-eyebrow': '#e0b96a', '--round-btn-bg': '#261a12', '--round-btn-border': '#6a5240', '--logout-border': '#6a5240',
      '--bottomnav-bg': '#1e1712f7', '--bottomnav-border': '#5a4230', '--bottomnav-hover': '#33241a',
      '--tab-selected-text': '#ffd28f', '--tab-selected-bg': 'linear-gradient(105deg,#7a3a14,#5c2c12)',
      '--tab-selected-border': '#d99a5e', '--phone-search-border': '#7d6650',
      '--chip-border': '#5a4230', '--chip-active-bg': '#5c2f14', '--chip-active-border': '#e0a050', '--chip-active-text': '#ffd8a0',
      '--alphabet-bg': '#1e1712f5', '--alphabet-border': '#4a3a2d', '--alphabet-disabled': '#86745f', '--scrollbar': '#9a6a44',
      '--radius-card': '13px', '--radius-control': '10px', '--radius-button': '9px'
    }
  }
}

const DEFAULT_THEME = 'midnight'
const PRESET_IDS = Object.keys(PRESETS)

module.exports = { PRESETS, PRESET_IDS, DEFAULT_THEME }
