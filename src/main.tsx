import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './ErrorBoundary'
import './styles.css'

// Block Chromium's default file-drop navigation outside the chat composer.
document.addEventListener('dragover', (event) => {
  if ([...event.dataTransfer?.types ?? []].includes('Files')) event.preventDefault()
})
document.addEventListener('drop', (event) => {
  if ([...event.dataTransfer?.types ?? []].includes('Files')) event.preventDefault()
})

// Errors in IPC callbacks and batched flushes never reach a component boundary.
window.addEventListener('error', (event) => {
  console.error('[farol] uncaught error', event.error ?? event.message)
})
window.addEventListener('unhandledrejection', (event) => {
  console.error('[farol] unhandled rejection', event.reason)
})

// No StrictMode: its double-invoked effects would spawn a second PTY for
// every shell tab in development.
createRoot(document.getElementById('root') as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
