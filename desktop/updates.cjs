// Keep update decisions in the main process: the renderer never supplies a URL or path.
function updateInstallBlock({ store, runner }, draftProtectionPending) {
  if (draftProtectionPending) return 'Save your changes before restarting.';
  if (store.projects().some(project => runner.hasActiveProject(project.id)) ||
      store.jobs().some(job => job.status === 'queued' || job.status === 'running'))
    return 'Finish or stop your active scans before restarting.';
  // A paused or unresolved cancellation record is already saved. Restarting
  // keeps its receipt, and an update can be how the user gets recovery support.
  return null;
}

function createUpdates({ updater, installed, version, manualInstall = false, canInstall, install, publish, readPreference, savePreference }) {
  let state = { status: installed ? 'idle' : 'unavailable', version, manualInstall, availableVersion: null, progress: 0, autoDownload: readPreference(), message: '' };
  let busy = false;
  let cancellationToken;
  const set = (patch) => { state = { ...state, ...patch }; publish({ ...state }); };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  // Releases distribute verified full installers, not differential blockmaps.
  updater.disableDifferentialDownload = true;
  updater.allowPrerelease = version.includes('-');
  updater.on('checking-for-update', () => set({ status: 'checking', message: '' }));
  updater.on('update-not-available', () => set({ status: 'current', message: '' }));
  updater.on('update-available', (info) => set({ status: 'available', availableVersion: info.version, progress: 0, message: '' }));
  updater.on('download-progress', (info) => set({ status: 'downloading', progress: Math.min(100, Math.max(0, info.percent)) }));
  updater.on('update-downloaded', () => set({ status: 'ready', progress: 100, message: '' }));
  updater.on('error', () => set({ status: 'error', message: 'The update could not complete. Please try again.' }));
  async function download() {
    set({ status: 'downloading', message: '' });
    await updater.downloadUpdate(cancellationToken);
  }
  return {
    snapshot: () => ({ ...state }),
    async command(action, value) {
      if (action === 'cancel' && state.status === 'downloading' && cancellationToken) {
        savePreference(false); set({ autoDownload: false, message: 'Stopping download...' });
        cancellationToken.cancel(); return { ...state };
      }
      if (action === 'preference') {
        if (typeof value !== 'boolean') throw new Error('Invalid update preference.');
        savePreference(value); set({ autoDownload: value }); return { ...state };
      }
      if (!installed || busy) return { ...state };
      busy = true;
      try {
        if (action === 'check' && !['ready', 'downloading', 'installing'].includes(state.status)) {
          const result = await updater.checkForUpdates();
          cancellationToken = result?.cancellationToken;
          if (state.status === 'available' && state.autoDownload) await download();
        } else if (action === 'download' && state.status === 'available') await download();
        else if (action === 'install' && state.status === 'ready') {
          // Restart only after drafts and paid work are safe to interrupt.
          const reason = canInstall();
          if (reason) set({ message: reason });
          else { if (!manualInstall) set({ status: 'installing', message: '' }); await install(); }
        }
      } catch {
        set(cancellationToken?.cancelled ? { status: 'idle', progress: 0, message: 'Download stopped. Automatic downloads are off.' } : { status: 'error', message: 'The update could not complete. Please try again.' });
      } finally { busy = false; }
      return { ...state };
    },
  };
}
module.exports = { createUpdates, updateInstallBlock };
