function getEmbeddedFramePatterns(pageUrl, siteProfiles) {
  try {
    const profile = siteProfiles?.resolveSiteProfile?.(new URL(pageUrl).hostname)

    return Array.isArray(profile?.embeddedFramePatterns) ? [...profile.embeddedFramePatterns] : []
  } catch (_error) {
    return []
  }
}

function matchesFramePattern(frameUrl, pattern) {
  try {
    const url = new URL(frameUrl)
    const patternUrl = new URL(pattern)
    const wildcardIndex = patternUrl.pathname.indexOf("*")
    const pathPrefix =
      wildcardIndex >= 0 ? patternUrl.pathname.slice(0, wildcardIndex) : patternUrl.pathname

    return url.origin === patternUrl.origin && url.pathname.startsWith(pathPrefix)
  } catch (_error) {
    return false
  }
}

function filterEmbeddedFrameResults(results, patterns) {
  const matched = []

  for (const result of results || []) {
    const frameId = result?.frameId
    const url = typeof result?.result === "string" ? result.result : ""

    if (
      !Number.isInteger(frameId) ||
      frameId <= 0 ||
      !patterns?.some((pattern) => matchesFramePattern(url, pattern))
    ) {
      continue
    }

    matched.push({ frameId, url })
  }

  return matched
}

async function discoverEmbeddedFrames(options) {
  if (options.translation) return options.translation.frames({ tabId: options.tabId })
  const patterns = getEmbeddedFramePatterns(options?.pageUrl, options?.siteProfiles)

  if (patterns.length === 0) {
    return []
  }

  try {
    const permissionRequest = { origins: patterns }
    const hasPermission = await options.permissions.contains(permissionRequest)

    if (!hasPermission && !(await options.permissions.request(permissionRequest))) {
      return []
    }

    const results = await options.scripting.executeScript({
      target: { tabId: options.tabId, allFrames: true },
      func: () => location.href,
    })

    return filterEmbeddedFrameResults(results, patterns)
  } catch (_error) {
    return []
  }
}

export {
  discoverEmbeddedFrames,
  filterEmbeddedFrameResults,
  getEmbeddedFramePatterns,
  matchesFramePattern,
}
