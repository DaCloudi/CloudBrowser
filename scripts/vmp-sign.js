// electron-builder afterPack hook: VMP-sign the packaged app with castLabs EVS so that
// streaming services that require it (Netflix, Disney+, …) will play. Without an EVS
// account (CI secrets EVS_ACCOUNT_NAME / EVS_PASSWD) the build still works, unsigned.
const { execFileSync } = require('child_process');

exports.default = async function vmpSign(context) {
  if (!process.env.EVS_ACCOUNT_NAME) {
    console.log('  • VMP signing skipped (no castLabs EVS account configured)');
    return;
  }
  const dir = context.appOutDir;
  console.log('  • VMP signing', dir);
  execFileSync('python', ['-m', 'castlabs_evs.vmp', 'sign-pkg', dir], { stdio: 'inherit' });
  execFileSync('python', ['-m', 'castlabs_evs.vmp', 'verify-pkg', dir], { stdio: 'inherit' });
};
