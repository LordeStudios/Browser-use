'use strict';

// Device presets for mobile and tablet emulation.
//
// CommonJS so the Electron main process can require it directly, matching
// cursorOverlay.cjs. Each profile carries everything a single CDP emulation
// pass needs: CSS viewport, device pixel ratio, and the user agent plus the
// client-hint metadata Chromium expects alongside it.
//
// Emulation.setUserAgentOverride rejects the call outright when
// userAgentMetadata is partial, so every mobile profile spells out
// architecture and model even when they are empty strings.

const DESKTOP_ID = 'desktop';

const DEVICE_PROFILES = [
  {
    id: DESKTOP_ID,
    label: 'Desktop',
    mode: 'desktop',
    touch: false
  },
  {
    id: 'pixel-8',
    label: 'Pixel 8',
    mode: 'mobile',
    touch: true,
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    maxTouchPoints: 5,
    platform: 'Android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    userAgentMetadata: {
      brands: [{ brand: 'Chromium', version: '131' }, { brand: 'Google Chrome', version: '131' }, { brand: 'Not_A Brand', version: '24' }],
      fullVersionList: [{ brand: 'Chromium', version: '131.0.0.0' }, { brand: 'Google Chrome', version: '131.0.0.0' }],
      fullVersion: '131.0.0.0',
      platform: 'Android',
      platformVersion: '14.0.0',
      architecture: '',
      model: 'Pixel 8',
      mobile: true
    }
  },
  {
    id: 'iphone-15-pro',
    label: 'iPhone 15 Pro',
    mode: 'mobile',
    touch: true,
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    maxTouchPoints: 5,
    platform: 'iPhone',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    userAgentMetadata: {
      brands: [],
      fullVersionList: [],
      fullVersion: '17.5',
      platform: 'iOS',
      platformVersion: '17.5',
      architecture: '',
      model: 'iPhone',
      mobile: true
    }
  },
  {
    id: 'iphone-se',
    label: 'iPhone SE',
    mode: 'mobile',
    touch: true,
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    maxTouchPoints: 5,
    platform: 'iPhone',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    userAgentMetadata: {
      brands: [],
      fullVersionList: [],
      fullVersion: '17.5',
      platform: 'iOS',
      platformVersion: '17.5',
      architecture: '',
      model: 'iPhone',
      mobile: true
    }
  },
  {
    id: 'ipad-pro-11',
    label: 'iPad Pro 11"',
    mode: 'tablet',
    touch: true,
    width: 834,
    height: 1194,
    deviceScaleFactor: 2,
    maxTouchPoints: 5,
    platform: 'iPad',
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    userAgentMetadata: {
      brands: [],
      fullVersionList: [],
      fullVersion: '17.5',
      platform: 'iOS',
      platformVersion: '17.5',
      architecture: '',
      model: 'iPad',
      mobile: true
    }
  },
  {
    id: 'galaxy-tab-s9',
    label: 'Galaxy Tab S9',
    mode: 'tablet',
    touch: true,
    width: 800,
    height: 1280,
    deviceScaleFactor: 2,
    maxTouchPoints: 5,
    platform: 'Android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    userAgentMetadata: {
      brands: [{ brand: 'Chromium', version: '131' }, { brand: 'Google Chrome', version: '131' }, { brand: 'Not_A Brand', version: '24' }],
      fullVersionList: [{ brand: 'Chromium', version: '131.0.0.0' }, { brand: 'Google Chrome', version: '131.0.0.0' }],
      fullVersion: '131.0.0.0',
      platform: 'Android',
      platformVersion: '14.0.0',
      architecture: '',
      model: 'SM-X710',
      // Android tablets report mobile:false in client hints even though they are
      // touch-first, which is what a real Galaxy Tab sends.
      mobile: false
    }
  }
];

const PROFILES_BY_ID = new Map(DEVICE_PROFILES.map((profile) => [profile.id, profile]));

function listDeviceProfiles() {
  return DEVICE_PROFILES.map((profile) => ({
    id: profile.id,
    label: profile.label,
    mode: profile.mode,
    touch: Boolean(profile.touch),
    width: profile.width || null,
    height: profile.height || null,
    deviceScaleFactor: profile.deviceScaleFactor || null
  }));
}

function getDeviceProfile(id) {
  return PROFILES_BY_ID.get(String(id || DESKTOP_ID)) || null;
}

// Landscape swaps the CSS viewport and reports the matching orientation angle,
// because a page that reads screen.orientation must agree with its own layout.
function resolveViewport(profile, orientation = 'portrait') {
  if (!profile || profile.mode === 'desktop') return null;
  const landscape = orientation === 'landscape';
  return {
    width: landscape ? profile.height : profile.width,
    height: landscape ? profile.width : profile.height,
    deviceScaleFactor: profile.deviceScaleFactor,
    mobile: profile.mode === 'mobile',
    screenOrientation: landscape
      ? { type: 'landscapePrimary', angle: 90 }
      : { type: 'portraitPrimary', angle: 0 }
  };
}

module.exports = { DEVICE_PROFILES, DESKTOP_ID, listDeviceProfiles, getDeviceProfile, resolveViewport };
