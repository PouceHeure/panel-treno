// "GENOVA PIAZZA PRINCIPE" -> "Genova Piazza Principe": the data shouts, the screens should not.
const LOWER_WORDS = new Set(['di', 'del', 'della', 'delle', 'dei', 'degli', 'dello', 'da', 'a', 'al', 'alla', 'e', 'ed', 'in', 'su', 'sul', 'sulla', 'la', 'il', 'le', 'lo', 'l', 'd'])
const KEEP_UPPER = new Set(['TV', 'FS', 'RFI', 'PC', 'AV', 'AP'])

function niceName(name) {
  if (!name) return ''
  return String(name)
    .toLowerCase()
    .split(/(\s+|-|')/)
    .map((word, i) => {
      if (!word || /^(\s+|-|')$/.test(word)) return word
      if (KEEP_UPPER.has(word.toUpperCase()) && word.length <= 3) return word.toUpperCase()
      if (i > 0 && LOWER_WORDS.has(word)) return word
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join('')
}

if (typeof module !== 'undefined') module.exports = { niceName }
