const electron = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const portfinder = require('portfinder');
const i18n = require('i18next');
const i18nBackend = require('i18next-node-fs-backend');
const os = require('os');
const fetch = require('node-fetch');
const remote = require('@electron/remote/main');
// eslint-disable-next-line import/no-unresolved
const aptabase = require('@aptabase/electron/main');
const Sentry = require('@sentry/electron/main');

require('dotenv').config();

remote.initialize();

const expressApp = express();
/* eslint-disable import/order */
const httpBase = require('http').Server(expressApp);
const http = require('http-shutdown')(httpBase);
const io = require('socket.io')(http);
/* eslint-enable */

const prodConfig = require('./config.prod.json');
const defaultPrefs = require('./www/configs/defaults.json');
const themes = require('./www/configs/themes.json');
const Analytics = require('./analytics');
const { styles } = require('./resetViewerStyles');

// Are we packaging for a platform's app store?
const appstore = false;
const maxChangeLogSeenCount = 5;

/* eslint-disable import/no-unresolved, import/extensions */
const Store = require('./www/js/store');
const {
  savedSettingsCamelCase,
} = require('./www/js/common/store/user-settings/get-saved-user-settings');
/* eslint-enable */

const savedSettings = savedSettingsCamelCase();

const platform = os.platform();
let isUnsupportedWindow = false;
if (platform === 'win32') {
  const version = /\d+\.\d/.exec(os.release())[0];
  if (version !== '6.3' && version !== '10.0') {
    isUnsupportedWindow = true;
  }
}

// Configuring the i18n
i18n.use(i18nBackend);
i18n.init({
  backend: {
    loadPath: path.join(__dirname, './www/locales/{{lng}}.json'),
    jsonIndent: 2,
  },
  fallbackLng: 'en',
});

expressApp.use(express.static(path.join(__dirname, 'www', 'obs')));
expressApp.use(express.json());

const {
  app,
  webContents,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  globalShortcut,
  systemPreferences,
  shell,
} = electron;

const store = new Store({
  configName: 'user-preferences',
  defaults: defaultPrefs,
});

const appVersion = app.getVersion();

const overlayCast = true;

// Reset to default theme if theme not found
const currentTheme = themes.find((theme) => theme.key === store.getUserPref('app.theme'));
if (currentTheme === undefined) {
  store.setUserPref('app.theme', themes[0].key);
}

let mainWindow;
let viewerWindow = false;
let projectionWindow = false;
let projectionCapturePending = false;
let startChangelogOpenTimer;
let endChangelogOpenTimer;

app.setAsDefaultProtocolClient('sttm-desktop');

// Initialize Aptabase with key from appropriate source
let aptabaseKey;
let sentryDsn;
if (process.env.NODE_ENV === 'development') {
  aptabaseKey = process.env.APTABASE_KEY;
  sentryDsn = process.env.SENTRY_DSN;
} else {
  try {
    aptabaseKey = prodConfig.APTABASE_KEY;
    sentryDsn = prodConfig.SENTRY_DSN;
  } catch (error) {
    console.error('Failed to load production config:', error);
  }
}

if (aptabaseKey) {
  aptabase.initialize(aptabaseKey);
}

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
  });
}

if (process.argv.length >= 2) {
  app.setAsDefaultProtocolClient('sttm-desktop', process.execPath, [path.resolve(process.argv[1])]);
}

const secondaryWindows = {
  changelogWindow: {
    obj: false,
    url: `file://${__dirname}/www/changelog.html`,
    onClose: () => {
      const count = store.get('changelog-seen-count');
      endChangelogOpenTimer = new Date().getTime();
      store.set('changelog-seen', appVersion);
      store.set('changelog-seen-count', count + 1);
      global.analytics.trackEvent({
        category: 'changelog',
        action: 'closed',
        label: 'changelog',
        value: (endChangelogOpenTimer - startChangelogOpenTimer) / 1000.0,
      });
    },
    show: () => {
      startChangelogOpenTimer = new Date().getTime();
    },
  },
  helpWindow: {
    obj: false,
    url: `file://${__dirname}/www/help.html`,
  },
  overlayWindow: {
    obj: false,
    url: `file://${__dirname}/www/overlay.html`,
  },
  shortcutLegend: {
    obj: false,
    url: `file://${__dirname}/www/legend.html`,
  },
};
let manualUpdate = false;
let lastLine;

