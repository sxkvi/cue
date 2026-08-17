const { contextBridge, ipcRenderer } = require('electron');
const platform = process.platform;

// Only channels named here can cross the bridge. Both lists are allowlists on
// purpose: a renderer compromised through model output still cannot reach an
// IPC route that was never published.
const EVENT_CHANNELS = [
  'capture:state',
  'capture:request-toggle',
  'llm:start', 'llm:token', 'llm:done', 'llm:error',
  'status', 'transcript',
  'stt:interim', 'stt:final', 'stt:status',
  'vad:state',
  'applink:consent-request',
  'hide:toggle',
  'whisper:download-progress', 'whisper:models-changed',
  'shortcuts:state',
  'local:pull-progress', 'local:install-progress', 'local:models-changed',
  'app:confirm-quit',
  'settings:show', 'onboard:show'
];

contextBridge.exposeInMainWorld('cue', {
  platform,
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  whisperModels: () => ipcRenderer.invoke('whisper:models'),
  whisperModelDownload: (modelId) => ipcRenderer.invoke('whisper:model-download', modelId),
  whisperModelCancel: (modelId) => ipcRenderer.invoke('whisper:model-cancel', modelId),
  whisperModelDelete: (modelId) => ipcRenderer.invoke('whisper:model-delete', modelId),
  whisperModelImport: (modelId) => ipcRenderer.invoke('whisper:model-import', modelId),
  platformInfo: () => ipcRenderer.invoke('platform:info'),
  ask: (payload) => ipcRenderer.send('ask', payload),
  stopAnswer: () => ipcRenderer.send('llm:stop'),
  refineAnswer: (kind) => ipcRenderer.send('llm:refine', { kind }),
  testProvider: (settings) => ipcRenderer.invoke('provider:test', settings),
  localStatus: () => ipcRenderer.invoke('local:status'),
  localStart: () => ipcRenderer.invoke('local:start'),
  localInstall: () => ipcRenderer.invoke('local:install'),
  localPull: (model) => ipcRenderer.invoke('local:pull', model),
  localCancel: () => ipcRenderer.send('local:cancel'),
  localRemove: (model) => ipcRenderer.invoke('local:remove', model),
  localCapabilities: () => ipcRenderer.invoke('local:capabilities'),
  localWarm: () => ipcRenderer.invoke('local:warm'),
  claudeCodeStatus: () => ipcRenderer.invoke('claudecode:status'),
  captureToggle: () => ipcRenderer.invoke('capture:toggle').catch((err) => {
    console.error('[cue] captureToggle error', err);
    return false;
  }),
  captureState: () => ipcRenderer.invoke('capture:state'),
  micPcm: (arrayBuffer) => ipcRenderer.send('mic:pcm', arrayBuffer),
  systemPcm: (arrayBuffer) => ipcRenderer.send('system:pcm', arrayBuffer),
  setIgnoreMouse: (v) => ipcRenderer.send('mouse:ignore', v),
  clearTranscript: () => ipcRenderer.invoke('transcript:clear'),
  exportTranscript: () => ipcRenderer.invoke('transcript:export'),
  nudgeWindow: (dx, dy, step) => ipcRenderer.send('window:nudge', { dx, dy, step }),
  shortcutsState: () => ipcRenderer.invoke('shortcuts:state'),
  openPane: (url) => ipcRenderer.send('open-pane', url),
  appLinkState: () => ipcRenderer.invoke('applink:state'),
  appLinkRevoke: (callerId) => ipcRenderer.invoke('applink:revoke', callerId),
  appLinkConsentRespond: (id, allowed) => ipcRenderer.send('applink:consent-response', { id, allowed }),
  pickProfileDocument: () => ipcRenderer.invoke('profile:pickDocument'),
  requestQuit: () => ipcRenderer.send('app:request-quit'),
  quit: () => ipcRenderer.send('app:quit'),
  permissionsCheck: () => ipcRenderer.invoke('permissions:check'),
  permissionsRequest: () => ipcRenderer.invoke('permissions:request'),
  permissionsContinue: () => ipcRenderer.send('permissions:continue'),
  log: (msg) => ipcRenderer.send('log', msg),
  on: (channel, cb) => {
    if (!EVENT_CHANNELS.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
