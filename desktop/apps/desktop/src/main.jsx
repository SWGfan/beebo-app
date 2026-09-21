import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import SignInGate from './components/SignInGate.jsx'
import { bootPosterView } from './lib/posterViewDom.js'
import { bootI18n } from './lib/i18nApp.js'
import { installGridNav } from './lib/gridNav.js'
import { bootProfile } from './lib/profileStore.js'
import './styles.css'
import './a11y.css'
import './profile.css'

bootI18n() // language and text direction, before the first paint
bootPosterView()
bootProfile() // the owner's saved layout / accessibility choices (Settings > Appearance)
installGridNav() // one Tab stop per poster grid, arrow keys inside it

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <SignInGate>
      <App />
    </SignInGate>
  </React.StrictMode>
)
