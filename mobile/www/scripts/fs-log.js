/**
 * FutureShield — production-safe console wrapper.
 * Loads first in index.html. Silences log/info/debug in production;
 * enable with ?debug=1 or on localhost.
 */
(function (global) {
  "use strict";

  var host = global.location && global.location.hostname ? global.location.hostname : "";
  var isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]";
  var isDebug =
    isLocal ||
    (global.location && /(?:^|[?&])debug=1(?:&|$)/.test(global.location.search || ""));

  global.__FS_DEV__ = isDebug;

  var native = {
    log: global.console.log.bind(global.console),
    info: global.console.info.bind(global.console),
    debug: global.console.debug.bind(global.console),
    warn: global.console.warn.bind(global.console),
    error: global.console.error.bind(global.console),
  };

  function noop() {}

  if (!isDebug) {
    global.console.log = noop;
    global.console.info = noop;
    global.console.debug = noop;
  }

  global.fsLog = isDebug ? native.log : noop;
  global.fsInfo = isDebug ? native.info : noop;
  global.fsDebug = isDebug ? native.debug : noop;
  global.fsWarn = native.warn;
  global.fsError = native.error;
})(typeof window !== "undefined" ? window : global);
