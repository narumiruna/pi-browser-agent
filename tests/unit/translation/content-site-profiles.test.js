import assert from "node:assert/strict"
import { test } from "vitest"
import { createContentRulesForProfile } from "../../../src/browser/translation/content/extraction/rules.js"
import {
  ANTIREZ_PROSE_CONTAINER_SELECTOR,
  ANTIREZ_PROSE_TEXT_SELECTOR,
  buildProfileSelectors,
  CARMINA_ARTICLE_ROOT_SELECTOR,
  CARMINA_ARTICLE_TEXT_SELECTOR,
  DISQUS_COMMENT_TEXT_SELECTOR,
  FINDY_ARTICLE_ROOT_SELECTOR,
  GITHUB_MAIN_CONTENT_SELECTOR,
  GITHUB_MARKDOWN_TEXT_SELECTOR,
  getActiveSiteProfile,
  normalizeHostname,
  REDDIT_ROOT_SELECTOR,
  resolveSiteProfile,
  SAFE_EMPTY_SELECTOR,
  SCHIIT_ARTICLE_ROOT_SELECTOR,
  SCHIIT_ARTICLE_TEXT_SELECTOR,
  THREADS_TEXT_BLOCK_SELECTOR,
  X_ARTICLE_TEXT_SELECTOR,
  X_ARTICLE_TITLE_SELECTOR,
  X_CURRENT_POST_TEXT_SELECTOR,
  X_TWEET_TEXT_SELECTOR,
  YOUTUBE_CAPTION_ROOT_SELECTOR,
  YOUTUBE_CAPTION_TEXT_SELECTOR,
} from "../../../src/browser/translation/content/extraction/site-profiles.js"

function createExtractionSelectorsForProfile(profile) {
  return createContentRulesForProfile(profile).selectors
}

test("normalizeHostname lowercases and strips trailing dots", () => {
  assert.equal(normalizeHostname(" WWW.X.COM. "), "www.x.com")
  assert.equal(normalizeHostname("mobile.Twitter.com..."), "mobile.twitter.com")
  assert.equal(normalizeHostname(null), "")
})

test("resolveSiteProfile matches exact built-in hosts", () => {
  const cases = [
    ["x.com", "x"],
    ["www.x.com", "x"],
    ["twitter.com", "x"],
    ["www.twitter.com", "x"],
    ["mobile.twitter.com", "x"],
    ["threads.net", "threads"],
    ["disqus.com", "disqus"],
    ["carminashoemaker.com", "carmina-article"],
    ["www.carminashoemaker.com", "carmina-article"],
    ["findy.co.jp", "findy-article"],
    ["www.findy.co.jp", "findy-article"],
    ["github.com", "github"],
    ["www.github.com", "github"],
    ["reddit.com", "reddit"],
    ["www.reddit.com", "reddit"],
    ["schiit.com", "schiit-article"],
    ["www.schiit.com", "schiit-article"],
    ["www.threads.net", "threads"],
    ["youtube.com", "youtube"],
    ["www.youtube.com", "youtube"],
    ["m.youtube.com", "youtube"],
    ["music.youtube.com", "default"],
    ["old.reddit.com", "default"],
    ["example.com", "default"],
    ["notx.com", "default"],
    ["x.com.evil.example", "default"],
    ["github.com.evil.example", "default"],
    ["reddit.com.evil.example", "default"],
    ["threads.net.evil.example", "default"],
  ]

  for (const [hostname, expectedProfileId] of cases) {
    assert.equal(resolveSiteProfile(hostname).id, expectedProfileId, hostname)
  }
})

test("getActiveSiteProfile accepts location-like objects and host strings", () => {
  assert.equal(getActiveSiteProfile({ hostname: "www.x.com" }).id, "x")
  assert.equal(getActiveSiteProfile("www.threads.net").id, "threads")
  assert.equal(getActiveSiteProfile({}).id, "default")
  assert.equal(getActiveSiteProfile(undefined).id, "default")
  assert.equal(getActiveSiteProfile(null).id, "default")
})

test("buildProfileSelectors filters empty entries and returns a safe empty selector", () => {
  assert.equal(buildProfileSelectors([" p ", ""], [null, "h1"]), "p, h1")
  assert.equal(buildProfileSelectors([], []), SAFE_EMPTY_SELECTOR)
  assert.equal(buildProfileSelectors(undefined, null), SAFE_EMPTY_SELECTOR)
  assert.equal(buildProfileSelectors(" p ", "h1"), "p, h1")
})

