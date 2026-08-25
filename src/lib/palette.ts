// Themes and accent colours.
//
// Colours are stored as RGB triples rather than CSS strings because the renderer composites
// with varying alpha on almost every draw call. Keeping the channels separate avoids parsing
// `#rrggbb` back apart per frame, and avoids the `color-mix()` the reference stylesheet uses,
// which has no canvas equivalent.

import type { AccentName } from '../types/mindmap'

export type Rgb = readonly [number, number, number]

export type ThemeName = 'dark' | 'light'

export interface Theme {
  name: ThemeName
  /** Page background, and the tint the radial vignette fades toward. */
  bg: Rgb
  bgVignette: Rgb
  /** Card fill gradient, top-left to bottom-right (the reference's 160deg). */
  cardTop: Rgb
  cardBottom: Rgb
  cardBorder: Rgb
  /** Dim under-stroke every connector sits on. */
  wireBase: Rgb
  text: Rgb
  textFaint: Rgb
  /** Which signature file to composite. */
  signature: 'black' | 'white'
  /** Shadow colour under cards. */
  shadow: Rgb
}

const DARK_ACCENTS: Record<AccentName, Rgb> = {
  blue: [96, 165, 250],
  cyan: [34, 211, 238],
  green: [52, 211, 153],
  gold: [251, 191, 36],
  pink: [244, 114, 182],
  purple: [167, 139, 250],
  red: [248, 113, 113],
  slate: [148, 163, 184],
}

// Shifted darker so they hold contrast against a near-white card and background.
const LIGHT_ACCENTS: Record<AccentName, Rgb> = {
  blue: [37, 99, 235],
  cyan: [8, 145, 178],
  green: [5, 150, 105],
  gold: [180, 118, 6],
  pink: [219, 39, 119],
  purple: [124, 58, 237],
  red: [220, 38, 38],
  slate: [71, 85, 105],
}

export const THEMES: Record<ThemeName, Theme> = {
  dark: {
    name: 'dark',
    bg: [8, 11, 20],
    bgVignette: [23, 32, 56],
    cardTop: [30, 41, 66],
    cardBottom: [18, 24, 41],
    cardBorder: [51, 64, 94],
    wireBase: [42, 54, 80],
    text: [237, 242, 250],
    textFaint: [141, 155, 181],
    signature: 'white',
    shadow: [0, 0, 0],
  },
  light: {
    name: 'light',
    bg: [247, 249, 252],
    bgVignette: [226, 234, 245],
    cardTop: [255, 255, 255],
    cardBottom: [240, 244, 250],
    cardBorder: [206, 216, 230],
    wireBase: [199, 210, 226],
    text: [23, 33, 51],
    textFaint: [100, 116, 139],
    signature: 'black',
    shadow: [15, 30, 60],
  },
}

export const accentColour = (theme: ThemeName, accent: AccentName): Rgb =>
  theme === 'dark' ? DARK_ACCENTS[accent] : LIGHT_ACCENTS[accent]

export const rgba = (c: Rgb, alpha = 1): string => `rgba(${c[0]},${c[1]},${c[2]},${alpha})`

/** Straight-line channel blend. Used for the card gradient and dimmed states. */
export const mix = (a: Rgb, b: Rgb, amount: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * amount),
  Math.round(a[1] + (b[1] - a[1]) * amount),
  Math.round(a[2] + (b[2] - a[2]) * amount),
]
