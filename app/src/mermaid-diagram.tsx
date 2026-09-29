import { useEffect, useId, useState } from 'react'
import { C, MONO } from './theme'

let renderSeq = 0
let mermaidReady: Promise<typeof import('mermaid').default> | null = null

export function isMermaidLang(lang: string | undefined): boolean {
  return (lang ?? '').toLowerCase() === 'mermaid'
}

function loadMermaid(): Promise<typeof import('mermaid').default> {
  mermaidReady ??= import('mermaid').then((mod) => {
    const mermaid = mod.default
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      theme: 'dark',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
      themeVariables: {
        darkMode: true,
        background: '#181817',
        primaryColor: '#232322',
        primaryTextColor: '#F0F0EC',
        primaryBorderColor: '#3E3E3A',
        secondaryColor: '#2D2D2B',
        tertiaryColor: '#232322',
        lineColor: '#A1A19A',
        textColor: '#F0F0EC',
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif'
      },
      flowchart: {
        curve: 'basis',
        padding: 16,
        nodeSpacing: 36,
        rankSpacing: 44
      }
    })
    return mermaid
  })
  return mermaidReady
}

export async function renderMermaidSvg(source: string, id: string): Promise<string> {
  const mermaid = await loadMermaid()
  const { svg } = await mermaid.render(id, source.trim())
  return svg
}

function Fallback({ source, failed }: { source: string; failed: boolean }) {
  return (
    <pre
      className="bf-md-mermaid-source"
      style={{
        margin: 0,
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: 1.5,
        color: C.textRow
      }}
    >
      <div style={{ fontSize: 10, color: C.faint, marginBottom: 8, userSelect: 'none' }}>
        {failed ? 'mermaid — could not render' : 'mermaid'}
      </div>
      <code style={{ fontFamily: 'inherit', whiteSpace: 'pre' }}>{source.replace(/\n$/, '')}</code>
    </pre>
  )
}

/** Client-side Mermaid → SVG. Incomplete or invalid source stays as a code fallback. */
export function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId().replace(/:/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setFailed(false)
    const id = `bf-md-mmd-${reactId}-${++renderSeq}`
    void renderMermaidSvg(source, id).then(
      (out) => {
        if (!cancelled) setSvg(out)
      },
      () => {
        if (!cancelled) setFailed(true)
      }
    )
    return () => {
      cancelled = true
    }
  }, [source, reactId])

  return (
    <div className="bf-md-mermaid" data-failed={failed || undefined}>
      {svg ? (
        <div className="bf-md-mermaid-svg" role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <Fallback source={source} failed={failed} />
      )}
    </div>
  )
}
