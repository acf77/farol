/** The one Bun API the bench uses (`electron-stub.ts`); the app has no Bun types installed. */
declare module 'bun' {
  interface ModuleBuilder {
    module(specifier: string, factory: () => { loader: 'object'; exports: Record<string, unknown> }): void
  }
  export function plugin(options: { name: string; setup(build: ModuleBuilder): void }): void
}

/** Bun sets this on the entry module. */
interface ImportMeta {
  main?: boolean
}