function openSecondaryWindow(windowName) {
  const window = secondaryWindows[windowName];
  const openWindow = BrowserWindow.getAllWindows().filter((item) => item.getURL() === window.url);
  if (openWindow.length > 0) {
    openWindow[0].show();
  } else {
    window.obj = new BrowserWindow({
      width: 1366,
      height: 768,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        enableRemoteModule: true,
        contextIsolation: false,
        webviewTag: true,
        nodeIntegrationInSubFrames: true,
        nodeIntegrationInWorker: true,
        media: true,
      },
    });
    remote.enable(window.obj.webContents);
    window.obj.setMenu(null);
    window.obj.webContents.on('did-finish-load', () => {
      window.obj.show();
      window.obj.focus();
      if (window.show) {
        window.show();
      }
      if (window.focus) {
        window.focus();
      }
    });
    window.obj.loadURL(window.url);

    window.obj.on('close', () => {
      window.obj = false;
      if (window.onClose) {
        window.onClose();
      }
    });
  }
}

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

expressApp.post('/api/bani-control', (req, res) => {
  const data = req.body;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bani-controller-data', data);
  }

  res.json({ success: true });
});

// autoUpdater events
autoUpdater.on('checking-for-update', () => {
  if (!isUnsupportedWindow) {
    mainWindow.webContents.send('checking-for-update');
  }
});
autoUpdater.on('update-available', () => {
  if (!isUnsupportedWindow) {
    mainWindow.webContents.send('update-available');
  }
});
autoUpdater.on('update-not-available', () => {
  if (!isUnsupportedWindow) {
    mainWindow.webContents.send('update-not-available');
    if (manualUpdate) {
      dialog.showMessageBox({
        type: 'info',
        buttons: [i18n.t('OK')],
        defaultId: 0,
        title: i18n.t('NO_UPDATE_AVAILABLE'),
        message: i18n.t('NO_UPDATE_AVAILABLE'),
        detail: i18n.t('LATEST_VERSION', { appVersion }),
      });
    }
  }
});
autoUpdater.on('update-downloaded', () => {
  if (!isUnsupportedWindow) {
    mainWindow.webContents.send('update-downloaded');
    dialog
      .showMessageBox({
        type: 'info',
        buttons: [i18n.t('DISMISS'), i18n.t('INSTALL_N_RESTART')],
        defaultId: 1,
        title: i18n.t('UPDATE_AVAILABLE'),
        message: i18n.t('UPDATE_AVAILABLE'),
        detail: i18n.t('UPDATE_DOWNLOADED'),
        cancelId: 0,
      })
      .then(({ response }) => {
        if (response === 1 || response === '1') {
          autoUpdater.quitAndInstall();
        }
        global.analytics.trackEvent({
          category: 'menu',
          action: 'install-restart',
          label: 'from-update-dialog',
          value: response,
        });
      });
  }
});
autoUpdater.on('error', () => {
  if (!isUnsupportedWindow) {
    if (manualUpdate) {
      dialog.showMessageBox({
        type: 'error',
        buttons: [i18n.t('OK')],
        defaultId: 0,
        title: i18n.t('SOMETHING_WENT_WRONG_UPDATE_TITLE'),
        message: i18n.t('SOMETHING_WENT_WRONG_UPDATE_BODY'),
        detail: i18n.t('CURRENT_VERSION', { appVersion }),
      });
    }
  }
});

function checkForUpdates(manual = false) {
  if (process.env.NODE_ENV !== 'development') {
    if (manual) {
      manualUpdate = true;
    }
    if (!isUnsupportedWindow) {
      autoUpdater.checkForUpdatesAndNotify();
    }
  }
}

function saveToken(token) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encryption is not available on this system');
  }
  const userDataPath = app.getPath('userData');
  const encryptedToken = safeStorage.encryptString(token);
  const tokenPath = path.join(userDataPath, 'userToken.enc');
  fs.writeFileSync(tokenPath, encryptedToken);
}

