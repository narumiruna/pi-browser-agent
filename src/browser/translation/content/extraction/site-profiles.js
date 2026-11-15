const SAFE_EMPTY_SELECTOR = ":not(*)"
const DEFAULT_PROFILE_ID = "default"
const ANTIREZ_PROSE_CONTAINER_SELECTOR = "article.comment > pre"
const ANTIREZ_PROSE_TEXT_SELECTOR = "article.comment > pre > [data-ot-prose-block]"
const CARMINA_ARTICLE_ROOT_SELECTOR = "main #module-special-category-header"
const CARMINA_ARTICLE_TEXT_SELECTOR = `${CARMINA_ARTICLE_ROOT_SELECTOR} .html-output`
const DISQUS_COMMENT_TEXT_SELECTOR = '[data-role="message"] p'
const FINDY_ARTICLE_ROOT_SELECTOR = ".p-single__wrap"
const GITHUB_MAIN_CONTENT_SELECTOR =
  'main .Layout-main, main [data-component="SplitPageLayout.Content"]'
const GITHUB_MARKDOWN_TEXT_SELECTOR = ".markdown-body p, .markdown-body li"
const REDDIT_ROOT_SELECTOR = "main"
const SCHIIT_ARTICLE_ROOT_SELECTOR = "body:where(.faq, .guides) #content-box .product > .pad"
const SCHIIT_ARTICLE_TEXT_SELECTOR = `${SCHIIT_ARTICLE_ROOT_SELECTOR} > .body > div`
const X_TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]'
const X_ARTICLE_TITLE_SELECTOR = '[data-testid="twitter-article-title"]'
const X_ARTICLE_TEXT_SELECTOR =
  '[data-testid="twitterArticleRichTextView"] :is(div[data-block="true"], div.longform-unstyled):not(section[data-block="true"] *)'
const X_CURRENT_POST_TEXT_SELECTOR = 'article div[dir="auto"].whitespace-pre-wrap:has(> span)'
const THREADS_TEXT_BLOCK_SELECTOR = 'div[lang]:has(> div > span[dir="auto"])'
const YOUTUBE_CAPTION_ROOT_SELECTOR = "#ytp-caption-window-container"
const YOUTUBE_CAPTION_TEXT_SELECTOR = `${YOUTUBE_CAPTION_ROOT_SELECTOR} .ytp-caption-segment`
const DEFAULT_SITE_PROFILE = Object.freeze({
  id: DEFAULT_PROFILE_ID,
  hosts: Object.freeze([]),
  textBlockSelectors: Object.freeze([]),
  rootSelectors: Object.freeze([]),
  splitContainerSelectors: Object.freeze([]),
  embeddedFramePatterns: Object.freeze([]),
  allowAncestorTransforms: false,
  dynamic: false,
  presentation: "inline",
  requireRoot: false,
  windowed: true,
})
const SITE_PROFILES = Object.freeze([
  Object.freeze({
    id: "antirez",
    hosts: Object.freeze(["antirez.com", "www.antirez.com"]),
    textBlockSelectors: Object.freeze([ANTIREZ_PROSE_TEXT_SELECTOR]),
    rootSelectors: Object.freeze(["#content"]),
    splitContainerSelectors: Object.freeze([ANTIREZ_PROSE_CONTAINER_SELECTOR]),
    embeddedFramePatterns: Object.freeze(["https://disqus.com/*"]),
  }),
  Object.freeze({
    id: "carmina-article",
    hosts: Object.freeze(["carminashoemaker.com", "www.carminashoemaker.com"]),
    textBlockSelectors: Object.freeze([CARMINA_ARTICLE_TEXT_SELECTOR]),
    rootSelectors: Object.freeze([CARMINA_ARTICLE_ROOT_SELECTOR]),
  }),
  Object.freeze({
    id: "disqus",
    hosts: Object.freeze(["disqus.com"]),
    textBlockSelectors: Object.freeze([DISQUS_COMMENT_TEXT_SELECTOR]),
    rootSelectors: Object.freeze(["#posts"]),
    windowed: false,
  }),
  Object.freeze({
    id: "findy-article",
    hosts: Object.freeze(["findy.co.jp", "www.findy.co.jp"]),
    rootSelectors: Object.freeze([FINDY_ARTICLE_ROOT_SELECTOR]),
  }),
  Object.freeze({
    id: "github",
    hosts: Object.freeze(["github.com", "www.github.com"]),
    textBlockSelectors: Object.freeze([GITHUB_MARKDOWN_TEXT_SELECTOR]),
    rootSelectors: Object.freeze([GITHUB_MAIN_CONTENT_SELECTOR]),
  }),
  Object.freeze({
    id: "reddit",
    hosts: Object.freeze(["reddit.com", "www.reddit.com"]),
    rootSelectors: Object.freeze([REDDIT_ROOT_SELECTOR]),
  }),
  Object.freeze({
    id: "schiit-article",
    hosts: Object.freeze(["schiit.com", "www.schiit.com"]),
    textBlockSelectors: Object.freeze([SCHIIT_ARTICLE_TEXT_SELECTOR]),
    rootSelectors: Object.freeze([SCHIIT_ARTICLE_ROOT_SELECTOR]),
  }),
  Object.freeze({
    id: "youtube",
    hosts: Object.freeze(["youtube.com", "www.youtube.com", "m.youtube.com"]),
    textBlockSelectors: Object.freeze([YOUTUBE_CAPTION_TEXT_SELECTOR]),
    rootSelectors: Object.freeze([YOUTUBE_CAPTION_ROOT_SELECTOR]),
    dynamic: true,
    presentation: "subtitle",
    requireRoot: true,
    windowed: false,
  }),
  Object.freeze({
    id: "x",
    hosts: Object.freeze([
      "x.com",
      "www.x.com",
      "twitter.com",
      "www.twitter.com",
      "mobile.twitter.com",
    ]),
    textBlockSelectors: Object.freeze([
      X_TWEET_TEXT_SELECTOR,
      X_CURRENT_POST_TEXT_SELECTOR,
      X_ARTICLE_TITLE_SELECTOR,
      X_ARTICLE_TEXT_SELECTOR,
    ]),
    rootSelectors: Object.freeze([
      '[data-testid="primaryColumn"]',
      'main:not(:has([data-testid="primaryColumn"]))',
    ]),
    allowAncestorTransforms: true,
  }),
  Object.freeze({
    id: "threads",
    hosts: Object.freeze(["threads.net", "www.threads.net"]),
    textBlockSelectors: Object.freeze([THREADS_TEXT_BLOCK_SELECTOR]),
  }),
])