test("default extraction selectors exclude site-only social selectors", () => {
  const selectors = createExtractionSelectorsForProfile(resolveSiteProfile("example.com"))

  assert.equal(selectors.EXPLICIT_TEXT_BLOCK_SELECTOR, SAFE_EMPTY_SELECTOR)
  assert.equal(selectors.READABLE_BLOCK_SELECTOR.includes(X_TWEET_TEXT_SELECTOR), false)
  assert.equal(selectors.READABLE_BLOCK_SELECTOR.includes(X_CURRENT_POST_TEXT_SELECTOR), false)
  assert.equal(selectors.READABLE_BLOCK_SELECTOR.includes(THREADS_TEXT_BLOCK_SELECTOR), false)
  for (const selector of [X_ARTICLE_TITLE_SELECTOR, X_ARTICLE_TEXT_SELECTOR]) {
    assert.equal(selectors.READABLE_BLOCK_SELECTOR.includes(selector), false)
    assert.equal(selectors.DIRECT_NOTE_TARGET_SELECTOR.includes(selector), false)
  }
})

test("site profiles compile into generic content capabilities", () => {
  const cases = [
    {
      host: "antirez.com",
      root: "#content",
      text: ANTIREZ_PROSE_TEXT_SELECTOR,
      split: ANTIREZ_PROSE_CONTAINER_SELECTOR,
      frames: ["https://disqus.com/*"],
    },
    {
      host: "carminashoemaker.com",
      root: CARMINA_ARTICLE_ROOT_SELECTOR,
      text: CARMINA_ARTICLE_TEXT_SELECTOR,
    },
    {
      host: "findy.co.jp",
      root: FINDY_ARTICLE_ROOT_SELECTOR,
    },
    {
      host: "github.com",
      root: GITHUB_MAIN_CONTENT_SELECTOR,
      text: GITHUB_MARKDOWN_TEXT_SELECTOR,
    },
    {
      host: "reddit.com",
      root: REDDIT_ROOT_SELECTOR,
    },
    {
      host: "schiit.com",
      root: SCHIIT_ARTICLE_ROOT_SELECTOR,
      text: SCHIIT_ARTICLE_TEXT_SELECTOR,
    },
    {
      host: "x.com",
      root: '[data-testid="primaryColumn"]',
      text: X_TWEET_TEXT_SELECTOR,
      allowAncestorTransforms: true,
    },
    {
      host: "threads.net",
      text: THREADS_TEXT_BLOCK_SELECTOR,
    },
    {
      host: "disqus.com",
      root: "#posts",
      text: DISQUS_COMMENT_TEXT_SELECTOR,
      windowed: false,
    },
  ]

  for (const expected of cases) {
    const profile = resolveSiteProfile(expected.host)
    const rules = createContentRulesForProfile(profile)
    const selectors = rules.selectors

    assert.equal(
      selectors.SITE_ROOT_SELECTOR.includes(expected.root || "missing-root"),
      Boolean(expected.root),
      expected.host,
    )
    assert.equal(
      selectors.EXPLICIT_TEXT_BLOCK_SELECTOR.includes(expected.text || "missing-text"),
      Boolean(expected.text),
      expected.host,
    )
    assert.equal(
      selectors.DIRECT_NOTE_TARGET_SELECTOR.includes(expected.text || "missing-text"),
      Boolean(expected.text),
      expected.host,
    )
    assert.equal(
      selectors.SPLIT_CONTAINER_SELECTOR.includes(expected.split || "missing-split"),
      Boolean(expected.split),
      expected.host,
    )
    assert.deepEqual(rules.embeddedFramePatterns, expected.frames || [])
    assert.equal(rules.windowed, expected.windowed !== false)
    assert.equal(rules.allowAncestorTransforms, expected.allowAncestorTransforms === true)
  }
})

test("site text selectors default to direct note targets without duplication", () => {
  for (const hostname of [
    "antirez.com",
    "carminashoemaker.com",
    "schiit.com",
    "x.com",
    "threads.net",
    "disqus.com",
  ]) {
    const profile = resolveSiteProfile(hostname)

    assert.equal(Object.hasOwn(profile, "directNoteTargetSelectors"), false, hostname)
    assert.ok(profile.textBlockSelectors.length > 0, hostname)
  }

  const findyProfile = resolveSiteProfile("findy.co.jp")
  assert.deepEqual(Object.keys(findyProfile).sort(), ["hosts", "id", "rootSelectors"])
})