function retrieveToken() {
  const userDataPath = app.getPath('userData');
  const tokenPath = path.join(userDataPath, 'userToken.enc');

  if (fs.existsSync(tokenPath)) {
    const encryptedToken = fs.readFileSync(tokenPath);
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Decryption is not available on this system');
    }
    return safeStorage.decryptString(encryptedToken);
  }

  return null;
}

function deleteToken() {
  const userDataPath = app.getPath('userData');
  const tokenPath = path.join(userDataPath, 'userToken.enc');
  fs.unlink(tokenPath, () => {
    // eslint-disable-next-line no-console
    console.log('token deleted');
  });
}

function getExternalDisplays() {
  const primaryDisplayId = electron.screen.getPrimaryDisplay().id;
  return electron.screen.getAllDisplays().filter((display) => display.id !== primaryDisplayId);
}

function sendToViewerWindows(channel, ...args) {
  if (viewerWindow && !viewerWindow.isDestroyed()) viewerWindow.webContents.send(channel, ...args);
}

function showChangelog() {
  const lastSeen = store.get('changelog-seen');
  const lastSeenCount = store.get('changelog-seen-count');
  const { limitChangeLog } = savedSettings;

  return lastSeen !== appVersion || (lastSeenCount < maxChangeLogSeenCount && !limitChangeLog);
}

async function captureShabadPane(targetWindow) {
  if (
    projectionCapturePending ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    projectionWindow !== targetWindow ||
    targetWindow.isDestroyed() ||
    !targetWindow.isVisible()
  ) {
    return;
  }

  projectionCapturePending = true;
  try {
    const paneBounds = await mainWindow.webContents.executeJavaScript(`(() => {
      const pane = document.querySelector(
        '.launchpad > .navigator-row:last-child > .shabad-pane, .launchpad .multipane-grid > .shabad1-container > .shabad-pane',
      );
      if (!pane) return null;
      const { x, y, width, height } = pane.getBoundingClientRect();
      return { x, y, width, height };
    })()`);
    if (!paneBounds || paneBounds.width < 2 || paneBounds.height < 2) return;

    const frame = await mainWindow.webContents.capturePage({
      x: Math.floor(paneBounds.x),
      y: Math.floor(paneBounds.y),
      width: Math.ceil(paneBounds.width),
      height: Math.ceil(paneBounds.height),
    });
    if (projectionWindow === targetWindow && !targetWindow.isDestroyed() && !frame.isEmpty()) {
      targetWindow.webContents.send('projection-frame', frame.toDataURL());
    }
  } catch (error) {
    log.warn(`[projection] Pane capture failed: ${error.message}`);
  } finally {
    projectionCapturePending = false;
  }
}

function createViewer(ipcData, display = getExternalDisplays()[0]) {
  if (viewerWindow && !viewerWindow.isDestroyed()) return;
  if (!display) return;

  const presenterWindow = new BrowserWindow({
    width: 800,
    height: 400,
    x: display.bounds.x + 50,
    y: display.bounds.y + 50,
    autoHideMenuBar: true,
    show: false,
    titleBarStyle: 'hidden',
    frame: false,
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: true,
      contextIsolation: false,
      webviewTag: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      media: true,
    },
  });
  viewerWindow = presenterWindow;
  presenterWindow.displayId = display.id;
  global.webview = presenterWindow.webContents;
  presenterWindow.loadURL(`file://${__dirname}/www/viewer.html`);
  remote.enable(presenterWindow.webContents);
  presenterWindow.webContents.on('did-finish-load', () => {
    presenterWindow.webContents.insertCSS(styles);
    presenterWindow.show();
    const [width, height] = presenterWindow.getSize();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('external-display', JSON.stringify({ width, height }));
      mainWindow.focus();
      if (showChangelog() && secondaryWindows.changelogWindow.obj) {
        secondaryWindows.changelogWindow.obj.focus();
      }
    }

    presenterWindow.setFullScreen(true);
    presenterWindow.webContents.send('wc-webview-enabled');
    presenterWindow.webContents.send('update-settings');

    if (ipcData) {
      presenterWindow.webContents.send(ipcData.send, ipcData.data);
    }
  });
  presenterWindow.on('enter-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
      if (showChangelog() && secondaryWindows.changelogWindow.obj) {
        secondaryWindows.changelogWindow.obj.focus();
      }
    }
  });
  presenterWindow.on('closed', () => {
    if (viewerWindow === presenterWindow) {
      viewerWindow = false;
      global.webview = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('remove-external-display');
      }
    }
  });
  presenterWindow.on('resize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const [width, height] = presenterWindow.getSize();
      mainWindow.webContents.send('external-display', JSON.stringify({ width, height }));
    }
  });
}

