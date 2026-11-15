import { resolveSiteProfile } from "../extraction/site-profiles.js"

const CONTROL_ATTR = "data-ot-youtube-control"
const CONTROL_SELECTOR = `[${CONTROL_ATTR}]`
const handledClickEvents = new WeakSet()
const playerControlBindings = new WeakMap()
const PLAYER_SELECTOR = "#movie_player"
const CAPTION_BUTTON_SELECTOR = ".ytp-subtitles-button"
const RIGHT_CONTROLS_LEFT_SELECTOR = ".ytp-right-controls-left"
const ICON_PATH =
  "M7 5.5C7 4.12 8.12 3 9.5 3h5C15.88 3 17 4.12 17 5.5v7c0 1.38-1.12 2.5-2.5 2.5H13l-2.5 2.25V15h-1A2.5 2.5 0 0 1 7 12.5v-7Zm2.5-.75a.75.75 0 0 0-.75.75v7c0 .41.34.75.75.75h2.75v.08l.79-.71.21-.19h1.25a.75.75 0 0 0 .75-.75V5.5a.75.75 0 0 0-.75-.75h-5ZM4 7.5c0-.95.53-1.78 1.3-2.2v7.2c0 1.77 1.43 3.2 3.2 3.2h.75v1.55L8.42 18H6.5A2.5 2.5 0 0 1 4 15.5v-8Zm7.18-1.38h1.64l1.93 5.75h-1.53l-.35-1.18h-1.83l-.35 1.18H9.25l1.93-5.75Zm.22 3.35h1.1l-.55-1.85-.55 1.85Z"

function isYoutubeWatchLocation(locationLike) {
  const profile = resolveSiteProfile(locationLike?.hostname)
  const pathname = String(locationLike?.pathname || "")
  const search = new URLSearchParams(String(locationLike?.search || ""))

  return Boolean(
    profile.id === "youtube" &&
      ((pathname === "/watch" && search.get("v")) || /^\/shorts\/[^/]+/u.test(pathname)),
  )
}

function getVisibleYoutubeCaptionText(documentLike) {
  return Array.from(
    documentLike?.querySelectorAll?.("#ytp-caption-window-container .ytp-caption-segment") || [],
  )
    .map((segment) => String(segment.textContent || "").trim())
    .filter(Boolean)
    .join("\n")
}

function getYoutubeCaptionTracks(playerResponse) {
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks

  return Array.isArray(tracks) ? tracks : []
}

function hasAvailableYoutubeCaptionTrack(playerResponse) {
  return getYoutubeCaptionTracks(playerResponse).length > 0
}

function findYoutubePlayerControlAnchor(player) {
  const captionButton = player?.querySelector?.(CAPTION_BUTTON_SELECTOR)

  if (captionButton?.parentElement) {
    return {
      controls: captionButton.parentElement,
      reference: captionButton,
    }
  }

  const controls = player?.querySelector?.(RIGHT_CONTROLS_LEFT_SELECTOR)

  return controls ? { controls, reference: null } : null
}

function turnOnNativeYoutubeCaptions(player, playerResponse) {
  const captionButton = player?.querySelector?.(CAPTION_BUTTON_SELECTOR)

  if (!captionButton) {
    return false
  }

  if (captionButton.getAttribute("aria-pressed") === "true") {
    return true
  }

  if (
    hasAvailableYoutubeCaptionTrack(playerResponse) ||
    !String(captionButton.getAttribute("aria-label") || "").match(/unavailable/i)
  ) {
    captionButton.click()

    if (
      captionButton.getAttribute("aria-pressed") !== "true" &&
      hasAvailableYoutubeCaptionTrack(playerResponse)
    ) {
      const firstTrack = getYoutubeCaptionTracks(playerResponse)[0]
      player?.setOption?.("captions", "track", {
        languageCode: firstTrack.languageCode,
        kind: firstTrack.kind || "",
        name: firstTrack.name?.simpleText || "",
      })
    }
  }

  return captionButton.getAttribute("aria-pressed") === "true"
}