test("YouTube extraction is restricted to persistent native caption text", () => {
  const profile = resolveSiteProfile("www.youtube.com")
  const rules = createContentRulesForProfile(profile)
  const selectors = rules.selectors

  assert.equal(rules.dynamic, true)
  assert.equal(rules.presentation, "subtitle")
  assert.equal(rules.requireRoot, true)
  assert.equal(rules.windowed, false)
  assert.deepEqual(profile.rootSelectors, [YOUTUBE_CAPTION_ROOT_SELECTOR])
  assert.equal(selectors.SITE_ROOT_SELECTOR, YOUTUBE_CAPTION_ROOT_SELECTOR)
  assert.equal(YOUTUBE_CAPTION_TEXT_SELECTOR, "#ytp-caption-window-container .ytp-caption-segment")
  assert.ok(selectors.READABLE_BLOCK_SELECTOR.includes(YOUTUBE_CAPTION_TEXT_SELECTOR))
  assert.ok(selectors.DIRECT_NOTE_TARGET_SELECTOR.includes(YOUTUBE_CAPTION_TEXT_SELECTOR))
})

test("Antirez profile declares its Disqus embedded frame", () => {
  assert.deepEqual(resolveSiteProfile("antirez.com").embeddedFramePatterns, [
    "https://disqus.com/*",
  ])
})

test("Disqus extraction targets comment text without discussion controls", () => {
  const selectors = createExtractionSelectorsForProfile(resolveSiteProfile("disqus.com"))

  assert.equal(resolveSiteProfile("disqus.com").windowed, false)
  assert.equal(selectors.SITE_ROOT_SELECTOR, "#posts")
  assert.ok(selectors.READABLE_BLOCK_SELECTOR.includes(DISQUS_COMMENT_TEXT_SELECTOR))
  assert.ok(selectors.DIRECT_NOTE_TARGET_SELECTOR.includes(DISQUS_COMMENT_TEXT_SELECTOR))
})

test("Carmina leather extraction targets the primary description", () => {
  const profile = resolveSiteProfile("www.carminashoemaker.com")
  const selectors = createExtractionSelectorsForProfile(profile)

  assert.deepEqual(profile.rootSelectors, [CARMINA_ARTICLE_ROOT_SELECTOR])
  assert.equal(selectors.SITE_ROOT_SELECTOR, CARMINA_ARTICLE_ROOT_SELECTOR)
  assert.ok(selectors.READABLE_BLOCK_SELECTOR.includes(CARMINA_ARTICLE_TEXT_SELECTOR))
  assert.ok(selectors.DIRECT_NOTE_TARGET_SELECTOR.includes(CARMINA_ARTICLE_TEXT_SELECTOR))
})

test("Findy article extraction stays inside the news article", () => {
  const profile = resolveSiteProfile("findy.co.jp")
  const selectors = createExtractionSelectorsForProfile(profile)

  assert.deepEqual(profile.rootSelectors, [FINDY_ARTICLE_ROOT_SELECTOR])
  assert.equal(selectors.SITE_ROOT_SELECTOR, FINDY_ARTICLE_ROOT_SELECTOR)
})

test("GitHub extraction excludes pull request sidebars", () => {
  const profile = resolveSiteProfile("github.com")
  const selectors = createExtractionSelectorsForProfile(profile)

  assert.deepEqual(profile.rootSelectors, [GITHUB_MAIN_CONTENT_SELECTOR])
  assert.equal(selectors.SITE_ROOT_SELECTOR, GITHUB_MAIN_CONTENT_SELECTOR)
  assert.match(GITHUB_MAIN_CONTENT_SELECTOR, /\.Layout-main/u)
  assert.match(GITHUB_MAIN_CONTENT_SELECTOR, /SplitPageLayout\.Content/u)
  assert.doesNotMatch(GITHUB_MAIN_CONTENT_SELECTOR, /Sidebar/u)
})

test("GitHub Markdown prose receives explicit text-block scoring", () => {
  const profile = resolveSiteProfile("github.com")
  const selectors = createExtractionSelectorsForProfile(profile)
  assert.deepEqual(profile.textBlockSelectors, [GITHUB_MARKDOWN_TEXT_SELECTOR])
  assert.equal(selectors.EXPLICIT_TEXT_BLOCK_SELECTOR, ".markdown-body p, .markdown-body li")
})

