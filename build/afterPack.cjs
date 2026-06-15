// electron-builder afterPack hook.
// We don't have an Apple Developer certificate, so the app can't be properly
// signed/notarized. But on Apple Silicon an unsigned (or signature-mismatched)
// binary is killed on launch. Re-signing the whole bundle with an ad-hoc
// signature ("-") makes it runnable locally and inside the DMG/zip we ship.
// Other users still get a Gatekeeper prompt (right-click → Open) since it isn't
// notarized — that's expected for an unsigned build.
const { execSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
    console.log(`  • ad-hoc signed ${appPath}`);
  } catch (e) {
    console.warn('  • ad-hoc signing failed:', e.message);
  }
};
