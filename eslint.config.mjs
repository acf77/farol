import appConfig from './app/eslint.config.mjs'

export default appConfig.map((config) => ({ ...config, basePath: 'app' }))