test("Reddit extraction stays rooted at the main post and comments region", () => {
  const profile = resolveSiteProfile("www.reddit.com")
  const selectors = createExtractionSelectorsForProfile(profile)

  assert.deepEqual(profile.rootSelectors, [REDDIT_ROOT_SELECTOR])
  assert.equal(selectors.SITE_ROOT_SELECTOR, REDDIT_ROOT_SELECTOR)
  assert.equal(selectors.EXPLICIT_TEXT_BLOCK_SELECTOR, SAFE_EMPTY_SELECTOR)
})

test("Schiit article extraction includes FAQ and guide div text blocks", () => {
  const profile = resolveSiteProfile("www.schiit.com")
  const selectors = createExtractionSelectorsForProfile(profile)

  assert.deepEqual(profile.rootSelectors, [SCHIIT_ARTICLE_ROOT_SELECTOR])
  assert.equal(selectors.SITE_ROOT_SELECTOR, SCHIIT_ARTICLE_ROOT_SELECTOR)
  assert.match(SCHIIT_ARTICLE_ROOT_SELECTOR, /body:where\(\.faq, \.guides\)/)
  assert.match(SCHIIT_ARTICLE_TEXT_SELECTOR, /> \.body > div$/)
  assert.ok(selectors.READABLE_BLOCK_SELECTOR.includes(SCHIIT_ARTICLE_TEXT_SELECTOR))
  assert.ok(selectors.DIRECT_NOTE_TARGET_SELECTOR.includes(SCHIIT_ARTICLE_TEXT_SELECTOR))
})

test("X extraction stays rooted at the scrolling post feed", () => {
  const profile = resolveSiteProfile("x.com")
  const selectors = createExtractionSelectorsForProfile(profile)

  assert.deepEqual(profile.rootSelectors, [
    '[data-testid="primaryColumn"]',
    'main:not(:has([data-testid="primaryColumn"]))',
  ])
  assert.equal(
    selectors.SITE_ROOT_SELECTOR,
    '[data-testid="primaryColumn"], main:not(:has([data-testid="primaryColumn"]))',
  )
})

test("X post selector does not require a tweet identity attribute", () => {
  assert.equal(
    X_CURRENT_POST_TEXT_SELECTOR,
    'article div[dir="auto"].whitespace-pre-wrap:has(> span)',
  )
})

test("X extraction selectors include X post text direct note targets", () => {
  const selectors = createExtractionSelectorsForProfile(resolveSiteProfile("x.com"))

  assert.ok(selectors.READABLE_BLOCK_SELECTOR.includes(X_TWEET_TEXT_SELECTOR))
  assert.ok(selectors.READABLE_BLOCK_SELECTOR.includes(X_CURRENT_POST_TEXT_SELECTOR))
  assert.ok(selectors.DIRECT_NOTE_TARGET_SELECTOR.includes(X_CURRENT_POST_TEXT_SELECTOR))
})

test("X Article title and Draft.js text are readable direct note targets", () => {
  const profile = resolveSiteProfile("x.com")
  const selectors = createExtractionSelectorsForProfile(profile)

  assert.equal(X_ARTICLE_TITLE_SELECTOR, '[data-testid="twitter-article-title"]')
  assert.equal(
    X_ARTICLE_TEXT_SELECTOR,
    '[data-testid="twitterArticleRichTextView"] :is(div[data-block="true"], div.longform-unstyled):not(section[data-block="true"] *)',
  )
  for (const selector of [X_ARTICLE_TITLE_SELECTOR, X_ARTICLE_TEXT_SELECTOR]) {
    assert.ok(profile.textBlockSelectors.includes(selector))
    assert.ok(selectors.READABLE_BLOCK_SELECTOR.includes(selector))
    assert.ok(selectors.EXPLICIT_TEXT_BLOCK_SELECTOR.includes(selector))
    assert.ok(selectors.DIRECT_NOTE_TARGET_SELECTOR.includes(selector))
  }
})

test("Threads extraction selectors include Threads post text direct note targets", () => {
  const selectors = createExtractionSelectorsForProfile(resolveSiteProfile("threads.net"))

  assert.ok(selectors.READABLE_BLOCK_SELECTOR.includes(THREADS_TEXT_BLOCK_SELECTOR))
  assert.ok(selectors.DIRECT_NOTE_TARGET_SELECTOR.includes(THREADS_TEXT_BLOCK_SELECTOR))
})