function createProjection(display) {
  if (!display || projectionWindow) return;

  const projectionHtml = `<!DOCTYPE html>
    <html><head><meta charset="utf-8"><style>
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #000; }
    img { width: 100%; height: 100%; object-fit: contain; }
    </style></head><body><img id="frame"><script>
    const { ipcRenderer } = require('electron');
    ipcRenderer.on('projection-frame', (_event, frame) => {
      document.getElementById('frame').src = frame;
    });
    </script></body></html>`;

  const quadrantWindow = new BrowserWindow({
    width: display.size.width,
    height: display.size.height,
    x: display.bounds.x,
    y: display.bounds.y,
    autoHideMenuBar: true,
    show: false,
    titleBarStyle: 'hidden',
    frame: false,
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  projectionWindow = quadrantWindow;
  quadrantWindow.displayId = display.id;
  let captureTimer;
  quadrantWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(projectionHtml)}`);
  quadrantWindow.webContents.on('did-finish-load', () => {
    quadrantWindow.show();
    quadrantWindow.setFullScreen(true);
    captureShabadPane(quadrantWindow);
    captureTimer = setInterval(() => captureShabadPane(quadrantWindow), 250);
  });
  quadrantWindow.on('closed', () => {
    clearInterval(captureTimer);
    if (projectionWindow === quadrantWindow) {
      projectionCapturePending = false;
      projectionWindow = false;
    }
  });
}

function syncViewerWindows() {
  const displays = getExternalDisplays();
  const presenterDisplay = displays[0];
  const projectionDisplay = displays[1] || null;

  if (
    presenterDisplay &&
    viewerWindow &&
    !viewerWindow.isDestroyed() &&
    viewerWindow.displayId !== presenterDisplay.id
  ) {
    const previousPresenterWindow = viewerWindow;
    viewerWindow = false;
    global.webview = null;
    previousPresenterWindow.close();
  }
  if (presenterDisplay && (!viewerWindow || viewerWindow.isDestroyed())) {
    createViewer(undefined, presenterDisplay);
  }
  if (!presenterDisplay && viewerWindow && !viewerWindow.isDestroyed()) {
    const previousPresenterWindow = viewerWindow;
    viewerWindow = false;
    global.webview = null;
    previousPresenterWindow.close();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('remove-external-display');
    }
  }
  if (
    projectionDisplay &&
    projectionWindow &&
    !projectionWindow.isDestroyed() &&
    projectionWindow.displayId !== projectionDisplay.id
  ) {
    const previousProjectionWindow = projectionWindow;
    projectionWindow = false;
    previousProjectionWindow.close();
  }
  if (projectionDisplay && (!projectionWindow || projectionWindow.isDestroyed())) {
    createProjection(projectionDisplay);
  }
  if (!projectionDisplay && projectionWindow && !projectionWindow.isDestroyed()) {
    const previousProjectionWindow = projectionWindow;
    projectionWindow = false;
    previousProjectionWindow.close();
  }
}

function writeFileCallback(err) {
  if (err) {
    throw err;
  }
}

function createBroadcastFiles(arg) {
  const liveFeedLocation = store.get('userPrefs.app.live-feed-location');
  const userDataPath =
    liveFeedLocation === 'default' || !liveFeedLocation
      ? electron.app.getPath('desktop')
      : liveFeedLocation;
  const gurbaniFile = `${userDataPath}/sttm-Gurbani.txt`;
  const englishFile = `${userDataPath}/sttm-English.txt`;

  try {
    if (arg.Line.Gurmukhi) {
      fs.writeFile(gurbaniFile, arg.Line.Gurmukhi.trim(), writeFileCallback);
      fs.appendFile(gurbaniFile, '\n', writeFileCallback);
      fs.writeFile(englishFile, arg.Line.English.trim(), writeFileCallback);
      fs.appendFile(englishFile, '\n', writeFileCallback);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(err);
  }
}

let seq = Math.floor(Math.random() * 100);

const showLine = async (line, socket = io) => {
  const lineWithSettings = line;
  lineWithSettings.languageSettings = {
    translation: savedSettings.translationLanguage,
    transliteration: savedSettings.transliterationLanguage,
  };

  const payload = lineWithSettings;
  if (Object.keys(line).length) {
    socket.emit('show-line', payload);
  }
  const zoomToken = store.get('userPrefs.app.zoomToken');
  if (zoomToken && line.Line.Unicode) {
    try {
      await fetch(`${zoomToken}&seq=${seq}`, {
        method: 'POST',
        body: `${line.Line.Unicode}\n`,
      });
      seq += 1;
    } catch (e) {
      // TODO: zoom recommends retrying 4XX responses.
      log(e);
    }
  }
};

const updateOverlayVars = (overlayPrefs) => {
  if (overlayPrefs) {
    io.emit('update-prefs', overlayPrefs);
  } else {
    mainWindow.webContents.send('get-overlay-prefs');
  }
};

const emptyOverlay = () => {
  const emptyLine = {
    Line: {
      Gurmukhi: '',
      English: '',
      Punjabi: '',
      Transliteration: '',
    },
  };
  showLine(emptyLine);
  if (savedSettings.liveFeed) {
    createBroadcastFiles(emptyLine);
  }
};

const singleInstanceLock = app.requestSingleInstanceLock();

const searchPorts = () => {
  portfinder.getPort(
    {
      // Re: http://www.sikhiwiki.org/index.php/Gurgadi
      ports: [1397, 1469, 1539, 1552, 1574, 1581, 1606, 1644, 1661, 1665, 1675, 1708],
      count: 1,
    },
    (err, port) => {
      if (err) {
        dialog.showErrorBox(i18n.t('OVERLAY_ERR'), i18n.t('NO_PORTS_AVAILABLE'));
        app.exit(-1);
        return;
      }
      global.overlayPort = port;
      // console.log(`Overlay Port No ${port}`);
      http.listen(port);
    },
  );
};

ipcMain.on('toggle-obs-cast', (event, arg) => {
  if (arg) {
    searchPorts();
  } else {
    http.shutdown();
  }
});

if (overlayCast) {
  searchPorts();
}

const handleDeeplink = async (url) => {
  const urlObject = url.replace('sttm-desktop://', '').split('?');
  if (urlObject[0].includes('login')) {
    const loginData = new URLSearchParams(`?${urlObject[1]}`);
    const token = loginData.get('token');
    if (token) {
      try {
        saveToken(token);
        mainWindow.webContents.send('userToken', token);
      } catch {
        // eslint-disable-next-line no-console
        console.error('Error saving token');
      }
    }
  }
};

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
    const deepLinkUrl = commandLine.find((arg) => arg.startsWith('sttm-desktop://'));
    if (deepLinkUrl) {
      handleDeeplink(deepLinkUrl);
    }
  });
}

app.on('open-url', (event, url) => {
  handleDeeplink(url);
});

app.on('ready', () => {
  // Retrieve the userid value, and if it's not there, assign it a new uuid.
  let userId = store.get('userId');

  // Reset the global state
  store.set('GlobalState', null);
  store.set('userPrefs.app.zoomToken', '');

  store.setUserPref('toolbar.language-settings', null);
  if (!userId) {
    userId = uuidv4();
    store.set('userId', userId);
  }
  const analytics = new Analytics();
  global.analytics = analytics;

  const screens = electron.screen;
  const { width, height } = screens.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    minWidth: 800,
    minHeight: 600,
    width,
    height,
    frame: process.platform === 'linux', // show frame only on linux
    show: false,
    backgroundColor: '#000000',
    titleBarStyle: 'hidden',
    webPreferences: {
      nodeIntegration: true,
      enableRemoteModule: true,
      contextIsolation: false,
      webviewTag: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      media: true,
    },
  });
  const splash = new BrowserWindow({
    width: 600,
    height: 400,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
  });
  splash.loadURL(`file://${__dirname}/www/splash.html`);
  splash.center();
  remote.enable(mainWindow.webContents);

  // Set up session permission handler for microphone access (required for Windows)
  const { session } = electron;
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') {
      // Allow microphone access
      callback(true);
    } else {
      // Deny other permissions by default
      callback(false);
    }
  });

  mainWindow.webContents.on('dom-ready', () => {
    const externalDisplays = getExternalDisplays();
    const externalDisplay = externalDisplays[0];
    if (externalDisplay) {
      mainWindow.webContents.send(
        'external-display',
        JSON.stringify({
          width: externalDisplay.size.width,
          height: externalDisplay.size.height,
        }),
      );
    }
    splash.close();
    mainWindow.show();
    const token = retrieveToken();
    if (token) {
      mainWindow.webContents.send('userToken', token);
    }
    // Platform-specific app stores have their own update mechanism
    // so only check if we're not in one
    if (!appstore && !isUnsupportedWindow) {
      checkForUpdates();
    }
    // Show changelog if last version wasn't seen
    const lastSeen = store.get('changelog-seen');

    if (showChangelog()) {
      openSecondaryWindow('changelogWindow');
      if (lastSeen !== appVersion) {
        store.set('changelog-seen-count', 1);
      }
    }
    syncViewerWindows();
  });
  mainWindow.loadURL(`file://${__dirname}/www/index.html`);

  if (!store.get('user-agent')) {
    store.set('user-agent', mainWindow.webContents.getUserAgent());
  }

  // Close all other windows if closing the main
  mainWindow.on('close', () => {
    emptyOverlay();
    if (viewerWindow && !viewerWindow.isDestroyed()) viewerWindow.close();
    if (projectionWindow && !projectionWindow.isDestroyed()) projectionWindow.close();
    viewerWindow = false;
    projectionWindow = false;
    global.webview = null;
    const changelogWindow = secondaryWindows.changelogWindow.obj;
    if (changelogWindow && !changelogWindow.isDestroyed()) {
      changelogWindow.close();
    }
  });

  screens.on('display-added', () => syncViewerWindows());
  screens.on('display-removed', () => syncViewerWindows());
  screens.on('display-metrics-changed', () => syncViewerWindows());

  globalShortcut.register('CommandOrControl+Shift+I', () => {
    if (mainWindow) {
      mainWindow.webContents.openDevTools();
    }
  });
});

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  // if (process.platform !== 'darwin') {
  app.quit();
  // }
});

