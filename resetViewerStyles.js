const styles = `
div.shabad-deck.single-display-mode { 
    padding-left: initial;
    padding-top: initial; 
}
.slide-quicktools, .slide-paddingtools { 
   display: none; 
 }
.verse-slide { 
  padding-top: 40px !IMPORTANT 
}
div.autoplay-icon-container { 
  display: none 
}
svg.viewer-logo {
  left: 12px !IMPORTANT;
}
.pane-projection-screen {
  align-items: center;
  display: flex;
  height: 100%;
  justify-content: center;
  overflow: hidden;
  pointer-events: none;
  width: 100%;
}
.pane-projection-stage {
  flex: none;
  transform-origin: center center;
}
.pane-projection-stage .pane-container {
  flex: none;
  height: 100%;
  max-height: none;
  width: 100%;
}
.pane-projection-stage .pane {
  height: 100%;
  min-width: 0;
  width: 100%;
}
.pane-projection-stage .gurmukhi {
  font-family: 'gurbaniakhar';
  font-size: 1.1em;
}`;

module.exports = { styles };
