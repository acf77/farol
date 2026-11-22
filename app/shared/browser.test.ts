import { describe, expect, it } from 'vitest'
import { isHttpUrl, normalizeBrowserUrl, parseBrowserBounds } from './browser'

describe('isHttpUrl', () => {
  it('allows http and https only', () => {
    expect(isHttpUrl('https://example.com')).toBe(true)
    expect(isHttpUrl('http://localhost:3000')).toBe(true)
    expect(isHttpUrl('file:///tmp/x')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
  })
})

describe('normalizeBrowserUrl', () => {
  it('keeps http and https links', () => {
    expect(normalizeBrowserUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(normalizeBrowserUrl(' http://example.com ')).toBe('http://example.com/')
  })

  it('opens local addresses over http', () => {
    expect(normalizeBrowserUrl('localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeBrowserUrl('5173')).toBe('http://localhost:5173/')
    expect(normalizeBrowserUrl('127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x')
  })

  it('uses https for a bare host', () => {
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com/')
  })

  it('refuses other schemes and bad input', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'a b', '', 42, null]) {
      expect(normalizeBrowserUrl(bad)).toBeNull()
    }
  })
})

describe('parseBrowserBounds', () => {
  it('rounds to whole pixels', () => {
    expect(parseBrowserBounds({ x: 1.4, y: 2.6, width: 100.2, height: 50.5 })).toEqual({
      x: 1,
      y: 3,
      width: 100,
      height: 51
    })
  })

  it('refuses bad numbers', () => {
    expect(parseBrowserBounds({ x: 0, y: 0, width: Infinity, height: 1 })).toBeNull()
    expect(parseBrowserBounds({ x: 0, y: 0, width: 1e9, height: 1 })).toBeNull()
    expect(parseBrowserBounds({ x: 0, y: 0, width: 1 })).toBeNull()
    expect(parseBrowserBounds(null)).toBeNull()
  })
})
