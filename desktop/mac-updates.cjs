const { EventEmitter } = require('node:events');
const { constants, createReadStream } = require('node:fs');
const { lstat, mkdir, open, rename, unlink } = require('node:fs/promises');
const { join } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

async function cachedInstallerMatches(path, file, signal) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size !== file.size) return false;
    const hash = createHash('sha512');
    let bytes = 0;
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    for await (const chunk of createReadStream(path, { flags, end: file.size, signal })) {
      bytes += chunk.length;
      hash.update(chunk);
    }
    return bytes === file.size && hash.digest('base64') === file.sha512;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Unsigned Mac builds can download a verified disk image, but cannot use signed-app replacement. */
class MacUpdates extends EventEmitter {
  constructor(updater, directory, architecture, fetcher = fetch) {
    super();
    this.updater = updater;
    this.directory = directory;
    this.architecture = architecture;
    this.fetcher = fetcher;
    this.info = null;
    this.installer = null;
    for (const event of ['checking-for-update', 'update-not-available', 'error']) updater.on(event, (...args) => this.emit(event, ...args));
    updater.on('update-available', info => { this.info = info; this.emit('update-available', info); });
  }
  set autoDownload(value) { this.updater.autoDownload = value; }
  set autoInstallOnAppQuit(value) { this.updater.autoInstallOnAppQuit = value; }
  set allowDowngrade(value) { this.updater.allowDowngrade = value; }
  set allowPrerelease(value) { this.updater.allowPrerelease = value; }
  checkForUpdates() { return this.updater.checkForUpdates(); }
  async downloadUpdate(cancellationToken) {
    const info = this.info;
    if (!info || !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(info.version) || !['arm64', 'x64'].includes(this.architecture)) throw new Error('Invalid release identity.');
    const name = `OpenGEO-${info.version}-macos-${this.architecture}.dmg`;
    const file = info.files?.find(file => file.url === name);
    if (!file || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 2 * 1024 ** 3 || typeof file.sha512 !== 'string' || Buffer.from(file.sha512, 'base64').length !== 64) throw new Error('Invalid installer metadata.');
    const destination = join(this.directory, name);
    let handle, temporary;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    cancellationToken?.onCancel(cancel);
    try {
      // Recheck downloaded bytes against the current release before letting a new app session reuse them.
      if (await cachedInstallerMatches(destination, file, abort.signal)) {
        abort.signal.throwIfAborted();
        this.installer = destination;
        this.emit('update-downloaded');
        return;
      }
      abort.signal.throwIfAborted();
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const response = await this.fetcher(`https://github.com/surfacedby/OpenGEO/releases/download/v${info.version}/${name}`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30 * 60 * 1000)]) });
      if (!response.ok || !response.body) throw new Error('Installer download failed.');
      const partial = join(this.directory, randomUUID() + '.part');
      handle = await open(partial, 'wx', 0o600);
      temporary = partial;
      const hash = createHash('sha512');
      let bytes = 0, lastProgress = 0;
      for await (const chunk of response.body) {
        abort.signal.throwIfAborted();
        bytes += chunk.length;
        if (bytes > file.size) throw new Error('Installer size mismatch.');
        hash.update(chunk);
        await handle.writeFile(chunk);
        if (Date.now() - lastProgress > 250) { lastProgress = Date.now(); this.emit('download-progress', { percent: bytes / file.size * 100 }); }
      }
      if (bytes !== file.size || hash.digest('base64') !== file.sha512) throw new Error('Installer checksum mismatch.');
      await handle.close(); handle = null;
      abort.signal.throwIfAborted();
      await rename(temporary, destination);
      temporary = undefined;
      this.installer = destination;
      this.emit('update-downloaded');
    } finally {
      cancellationToken?.removeListener('cancel', cancel);
      await handle?.close();
      if (temporary) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
module.exports = { MacUpdates };
