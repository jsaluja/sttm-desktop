import React, { useEffect, useState } from 'react';
import { StoreProvider, useStoreState } from 'easy-peasy';
import { ipcRenderer } from 'electron';

import ShabadDeck from './ShabadDeck/ShabadDeck';
import ViewerState from './store/ViewerState';
import ShabadPane from '../navigator/shabad/ShabadPane';
import { castToReceiver, appendMessage, requestSession, stopApp, tingle } from './utils';

const chromecast = require('electron-chromecast');
const remote = require('@electron/remote');

const { i18n } = remote.require('./app');
const isPaneProjection = new URLSearchParams(window.location.search).has('paneProjection');

const PaneProjection = () => {
  const projectionReady = useStoreState((state) => state.projection.ready);
  const paneWidth = useStoreState((state) => state.projection.width);
  const paneHeight = useStoreState((state) => state.projection.height);
  const { currentWorkspace, theme } = useStoreState((state) => state.userSettings);
  const [screenSize, setScreenSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  useEffect(() => {
    ipcRenderer.send('projection-render-state', {
      ready: projectionReady,
      paneWidth,
      paneHeight,
      currentWorkspace,
      location: window.location.href,
    });
  }, [currentWorkspace, paneHeight, paneWidth, projectionReady]);

  useEffect(() => {
    const updateScreenSize = () => {
      setScreenSize({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', updateScreenSize);
    return () => window.removeEventListener('resize', updateScreenSize);
  }, []);

  useEffect(() => {
    if (projectionReady) return undefined;
    const requestProjectionState = () => ipcRenderer.send('projection-state-request');
    requestProjectionState();
    const retryTimer = setTimeout(() => {
      if (!ViewerState.getState().projection.ready) requestProjectionState();
    }, 750);
    return () => clearTimeout(retryTimer);
  }, [projectionReady]);

  if (!projectionReady || !paneWidth || !paneHeight) {
    return <div className={`pane-projection-screen theme-${theme}`} />;
  }

  const scale = Math.min(screenSize.width / paneWidth, screenSize.height / paneHeight);
  const multiPaneId = currentWorkspace === i18n.t('WORKSPACES.MULTI_PANE') ? 1 : false;
  return (
    <div className={`pane-projection-screen theme-${theme}`}>
      <div
        className="pane-projection-stage"
        style={{
          width: paneWidth,
          height: paneHeight,
          transform: `scale(${scale})`,
        }}
      >
        <ShabadPane
          className=""
          multiPaneId={multiPaneId}
          isProjection
          style={{ width: '100%', height: '100%', maxHeight: 'none', flex: 'none' }}
        />
      </div>
    </div>
  );
};

const ViewerContent = () => (isPaneProjection ? <PaneProjection /> : <ShabadDeck />);

const ViewerApp = () => {
  if (!isPaneProjection) {
    chromecast(
      (receivers) =>
        new Promise((resolve) => {
          const modal = new tingle.Modal({
            footer: true,
            stickyFooter: false,
            closeMethods: ['overlay', 'button', 'escape'],
          });

          receivers.forEach((receiver) => {
            const fullName = receiver.service_fullname;
            const blacklist = ['Chromecast-Audio', 'Google-Home', 'Sound-Bar', 'Google-Cast-Group'];
            if (receiver.friendlyName && !new RegExp(blacklist.join('|')).test(fullName)) {
              modal.addCastBtn(
                receiver.friendlyName,
                'tingle-btn tingle-btn--primary',
                `${receiver.ipAddress}_${receiver.port}`,
                (e) => {
                  if (
                    e.target.getAttribute('data-reciever-id') ===
                    `${receiver.ipAddress}_${receiver.port}`
                  ) {
                    resolve(receiver);
                  }
                  modal.close();
                },
              );
            }
          });
          // set content
          const message =
            receivers.length === 0
              ? i18n.t(`CHROMECAST.NO_DEVICES_FOUND`)
              : i18n.t('CHROMECAST.SELECT_DEVICE');
          modal.setContent(`<h2 class='tingle-heading'>${message}</h2>`);
          // add cancel button
          const cancelTitle = receivers.length === 0 ? 'OK' : i18n.t('CHROMECAST.CANCEL');
          modal.addFooterBtn(
            cancelTitle,
            'tingle-btn tingle-btn--pull-right tingle-btn--default',
            () => {
              modal.close();
            },
          );
          modal.open();
        }),
    );

    ipcRenderer.on('search-cast', (event, pos) => {
      requestSession();
      appendMessage(event);
      appendMessage(pos);
    });

    ipcRenderer.on('stop-cast', () => {
      stopApp();
    });

    ipcRenderer.on('cast-verse', () => {
      castToReceiver();
    });
  }
  return (
    <StoreProvider store={ViewerState}>
      <ViewerContent />
    </StoreProvider>
  );
};

export default ViewerApp;
