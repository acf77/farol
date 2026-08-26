import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// No StrictMode: its double-invoked effects would spawn a second PTY for
// every shell tab in development.
createRoot(document.getElementById('root') as HTMLElement).render(<App />)
