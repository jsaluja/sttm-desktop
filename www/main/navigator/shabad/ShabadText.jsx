import React, { useState, useEffect, useRef } from 'react';
import { useStoreActions, useStoreState } from 'easy-peasy';
import { Virtuoso } from 'react-virtuoso';
import { ipcRenderer } from 'electron';
import PropTypes from 'prop-types';

import { loadShabad, loadBani, loadCeremony } from '../utils';
import { ShabadVerse } from '../../common/sttm-ui';
import {
  changeHomeVerse,
  changeVerse,
  filterRequiredVerseItems,
  filterOverlayVerseItems,
  udpateHistory,
  scrollToVerse,
  saveToHistory,
  copyToClipboard,
  intelligentNextVerse,
  sendToBaniController,
  FLOWER_VERSE_ID,
} from './utils';

const baniLengthCols = {
  short: 'existsSGPC',
  medium: 'existsMedium',
  long: 'existsTaksal',
  extralong: 'existsBuddhaDal',
};

export const ShabadText = ({
  shabadId,
  baniType,
  paneAttributes,
  setPaneAttributes,
  currentPane,
  isProjection = false,
  projectionSource = false,
}) => {
  const [previousVerseIndex, setPreviousIndex] = useState();
  const [filteredItems, setFilteredItems] = useState([]);
  const [activeVerse, setActiveVerse] = useState({});
  const [rawVerses, setRawVerses] = useState([]);
  const [atHome, setHome] = useState(true);

  const virtuosoRef = useRef(null);
  const activeVerseRef = useRef(null);
  const listScrollRef = useRef(null);

  const {
    activeVerseId,
    isMiscSlide,
    isSundarGutkaBani,
    sundarGutkaBaniId,
    isCeremonyBani,
    ceremonyId,
    activeShabadId,
    verseHistory,
    initialVerseId,
    activePaneId,
    shortcuts,
    lineNumber,
  } = useStoreState((state) => state.navigator);

  const { baniLength, liveFeed, autoplayDelay, autoplayToggle, intelligentSpacebar, akhandpatt } =
    useStoreState((state) => state.userSettings);

  const {
    setActiveVerseId,
    setIsMiscSlide,
    setActiveShabadId,
    setVerseHistory,
    setActivePaneId,
    setShortcuts,
    setSundarGutkaBaniId,
    setCeremonyId,
    setIsCeremonyBani,
    setIsSundarGutkaBani,
    savedCrossPlatformId,
  } = useStoreActions((actions) => actions.navigator);

  const updateTraversedVerse = (newTraversedVerse, verseIndex, crossPlatformId = null) => {
    if (isMiscSlide) {
      setIsMiscSlide(false);
    }
    // Ignoring flower verse to avoid unwanted scroll during asa di vaar
    if (newTraversedVerse === FLOWER_VERSE_ID) {
      return;
    }
    if (activePaneId !== currentPane) {
      setActivePaneId(currentPane);
    }
    changeVerse(newTraversedVerse, verseIndex, shabadId, {
      activeVerseId,
      setActiveVerseId,
      setActiveVerse,
      activeShabadId,
      setActiveShabadId,
      setPreviousIndex,
      baniType,
      sundarGutkaBaniId,
      setSundarGutkaBaniId,
      ceremonyId,
      setCeremonyId,
      isSundarGutkaBani,
      setIsSundarGutkaBani,
      isCeremonyBani,
      setIsCeremonyBani,
    });
    udpateHistory(shabadId, newTraversedVerse, {
      verseHistory,
      setVerseHistory,
      setPaneAttributes,
      paneAttributes,
    });
    sendToBaniController(crossPlatformId, filteredItems, newTraversedVerse, baniLength, {
      isSundarGutkaBani,
      sundarGutkaBaniId,
      isCeremonyBani,
      ceremonyId,
      activeShabadId,
      paneAttributes,
    });
  };

  const updateHomeVerse = (verseIndex) => {
    changeHomeVerse(verseIndex, { paneAttributes, setPaneAttributes });
  };

  const setVerseList = (verseList) => {
    if (verseList.length) {
      setRawVerses(verseList);
      saveToHistory(
        shabadId,
        verseList,
        baniType,
        { verseHistory, setVerseHistory, baniLength },
        initialVerseId,
      );
      const filtered = filterRequiredVerseItems(verseList);
      setFilteredItems(filtered);
      const resumeVerseId = paneAttributes?.activeVerse || filtered[0].verseId;
      if (filtered.length > 0) {
        const resumeVerseIndex = filtered.findIndex((v) => v.verseId === resumeVerseId);
        if (resumeVerseIndex >= 0) {
          updateTraversedVerse(resumeVerseId, resumeVerseIndex);
        } else {
          updateTraversedVerse(filtered[0].verseId, 0);
        }
      }
    }
  };

  useEffect(() => {
    if (baniType === 'shabad') {
      loadShabad(shabadId).then(setVerseList);
    } else if (baniType === 'bani') {
      loadBani(shabadId, baniLengthCols[baniLength]).then(setVerseList);
    } else if (baniType === 'ceremony') {
      loadCeremony(shabadId).then(setVerseList);
    }
  }, [shabadId, baniType, baniLength]);

  useEffect(() => {
    if (filteredItems.length) {
      if (isProjection) {
        const liveActiveId = activeVerseId || paneAttributes?.activeVerse;
        const projectedActiveIndex = filteredItems.findIndex(
          (verse) => verse.verseId === liveActiveId,
        );
        if (projectedActiveIndex >= 0) {
          setActiveVerse({ [projectedActiveIndex]: liveActiveId });
        }
        return;
      }
      setTimeout(() => {
        scrollToVerse(initialVerseId, filteredItems, virtuosoRef);
      }, 100);
      const initialVerseIndex = filteredItems.findIndex(
        (verse) => verse.verseId === initialVerseId,
      );
      const activeVerseIndex = filteredItems.findIndex((verse) => verse.verseId === activeVerseId);
      if (initialVerseIndex >= 0) {
        updateHomeVerse(initialVerseIndex);
        setActiveVerse({ [activeVerseIndex]: activeVerseId });
      }
      if (
        (activeShabadId === null && sundarGutkaBaniId === null && ceremonyId === null) ||
        (initialVerseIndex >= 0 && Object.keys(activeVerse).length === 0)
      ) {
        updateTraversedVerse(initialVerseId, initialVerseIndex);
      }
    }
  }, [filteredItems, isProjection, paneAttributes?.activeVerse, activeVerseId]);

  useEffect(() => {
    if (isProjection) return;
    const baniVerseIndex = filteredItems.findIndex(
      (obj) => obj.crossPlatformId === savedCrossPlatformId,
    );
    if (baniVerseIndex >= 0) {
      updateTraversedVerse(filteredItems[baniVerseIndex].ID, baniVerseIndex);
    }
  }, [isProjection, savedCrossPlatformId]);

  useEffect(() => {
    const overlayVerse = filterOverlayVerseItems(rawVerses, activeVerseId);
    if (!isProjection) {
      ipcRenderer.send(
        'show-line',
        JSON.stringify({
          Line: overlayVerse,
          live: liveFeed,
          activeVerseId,
          baniType,
          shabadId,
          currentPane,
        }),
      );
    }
    if (
      !isProjection &&
      ((isCeremonyBani && ceremonyId === paneAttributes.activeShabad) ||
        (isSundarGutkaBani && sundarGutkaBaniId === paneAttributes.activeShabad) ||
        (!isSundarGutkaBani && !isCeremonyBani && activeShabadId === paneAttributes.activeShabad))
    ) {
      if (lineNumber !== null && filteredItems[lineNumber - 1]?.verseId === activeVerseId) {
        setActiveVerse({ [lineNumber - 1]: activeVerseId });
        scrollToVerse(activeVerseId, filteredItems, virtuosoRef);
      }
    }
  }, [rawVerses, activeShabadId, activeVerseId, sundarGutkaBaniId, ceremonyId, isProjection]);

  // Display 2: full DOM list (no Virtuoso windowing). Scroll active row into view.
  // Virtuoso only mounts viewport rows — with scaled stage height, bottom rows never
  // enter the item-list and cannot scroll into view. Full list fixes that.
  useEffect(() => {
    if (!isProjection || !filteredItems.length) return undefined;
    const liveActiveId = activeVerseId || paneAttributes?.activeVerse;
    if (liveActiveId == null) return undefined;
    const activeVerseIndex = filteredItems.findIndex((verse) => verse.verseId === liveActiveId);
    if (activeVerseIndex < 0) return undefined;
    setActiveVerse({ [activeVerseIndex]: liveActiveId });

    const apply = () => {
      const el = activeVerseRef.current;
      const scroller = listScrollRef.current;
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
        return;
      }
      if (scroller && el) {
        const rowTop = el.offsetTop;
        const rowHeight = el.offsetHeight || 0;
        const viewHeight = scroller.clientHeight || 0;
        scroller.scrollTop = Math.max(0, rowTop - (viewHeight - rowHeight) / 2);
      }
    };

    const t1 = setTimeout(apply, 0);
    const t2 = setTimeout(apply, 50);
    const t3 = setTimeout(apply, 150);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [isProjection, filteredItems, activeVerseId, paneAttributes?.activeVerse]);

  const getVerse = (direction) => {
    let verseIndex = null;
    if (direction === 'next') {
      Object.keys(activeVerse).forEach((activeVerseIndex) => {
        if (filteredItems.length - 1 > parseInt(activeVerseIndex, 10)) {
          let nextVerseIndex = parseInt(activeVerseIndex, 10) + 1;
          // Ignoring flower verse to avoid unwanted scroll during asa di vaar
          if (filteredItems[nextVerseIndex].verseId === FLOWER_VERSE_ID) {
            nextVerseIndex++;
          }
          verseIndex = nextVerseIndex;
        }
      });
    } else if (direction === 'prev') {
      Object.keys(activeVerse).forEach((activeVerseIndex) => {
        if (parseInt(activeVerseIndex, 10) > 0) {
          let prevVerseIndex = parseInt(activeVerseIndex, 10) - 1;
          // Ignoring flower verse to avoid unwanted scroll during asa di vaar
          if (filteredItems[prevVerseIndex].verseId === FLOWER_VERSE_ID) {
            prevVerseIndex--;
          }
          verseIndex = prevVerseIndex;
        }
      });
    }
    if (verseIndex !== null) {
      const { verseId } = filteredItems[verseIndex];
      return { verseIndex, verseId };
    }
    return null;
  };

  useEffect(() => {
    if (isProjection) return;
    if (activePaneId === currentPane) {
      if (shortcuts.nextVerse) {
        const nextVerse = getVerse('next');
        if (nextVerse) {
          updateTraversedVerse(nextVerse.verseId, nextVerse.verseIndex);
          scrollToVerse(nextVerse.verseId, filteredItems, virtuosoRef);
        } else if (akhandpatt && !isSundarGutkaBani && !isCeremonyBani) {
          setShortcuts({
            ...shortcuts,
            nextShabad: true,
            nextVerse: false,
          });
        }
        setShortcuts({
          ...shortcuts,
          nextVerse: false,
        });
      }
      if (shortcuts.prevVerse) {
        const prevVerse = getVerse('prev');
        if (prevVerse) {
          updateTraversedVerse(prevVerse.verseId, prevVerse.verseIndex);
          scrollToVerse(prevVerse.verseId, filteredItems, virtuosoRef);
        }
        setShortcuts({
          ...shortcuts,
          prevVerse: false,
        });
      }
      if (shortcuts.homeVerse) {
        const verse = intelligentNextVerse(filteredItems, {
          activeVerseId: paneAttributes.activeVerse,
          previousVerseIndex,
          setPreviousIndex,
          atHome,
          setHome,
          homeVerse: paneAttributes.homeVerse,
          intelligentSpacebar,
        });
        if (verse) {
          updateTraversedVerse(verse.verseId, verse.verseIndex);
          scrollToVerse(verse.verseId, filteredItems, virtuosoRef);
        }
        setShortcuts({
          ...shortcuts,
          homeVerse: false,
        });
      }
      if (shortcuts.copyToClipboard) {
        copyToClipboard(activeVerseRef);
        setShortcuts({
          ...shortcuts,
          copyToClipboard: false,
        });
      }
    }
  }, [shortcuts]);

  useEffect(() => {
    if (isProjection) return undefined;
    const milisecondsDelay = parseInt(autoplayDelay, 10) * 1000;
    const interval = setInterval(() => {
      if (autoplayToggle) {
        setShortcuts({
          ...shortcuts,
          nextVerse: true,
        });
      }
    }, milisecondsDelay);
    return () => {
      clearInterval(interval);
    };
  }, [autoplayToggle, autoplayDelay, isProjection]);

  const renderVerse = (index, verseObj) => {
    const { verseId, verse, english } = verseObj;
    return (
      <ShabadVerse
        key={verseId != null ? verseId : index}
        activeVerse={activeVerse}
        isHomeVerse={paneAttributes.homeVerse}
        lineNumber={index}
        versesRead={paneAttributes.versesRead}
        activeVerseRef={activeVerseRef}
        verse={verse}
        englishVerse={english}
        verseId={verseId}
        changeHomeVerse={updateHomeVerse}
        updateTraversedVerse={updateTraversedVerse}
      />
    );
  };

  return (
    <div className="shabad-list">
      <div className="verse-block" ref={isProjection ? listScrollRef : undefined}>
        {isProjection ? (
          // Full list on Display 2 — every row is in the DOM (no Virtuoso windowing).
          // Controller keeps Virtuoso for performance; projection needs last lines reachable.
          <div className="shabad-list-full" data-testid="shabad-item-list" style={{ width: '100%' }}>
            {filteredItems.map((verseObj, index) => renderVerse(index, verseObj))}
          </div>
        ) : (
          <Virtuoso
            id={`shabad-text-${currentPane}`}
            data={filteredItems}
            ref={virtuosoRef}
            totalCount={filteredItems.length}
            rangeChanged={(range) => {
              if (projectionSource && !isProjection) {
                ipcRenderer.send('projection-range', { paneId: currentPane, ...range });
              }
            }}
            itemContent={(index, verseObj) => renderVerse(index, verseObj)}
          />
        )}
      </div>
    </div>
  );
};

ShabadText.propTypes = {
  shabadId: PropTypes.number,
  initialVerseId: PropTypes.number,
  baniType: PropTypes.string,
  paneAttributes: PropTypes.object,
  setPaneAttributes: PropTypes.func,
  currentPane: PropTypes.number,
  isProjection: PropTypes.bool,
  projectionSource: PropTypes.bool,
};
