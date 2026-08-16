/**
 * dsh-auto-proxy — shared types (host + client).
 *
 * Type-only module: no runtime imports, so the browser bundle can inline it
 * safely alongside the host's node-only modules.
 */

/** User-facing settings section for the `auto-proxy` namespace. */
export interface AutoProxySettings {
  /** off | auto | manual */
  mode: 'off' | 'auto' | 'manual'
  /** Manual-mode HTTP proxy URL, e.g. http://127.0.0.1:8080 (may be empty). */
  http: string
  /** Manual-mode HTTPS proxy URL (may be empty). */
  https: string
  /** Manual-mode SOCKS proxy URL, e.g. socks5://127.0.0.1:10808 (may be empty). */
  socks: string
  /** Manual-mode NO_PROXY list, comma-separated (may be empty). */
  noProxy: string
  /** When true, apply the resolved proxy to the git global config on change. */
  gitApply: boolean
  /** Target URL the connectivity probe hits (proxy_test / card test button). */
  testUrl: string
  /** Internal: previous git global http.proxy, for restore on disable. */
  _gitPrevHttp?: string
  /** Internal: previous git global https.proxy, for restore on disable. */
  _gitPrevHttps?: string
}

/** The concrete proxy plan the rest of the plugin consumes. */
export interface ResolvedProxy {
  mode: 'off' | 'auto' | 'manual'
  /** Where the values came from. */
  source: 'none' | 'registry' | 'env' | 'manual'
  /** Normalized http proxy URL, '' when none. */
  http: string
  /** Normalized https proxy URL, '' when none. */
  https: string
  /** Normalized socks proxy URL (socks5h:// for git/curl DNS safety), '' when none. */
  socks: string
  /** NO_PROXY list (comma-separated), '' when none. */
  noProxy: string
  /** True when at least one usable proxy entry exists. */
  ready: boolean
  /** One-line human summary (used by the prompt section and the UI). */
  detail: string
}
