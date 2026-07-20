// The live Vendo drop-in on the docs themselves: the corner launcher pill on
// every page IS the shipped component (scripted data, no model key). Mintlify
// auto-includes this file site-wide. Remove this file to remove the launcher.
(function () {
  if (window.__vendoDocsLauncher) return;
  window.__vendoDocsLauncher = true;
  var script = document.createElement("script");
  script.src = "https://vendo.run/playground/embed.js";
  script.async = true;
  script.onload = function () {
    if (window.VendoDocsEmbed) window.VendoDocsEmbed.mountLauncher();
  };
  document.head.appendChild(script);
})();
