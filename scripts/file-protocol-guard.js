/**
 * FutureShield file:// handler — inlined in index.html <head>.
 * 1. If dev server is up → redirect to http://localhost:8080/
 * 2. Else → full-screen instructions (no Firebase / iframe errors needed)
 */
(function () {
  if (location.protocol !== "file:") return;
  if (window.__FS_FILE_PROTOCOL__) return;

  window.__FS_FILE_PROTOCOL__ = true;
  window.__fsFileProtocolBlocked = function () { return true; };
  window.__fsAbortFirebaseOnFileProtocol = function () {};

  var PORT = 8080;
  var ORIGIN = "http://localhost:" + PORT;
  var redirected = false;

  function showBlock() {
    if (redirected || document.getElementById("fs-file-block")) return;

    var css =
      "html,body{overflow:hidden!important;margin:0}" +
      "#fs-file-block{position:fixed;inset:0;z-index:2147483647;background:#0f172a;color:#fff;" +
      "display:flex;align-items:center;justify-content:center;padding:2rem;text-align:center;" +
      "font-family:Inter,system-ui,sans-serif;line-height:1.6}";
    var style = document.createElement("style");
    style.id = "fs-file-block-style";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);

    var el = document.createElement("div");
    el.id = "fs-file-block";
    el.setAttribute("role", "alert");
    el.innerHTML =
      '<div style="max-width:520px">' +
      '<h1 style="font-size:1.35rem;font-weight:700;margin:0 0 1rem">Cannot open from disk (file://)</h1>' +
      '<p style="color:#94a3b8;margin:0 0 1rem">Do <strong>not</strong> double-click <code style="color:#fbbf24">index.html</code>. ' +
      'FutureShield must run through the local dev server.</p>' +
      '<p style="color:#cbd5e1;margin:0 0 .75rem">In the project folder, run:</p>' +
      '<code style="display:block;background:#1e293b;padding:.75rem 1rem;border-radius:.5rem;color:#a5f3fc;margin-bottom:1rem">npm run serve</code>' +
      '<p style="color:#94a3b8;margin:0">Then open ' +
      '<a href="' + ORIGIN + '/" style="color:#818cf8;font-weight:600">' + ORIGIN + '/</a></p>' +
      '<p style="color:#64748b;margin-top:1rem;font-size:.85rem">Checking for a running server...</p>' +
      '</div>';

    function mount() {
      if (document.getElementById("fs-file-block")) return;
      (document.body || document.documentElement).appendChild(el);
    }
    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount);
  }

  function tryRedirect() {
    var img = new Image();
    img.onload = function () {
      redirected = true;
      location.replace(ORIGIN + "/");
    };
    img.onerror = function () { /* wait for timeout or retry */ };
    img.src = ORIGIN + "/assets/favicon.svg?fsprobe=" + Date.now();
  }

  tryRedirect();
  setTimeout(function () {
    if (!redirected) showBlock();
  }, 1500);
  setTimeout(tryRedirect, 400);
})();
