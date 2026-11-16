const HEX_COLOR_REGEX = /^#[0-9a-f]{6}$/i
const PRESET_IDS = Object.freeze(["calm-reading", "minimal", "high-contrast"])
const ALL_PRESET_IDS = Object.freeze([...PRESET_IDS, "custom"])
const FONT_FAMILY_STACKS = Object.freeze({
  serif: '"Noto Serif CJK TC", "Noto Serif TC", "Songti TC", "PMingLiU", Georgia, serif',
  "sans-serif": '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  monospace: 'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, monospace',
  inherit: "inherit",
})
const APPEARANCE_LIMITS = Object.freeze({
  inline: Object.freeze({
    fontSizePx: Object.freeze([14, 24]),
    lineHeight: Object.freeze([1.3, 2.2]),
    maxWidthPx: Object.freeze([480, 1000]),
    marginTopPx: Object.freeze([0, 48]),
    marginBottomPx: Object.freeze([0, 48]),
    paddingVerticalPx: Object.freeze([0, 32]),
    paddingHorizontalPx: Object.freeze([0, 32]),
    borderRadiusPx: Object.freeze([0, 24]),
    accentWidthPx: Object.freeze([0, 8]),
  }),
  selection: Object.freeze({
    widthPx: Object.freeze([240, 480]),
    fontSizePx: Object.freeze([12, 20]),
    lineHeight: Object.freeze([1.3, 1.8]),
    borderRadiusPx: Object.freeze([0, 24]),
    surfaceOpacityPercent: Object.freeze([85, 100]),
  }),
})

function createSelectionDefaults() {
  return {
    widthPx: 280,
    fontSizePx: 14,
    lineHeight: 1.45,
    borderRadiusPx: 14,
    surfaceOpacityPercent: 97,
    light: {
      surfaceColor: "#ffffff",
      textColor: "#3a3a3c",
      accentColor: "#007aff",
    },
    dark: {
      surfaceColor: "#1c1c1e",
      textColor: "#d1d1d6",
      accentColor: "#0a84ff",
    },
  }
}

const TRANSLATION_APPEARANCE_PRESETS = {
  "calm-reading": {
    presetId: "calm-reading",
    inline: {
      fontFamily: "sans-serif",
      fontSizePx: 14,
      fontWeight: 400,
      lineHeight: 1.5,
      maxWidthPx: 832,
      marginTopPx: 4,
      marginBottomPx: 8,
      paddingVerticalPx: 1,
      paddingHorizontalPx: 8,
      borderRadiusPx: 0,
      accentWidthPx: 2,
      showBackground: false,
      showLabel: true,
      enableFadeAnimation: true,
      light: {
        backgroundColor: "#ffffff",
        textColor: "#57606a",
        accentColor: "#afb8c1",
        labelColor: "#6e7781",
      },
      dark: {
        backgroundColor: "#0d1117",
        textColor: "#8c959f",
        accentColor: "#484f58",
        labelColor: "#8c959f",
      },
    },
    selection: createSelectionDefaults(),
  },
  minimal: {
    presetId: "minimal",
    inline: {
      fontFamily: "sans-serif",
      fontSizePx: 14,
      fontWeight: 400,
      lineHeight: 1.45,
      maxWidthPx: 832,
      marginTopPx: 3,
      marginBottomPx: 6,
      paddingVerticalPx: 0,
      paddingHorizontalPx: 6,
      borderRadiusPx: 0,
      accentWidthPx: 1,
      showBackground: false,
      showLabel: false,
      enableFadeAnimation: false,
      light: {
        backgroundColor: "#ffffff",
        textColor: "#57606a",
        accentColor: "#d0d7de",
        labelColor: "#6e7781",
      },
      dark: {
        backgroundColor: "#0d1117",
        textColor: "#8c959f",
        accentColor: "#30363d",
        labelColor: "#8c959f",
      },
    },
    selection: createSelectionDefaults(),
  },
  "high-contrast": {
    presetId: "high-contrast",
    inline: {
      fontFamily: "sans-serif",
      fontSizePx: 17,
      fontWeight: 400,
      lineHeight: 1.75,
      maxWidthPx: 800,
      marginTopPx: 16,
      marginBottomPx: 24,
      paddingVerticalPx: 14,
      paddingHorizontalPx: 16,
      borderRadiusPx: 6,
      accentWidthPx: 4,
      showBackground: true,
      showLabel: true,
      enableFadeAnimation: true,
      light: {
        backgroundColor: "#ffffff",
        textColor: "#111827",
        accentColor: "#1d4ed8",
        labelColor: "#1e40af",
      },
      dark: {
        backgroundColor: "#111827",
        textColor: "#f9fafb",
        accentColor: "#93c5fd",
        labelColor: "#bfdbfe",
      },
    },
    selection: createSelectionDefaults(),
  },
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value
  }

  Object.freeze(value)
  for (const nested of Object.values(value)) {
    deepFreeze(nested)
  }

  return value
}

