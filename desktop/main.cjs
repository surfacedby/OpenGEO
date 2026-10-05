const {
  app,
  BrowserWindow,
  safeStorage,
  shell,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
} = require("electron");
const path = require("node:path");
const identity = require("../assets/identity.json");
let runtime,
  window,
  tray,
  quitting = false,
  draftProtectionPending = false;
ipcMain.on('opengeo:draft-pending', (event, value) => {
  if (event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && typeof value === 'boolean') draftProtectionPending = value;
});
app.setName(identity.name);
app.setPath("userData", path.join(app.getPath("appData"), identity.storageName));
if(process.env.OPENGEO_DESKTOP_DATA_DIR)app.setPath('userData',path.resolve(process.env.OPENGEO_DESKTOP_DATA_DIR));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app.whenReady().then(async () => {
    try {
      if (
        !safeStorage.isEncryptionAvailable() ||
        safeStorage.getSelectedStorageBackend?.() === "basic_text"
      )
        throw new Error(
          "A protected operating-system credential store is required.",
        );
      if(app.isPackaged)process.env.PLAYWRIGHT_BROWSERS_PATH=path.join(process.resourcesPath,'browsers');
      const { start } = await import("../dist-server/main.js");
      runtime = await start({
        directory: app.getPath("userData"),
        port: 0,
        staticRoot:path.join(app.getAppPath(),'dist'),
        onConnected: () => { window?.show(); window?.focus(); },
        protector: {
          encrypt: (text) => safeStorage.encryptString(text),
          decrypt: (bytes) => safeStorage.decryptString(bytes),
        },
      });
      const address = runtime.app.server.address();
      const origin = "http://127.0.0.1:" + address.port;
      window = new BrowserWindow({
        width: 1320,
        height: 860,
        minWidth: 760,
        minHeight: 600,
        title: identity.name,
        backgroundColor: "#f5f7fa",
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          preload: path.join(__dirname, 'preload.cjs'),
        },
      });
        window.webContents.setWindowOpenHandler(({ url }) => {
          const parsed = new URL(url);
          if(parsed.origin===origin)return {action:'allow',overrideBrowserWindowOptions:{webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}}};
        if (
          ["https:", "http:"].includes(parsed.protocol) &&
          (!parsed.hostname.startsWith("127.") || parsed.origin === origin)
        )
          void shell.openExternal(url);
        return { action: "deny" };
      });
      window.webContents.on("will-navigate", (event, url) => {
        if (new URL(url).origin !== origin) event.preventDefault();
      });
      window.webContents.session.setPermissionRequestHandler(
        (_, __, callback) => callback(false),
      );
      window.on("close", (event) => {
        if (!quitting) {
          event.preventDefault();
          window.hide();
        }
      });
      await window.loadURL(origin);
      const icon = path.join(app.getAppPath(), "assets/app-icon.png");
      tray = new Tray(nativeImage.createFromPath(icon));
      tray.setToolTip(identity.name);
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Open " + identity.name, click: () => window.show() },
          {
            label: "Start at login",
            type: "checkbox",
            checked: app.getLoginItemSettings().openAtLogin,
            click: (item) =>
              app.setLoginItemSettings({ openAtLogin: item.checked }),
          },
          {
            label: "Quit",
            click: () => {
              quitting = true;
              app.quit();
            },
          },
        ]),
      );
      tray.on("click", () => window.show());
    } catch (error) {
      console.error(identity.name + ' startup failed: '+error.message);
      require("electron").dialog.showErrorBox(
        identity.name + " could not start",
        error.message,
      );
      quitting = true;
      app.quit();
    }
  });
  let closed=false;
  app.on("before-quit", (event) => {
    if (draftProtectionPending && window && !window.isDestroyed()) {
      event.preventDefault(); quitting = false;
      window.show(); window.focus(); window.webContents.send('opengeo:quit-deferred');
      return;
    }
    quitting = true;
    if(runtime&&!closed){event.preventDefault();void runtime.app.close().finally(()=>{closed=true;app.quit()});}
  });
  app.on("window-all-closed", () => {});
}
