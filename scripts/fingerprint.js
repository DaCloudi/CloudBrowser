// CI diagnostics: what a page can see about the browser (compared between real Chrome and CloudBrowser).
(async () => {
  const out = {};
  const c = window.chrome;
  out.chromeKeys = c ? Object.keys(c).sort() : null;
  out.chromeApp = c && c.app ? Object.keys(c.app).sort() : null;
  out.chromeRuntime = c && c.runtime ? Object.keys(c.runtime).length : null;
  out.csi = typeof (c && c.csi); out.loadTimes = typeof (c && c.loadTimes);
  out.webdriver = navigator.webdriver;
  out.plugins = [...navigator.plugins].map(p => p.name);
  out.mimeTypes = navigator.mimeTypes.length;
  out.pdfViewerEnabled = navigator.pdfViewerEnabled;
  out.languages = navigator.languages;
  out.hw = [navigator.hardwareConcurrency, navigator.deviceMemory, navigator.maxTouchPoints];
  out.notification = typeof Notification !== 'undefined' ? Notification.permission : 'none';
  try { out.permNotif = (await navigator.permissions.query({ name: 'notifications' })).state; } catch (e) { out.permNotif = 'ERR ' + e.message; }
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    out.webgl = [gl.getParameter(d.UNMASKED_VENDOR_WEBGL), gl.getParameter(d.UNMASKED_RENDERER_WEBGL)];
  } catch (e) { out.webgl = 'ERR'; }
  out.screen = [screen.width, screen.height, screen.availHeight, screen.colorDepth, devicePixelRatio];
  out.outerMinusInner = [outerWidth - innerWidth, outerHeight - innerHeight];
  out.connection = navigator.connection ? navigator.connection.effectiveType : null;
  out.voices = typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices().length : null;
  out.globals = Object.getOwnPropertyNames(window).filter(k => /electron|process|require|module|cloud|__/i.test(k));
  out.windowPropCount = Object.getOwnPropertyNames(window).length;
  out.navProps = Object.getOwnPropertyNames(Navigator.prototype).length;
  out.userActivation = !!navigator.userActivation;
  out.share = typeof navigator.share; out.contacts = typeof navigator.contacts;
  out.serial = typeof navigator.serial; out.hid = typeof navigator.hid; out.usb = typeof navigator.usb; out.bluetooth = typeof navigator.bluetooth;
  out.wakeLock = typeof navigator.wakeLock; out.xr = typeof navigator.xr; out.gpu = typeof navigator.gpu;
  out.paymentRequest = typeof window.PaymentRequest; out.credentials = typeof navigator.credentials;
  out.publicKey = typeof window.PublicKeyCredential;
  try { out.webauthnPlatform = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch (e) { out.webauthnPlatform = 'ERR'; }
  try { out.conditional = await PublicKeyCredential.isConditionalMediationAvailable(); } catch (e) { out.conditional = 'ERR'; }
  out.storageEstimate = navigator.storage ? Math.round(((await navigator.storage.estimate()).quota || 0) / 1e9) : null;
  out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  out.ua = navigator.userAgent;
  try { out.uadHigh = await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'wow64', 'formFactors']); } catch (e) { out.uadHigh = 'ERR'; }
  out.fileSystemAccess = typeof window.showOpenFilePicker;
  out.documentPip = typeof window.documentPictureInPicture;
  out.launchQueue = typeof window.launchQueue;
  out.sharedStorage = typeof window.sharedStorage; out.topics = typeof document.browsingTopics; out.fledge = typeof navigator.joinAdInterestGroup;
  out.attribution = typeof window.attributionReporting;
  return JSON.stringify(out);
})()