deepFreeze(TRANSLATION_APPEARANCE_PRESETS)

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createTranslationAppearancePreset(presetId) {
  const normalizedId = PRESET_IDS.includes(presetId) ? presetId : "calm-reading"

  return clone(TRANSLATION_APPEARANCE_PRESETS[normalizedId])
}

const DEFAULT_TRANSLATION_APPEARANCE = deepFreeze(createTranslationAppearancePreset("calm-reading"))

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizeNumber(value, bounds, fallback, options = {}) {
  if (value === null || value === undefined || value === "") {
    return fallback
  }

  const numeric = Number(value)

  if (!Number.isFinite(numeric)) {
    return fallback
  }

  const clamped = Math.min(bounds[1], Math.max(bounds[0], numeric))

  if (options.integer) {
    return Math.round(clamped)
  }

  return Math.round(clamped * 100) / 100
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback
}

function normalizeEnum(value, allowedValues, fallback) {
  return allowedValues.includes(value) ? value : fallback
}

function normalizeColor(value, fallback) {
  const normalized = String(value || "").trim()

  return HEX_COLOR_REGEX.test(normalized) ? normalized.toLowerCase() : fallback
}

function normalizeInlineTheme(input, fallback) {
  const source = isRecord(input) ? input : {}

  return {
    backgroundColor: normalizeColor(source.backgroundColor, fallback.backgroundColor),
    textColor: normalizeColor(source.textColor, fallback.textColor),
    accentColor: normalizeColor(source.accentColor, fallback.accentColor),
    labelColor: normalizeColor(source.labelColor, fallback.labelColor),
  }
}

function normalizeSelectionTheme(input, fallback) {
  const source = isRecord(input) ? input : {}

  return {
    surfaceColor: normalizeColor(source.surfaceColor, fallback.surfaceColor),
    textColor: normalizeColor(source.textColor, fallback.textColor),
    accentColor: normalizeColor(source.accentColor, fallback.accentColor),
  }
}

