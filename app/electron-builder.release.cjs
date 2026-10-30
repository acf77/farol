/* global require, module, process */
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Config for `npm run release` (the Release workflow): the `build` block from
 * package.json, plus Developer ID signing and notarization when the signing
 * certificate is available.
 *
 * - CSC_LINK set (base64 .p12) → signed with hardened runtime, then notarized
 *   with APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID.
 * - CSC_LINK empty → the same ad-hoc build as before, so releases keep working
 *   until the secrets exist.
 *
 * Local builds (`npm run dist`) don't use this file.
 */
const base = require('./package.json').build

const artifactName = 'Farol-mac-${arch}.${ext}'

function releaseConfig(env = process.env) {
  if (!env.CSC_LINK) {
    return { ...base, mac: { ...base.mac, artifactName, notarize: false } }
  }
  // Ad-hoc signing pins identity to "-" and turns the timestamp off. A
  // Developer ID build drops both, so electron-builder finds the certificate
  // and timestamps the signature, which notarization requires.
  const mac = { ...base.mac }
  delete mac.identity
  delete mac.timestamp
  return {
    ...base,
    mac: {
      ...mac,
      artifactName,
      hardenedRuntime: true,
      entitlements: 'build/entitlements.signed.plist',
      entitlementsInherit: 'build/entitlements.signed.plist',
      notarize: true
    }
  }
}

module.exports = releaseConfig()
module.exports.releaseConfig = releaseConfig