function normalizeHostname(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/u, "")
}

function normalizeSelectorList(selectors) {
  return (Array.isArray(selectors) ? selectors : [selectors])
    .map((selector) => String(selector || "").trim())
    .filter(Boolean)
}

function buildSelector(selectors, fallback = SAFE_EMPTY_SELECTOR) {
  const normalized = normalizeSelectorList(selectors)

  return normalized.length > 0 ? normalized.join(", ") : fallback
}

function buildProfileSelectors(defaultSelectors, profileSelectors, fallback = SAFE_EMPTY_SELECTOR) {
  return buildSelector(
    [...normalizeSelectorList(defaultSelectors), ...normalizeSelectorList(profileSelectors)],
    fallback,
  )
}

function resolveSiteProfile(hostname) {
  const normalizedHostname = normalizeHostname(hostname)

  for (const profile of SITE_PROFILES) {
    if (profile.hosts.includes(normalizedHostname)) {
      return profile
    }
  }

  return DEFAULT_SITE_PROFILE
}

function getActiveSiteProfile(locationLike) {
  return resolveSiteProfile(locationLike?.hostname || locationLike || "")
}

export {
  ANTIREZ_PROSE_CONTAINER_SELECTOR,
  ANTIREZ_PROSE_TEXT_SELECTOR,
  buildProfileSelectors,
  buildSelector,
  CARMINA_ARTICLE_ROOT_SELECTOR,
  CARMINA_ARTICLE_TEXT_SELECTOR,
  DEFAULT_PROFILE_ID,
  DEFAULT_SITE_PROFILE,
  DISQUS_COMMENT_TEXT_SELECTOR,
  FINDY_ARTICLE_ROOT_SELECTOR,
  GITHUB_MAIN_CONTENT_SELECTOR,
  GITHUB_MARKDOWN_TEXT_SELECTOR,
  getActiveSiteProfile,
  normalizeHostname,
  normalizeSelectorList,
  REDDIT_ROOT_SELECTOR,
  resolveSiteProfile,
  SAFE_EMPTY_SELECTOR,
  SCHIIT_ARTICLE_ROOT_SELECTOR,
  SCHIIT_ARTICLE_TEXT_SELECTOR,
  SITE_PROFILES,
  THREADS_TEXT_BLOCK_SELECTOR,
  X_ARTICLE_TEXT_SELECTOR,
  X_ARTICLE_TITLE_SELECTOR,
  X_CURRENT_POST_TEXT_SELECTOR,
  X_TWEET_TEXT_SELECTOR,
  YOUTUBE_CAPTION_ROOT_SELECTOR,
  YOUTUBE_CAPTION_TEXT_SELECTOR,
}
