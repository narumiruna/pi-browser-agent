export function createPageProfile(options = {}) {
  const {
    document,
    Node,
    contentRules,
    detectContentMode,
    isInsideTranslation,
    mainContentSelector,
    normalizeSegmentText,
    proseBlockAttr,
    proseSplitAttr,
    scoreTranslationRoot,
    semanticBlockSelector,
    rootAttr,
  } = options
  const siteRootSelector = contentRules?.selectors?.SITE_ROOT_SELECTOR || ":not(*)"
  const splitContainerSelector = contentRules?.selectors?.SPLIT_CONTAINER_SELECTOR || ":not(*)"

  function getRootCandidates() {
    const candidates = new Set()

    for (const element of document.querySelectorAll(mainContentSelector)) {
      candidates.add(element)
    }

    if (document.body) {
      candidates.add(document.body)
    }

    return Array.from(candidates)
  }

  function isTranslatorOwned(element) {
    return Boolean(element?.closest?.(`[${rootAttr}]`))
  }

  function scoreRoot(element) {
    return scoreTranslationRoot(element, {
      document,
      isInsideTranslation,
      isTranslatorOwned,
    })
  }

  function splitContainer(container) {
    if (!container || container.hasAttribute(proseSplitAttr)) {
      return
    }

    const originalNodes = Array.from(container.childNodes)
    const output = document.createDocumentFragment()
    let block = document.createElement("span")

    block.setAttribute(proseBlockAttr, "")

    function flushBlock() {
      if (
        !normalizeSegmentText(block.textContent || "") &&
        !Array.from(block.childNodes).some((node) => node.nodeType !== Node.TEXT_NODE)
      ) {
        return
      }

      output.appendChild(block)
      block = document.createElement("span")
      block.setAttribute(proseBlockAttr, "")
    }

    for (const node of originalNodes) {
      if (node.nodeType !== Node.TEXT_NODE) {
        block.appendChild(node)
        continue
      }

      for (const part of String(node.textContent || "").split(/(\n[ \t]*\n+)/)) {
        if (!part) {
          continue
        }

        if (/^\n[ \t]*\n+$/u.test(part)) {
          flushBlock()
          output.appendChild(document.createTextNode(part))
          continue
        }

        block.appendChild(document.createTextNode(part))
      }
    }

    flushBlock()
    container.replaceChildren(output)
    container.setAttribute(proseSplitAttr, "true")
  }

  function prepareSplitContainers() {
    for (const container of document.querySelectorAll(splitContainerSelector)) {
      splitContainer(container)
    }
  }

  function getTranslationProfile() {
    const siteRoot = Array.from(document.querySelectorAll(siteRootSelector)).find((candidate) =>
      Number.isFinite(scoreRoot(candidate)),
    )
    const requireSiteRoot = contentRules?.requireRoot === true
    const candidates = siteRoot || requireSiteRoot ? [] : getRootCandidates()
    let root = siteRoot || (requireSiteRoot ? null : document.body)
    let bestScore = Number.NEGATIVE_INFINITY
    let bestNonBodyRoot = null
    let bestNonBodyScore = Number.NEGATIVE_INFINITY

    for (const candidate of candidates) {
      const score = scoreRoot(candidate)

      if (score > bestScore) {
        bestScore = score
        root = candidate
      }

      if (candidate !== document.body && score > bestNonBodyScore) {
        bestNonBodyScore = score
        bestNonBodyRoot = candidate
      }
    }

    if (root === document.body && bestNonBodyRoot && bestNonBodyScore > 0) {
      root = bestNonBodyRoot
    }

    const mode = detectContentMode(root)
    const semanticCount = root ? root.querySelectorAll(semanticBlockSelector).length : 0

    console.debug(
      `[OpenAI Translator] Using ${root?.tagName ? root.tagName.toLowerCase() : root ? "body" : "no"} root (${mode})`,
    )

    return {
      root,
      mode,
      allowFallback: semanticCount > 0,
      windowed: contentRules?.windowed !== false && mode !== "directory",
    }
  }

  return {
    getTranslationProfile,
    isTranslatorOwned,
    prepareSplitContainers,
    scoreTranslationRoot: scoreRoot,
    splitContainer,
  }
}

export default { createPageProfile }