function normalizeTranslationAppearance(input) {
  const source = isRecord(input) ? input : {}
  const presetId = ALL_PRESET_IDS.includes(source.presetId)
    ? source.presetId
    : isRecord(source.inline) && Object.keys(source.inline).length > 0
      ? "custom"
      : "calm-reading"

  const fallback = createTranslationAppearancePreset(
    presetId === "custom" ? "calm-reading" : presetId,
  )
  const inlineSource =
    PRESET_IDS.includes(presetId) && source.presetId === presetId
      ? fallback.inline
      : isRecord(source.inline)
        ? source.inline
        : {}
  const selectionSource = isRecord(source.selection) ? source.selection : {}
  const inlineFallback = fallback.inline
  const selectionFallback = fallback.selection

  return {
    presetId,
    inline: {
      fontFamily: normalizeEnum(
        inlineSource.fontFamily,
        Object.keys(FONT_FAMILY_STACKS),
        inlineFallback.fontFamily,
      ),
      fontSizePx: normalizeNumber(
        inlineSource.fontSizePx,
        APPEARANCE_LIMITS.inline.fontSizePx,
        inlineFallback.fontSizePx,
      ),
      fontWeight: normalizeEnum(
        Number(inlineSource.fontWeight),
        [400, 500, 600],
        inlineFallback.fontWeight,
      ),
      lineHeight: normalizeNumber(
        inlineSource.lineHeight,
        APPEARANCE_LIMITS.inline.lineHeight,
        inlineFallback.lineHeight,
      ),
      maxWidthPx: normalizeNumber(
        inlineSource.maxWidthPx,
        APPEARANCE_LIMITS.inline.maxWidthPx,
        inlineFallback.maxWidthPx,
        { integer: true },
      ),
      marginTopPx: normalizeNumber(
        inlineSource.marginTopPx,
        APPEARANCE_LIMITS.inline.marginTopPx,
        inlineFallback.marginTopPx,
        { integer: true },
      ),
      marginBottomPx: normalizeNumber(
        inlineSource.marginBottomPx,
        APPEARANCE_LIMITS.inline.marginBottomPx,
        inlineFallback.marginBottomPx,
        { integer: true },
      ),
      paddingVerticalPx: normalizeNumber(
        inlineSource.paddingVerticalPx,
        APPEARANCE_LIMITS.inline.paddingVerticalPx,
        inlineFallback.paddingVerticalPx,
        { integer: true },
      ),
      paddingHorizontalPx: normalizeNumber(
        inlineSource.paddingHorizontalPx,
        APPEARANCE_LIMITS.inline.paddingHorizontalPx,
        inlineFallback.paddingHorizontalPx,
        { integer: true },
      ),
      borderRadiusPx: normalizeNumber(
        inlineSource.borderRadiusPx,
        APPEARANCE_LIMITS.inline.borderRadiusPx,
        inlineFallback.borderRadiusPx,
        { integer: true },
      ),
      accentWidthPx: normalizeNumber(
        inlineSource.accentWidthPx,
        APPEARANCE_LIMITS.inline.accentWidthPx,
        inlineFallback.accentWidthPx,
        { integer: true },
      ),
      showBackground: normalizeBoolean(inlineSource.showBackground, inlineFallback.showBackground),
      showLabel: normalizeBoolean(inlineSource.showLabel, inlineFallback.showLabel),
      enableFadeAnimation: normalizeBoolean(
        inlineSource.enableFadeAnimation,
        inlineFallback.enableFadeAnimation,
      ),
      light: normalizeInlineTheme(inlineSource.light, inlineFallback.light),
      dark: normalizeInlineTheme(inlineSource.dark, inlineFallback.dark),
    },
    selection: {
      widthPx: normalizeNumber(
        selectionSource.widthPx,
        APPEARANCE_LIMITS.selection.widthPx,
        selectionFallback.widthPx,
        { integer: true },
      ),
      fontSizePx: normalizeNumber(
        selectionSource.fontSizePx,
        APPEARANCE_LIMITS.selection.fontSizePx,
        selectionFallback.fontSizePx,
      ),
      lineHeight: normalizeNumber(
        selectionSource.lineHeight,
        APPEARANCE_LIMITS.selection.lineHeight,
        selectionFallback.lineHeight,
      ),
      borderRadiusPx: normalizeNumber(
        selectionSource.borderRadiusPx,
        APPEARANCE_LIMITS.selection.borderRadiusPx,
        selectionFallback.borderRadiusPx,
        { integer: true },
      ),
      surfaceOpacityPercent: normalizeNumber(
        selectionSource.surfaceOpacityPercent,
        APPEARANCE_LIMITS.selection.surfaceOpacityPercent,
        selectionFallback.surfaceOpacityPercent,
        { integer: true },
      ),
      light: normalizeSelectionTheme(selectionSource.light, selectionFallback.light),
      dark: normalizeSelectionTheme(selectionSource.dark, selectionFallback.dark),
    },
  }
}

function colorLuminance(hexColor) {
  const normalized = String(hexColor || "").trim()

  if (!HEX_COLOR_REGEX.test(normalized)) {
    return null
  }

  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255,
  )
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  )

  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

function calculateContrastRatio(foreground, background) {
  const foregroundLuminance = colorLuminance(foreground)
  const backgroundLuminance = colorLuminance(background)

  if (foregroundLuminance === null || backgroundLuminance === null) {
    return null
  }

  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)

  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100
}

function getContrastingTextColor(backgroundColor) {
  const blackContrast = calculateContrastRatio("#000000", backgroundColor)
  const whiteContrast = calculateContrastRatio("#ffffff", backgroundColor)

  if (blackContrast === null || whiteContrast === null) {
    return "#000000"
  }

  return whiteContrast > blackContrast ? "#ffffff" : "#000000"
}

function hexToRgbaColor(hexColor, opacityPercent) {
  const normalized = normalizeColor(hexColor, "#ffffff")
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(normalized.slice(offset, offset + 2), 16),
  )
  const opacity = normalizeNumber(opacityPercent, [0, 100], 100) / 100

  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${opacity})`
}

export {
  ALL_PRESET_IDS,
  APPEARANCE_LIMITS,
  calculateContrastRatio,
  createTranslationAppearancePreset,
  DEFAULT_TRANSLATION_APPEARANCE,
  FONT_FAMILY_STACKS,
  getContrastingTextColor,
  hexToRgbaColor,
  normalizeTranslationAppearance,
  PRESET_IDS,
  TRANSLATION_APPEARANCE_PRESETS,
}
