/**
 * A small, safe Markdown renderer for AI answers. Everything is escaped
 * first; only the constructs below become HTML. No raw HTML and no images:
 * an answer can never load a remote URL by itself (that would let page
 * content smuggle data out through an image request).
 *
 * Classic script so it works in content scripts too: sets
 * globalThis.CMMarkdown = { render(markdown, options) }.
 * options.timestamps turns [mm:ss] / [h:mm:ss] into seek buttons.
 */
;(function () {
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  const SAFE_URL = /^(https?:|mailto:)/i

  function toSeconds(stamp) {
    return stamp
      .split(':')
      .map(Number)
      .reduce((acc, n) => acc * 60 + n, 0)
  }

  function inline(src, opts) {
    const codes = []
    let s = String(src).replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, ticks, code) => {
      codes.push(`<code>${esc(code.trim() === '' ? code : code.replace(/^ (.*) $/, '$1'))}</code>`)
      return `\u0000${codes.length - 1}\u0000`
    })
    const links = []
    s = s.replace(/\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (match, text, url) => {
      if (!SAFE_URL.test(url)) return match
      links.push({ text, url })
      return `\u0001${links.length - 1}\u0001`
    })
    s = esc(s)
    s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+[^\s<.,:;!?)'"\]])/g, (m, pre, url) => {
      return `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
    })
    s = s
      .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    if (opts.timestamps) {
      s = s.replace(/[[(]((?:\d{1,2}:)?\d{1,2}:\d{2})(?:\s*[-–]\s*(?:\d{1,2}:)?\d{1,2}:\d{2})?[\])]/g, (m, stamp) => {
        return `<button type="button" class="cm-ts" data-seconds="${toSeconds(stamp)}">${esc(stamp)}</button>`
      })
    }
    s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => {
      const { text, url } = links[i]
      return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${inline(text, { ...opts, timestamps: false })}</a>`
    })
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[i])
  }

  const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

  function splitRow(line) {
    let row = line.trim()
    if (row.startsWith('|')) row = row.slice(1)
    if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
    return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
  }

  function renderList(lines, opts) {
    // lines: [{ indent, ordered, text }]
    let html = ''
    const stack = []
    for (const item of lines) {
      while (stack.length && item.indent < stack.at(-1).indent) {
        html += `</li></${stack.pop().tag}>`
      }
      // Same level, other kind of list (bullets after numbers): start a new list.
      if (stack.length && item.indent === stack.at(-1).indent && (item.ordered ? 'ol' : 'ul') !== stack.at(-1).tag) {
        html += `</li></${stack.pop().tag}>`
      }
      const top = stack.at(-1)
      if (!top || item.indent > top.indent) {
        const tag = item.ordered ? 'ol' : 'ul'
        const start = item.ordered && item.number !== 1 ? ` start="${item.number}"` : ''
        stack.push({ indent: item.indent, tag })
        html += `<${tag}${start}>`
      } else {
        html += '</li>'
      }
      let text = item.text
      let check = ''
      const task = /^\[([ xX])\]\s+(.*)$/.exec(text)
      if (task) {
        check = `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> `
        text = task[2]
      }
      html += `<li${task ? ' class="task"' : ''}>${check}${inline(text, opts)}`
    }
    while (stack.length) html += `</li></${stack.pop().tag}>`
    return html
  }

  function render(markdown, opts = {}) {
    const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
    let html = ''
    let i = 0
    let para = []
    const flushPara = () => {
      if (para.length) html += `<p>${para.map((l) => inline(l, opts)).join('<br>')}</p>`
      para = []
    }
    while (i < lines.length) {
      const line = lines[i]
      const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line)
      if (fence) {
        flushPara()
        const marker = fence[1]
        const lang = fence[2] || ''
        const body = []
        i++
        while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++])
        i++
        html +=
          `<div class="cm-code"><div class="cm-code-head"><span>${esc(lang || 'code')}</span>` +
          `<button type="button" class="cm-copy-code">Copy</button></div>` +
          `<pre><code${lang ? ` data-lang="${esc(lang)}"` : ''}>${esc(body.join('\n'))}</code></pre></div>`
        continue
      }
      if (!line.trim()) {
        flushPara()
        i++
        continue
      }
      const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
      if (heading) {
        flushPara()
        const level = Math.min(6, heading[1].length + 2)
        html += `<h${level}>${inline(heading[2], opts)}</h${level}>`
        i++
        continue
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flushPara()
        html += '<hr>'
        i++
        continue
      }
      if (/^\s*>/.test(line)) {
        flushPara()
        const quote = []
        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''))
        html += `<blockquote>${render(quote.join('\n'), opts)}</blockquote>`
        continue
      }
      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        flushPara()
        const head = splitRow(line)
        const aligns = splitRow(lines[i + 1]).map((c) =>
          c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '',
        )
        i += 2
        const rows = []
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]))
        const cell = (tag, text, idx) =>
          `<${tag}${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ''}>${inline(text, opts)}</${tag}>`
        html +=
          `<div class="cm-table"><table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${head.map((_, k) => cell('td', r[k] ?? '', k)).join('')}</tr>`).join('')}</tbody></table></div>`
        continue
      }
      if (LIST_ITEM.test(line)) {
        flushPara()
        const items = []
        while (i < lines.length) {
          const m = LIST_ITEM.exec(lines[i])
          if (m) {
            const ordered = /\d/.test(m[2])
            items.push({ indent: m[1].replace(/\t/g, '  ').length, ordered, number: ordered ? parseInt(m[2], 10) : 0, text: m[3] })
            i++
          } else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) {
            items.at(-1).text += ' ' + lines[i].trim()
            i++
          } else if (!lines[i].trim() && i + 1 < lines.length && LIST_ITEM.test(lines[i + 1])) {
            i++
          } else break
        }
        html += renderList(items, opts)
        continue
      }
      para.push(line)
      i++
    }
    flushPara()
    return html
  }

  globalThis.CMMarkdown = { render, escape: esc }
})()
