import assert from "node:assert/strict"
import { test } from "vitest"

import * as SiteProfiles from "../../../src/browser/translation/content/extraction/site-profiles.js"
import {
  discoverEmbeddedFrames,
  filterEmbeddedFrameResults,
  getEmbeddedFramePatterns,
  matchesFramePattern,
} from "../../../src/browser/translation/shared/embedded-frames.js"

test("embedded frame patterns come from the top-page site profile", () => {
  assert.deepEqual(getEmbeddedFramePatterns("https://antirez.com/news/169", SiteProfiles), [
    "https://disqus.com/*",
  ])
  assert.deepEqual(getEmbeddedFramePatterns("https://example.com/article", SiteProfiles), [])
})

test("frame pattern matching requires the declared origin and path", () => {
  assert.equal(
    matchesFramePattern("https://disqus.com/embed/comments/?thread=1", "https://disqus.com/*"),
    true,
  )
  assert.equal(
    matchesFramePattern("https://disqus.com.evil.example/embed/comments/", "https://disqus.com/*"),
    false,
  )
  assert.equal(matchesFramePattern("https://example.com/", "malformed"), false)
})

test("embedded frame discovery preserves top-page behavior when permission is denied", async () => {
  let executed = false
  const frames = await discoverEmbeddedFrames({
    pageUrl: "https://antirez.com/news/169",
    permissions: {
      contains: async () => false,
      request: async () => false,
    },
    scripting: {
      executeScript: async () => {
        executed = true
        return []
      },
    },
    siteProfiles: SiteProfiles,
    tabId: 3,
  })

  assert.deepEqual(frames, [])
  assert.equal(executed, false)
})

test("embedded frame discovery filters accessible frames after permission", async () => {
  const frames = await discoverEmbeddedFrames({
    pageUrl: "https://antirez.com/news/169",
    permissions: {
      contains: async () => true,
      request: async () => {
        throw new Error("permission request should not run")
      },
    },
    scripting: {
      executeScript: async ({ target }) => {
        assert.deepEqual(target, { allFrames: true, tabId: 3 })
        return [
          { frameId: 0, result: "https://antirez.com/news/169" },
          { frameId: 4, result: "https://disqus.com/embed/comments/" },
        ]
      },
    },
    siteProfiles: SiteProfiles,
    tabId: 3,
  })

  assert.deepEqual(frames, [{ frameId: 4, url: "https://disqus.com/embed/comments/" }])
})

test("embedded frame filtering excludes the top frame and unrelated frames", () => {
  assert.deepEqual(
    filterEmbeddedFrameResults(
      [
        { frameId: 0, result: "https://antirez.com/news/169" },
        {
          frameId: 4,
          result: "https://disqus.com/embed/comments/?thread=1",
        },
        { frameId: 7, result: "https://tracker.example/pixel" },
        { frameId: 8, result: null },
      ],
      ["https://disqus.com/*"],
    ),
    [
      {
        frameId: 4,
        url: "https://disqus.com/embed/comments/?thread=1",
      },
    ],
  )
})
