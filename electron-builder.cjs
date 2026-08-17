/* electron-builder configuration.
 *
 * Moved out of package.json so signing can be chosen by the environment rather
 * than hardcoded — the same shape NitroAI uses.
 *
 *   • Signed + notarized — set MAC_SIGN=1 with a "Developer ID Application"
 *     identity reachable in the keychain (or CSC_LINK in CI), plus
 *     APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID. electron-builder
 *     signs with the hardened runtime, notarizes, and staples. The app then
 *     opens on the first double-click with no warning at all.
 *
 *   • Ad-hoc fallback (no cert) — identity:null, so a fork or a secret-less CI
 *     run still produces a valid (not "damaged") build. It is NOT distributable:
 *     macOS refuses it after a download, and since macOS 15 the old
 *     right-click → Open escape hatch is gone.
 */

// Gated on an explicit flag rather than on CSC_LINK: a bare .p12 carries only
// the leaf certificate, and signing with an incomplete chain fails in a way
// that looks like a wrong password.
const hasCert = process.env.MAC_SIGN === "1";

// A locally built app still needs a stable identity, because macOS keys
// permissions to the code signature. Unsigned, the designated requirement is a
// bare hash of the binary, so every rebuild looks like a different application
// and Screen Recording has to be granted again — and the app never appears in
// that list to begin with. Signing with any real certificate, including a
// self-signed one, makes the requirement name the certificate instead, and the
// grant survives every rebuild.
//
// scripts/make-signing-cert.sh creates the certificate this looks for.
const LOCAL_IDENTITY = process.env.VOICEGOAT_SIGN_IDENTITY || "voicegoat local signing";

function localIdentityAvailable() {
  if (process.platform !== "darwin") return false;
  try {
    const { execFileSync } = require("child_process");
    const found = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
    });
    return found.includes(LOCAL_IDENTITY);
  } catch (_) {
    return false;
  }
}

const localIdentity = !hasCert && localIdentityAvailable();
if (localIdentity) {
  console.log(`[voicegoat] signing with the local certificate "${LOCAL_IDENTITY}"`);
}
const canNotarize =
  hasCert &&
  !!process.env.APPLE_ID &&
  !!process.env.APPLE_APP_SPECIFIC_PASSWORD &&
  !!process.env.APPLE_TEAM_ID;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "com.voicegoat.app",
  productName: "voicegoat",
  asar: false,
  publish: null,
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  // An allowlist, so anything new has to be added here or it simply is not in
  // the shipped app — and the only symptom is a require() that throws at
  // launch, in a build that ran fine from source.
  files: ["main.js", "preload.js", "src/**/*", "renderer/**/*", "vendor/**/*"],
  directories: { buildResources: "build-resources" },
  afterPack: "scripts/after-pack.js",
  mac: {
    target: [{ target: "zip", arch: ["x64", "arm64"] }],
    category: "public.app-category.productivity",
    icon: "build-resources/icon.icns",
    // With a real cert, let electron-builder discover it and apply the hardened
    // runtime (notarization is refused without it). Without one, identity:null
    // makes it skip signing rather than fail.
    identity: hasCert ? undefined : localIdentity ? LOCAL_IDENTITY : null,
    hardenedRuntime: hasCert,
    gatekeeperAssess: false,
    entitlements: "build-resources/entitlements.mac.plist",
    entitlementsInherit: "build-resources/entitlements.mac.plist",
    // electron-builder 26 wants a boolean; the credentials come from
    // APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID in the env.
    notarize: canNotarize,
    extendInfo: {
      LSUIElement: true,
      NSMicrophoneUsageDescription:
        "voicegoat transcribes your microphone so it can help you in conversations.",
      NSCameraUsageDescription: "voicegoat does not use the camera.",
      NSAudioCaptureUsageDescription:
        "voicegoat captures system audio to transcribe the other participant in a call.",
    },
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    artifactName: "${productName}-win-${arch}.${ext}",
    icon: "build-resources/icon.png",
  },
  // A per-user install with a visible directory step: voicegoat is a personal overlay,
  // not a machine-wide service, so it should never need an elevation prompt.
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: "voicegoat",
  },
  linux: {
    target: [{ target: "AppImage", arch: ["x64", "arm64"] }],
    category: "Utility",
    icon: "build-resources/icon.png",
  },
};
