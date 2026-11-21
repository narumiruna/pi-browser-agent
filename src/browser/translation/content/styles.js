export function applyContentStyles(options = {}) {
  const {
    appearance,
    appearanceApi: AppearanceApi,
    document,
    pageState,
    rootAttr: ROOT_ATTR,
    styleId: STYLE_ID,
  } = options
  const SELECTION_PANEL_COMPACT_MAX_BODY_HEIGHT = 132
  const SELECTION_PANEL_EXPANDED_MAX_BODY_HEIGHT = 320
  if (appearance) {
    pageState.translationAppearance = AppearanceApi.normalizeTranslationAppearance(appearance)
  }

  const resolvedAppearance = pageState.translationAppearance
  const inlineAppearance = resolvedAppearance.inline
  const selectionAppearance = resolvedAppearance.selection
  const inlineBackground = inlineAppearance.showBackground
    ? inlineAppearance.light.backgroundColor
    : "transparent"
  const inlineDarkBackground = inlineAppearance.showBackground
    ? inlineAppearance.dark.backgroundColor
    : "transparent"
  const inlineLightText = inlineAppearance.showBackground
    ? inlineAppearance.light.textColor
    : "inherit"
  const inlineDarkText = inlineAppearance.showBackground
    ? inlineAppearance.dark.textColor
    : "inherit"
  const inlineLightAccent = inlineAppearance.showBackground
    ? inlineAppearance.light.accentColor
    : "currentColor"
  const inlineDarkAccent = inlineAppearance.showBackground
    ? inlineAppearance.dark.accentColor
    : "currentColor"
  const inlineLightLabel = inlineAppearance.showBackground
    ? inlineAppearance.light.labelColor
    : "inherit"
  const inlineDarkLabel = inlineAppearance.showBackground
    ? inlineAppearance.dark.labelColor
    : "inherit"
  const inlineLabelOpacity = inlineAppearance.showBackground ? 1 : 0.72
  const inlineLightCodeBackground = inlineAppearance.showBackground
    ? "rgba(60, 60, 67, 0.08)"
    : "transparent"
  const inlineDarkCodeBackground = inlineAppearance.showBackground
    ? "rgba(255, 255, 255, 0.11)"
    : "transparent"
  const inlineLightCodeText = inlineAppearance.showBackground ? "#3a3a3c" : "inherit"
  const inlineDarkCodeText = inlineAppearance.showBackground ? "#f2f2f7" : "inherit"
  const fadeAnimation = inlineAppearance.enableFadeAnimation
    ? "ot-fade-in 0.18s ease forwards"
    : "none"
  const inlineLabelDisplay = inlineAppearance.showLabel
    ? inlineAppearance.showBackground
      ? "block"
      : "inline-block"
    : "none"
  const inlineLabelMargin = inlineAppearance.showBackground ? "0 0 0.4rem" : "0 0.55em 0 0"
  const inlineBodyDisplay = inlineAppearance.showBackground ? "block" : "inline"
  const selectionLightBackground = AppearanceApi.hexToRgbaColor(
    selectionAppearance.light.surfaceColor,
    selectionAppearance.surfaceOpacityPercent,
  )
  const selectionDarkBackground = AppearanceApi.hexToRgbaColor(
    selectionAppearance.dark.surfaceColor,
    selectionAppearance.surfaceOpacityPercent,
  )
  const selectionLightAccentSoft = AppearanceApi.hexToRgbaColor(
    selectionAppearance.light.accentColor,
    10,
  )
  const selectionLightAccentHover = AppearanceApi.hexToRgbaColor(
    selectionAppearance.light.accentColor,
    16,
  )
  const selectionDarkAccentSoft = AppearanceApi.hexToRgbaColor(
    selectionAppearance.dark.accentColor,
    16,
  )
  const selectionLightAccentText = AppearanceApi.getContrastingTextColor(
    selectionAppearance.light.accentColor,
  )
  const selectionDarkAccentText = AppearanceApi.getContrastingTextColor(
    selectionAppearance.dark.accentColor,
  )
  let style = document.getElementById(STYLE_ID)

  if (!style) {
    style = document.createElement("style")
    style.id = STYLE_ID
    document.documentElement.appendChild(style)
  }

  style.textContent = `
      .translation[${ROOT_ATTR}="note"] {
        all: initial;
        display: block;
        box-sizing: border-box;
        contain: layout style paint;
        isolation: isolate;
        transform: none;
        filter: none;
        backdrop-filter: none;
        mix-blend-mode: normal;
        overflow: visible;
        float: none;
        clear: both;
        width: min(100%, ${inlineAppearance.maxWidthPx}px);
        max-width: 100%;
        margin: ${inlineAppearance.marginTopPx}px 0 ${inlineAppearance.marginBottomPx}px;
        padding: ${inlineAppearance.paddingVerticalPx}px ${inlineAppearance.paddingHorizontalPx}px;
        border: 0;
        border-left: ${inlineAppearance.accentWidthPx}px solid ${inlineLightAccent};
        border-radius: 0 ${inlineAppearance.borderRadiusPx}px ${inlineAppearance.borderRadiusPx}px 0;
        font-family: ${AppearanceApi.FONT_FAMILY_STACKS[inlineAppearance.fontFamily]};
        font-size: ${inlineAppearance.fontSizePx}px;
        font-weight: ${inlineAppearance.fontWeight};
        line-height: ${inlineAppearance.lineHeight};
        letter-spacing: normal;
        color: ${inlineLightText};
        text-align: start;
        background: ${inlineBackground};
        position: static;
      }

      .translation[${ROOT_ATTR}="note"][data-ot-note-aligned] {
        align-self: start;
        inline-size: min(${inlineAppearance.maxWidthPx}px, var(--ot-note-inline-size), calc(100% - var(--ot-note-inline-start)));
        margin-inline-start: var(--ot-note-inline-start);
      }

      .translation[${ROOT_ATTR}="note"][data-phase="ready"] {
        animation: ${fadeAnimation};
      }

      .ot-youtube-translate-button {
        color: #ffffff;
      }

      .ot-youtube-translate-button svg {
        display: block;
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        padding: 10px;
      }

      .ot-youtube-translate-button[data-state="active"] {
        color: #61b8ff;
      }

      .ot-youtube-translate-button[data-state="loading"] {
        color: #d2e9ff;
        cursor: progress;
        opacity: 0.8;
      }

      .ot-youtube-translate-button[data-state="loading"] svg {
        animation: ot-control-pulse 0.9s ease-in-out infinite alternate;
      }

      .ot-youtube-translate-button[data-state="error"] {
        color: #ff8a80;
      }

      [${ROOT_ATTR}="youtube-diagnostics"] {
        position: absolute;
        z-index: 80;
        right: 12px;
        bottom: 56px;
        box-sizing: border-box;
        width: min(390px, calc(100% - 24px));
        padding: 12px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 8px;
        color: #f5f5f5;
        background: rgba(12, 12, 14, 0.94);
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
        font: 13px/1.45 Roboto, Arial, sans-serif;
        pointer-events: auto;
      }

      [${ROOT_ATTR}="youtube-diagnostics"] strong,
      [${ROOT_ATTR}="youtube-diagnostics"] span {
        display: block;
      }

      [${ROOT_ATTR}="youtube-diagnostics"] [data-ot-diagnostic-status] {
        margin: 4px 0 10px;
        color: #b9ddff;
      }

      [${ROOT_ATTR}="youtube-diagnostics"] pre {
        max-height: 190px;
        margin: 0 0 10px;
        overflow: auto;
        color: #d7d7dc;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font: 11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
      }

      [${ROOT_ATTR}="youtube-diagnostics"] button {
        min-width: 44px;
        min-height: 32px;
        margin-right: 8px;
        padding: 5px 10px;
        border: 1px solid rgba(255, 255, 255, 0.28);
        border-radius: 5px;
        color: #ffffff;
        background: rgba(255, 255, 255, 0.1);
        cursor: pointer;
      }

      .ytp-caption-segment[data-ot-subtitle-replaced="true"] {
        display: none !important;
      }

      .translation[${ROOT_ATTR}="note"][data-ot-presentation="subtitle"] {
        display: block;
        width: max-content;
        max-width: min(88vw, 100%);
        margin: 0 auto;
        padding: 0.08em 0.34em 0.14em;
        border: 0;
        border-radius: 3px;
        font-family: "YouTube Noto", Roboto, Arial, sans-serif;
        font-size: var(--ot-subtitle-font-size, clamp(16px, 2.1vw, 32px));
        font-weight: 500;
        line-height: 1.25;
        letter-spacing: normal;
        color: #ffe082;
        text-align: center;
        background: rgba(8, 8, 8, 0.78);
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.92);
        animation: none;
        pointer-events: none;
      }

      .translation[${ROOT_ATTR}="note"][data-ot-presentation="subtitle"] [${ROOT_ATTR}="note-label"] {
        display: none;
      }

      .translation[${ROOT_ATTR}="note"][data-ot-presentation="subtitle"] [${ROOT_ATTR}="note-body"] {
        text-align: center;
        white-space: pre-wrap;
        overflow-wrap: break-word;
      }

      .translation[${ROOT_ATTR}="note"][data-stale="true"] {
        opacity: 0.48;
        filter: grayscale(0.2);
      }

      @media (prefers-color-scheme: dark) {
        .translation[${ROOT_ATTR}="note"] {
          border-left-color: ${inlineDarkAccent};
          color: ${inlineDarkText};
          background: ${inlineDarkBackground};
        }
      }

      .translation [${ROOT_ATTR}="note-label"] {
        all: initial;
        display: ${inlineLabelDisplay};
        margin: ${inlineLabelMargin};
        color: ${inlineLightLabel};
        font: 600 0.625rem/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
        letter-spacing: 0.035em;
        opacity: ${inlineLabelOpacity};
        vertical-align: 0.08em;
      }

      @media (prefers-color-scheme: dark) {
        .translation [${ROOT_ATTR}="note-label"] {
          color: ${inlineDarkLabel};
        }
      }

      .translation [${ROOT_ATTR}="note-body"] {
        all: initial;
        display: ${inlineBodyDisplay};
        max-width: 100%;
        margin: 0;
        padding: 0;
        font: inherit;
        color: inherit;
        opacity: 1;
        text-decoration: none;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: normal;
        hyphens: auto;
      }

      .translation [${ROOT_ATTR}="note-body"][data-state="pending"] {
        display: inline-block;
        width: min(12rem, 72%);
        min-height: 1.2em;
        color: transparent;
        border-radius: 6px;
        text-decoration: none;
        background:
          linear-gradient(
            90deg,
            rgba(79, 125, 98, 0.08) 0%,
            rgba(255, 255, 255, 0.76) 50%,
            rgba(79, 125, 98, 0.08) 100%
          );
        background-size: 200% 100%;
        animation: ot-shimmer 1.2s linear infinite;
      }

      .translation [${ROOT_ATTR}="note-body"] code {
        all: initial;
        display: inline;
        padding: 0.08em 0.34em;
        border-radius: 5px;
        background: ${inlineLightCodeBackground};
        color: ${inlineLightCodeText};
        text-decoration: none;
        font: 0.92em/1.4 ui-monospace, "SF Mono", "SFMono-Regular", Menlo, monospace;
      }

      @media (prefers-color-scheme: dark) {
        .translation [${ROOT_ATTR}="note-body"] code {
          background: ${inlineDarkCodeBackground};
          color: ${inlineDarkCodeText};
        }
      }

      [${ROOT_ATTR}="toast-layer"] {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin: 0 0 1rem;
      }

      [${ROOT_ATTR}="toast"] {
        max-width: min(100%, 32rem);
        padding: 11px 14px;
        border-radius: 12px;
        background: rgba(44, 44, 46, 0.95);
        color: #f5f5f7;
        font: 500 13px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
      }

      [${ROOT_ATTR}="toast"][data-level="success"] {
        background: rgba(52, 199, 89, 0.9);
        color: #ffffff;
      }

      [${ROOT_ATTR}="toast"][data-level="error"] {
        background: rgba(255, 59, 48, 0.92);
        color: #ffffff;
      }

      .translation[${ROOT_ATTR}="selection-panel"] {
        all: initial;
        box-sizing: border-box;
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        display: block;
        width: min(${selectionAppearance.widthPx}px, calc(100vw - 24px));
        max-width: min(${selectionAppearance.widthPx}px, calc(100vw - 24px));
        padding: 14px;
        overflow: hidden;
        border: 1px solid rgba(60, 60, 67, 0.12);
        border-radius: ${selectionAppearance.borderRadiusPx}px;
        background: ${selectionLightBackground};
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08), 0 18px 52px rgba(0, 0, 0, 0.14);
        color: ${selectionAppearance.light.textColor};
        font: 400 ${selectionAppearance.fontSizePx}px/${selectionAppearance.lineHeight} -apple-system, BlinkMacSystemFont, "SF Pro Text", "Noto Sans TC", system-ui, sans-serif;
        text-align: start;
        color-scheme: light dark;
        isolation: isolate;
        backdrop-filter: blur(24px) saturate(1.15);
        -webkit-backdrop-filter: blur(24px) saturate(1.15);
        animation: ot-panel-in 0.16s ease-out;
      }

      .translation[${ROOT_ATTR}="selection-panel"] *,
      .translation[${ROOT_ATTR}="selection-panel"] *::before,
      .translation[${ROOT_ATTR}="selection-panel"] *::after {
        box-sizing: border-box;
      }

      .translation[${ROOT_ATTR}="selection-panel"] [hidden] {
        display: none !important;
      }

      @media (prefers-color-scheme: dark) {
        .translation[${ROOT_ATTR}="selection-panel"] {
          background: ${selectionDarkBackground};
          border-color: rgba(255, 255, 255, 0.11);
          color: ${selectionAppearance.dark.textColor};
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.34), 0 20px 56px rgba(0, 0, 0, 0.44);
        }
      }

      .translation [${ROOT_ATTR}="selection-panel-header"] {
        all: initial;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        min-width: 0;
        margin: 0 0 12px;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Noto Sans TC", system-ui, sans-serif;
      }

      .translation [${ROOT_ATTR}="selection-panel-identity"] {
        all: initial;
        display: flex;
        flex: 1 1 auto;
        align-items: center;
        gap: 7px;
        min-width: 0;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Noto Sans TC", system-ui, sans-serif;
      }

      .translation [${ROOT_ATTR}="selection-panel-icon"] {
        all: initial;
        display: inline-flex;
        flex: 0 0 auto;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 8px;
        background: ${selectionLightAccentSoft};
        color: ${selectionAppearance.light.accentColor};
        font: 650 12px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      }

      .translation [${ROOT_ATTR}="selection-panel-title"] {
        all: initial;
        flex: 0 1 auto;
        min-width: 0;
        margin: 0;
        color: ${selectionAppearance.light.textColor};
        font: 650 13px/1.3 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
        letter-spacing: -0.01em;
      }

      .translation [${ROOT_ATTR}="selection-panel-language"] {
        all: initial;
        display: inline-flex;
        flex: 0 1 auto;
        align-items: center;
        min-width: 0;
        padding: 4px 7px;
        border: 1px solid rgba(60, 60, 67, 0.1);
        border-radius: 999px;
        background: rgba(60, 60, 67, 0.055);
        color: ${selectionAppearance.light.textColor};
        font: 550 11px/1.25 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Noto Sans TC", system-ui, sans-serif;
        overflow-wrap: anywhere;
      }

      .translation [${ROOT_ATTR}="selection-panel-close"] {
        all: initial;
        display: inline-flex;
        flex: 0 0 auto;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        margin: -2px -3px -2px 0;
        border: 0;
        border-radius: 9px;
        background: transparent;
        color: #6c6c70;
        cursor: pointer;
        font: 450 19px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
        transition: background 0.14s ease, color 0.14s ease;
      }

      .translation [${ROOT_ATTR}="selection-panel-close"]:hover {
        background: rgba(60, 60, 67, 0.09);
        color: #2c2c2e;
      }

      .translation [${ROOT_ATTR}="selection-panel-close"]:focus-visible,
      .translation [${ROOT_ATTR}="selection-panel-expand"]:focus-visible,
      .translation [${ROOT_ATTR}="selection-panel-retry"]:focus-visible {
        outline: 3px solid ${selectionLightAccentSoft};
        outline-offset: 2px;
      }

      .translation [${ROOT_ATTR}="selection-panel-body"] {
        all: initial;
        display: block;
        max-height: ${SELECTION_PANEL_COMPACT_MAX_BODY_HEIGHT}px;
        overflow: auto;
        margin: 0;
        padding: 0 2px 0 0;
        color: ${selectionAppearance.light.textColor};
        font: 400 ${selectionAppearance.fontSizePx}px/${selectionAppearance.lineHeight} -apple-system, BlinkMacSystemFont, "SF Pro Text", "Noto Sans TC", system-ui, sans-serif;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: normal;
        text-decoration: none;
        scrollbar-width: thin;
      }

      .translation[${ROOT_ATTR}="selection-panel"][data-expanded="true"] [${ROOT_ATTR}="selection-panel-body"] {
        max-height: min(${SELECTION_PANEL_EXPANDED_MAX_BODY_HEIGHT}px, calc(100vh - 120px));
      }

      .translation [${ROOT_ATTR}="selection-panel-status"] {
        all: initial;
        display: block;
        margin: 0 0 11px;
        color: ${selectionAppearance.light.textColor};
        font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Noto Sans TC", system-ui, sans-serif;
        opacity: 0.72;
      }

      .translation [${ROOT_ATTR}="selection-panel-skeleton"] {
        all: initial;
        display: grid;
        gap: 8px;
      }

      .translation [${ROOT_ATTR}="selection-panel-skeleton"] > span {
        all: initial;
        display: block;
        width: 100%;
        height: 10px;
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(60, 60, 67, 0.07) 0%, rgba(255, 255, 255, 0.72) 50%, rgba(60, 60, 67, 0.07) 100%);
        background-size: 200% 100%;
        animation: ot-shimmer 1.2s linear infinite;
      }

      .translation [${ROOT_ATTR}="selection-panel-skeleton"] > span:nth-child(2) {
        width: 88%;
      }

      .translation [${ROOT_ATTR}="selection-panel-skeleton"] > span:nth-child(3) {
        width: 64%;
      }

      .translation [${ROOT_ATTR}="selection-panel-error-message"] {
        all: initial;
        display: block;
        margin: 0;
        color: ${selectionAppearance.light.textColor};
        font: 400 ${selectionAppearance.fontSizePx}px/${selectionAppearance.lineHeight} -apple-system, BlinkMacSystemFont, "SF Pro Text", "Noto Sans TC", system-ui, sans-serif;
        overflow-wrap: anywhere;
      }

      .translation [${ROOT_ATTR}="selection-panel-footer"] {
        all: initial;
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 8px;
        margin: 12px 0 0;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
      }

      .translation [${ROOT_ATTR}="selection-panel-expand"],
      .translation [${ROOT_ATTR}="selection-panel-retry"] {
        all: initial;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 32px;
        padding: 6px 10px;
        border: 0;
        border-radius: 8px;
        cursor: pointer;
        font: 620 12px/1.3 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      }

      .translation [${ROOT_ATTR}="selection-panel-expand"] {
        background: ${selectionLightAccentSoft};
        color: ${selectionAppearance.light.textColor};
      }

      .translation [${ROOT_ATTR}="selection-panel-expand"]:hover {
        background: ${selectionLightAccentHover};
      }

      .translation [${ROOT_ATTR}="selection-panel-retry"] {
        background: ${selectionAppearance.light.accentColor};
        color: ${selectionLightAccentText};
      }

      .translation [${ROOT_ATTR}="selection-panel-retry"]:disabled {
        cursor: default;
        opacity: 0.55;
      }

      .translation [${ROOT_ATTR}="selection-panel-body"] code {
        all: initial;
        display: inline;
        padding: 0.08em 0.34em;
        border-radius: 5px;
        background: rgba(60, 60, 67, 0.08);
        color: #3a3a3c;
        text-decoration: none;
        font: 0.92em/1.4 ui-monospace, "SF Mono", "SFMono-Regular", Menlo, monospace;
      }

      @media (prefers-color-scheme: dark) {
        .translation [${ROOT_ATTR}="selection-panel-icon"],
        .translation [${ROOT_ATTR}="selection-panel-expand"] {
          background: ${selectionDarkAccentSoft};
        }

        .translation [${ROOT_ATTR}="selection-panel-icon"] {
          color: ${selectionAppearance.dark.accentColor};
        }

        .translation [${ROOT_ATTR}="selection-panel-expand"] {
          color: ${selectionAppearance.dark.textColor};
        }

        .translation [${ROOT_ATTR}="selection-panel-title"],
        .translation [${ROOT_ATTR}="selection-panel-language"],
        .translation [${ROOT_ATTR}="selection-panel-body"],
        .translation [${ROOT_ATTR}="selection-panel-status"],
        .translation [${ROOT_ATTR}="selection-panel-error-message"] {
          color: ${selectionAppearance.dark.textColor};
        }

        .translation [${ROOT_ATTR}="selection-panel-language"] {
          border-color: rgba(255, 255, 255, 0.1);
          background: rgba(255, 255, 255, 0.07);
        }

        .translation [${ROOT_ATTR}="selection-panel-close"] {
          color: #aeaeb2;
        }

        .translation [${ROOT_ATTR}="selection-panel-close"]:hover {
          background: rgba(255, 255, 255, 0.1);
          color: #f2f2f7;
        }

        .translation [${ROOT_ATTR}="selection-panel-close"]:focus-visible,
        .translation [${ROOT_ATTR}="selection-panel-expand"]:focus-visible,
        .translation [${ROOT_ATTR}="selection-panel-retry"]:focus-visible {
          outline-color: ${selectionDarkAccentSoft};
        }

        .translation [${ROOT_ATTR}="selection-panel-retry"] {
          background: ${selectionAppearance.dark.accentColor};
          color: ${selectionDarkAccentText};
        }

        .translation [${ROOT_ATTR}="selection-panel-body"] code {
          background: rgba(255, 255, 255, 0.11);
          color: #f2f2f7;
        }
      }

      @media (pointer: coarse) {
        .translation [${ROOT_ATTR}="selection-panel-close"] {
          width: 44px;
          height: 44px;
          margin-block: -8px;
        }

        .translation [${ROOT_ATTR}="selection-panel-expand"],
        .translation [${ROOT_ATTR}="selection-panel-retry"] {
          min-height: 44px;
        }
      }

      .translation[${ROOT_ATTR}="debug-panel"] {
        position: fixed;
        left: 16px;
        bottom: 16px;
        z-index: 2147483647;
        width: min(420px, calc(100vw - 24px));
        max-height: min(44vh, 28rem);
        overflow: auto;
        padding: 12px 14px 14px;
        border: 1px solid rgba(60, 60, 67, 0.12);
        border-radius: 14px;
        background: rgba(242, 242, 247, 0.97);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 16px 48px rgba(0, 0, 0, 0.1);
        color: #1c1c1e;
        font: 400 12px/1.5 ui-monospace, "SF Mono", "SFMono-Regular", Menlo, monospace;
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
      }

      @media (prefers-color-scheme: dark) {
        .translation[${ROOT_ATTR}="debug-panel"] {
          background: rgba(28, 28, 30, 0.97);
          border-color: rgba(255, 255, 255, 0.1);
          color: #f5f5f7;
        }
      }

      .translation [${ROOT_ATTR}="debug-title"] {
        display: block;
        margin: 0 0 10px;
        color: #007aff;
        font: 600 11px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .translation [${ROOT_ATTR}="debug-section-title"] {
        display: block;
        margin: 12px 0 6px;
        color: #6c6c70;
        font-weight: 600;
      }

      .translation [${ROOT_ATTR}="debug-list"] {
        display: block;
        margin: 0;
        padding-left: 18px;
      }

      .translation [${ROOT_ATTR}="debug-list"] li {
        margin: 0 0 4px;
      }

      @media (max-width: 640px) {
        .translation[${ROOT_ATTR}="note"] {
          margin: min(${inlineAppearance.marginTopPx}px, 14px) 0 min(${inlineAppearance.marginBottomPx}px, 20px);
          padding: min(${inlineAppearance.paddingVerticalPx}px, 12px) min(${inlineAppearance.paddingHorizontalPx}px, 13px);
          border-radius: 0 min(${inlineAppearance.borderRadiusPx}px, 7px) min(${inlineAppearance.borderRadiusPx}px, 7px) 0;
        }

        .translation[${ROOT_ATTR}="selection-panel"] {
          right: 10px;
          left: 10px;
          bottom: 10px;
          width: auto;
          max-width: none;
        }

        .translation[${ROOT_ATTR}="debug-panel"] {
          right: 10px;
          left: 10px;
          bottom: 10px;
          width: auto;
          max-width: none;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .translation[${ROOT_ATTR}="note"][data-phase="ready"],
        .translation[${ROOT_ATTR}="selection-panel"],
        .ot-youtube-translate-button[data-state="loading"] svg,
        .translation [${ROOT_ATTR}="note-body"][data-state="pending"],
        .translation [${ROOT_ATTR}="selection-panel-skeleton"] > span {
          animation: none;
        }
      }

      @keyframes ot-control-pulse {
        from {
          opacity: 0.52;
          transform: scale(0.92);
        }

        to {
          opacity: 1;
          transform: scale(1);
        }
      }

      @keyframes ot-shimmer {
        0% {
          background-position: 200% 0;
        }

        100% {
          background-position: -200% 0;
        }
      }

      @keyframes ot-panel-in {
        from {
          opacity: 0;
          transform: translateY(3px) scale(0.99);
        }

        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      @keyframes ot-fade-in {
        from {
          opacity: 0;
          transform: translateY(4px);
        }

        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
    `
}
