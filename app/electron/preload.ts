import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentTaskEvent,
  FarolApi,
  GitChanged,
  Pipeline,
  PipelinesChanged,
  Project,
  RunEvent,
  ShellCwd,
  ShellData,
  ShellExit,
  UpdateStatus
} from '../shared/types'

/** Subscribe to a main-process channel; returns an unsubscribe function. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: FarolApi = {
  platform: process.platform,
  shellName: (process.env.SHELL || '').split('/').pop() || 'shell',
  project: {
    open: () => ipcRenderer.invoke('project:open'),
    recents: () => ipcRenderer.invoke('project:recents'),
    openPath: (p: string) => ipcRenderer.invoke('project:openPath', p),
    listFiles: (projectPath, query) => ipcRenderer.invoke('project:listFiles', projectPath, query),
    listSkills: (projectPath, provider) =>
      ipcRenderer.invoke('project:listSkills', projectPath, provider),
    saveAttachment: (projectPath, name, data) =>
      ipcRenderer.invoke('project:saveAttachment', projectPath, name, data),
    onOpened: (cb) => on<Project>('project:opened', cb)
  },
  session: {
    last: () => ipcRenderer.invoke('session:last'),
    openProjects: () => ipcRenderer.invoke('session:openProjects'),
    saveOpenProjects: (paths, activePath) =>
      ipcRenderer.invoke('session:saveOpenProjects', paths, activePath),
    load: (projectPath) => ipcRenderer.invoke('session:load', projectPath),
    save: (projectPath, session, last) =>
      ipcRenderer.invoke('session:save', projectPath, session, last),
    clearLast: () => ipcRenderer.invoke('session:clearLast')
  },
  pipelines: {
    load: (projectPath: string) => ipcRenderer.invoke('pipelines:load', projectPath),
    save: (projectPath: string, pipelines: Pipeline[]) =>
      ipcRenderer.invoke('pipelines:save', projectPath, pipelines),
    onChanged: (cb) => on<PipelinesChanged>('pipelines:changed', cb)
  },
  shell: {
    open: (paneId, cwd, cols, rows, provider) =>
      ipcRenderer.invoke('shell:open', paneId, cwd, cols, rows, provider),
    write: (paneId, data) => ipcRenderer.invoke('shell:write', paneId, data),
    resize: (paneId, cols, rows) => ipcRenderer.invoke('shell:resize', paneId, cols, rows),
    dispose: (paneId) => ipcRenderer.invoke('shell:dispose', paneId),
    send: (paneId, data) => ipcRenderer.invoke('shell:send', paneId, data),
    onData: (cb) => on<ShellData>('shell:data', cb),
    onExit: (cb) => on<ShellExit>('shell:exit', cb),
    onCwd: (cb) => on<ShellCwd>('shell:cwd', cb)
  },
  git: {
    info: (projectPath: string) => ipcRenderer.invoke('git:info', projectPath),
    checkout: (projectPath: string, branch: string) =>
      ipcRenderer.invoke('git:checkout', projectPath, branch),
    worktree: (projectPath, req) => ipcRenderer.invoke('git:worktree', projectPath, req),
    status: (projectPath: string) => ipcRenderer.invoke('git:status', projectPath),
    recentCommits: (projectPath: string) => ipcRenderer.invoke('git:recentCommits', projectPath),
    draftCommit: (projectPath: string, provider, model, files) =>
      ipcRenderer.invoke('git:draftCommit', projectPath, provider, model, files),
    commit: (projectPath, message, files) =>
      ipcRenderer.invoke('git:commit', projectPath, message, files),
    push: (projectPath: string) => ipcRenderer.invoke('git:push', projectPath),
    github: (projectPath: string) => ipcRenderer.invoke('git:github', projectPath),
    createPr: (projectPath: string, base?: string, title?: string) =>
      ipcRenderer.invoke('git:createPr', projectPath, base, title),
    bringConflicts: (projectPath: string) => ipcRenderer.invoke('git:bringConflicts', projectPath),
    onChanged: (cb) => on<GitChanged>('git:changed', cb)
  },
  run: {
    start: (pipeline, cwd, branch) => ipcRenderer.invoke('run:start', pipeline, cwd, branch),
    cancel: (pipelineId) => ipcRenderer.invoke('run:cancel', pipelineId),
    onEvent: (cb) => on<RunEvent>('run:event', cb)
  },
  agent: {
    start: (request) => ipcRenderer.invoke('agent:start', request),
    message: (taskId, text, provider, pipelines, model) =>
      ipcRenderer.invoke('agent:message', taskId, text, provider, pipelines, model),
    setProvider: (taskId, provider, model) =>
      ipcRenderer.invoke('agent:setProvider', taskId, provider, model),
    cancel: (taskId) => ipcRenderer.invoke('agent:cancel', taskId),
    dispose: (taskId) => ipcRenderer.invoke('agent:dispose', taskId),
    answer: (taskId, requestId, answers) =>
      ipcRenderer.invoke('agent:answer', taskId, requestId, answers),
    onEvent: (cb) => on<AgentTaskEvent>('agent:event', cb)
  },
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (settings) => ipcRenderer.invoke('settings:save', settings)
  },
  openrouter: {
    saveKey: (key) => ipcRenderer.invoke('openrouter:saveKey', key),
    clearKey: () => ipcRenderer.invoke('openrouter:clearKey'),
    refresh: () => ipcRenderer.invoke('openrouter:refresh'),
    setPinned: (ids) => ipcRenderer.invoke('openrouter:setPinned', ids)
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.send('update:install'),
    onStatus: (cb) => on<UpdateStatus>('update:status', cb)
  },
  ui: {
    glass: () => ipcRenderer.invoke('ui:glass'),
    onGlass: (cb) => on<boolean>('ui:glass', cb),
    onSettings: (cb) => on('ui:settings', () => cb())
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close')
  }
}

contextBridge.exposeInMainWorld('farol', api)
