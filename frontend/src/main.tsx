import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { initializeTabSession } from './tabSession'
import './index.css'
import App from './App.tsx'

const root = createRoot(document.getElementById('root')!)

void initializeTabSession().then(() => {
  root.render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  )
}).catch((error: unknown) => {
  root.render(
    <p role="alert">
      Could not initialize this browser tab's session: {error instanceof Error ? error.message : 'Unknown error'}
    </p>,
  )
})
