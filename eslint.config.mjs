import appConfig from './app/eslint.config.mjs'

/** Repo-root ignores (paths relative to the checkout, not `basePath: 'app'`). */
const rootIgnores = {
  ignores: ['app/service/dist/**', 'app/**/dist/**', 'app/**/out/**', '**/node_modules/**']
}

export default [rootIgnores, ...appConfig.map((config) => ({ ...config, basePath: 'app' }))]