ipcMain.handle('send-to-bani-controller', async (event, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bani-controller-data', data);
  }
  return { success: true };
});

ipcMain.on('enable-wc-webview', (event, data) => {
  const webViewWC = webContents.fromId(parseInt(data, 10));
  remote.enable(webViewWC);
  webViewWC.send('wc-webview-enabled');
  sendToViewerWindows('wc-webview-enabled');
});

ipcMain.on('cast-session-active', () => {
  mainWindow.webContents.send('cast-session-active');
});

ipcMain.on('cast-session-stopped', () => {
  mainWindow.webContents.send('cast-session-stopped');
});

ipcMain.on('cast-to-receiver', (event) => {
  event.reply('cast-verse', 'update verse');
});

ipcMain.on('checkForUpdates', checkForUpdates);
ipcMain.on('quitAndInstall', () => autoUpdater.quitAndInstall());

ipcMain.on('clear-apv', () => {
  sendToViewerWindows('clear-apv');
});

ipcMain.on('save-overlay-settings', (event, overlayPrefs) => {
  updateOverlayVars(JSON.parse(overlayPrefs));
});

ipcMain.on('deleteToken', () => {
  deleteToken();
});

io.on('connection', (socket) => {
  updateOverlayVars();
  if (lastLine) {
    showLine(lastLine, socket);
  }
});

