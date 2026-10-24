import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting
} from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { detectIndent, fileName, isDirty, languageFromPath, type EditorLanguage } from '../code'
import type { CodeNotice, CodeTab } from '../hooks/useCodeWorkspace'
import { C, MONO, PANE, ELLIPSIS } from '../theme'
import { ChevronDown, ChevronRight, FileIcon, FolderIcon } from './icons'

const api = window.farol

const farolHighlight = HighlightStyle.define([
  { tag: t.comment, color: C.faint },
  { tag: t.string, color: C.green },
  { tag: t.keyword, color: C.textSoft, fontWeight: '600' },
  { tag: t.number, color: C.textRow },
  { tag: t.name, color: C.text },
  { tag: t.propertyName, color: C.textRow },
  { tag: t.typeName, color: C.textMuted },
  { tag: t.operator, color: C.textMuted },
  { tag: t.meta, color: C.textMuted },
  { tag: t.heading, color: C.text, fontWeight: '600' },
  { tag: t.tagName, color: C.textSoft },
  { tag: t.attributeName, color: C.textRow }
])

const farolTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: C.app,
      color: C.text,
      fontFamily: MONO,
      fontSize: '12px'
    },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' },
    '.cm-content': { caretColor: C.text },
    '.cm-gutters': {
      backgroundColor: C.app,
      color: C.faint,
      borderRight: '1px solid #3E3E3A'
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)', color: C.textMuted },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'rgba(214, 242, 58, 0.22)'
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: C.text },
    '.cm-searchMatch': { backgroundColor: 'rgba(214, 242, 58, 0.18)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(214, 242, 58, 0.35)' }
  },
  { dark: true }
)

function languageExt(language: EditorLanguage) {
  if (language === 'javascript') return javascript({ jsx: true })
  if (language === 'typescript') return javascript({ typescript: true, jsx: true })
  if (language === 'json') return json()
  if (language === 'css') return css()
  if (language === 'html') return html()
  if (language === 'markdown') return markdown()
  if (language === 'python') return python()
  return []
}

function CodeEditor({
  path,
  content,
  onChange
}: {
  path: string
  content: string
  onChange: (text: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const contentRef = useRef(content)
  const onChangeRef = useRef(onChange)
  contentRef.current = content
  onChangeRef.current = onChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const initial = contentRef.current
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initial,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          highlightSelectionMatches(),
          syntaxHighlighting(farolHighlight),
          farolTheme,
          languageExt(languageFromPath(path)),
          indentUnit.of(detectIndent(initial)),
          keymap.of([
            { key: 'Mod-/', run: toggleComment },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          })
        ]
      })
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [path])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === content) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
  }, [content])

  return <div ref={hostRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }} />
}

function DirNode({
  projectPath,
  rel,
  label,
  selected,
  onOpen,
  depth,
  defaultOpen
}: {
  projectPath: string
  rel: string
  label: string
  selected: string | null
  onOpen: (path: string) => void
  depth: number
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen === true)
  const { data: entries } = useQuery({
    queryKey: ['project-dir', projectPath, rel],
    queryFn: async () => {
      const result = await api.project.listDir(projectPath, rel)
      return result.ok ? result.entries : null
    },
    enabled: open,
    staleTime: 30_000
  })

  return (
    <div>
      <button
        type="button"
        className="bf-focus"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          padding: `4px 8px 4px ${8 + depth * 12}px`,
          border: 'none',
          background: 'transparent',
          color: C.textSoft,
          fontSize: 12,
          textAlign: 'left',
          cursor: 'pointer'
        }}
      >
        {open ? <ChevronDown size={10} color="currentColor" /> : <ChevronRight size={10} />}
        <FolderIcon size={12} />
        <span style={{ ...ELLIPSIS }}>{label}</span>
      </button>
      {open &&
        entries?.map((entry) =>
          entry.kind === 'dir' ? (
            <DirNode
              key={entry.path}
              projectPath={projectPath}
              rel={entry.path}
              label={entry.name}
              selected={selected}
              onOpen={onOpen}
              depth={depth + 1}
            />
          ) : (
            <button
              key={entry.path}
              type="button"
              className="bf-focus"
              onClick={() => onOpen(entry.path)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                padding: `4px 8px 4px ${20 + depth * 12}px`,
                border: 'none',
                borderRadius: 6,
                background: selected === entry.path ? '#ffffff14' : 'transparent',
                color: selected === entry.path ? C.text : C.textSoft,
                fontSize: 12,
                textAlign: 'left',
                cursor: 'pointer'
              }}
            >
              <FileIcon size={12} />
              <span style={{ ...ELLIPSIS }}>
                {entry.name}
              </span>
            </button>
          )
        )}
    </div>
  )
}