function createControlIcon(documentLike) {
  const svg = documentLike.createElementNS("http://www.w3.org/2000/svg", "svg")
  const path = documentLike.createElementNS("http://www.w3.org/2000/svg", "path")

  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("width", "100%")
  svg.setAttribute("height", "100%")
  path.setAttribute("d", ICON_PATH)
  path.setAttribute("fill", "currentColor")
  svg.appendChild(path)

  return svg
}

function handleYoutubePlayerControlClick(event, control, onClick) {
  if (!event || handledClickEvents.has(event)) {
    return false
  }

  handledClickEvents.add(event)
  onClick?.(event, control)

  return true
}

function bindYoutubePlayerControl(documentLike, onClick) {
  if (!documentLike?.addEventListener) {
    return false
  }

  const existingBinding = playerControlBindings.get(documentLike)

  if (existingBinding) {
    existingBinding.onClick = onClick
    return false
  }

  const binding = {
    handleClick(event) {
      const control = event.target?.closest?.(CONTROL_SELECTOR)
      const player = documentLike.querySelector?.(PLAYER_SELECTOR)

      if (control && player?.contains?.(control)) {
        handleYoutubePlayerControlClick(event, control, binding.onClick)
      }
    },
    onClick,
  }

  documentLike.addEventListener("click", binding.handleClick, true)
  playerControlBindings.set(documentLike, binding)

  return true
}

function unbindYoutubePlayerControl(documentLike) {
  const binding = playerControlBindings.get(documentLike)

  if (!binding) {
    return false
  }

  documentLike.removeEventListener?.("click", binding.handleClick, true)
  playerControlBindings.delete(documentLike)
  return true
}

function createYoutubePlayerControl(options = {}) {
  const documentLike = options.document || globalThis.document
  const button = documentLike.createElement("button")

  button.className = "ytp-button ot-youtube-translate-button"
  button.type = "button"
  button.setAttribute(CONTROL_ATTR, "")
  button.setAttribute("data-priority", "4")
  button.appendChild(createControlIcon(documentLike))
  button.addEventListener("click", (event) => {
    handleYoutubePlayerControlClick(event, button, options.onClick)
  })

  return button
}

function mountYoutubePlayerControl(options = {}) {
  const documentLike = options.document || globalThis.document

  bindYoutubePlayerControl(documentLike, options.onClick)

  if (!isYoutubeWatchLocation(options.location || globalThis.location)) {
    documentLike.querySelector?.(CONTROL_SELECTOR)?.remove?.()
    return null
  }

  const player = documentLike.querySelector?.(PLAYER_SELECTOR)
  const anchor = findYoutubePlayerControlAnchor(player)

  if (!anchor) {
    return null
  }

  let button = player.querySelector?.(CONTROL_SELECTOR)

  if (!button) {
    button = createYoutubePlayerControl(options)
  }

  if (
    anchor.reference &&
    (button.parentElement !== anchor.controls || button.nextElementSibling !== anchor.reference)
  ) {
    anchor.controls.insertBefore(button, anchor.reference)
  } else if (!anchor.reference && button.parentElement !== anchor.controls) {
    anchor.controls.appendChild(button)
  }

  return button
}

export {
  bindYoutubePlayerControl,
  CAPTION_BUTTON_SELECTOR,
  CONTROL_ATTR,
  CONTROL_SELECTOR,
  createYoutubePlayerControl,
  findYoutubePlayerControlAnchor,
  getVisibleYoutubeCaptionText,
  getYoutubeCaptionTracks,
  handleYoutubePlayerControlClick,
  hasAvailableYoutubeCaptionTrack,
  isYoutubeWatchLocation,
  mountYoutubePlayerControl,
  PLAYER_SELECTOR,
  turnOnNativeYoutubeCaptions,
  unbindYoutubePlayerControl,
}