ipcMain.on('show-line', (event, arg) => {
  const linePayload = JSON.parse(arg);
  lastLine = linePayload;
  showLine(linePayload);
  if (viewerWindow && !viewerWindow.isDestroyed()) {
    viewerWindow.webContents.send('show-line', linePayload);
  } else {
    createViewer({ send: 'show-line', data: linePayload });
  }
  syncViewerWindows();
  if (linePayload.live) {
    createBroadcastFiles(linePayload);
  }
});

ipcMain.on('show-misc-text', (event, arg) => {
  io.emit('show-misc-text', arg);
});

ipcMain.on('show-empty-slide', () => {
  emptyOverlay();
});

ipcMain.on('show-text', (event, arg) => {
  const { isGurmukhi, text, unicode } = JSON.parse(arg);
  const textLine = {
    Line: {
      Gurmukhi: isGurmukhi ? text : '',
      English: !isGurmukhi ? text : '',
      Unicode: unicode,
      Punjabi: '',
      Transliteration: {
        devanagari: '',
        English: '',
      },
      Translation: {
        Spanish: '',
        English: '',
        Hindi: '',
      },
    },
  };

  const emptyLine = {
    Line: {
      Gurmukhi: '',
      English: '',
      Punjabi: '',
      Transliteration: {
        devanagari: '',
        English: '',
      },
      Translation: {
        Spanish: '',
        English: '',
        Hindi: '',
      },
    },
  };

  const announcementOverlay = store.getUserPref('app.announcement-overlay');
  if (arg.isAnnouncement && !announcementOverlay) {
    showLine(emptyLine);
  } else {
    showLine(textLine);
  }

  if (viewerWindow && !viewerWindow.isDestroyed()) {
    viewerWindow.webContents.send('show-text', arg);
  } else {
    createViewer({ send: 'show-text', data: arg });
  }
  if (arg.live) {
    createBroadcastFiles(arg);
  }
});

