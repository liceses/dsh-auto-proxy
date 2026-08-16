// Standalone smoke test for dsh-auto-proxy core logic (no DSH runtime).
// Runs via node's native TS type stripping: node smoke.mjs
import { resolveProxy, exportBlock, parseProxyServer } from './src/proxy.ts'
import { probeUrl } from './src/probe.ts'

const results = []

// 1. manual resolution (user-specified schemes are preserved)
const manual = await resolveProxy({ mode: 'manual', http: '127.0.0.1:8080', https: 'http://127.0.0.1:8080', socks: 'socks5://127.0.0.1:10808', noProxy: 'localhost,.internal', gitApply: false, testUrl: 'https://www.google.com/generate_204' })
results.push(['manual resolve', manual.http === 'http://127.0.0.1:8080' && manual.socks === 'socks5://127.0.0.1:10808' && manual.ready])

// 1b. https:// prefix on the https slot normalizes to http:// (CONNECT semantics)
const httpsPrefixed = await resolveProxy({ mode: 'manual', http: '', https: 'https://127.0.0.1:10808', socks: '', noProxy: '', gitApply: false, testUrl: 'x' })
results.push(['https prefix normalized', httpsPrefixed.https === 'http://127.0.0.1:10808'])
console.log('manual:', JSON.stringify(manual, null, 0))

// 2. off mode
const off = await resolveProxy({ mode: 'off', http: '', https: '', socks: '', noProxy: '', gitApply: false, testUrl: 'x' })
results.push(['off resolve', !off.ready && off.source === 'none'])

// 3. proxy server parsing
const parsed = parseProxyServer('http=127.0.0.1:8080;https=127.0.0.1:8080;socks=127.0.0.1:10808')
results.push(['parseProxyServer', parsed.http === '127.0.0.1:8080' && parsed.socks === '127.0.0.1:10808'])
const parsed2 = parseProxyServer('127.0.0.1:7890')
results.push(['parseProxyServer bare', parsed2.http === '127.0.0.1:7890' && parsed2.https === '127.0.0.1:7890'])

// 4. export block sanity
const block = exportBlock(manual)
results.push(['exportBlock', block.includes('export HTTPS_PROXY=') && block.includes('DSH_PROXY_SOCKS')])

// 5. probe through socks proxy (v2RayN 10808) — socks-only plan
const target = 'https://www.google.com/generate_204'
const socksOnly = { ...manual, http: '', https: '' }
const socksProbe = await probeUrl(socksOnly, target, 12000)
results.push(['probe via socks', socksProbe.ok, socksProbe.status ?? socksProbe.error])
console.log('socks probe:', JSON.stringify(socksProbe))

// 6. probe via http proxy (8080) — may fail per known v2RayN limitation; just report
const httpProbe = await probeUrl({ ...manual, http: 'http://127.0.0.1:8080', socks: '', https: '' }, target, 12000)
console.log('http probe:', JSON.stringify(httpProbe))

// 7. direct probe (no proxy) — report
const direct = await probeUrl({ mode: 'off', source: 'none', http: '', https: '', socks: '', noProxy: '', ready: false, detail: '' }, target, 12000)
console.log('direct probe:', JSON.stringify(direct))

// 8. noProxy matching
const nm = await import('./src/probe.ts')
results.push(['matchesNoProxy', nm.matchesNoProxy('intra.internal', 'localhost,.internal') === true && nm.matchesNoProxy('google.com', 'localhost,.internal') === false])

let failed = 0
for (const [label, ok, extra] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`)
  if (!ok) failed++
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`)
process.exit(failed === 0 ? 0 : 1)
