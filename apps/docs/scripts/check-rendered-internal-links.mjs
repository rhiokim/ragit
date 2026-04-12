import fs from 'node:fs'
import path from 'node:path'

const outDir = path.join(process.cwd(), 'out')

const HTML_HREF_PATTERN = /href=(['"])\/(en|ko)\/docs(?:[/?#][^"'<>]*)?\1/g
const ESCAPED_HREF_PATTERN = /\\"href\\":\\"\/(en|ko)\/docs(?:[/?#][^"\\<>]*)\\"/g
const JSON_HREF_PATTERN = /"href":"\/(en|ko)\/docs(?:[/?#][^"<>]*)"/g

function collectHtmlFiles(directory) {
  const collected = []

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      collected.push(...collectHtmlFiles(absolute))
      continue
    }

    if (entry.isFile() && entry.name.endsWith('.html')) {
      collected.push(absolute)
    }
  }

  return collected
}

function collectMatches(raw) {
  const patterns = [HTML_HREF_PATTERN, ESCAPED_HREF_PATTERN, JSON_HREF_PATTERN]
  const matches = []

  for (const pattern of patterns) {
    matches.push(...raw.match(pattern) ?? [])
  }

  return matches
}

function main() {
  if (!fs.existsSync(outDir)) {
    throw new Error(`정적 export 산출물이 없습니다: ${outDir}`)
  }

  const htmlFiles = collectHtmlFiles(outDir)
  const failures = []

  for (const filePath of htmlFiles) {
    const raw = fs.readFileSync(filePath, 'utf8')
    const matches = collectMatches(raw)

    if (matches.length === 0) {
      continue
    }

    failures.push({
      filePath,
      matches: matches.slice(0, 5),
    })
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      const relative = path.relative(process.cwd(), failure.filePath)
      console.error(`[internal-doc-links][fail] ${relative}`)
      for (const match of failure.matches) {
        console.error(`  ${match}`)
      }
    }

    throw new Error(
      `basePath가 빠진 internal docs 링크가 ${failures.length}개 파일에서 발견되었습니다.`
    )
  }

  console.log(
    `[internal-doc-links] verified ${htmlFiles.length} exported html files.`
  )
}

main()
