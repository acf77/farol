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
  ShellActivity,
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
    listDir: (projectPath, relDir) => ipcRenderer.invoke('project:listDir', projectPath, relDir),
    readFile: (projectPath, relPath) => ipcRenderer.invoke('project:readFile', projectPath, relPath),
    writeFile: (projectPath, relPath, content, opts) =>
      ipcRenderer.invoke('project:writeFile', projectPath, relPath, content, opts),
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
  todos: {
    load: (projectPath) => ipcRenderer.invoke('todos:load', projectPath),
    save: (checkout, todos, expected) => ipcRenderer.invoke('todos:save', checkout, todos, expected),
    onChanged: (cb) => on('todos:changed', cb)
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
    onCwd: (cb) => on<ShellCwd>('shell:cwd', cb),
    onActivity: (cb) => on<ShellActivity>('shell:activity', cb)
  },
  git: {
    info: (projectPath: string) => ipcRenderer.invoke('git:info', projectPath),
    checkout: (projectPath: string, branch: string) =>
      ipcRenderer.invoke('git:checkout', projectPath, branch),
    worktree: (projectPath, req) => ipcRenderer.invoke('git:worktree', projectPath, req),
    status: (projectPath: string, base?: string) => ipcRenderer.invoke('git:status', projectPath, base),
    recentCommits: (projectPath: string) => ipcRenderer.invoke('git:recentCommits', projectPath),
    draftCommit: (projectPath: string, provider, model, files) =>
      ipcRenderer.invoke('git:draftCommit', projectPath, provider, model, files),
    commit: (projectPath, message, files) =>
      ipcRenderer.invoke('git:commit', projectPath, message, files),
    push: (projectPath: string) => ipcRenderer.invoke('git:push', projectPath),
    pull: (projectPath: string) => ipcRenderer.invoke('git:pull', projectPath),
    hooks: (projectPath: string) => ipcRenderer.invoke('git:hooks', projectPath),
    github: (projectPath: string) => ipcRenderer.invoke('git:github', projectPath),
    createPr: (projectPath: string, base?: string, title?: string, body?: string) =>
      ipcRenderer.invoke('git:createPr', projectPath, base, title, body),
    draftPr: (projectPath: string, provider, model, base) =>
      ipcRenderer.invoke('git:draftPr', projectPath, provider, model, base),
    mergePr: (projectPath: string, strategy) =>
      ipcRenderer.invoke('git:mergePr', projectPath, strategy),
    bringConflicts: (projectPath: string, base?: string) =>
      ipcRenderer.invoke('git:bringConflicts', projectPath, base),
    onChanged: (cb) => on<GitChanged>('git:changed', cb)
  },
  run: {
    start: (pipeline, cwd, branch) => ipcRenderer.invoke('run:start', pipeline, cwd, branch),
    cancel: (pipelineId) => ipcRenderer.invoke('run:cancel', pipelineId),
    onEvent: (cb) => on<RunEvent>('run:event', cb)
  },
  agent: {
    start: (request) => ipcRenderer.invoke('agent:start', request),
    message: (taskId, text, provider, pipelines, model, mode, fallbacks, cwd, checkout) =>
      ipcRenderer.invoke('agent:message', taskId, text, provider, pipelines, model, mode, fallbacks, cwd, checkout),
    setProvider: (taskId, provider, model, mode) =>
      ipcRenderer.invoke('agent:setProvider', taskId, provider, model, mode),
    cancel: (taskId) => ipcRenderer.invoke('agent:cancel', taskId),
    dispose: (taskId) => ipcRenderer.invoke('agent:dispose', taskId),
    undoDelegate: (taskId, delegateId, restore) => ipcRenderer.invoke('agent:undoDelegate', taskId, delegateId, restore),
    answer: (taskId, requestId, answers) =>
      ipcRenderer.invoke('agent:answer', taskId, requestId, answers),
    freshStart: (taskId) => ipcRenderer.invoke('agent:freshStart', taskId),
    onEvent: (cb) => on<AgentTaskEvent>('agent:event', cb)
  },
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (settings) => ipcRenderer.invoke('settings:save', settings)
  },
  prompts: {
    load: (projectPath) => ipcRenderer.invoke('prompts:load', projectPath),
    saveGlobal: (projectPath, prompts) => ipcRenderer.invoke('prompts:saveGlobal', projectPath, prompts),
    saveProject: (projectPath, prompts) => ipcRenderer.invoke('prompts:saveProject', projectPath, prompts),
    setProjectActive: (projectPath, ids) => ipcRenderer.invoke('prompts:setProjectActive', projectPath, ids)
  },
  openrouter: {
    saveKey: (key) => ipcRenderer.invoke('openrouter:saveKey', key),
    clearKey: () => ipcRenderer.invoke('openrouter:clearKey'),
    refresh: () => ipcRenderer.invoke('openrouter:refresh'),
    setPinned: (ids) => ipcRenderer.invoke('openrouter:setPinned', ids)
  },
  agents: {
    scan: () => ipcRenderer.invoke('agents:scan')
  },
  agentModels: {
    refresh: (force) => ipcRenderer.invoke('agentModels:refresh', force === true)
  },
  remote: {
    signInStart: () => ipcRenderer.invoke('remote:signInStart'),
    signInWait: () => ipcRenderer.invoke('remote:signInWait'),
    signInCancel: () => ipcRenderer.invoke('remote:signInCancel'),
    account: () => ipcRenderer.invoke('remote:account'),
    signOut: () => ipcRenderer.invoke('remote:signOut'),
    billing: () => ipcRenderer.invoke('remote:billing'),
    openBilling: (kind) => ipcRenderer.invoke('remote:openBilling', kind),
    onPaymentRequired: (cb) => on<{ canUpgrade: boolean }>('remote:paymentRequired', cb)
  },
  providerKey: {
    save: (name, key) => ipcRenderer.invoke('providerKey:save', name, key),
    clear: (name) => ipcRenderer.invoke('providerKey:clear', name)
  },
  jev: {
    saveKey: (key) => ipcRenderer.invoke('jev:saveKey', key),
    clearKey: () => ipcRenderer.invoke('jev:clearKey'),
    check: () => ipcRenderer.invoke('jev:check')
  },
  usage: {
    read: () => ipcRenderer.invoke('usage:read'),
    spend: (force) => ipcRenderer.invoke('spend:read', force),
    spendKeys: () => ipcRenderer.invoke('spend:keys'),
    saveSpendKey: (name, key) => ipcRenderer.invoke('spend:saveKey', name, key),
    clearSpendKey: (name) => ipcRenderer.invoke('spend:clearKey', name)
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.send('update:install'),
    onStatus: (cb) => on<UpdateStatus>('update:status', cb)
  },
  ui: {
    onSettings: (cb) => on('ui:settings', () => cb())
  }
}

contextBridge.exposeInMainWorld('farol', api)