function NoticeBar({
  notice,
  onDiscard,
  onOverwrite,
  onCancel
}: {
  notice: CodeNotice
  onDiscard: () => void
  onOverwrite: () => void
  onCancel: () => void
}) {
  const dirty = notice.kind === 'dirty-close'
  const conflict = notice.kind === 'conflict'
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 10px',
        borderBottom: `1px solid ${C.border}`,
        background: C.sidebar,
        color: notice.kind === 'error' ? '#ff8b80' : C.text,
        fontSize: 12
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        {dirty
          ? 'Discard unsaved changes?'
          : conflict
            ? 'File changed on disk. Overwrite?'
            : notice.text}
      </span>
      {dirty && (
        <button type="button" className="bf-focus" onClick={onDiscard} style={textBtn(C.red)}>
          Discard
        </button>
      )}
      {conflict && (
        <button type="button" className="bf-focus" onClick={onOverwrite} style={textBtn(C.accent)}>
          Overwrite
        </button>
      )}
      <button type="button" className="bf-focus" onClick={onCancel} style={textBtn(C.textMuted)}>
        {notice.kind === 'error' ? 'Dismiss' : 'Keep'}
      </button>
    </div>
  )
}

function textBtn(color: string): CSSProperties {
  return {
    border: 'none',
    background: 'transparent',
    color,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    padding: '2px 4px'
  }
}

interface Props {
  projectPath: string
  tabs: CodeTab[]
  activePath: string | null
  active: CodeTab | null
  notice: CodeNotice | null
  onOpen: (path: string) => void
  onSelect: (path: string) => void
  onChange: (path: string, content: string) => void
  onClose: (path: string) => void
  onSave: () => void
  onRevert: () => void
  onDiscard: () => void
  onOverwrite: () => void
  onCancelNotice: () => void
}

export default function CodePane({
  projectPath,
  tabs,
  activePath,
  active,
  notice,
  onOpen,
  onSelect,
  onChange,
  onClose,
  onSave,
  onRevert,
  onDiscard,
  onOverwrite,
  onCancelNotice
}: Props) {
  const rootName = projectPath.split('/').filter(Boolean).pop() || projectPath
  const dirty = active ? isDirty(active.original, active.content) : false

  return (
    <div style={{ ...PANE, flex: '1 1 100%' }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <nav
          aria-label="Project files"
          style={{
            width: 220,
            flex: 'none',
            overflow: 'auto',
            borderRight: `1px solid ${C.border}`,
            background: C.sidebar,
            padding: '6px 4px'
          }}
        >
          <DirNode
            projectPath={projectPath}
            rel=""
            label={rootName}
            selected={activePath}
            onOpen={onOpen}
            depth={0}
            defaultOpen
          />
        </nav>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {tabs.length > 0 && (
            <div
              role="tablist"
              aria-label="Open files"
              style={{
                display: 'flex',
                flex: 'none',
                overflow: 'auto',
                borderBottom: `1px solid ${C.border}`
              }}
            >
              {tabs.map((tab) => {
                const on = tab.path === activePath
                const marked = isDirty(tab.original, tab.content)
                return (
                  <div
                    key={tab.path}
                    role="tab"
                    aria-selected={on}
                    tabIndex={0}
                    className="bf-focus"
                    title={tab.path}
                    onClick={() => onSelect(tab.path)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSelect(tab.path)
                      }
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 10px',
                      background: on ? C.sidebar : 'transparent',
                      color: on ? C.text : C.textMuted,
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {marked && (
                      <span
                        aria-label="Unsaved"
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          background: C.accent
                        }}
                      />
                    )}
                    <span>{fileName(tab.path)}</span>
                    <button
                      type="button"
                      className="bf-focus"
                      aria-label={`Close ${fileName(tab.path)}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onClose(tab.path)
                      }}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: 'inherit',
                        cursor: 'pointer',
                        padding: 0,
                        lineHeight: 1
                      }}
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          {notice && (
            <NoticeBar
              notice={notice}
              onDiscard={onDiscard}
              onOverwrite={onOverwrite}
              onCancel={onCancelNotice}
            />
          )}
          {active ? (
            <CodeEditor
              key={active.path}
              path={active.path}
              content={active.content}
              onChange={(text) => onChange(active.path, text)}
            />
          ) : (
            <div
              style={{
                flex: 1,
                display: 'grid',
                placeItems: 'center',
                color: C.textMuted,
                fontSize: 13
              }}
            >
              Open a file from the tree or ⌘K.
            </div>
          )}
          <div
            style={{
              flex: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '4px 10px',
              borderTop: `1px solid ${C.border}`,
              color: C.textMuted,
              fontSize: 11,
              fontFamily: MONO
            }}
          >
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {active?.path ?? 'No file open'}
            </span>
            <span>{dirty ? 'Unsaved' : 'Saved'}</span>
            <span>UTF-8</span>
            <span>{active?.lineEnding === 'crlf' ? 'CRLF' : 'LF'}</span>
            <button
              type="button"
              className="bf-focus"
              disabled={!dirty}
              onClick={onRevert}
              style={{
                border: 'none',
                background: 'transparent',
                color: dirty ? C.text : C.faint,
                cursor: dirty ? 'pointer' : 'default',
                fontSize: 11,
                fontWeight: 600,
                fontFamily: 'inherit'
              }}
            >
              Revert
            </button>
            <button
              type="button"
              className="bf-focus"
              disabled={!dirty}
              onClick={onSave}
              title="Save (⌘S)"
              style={{
                border: 'none',
                borderRadius: 8,
                height: 22,
                padding: '0 10px',
                background: dirty ? C.accent : '#2A2A28',
                color: dirty ? C.accentInk : C.faint,
                cursor: dirty ? 'pointer' : 'default',
                fontSize: 11,
                fontWeight: 600
              }}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
