/**
 * Standalone build config for the dsh-auto-proxy plugin (self-contained copy
 * of the dsh-web-ui shared client-bundle preset, adapted from dsh-text-drop):
 * the node-half lib/ (host plugin: settings, shell-env, prompt, tools,
 * routes) plus the browser bundle lib/client.js (closure-factory artifact for
 * the GUI's __ModuleLoader__, platform modules stay external, everything else
 * inlines).
 */

import type { UserConfig } from 'tsdown'

const ID = '@icelily/dsh-auto-proxy'

/** The module specifiers the shell shares into the frozen module table. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** Externals resolved from the loader module table (platform seeds + the
 * settings domain row; 0.1.2 moved the runtime's client face into
 * `dsh-client-store` and the scope contract into `dsh-client-ui-settings`). */
const CLIENT_EXTERNALS: readonly string[] = [
  ...PLATFORM_MODULES,
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-settings/client',
]

/** Node-half library: the host plugin. */
const nodeConfig: UserConfig = {
  name: ID,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Resolved at runtime from the dsh profile tree, never from this repo's install.
  external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-host-webserver'],
}

/** Browser bundle: the client half, served at /plugins/<id>/client.js. */
const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  // Platform modules stay external (the loader table answers them); every
  // other dependency inlines into the bundle.
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [nodeConfig, clientConfig]
