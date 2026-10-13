/**
 * The Farol service that runs remote pipelines. It is built into the app, not a
 * setting: sandbox provider credentials live on the service, and a user only signs
 * in. Set `MAIN_VITE_FAROL_SERVICE_URL` when building to point a build elsewhere
 * (e.g. `http://localhost:8787` for development).
 */
export const SERVICE_URL: string = import.meta.env.MAIN_VITE_FAROL_SERVICE_URL || 'https://farol-api-production-3b3c.up.railway.app'
