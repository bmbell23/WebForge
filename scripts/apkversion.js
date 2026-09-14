// #149: the gate that stops us publishing an APK under a version it doesn't contain.
//
// The Android updater compares the server's /version.txt against the running
// app's BuildConfig.VERSION_NAME. If the published APK reports something OLDER
// than the number advertised beside it, the phone downloads, installs, is no
// newer than before, and prompts again on the next resume — forever. That
// happened twice (#106 2026-07-31, #149 2026-09-14) from two different causes,
// which is the tell that care isn't the fix and a guard is.
//
// So `build-apk.sh` asks this module whether the pair it is about to stage is
// coherent, and refuses to publish if it isn't. The version is read out of the
// built APK with aapt2 — not from build.gradle and not from version.txt —
// because a stale artifact is exactly what we're trying to catch, and both of
// those would happily report the number we wish were in there.
//
// CLI (what the build script uses):
//   node scripts/apkversion.js read <apk>                -> prints "<name> <code>"
//   node scripts/apkversion.js check <apk> <expected> [published-apk]
//       exits 0 and prints the version when safe to stage; exits 1 with the
//       reason otherwise.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// `aapt2 dump badging` line 1, e.g.
//   package: name='com.webforge.browser' versionCode='256' versionName='0.1.156' ...
function parseBadging(text) {
  if (typeof text !== 'string') return null;
  const name = /versionName='([^']*)'/.exec(text);
  const code = /versionCode='([^']*)'/.exec(text);
  if (!name || !code) return null;
  const versionCode = Number(code[1]);
  if (!Number.isInteger(versionCode)) return null;
  return { versionName: name[1], versionCode };
}

function compareSemver(a, b) {
  const parts = (v) => String(v).split('.').map((n) => Number(n) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// `built`    — what aapt2 read out of the APK we are about to stage
// `expected` — repo-root version.txt, the number the endpoint will advertise
// `published`— what is already staged (null on a first publish)
function checkStageable({ built, expected, published }) {
  if (!built) {
    return { ok: false, reason: 'could not read a version out of the built APK' };
  }
  if (!expected || !/^\d+\.\d+\.\d+$/.test(expected)) {
    return { ok: false, reason: `version.txt is not a semver: ${JSON.stringify(expected)}` };
  }

  // The loop itself. The endpoint would advertise `expected` while handing the
  // phone an APK that reports `built`, so the phone can never reach the number
  // it is being told to want.
  if (built.versionName !== expected) {
    return {
      ok: false,
      reason:
        `the APK reports ${built.versionName} but version.txt says ${expected}.\n` +
        `       Publishing this pair makes the phone update-loop: it would download\n` +
        `       ${built.versionName}, still not be ${expected}, and ask again on every launch.\n` +
        `       The APK is stale — assembleDebug did not rebuild against this version.`,
    };
  }

  if (published) {
    // Same versionCode means Android treats the install as a no-op even when the
    // bytes differ — a quieter version of the same loop.
    if (published.versionCode === built.versionCode && published.versionName !== built.versionName) {
      return {
        ok: false,
        reason: `versionCode ${built.versionCode} is already published for a different versionName ` +
          `(${published.versionName}); Android would not treat this as an upgrade`,
      };
    }
    if (compareSemver(built.versionName, published.versionName) < 0) {
      return {
        ok: false,
        reason: `this would publish ${built.versionName} over ${published.versionName} — a downgrade; ` +
          `phones on the newer build would never be offered anything again`,
      };
    }
  }

  return { ok: true, version: built.versionName, versionCode: built.versionCode };
}

// --- reading a real APK -----------------------------------------------------

// Gradle's SDK location, then the newest build-tools that actually has aapt2.
function findAapt2(root) {
  const props = path.join(root, 'android', 'local.properties');
  let sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
  if (!sdk && fs.existsSync(props)) {
    const m = /^sdk\.dir=(.*)$/m.exec(fs.readFileSync(props, 'utf8'));
    if (m) sdk = m[1].trim();
  }
  if (!sdk) return null;
  const dir = path.join(sdk, 'build-tools');
  if (!fs.existsSync(dir)) return null;
  const candidates = fs
    .readdirSync(dir)
    .sort((a, b) => compareSemver(b, a)) // newest first
    .map((v) => path.join(dir, v, 'aapt2'))
    .filter((p) => fs.existsSync(p));
  return candidates[0] || null;
}

function readApkVersion(apkPath, aapt2) {
  if (!fs.existsSync(apkPath)) return null;
  const tool = aapt2 || findAapt2(path.join(__dirname, '..'));
  if (!tool) throw new Error('aapt2 not found — cannot verify the APK version');
  const out = execFileSync(tool, ['dump', 'badging', apkPath], { encoding: 'utf8' });
  return parseBadging(out);
}

module.exports = { parseBadging, compareSemver, checkStageable, findAapt2, readApkVersion };

// --- CLI --------------------------------------------------------------------

if (require.main === module) {
  const [cmd, apk, expected, publishedApk] = process.argv.slice(2);
  try {
    if (cmd === 'read') {
      const v = readApkVersion(apk);
      if (!v) throw new Error(`no version readable from ${apk}`);
      console.log(`${v.versionName} ${v.versionCode}`);
      process.exit(0);
    }
    if (cmd === 'check') {
      const built = readApkVersion(apk);
      // Absent on a first publish; not an error.
      const published = publishedApk && fs.existsSync(publishedApk) ? readApkVersion(publishedApk) : null;
      const result = checkStageable({ built, expected, published });
      if (!result.ok) {
        console.error(`❌ refusing to stage: ${result.reason}`);
        process.exit(1);
      }
      console.log(`${result.version} ${result.versionCode}`);
      process.exit(0);
    }
    console.error('usage: apkversion.js read <apk> | check <apk> <expected> [published-apk]');
    process.exit(2);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