ipcMain.on('toggle-viewer-window', (event, arg) => {
  if (viewerWindow && !viewerWindow.isDestroyed()) {
    if (arg) {
      viewerWindow.show();
    } else {
      viewerWindow.hide();
    }
  }
});

ipcMain.on('presenter-view', (event, arg) => {
  if (!viewerWindow || viewerWindow.isDestroyed()) return;
  if (!arg) {
    viewerWindow.hide();
  } else {
    viewerWindow.show();
    viewerWindow.setFullScreen(true);
  }
});

ipcMain.on('scroll-from-main', (event, arg) => {
  sendToViewerWindows('send-scroll', arg);
});

ipcMain.on('next-ang', (event, arg) => {
  sendToViewerWindows('show-ang', arg);
  mainWindow.webContents.send('next-ang', arg);
});

ipcMain.on('scroll-pos', (event, arg) => {
  mainWindow.webContents.send('send-scroll', arg);
});

ipcMain.on('update-settings', () => {
  sendToViewerWindows('update-settings');
  mainWindow.webContents.send('sync-settings');
});

ipcMain.on('save-settings', (event, setting) => {
  sendToViewerWindows('save-settings', setting);
});

ipcMain.on('update-viewer-setting', (event, setting) => {
  sendToViewerWindows('update-viewer-setting', setting);
});

ipcMain.on('update-global-setting', (event, setting) => {
  mainWindow.webContents.send('update-global-setting', setting);
});

ipcMain.on('set-user-setting', (event, settingChanger) => {
  mainWindow.webContents.send('set-user-setting', settingChanger);
});

ipcMain.on('get-media-access-status', async (event, mediaType) => {
  try {
    // macOS-specific API
    if (platform === 'darwin' && systemPreferences.askForMediaAccess) {
      const isGranted = await systemPreferences.askForMediaAccess(mediaType);
      if (!isGranted) {
        if (mediaType === 'microphone') {
          shell.openExternal(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
          );
        }
      }
      event.reply('media-access-status', isGranted ? 'granted' : 'denied');
    } else {
      event.reply('media-access-status', 'granted');
    }
  } catch (error) {
    console.error('Error checking media access status:', error);
    event.reply('media-access-status', 'granted');
  }
});

module.exports = {
  openSecondaryWindow,
  appVersion,
  checkForUpdates,
  autoUpdater,
  store,
  themes,
  appstore,
  i18n,
  isUnsupportedWindow,
};
