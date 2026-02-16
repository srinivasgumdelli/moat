// Minimal YAML parser — handles the subset needed for .moat.yml
// Supports: mappings, sequences (- item), quoted/unquoted scalars, nested maps
// Extracted from generate-project-config.mjs

export function parseYaml(text) {
  const lines = text.split('\n');
  let i = 0;

  function currentIndent(line) {
    const match = line.match(/^( *)/);
    return match ? match[1].length : 0;
  }

  function parseValue(val) {
    val = val.trim();
    if (val === '' || val === '~' || val === 'null') return null;
    if (val === 'true') return true;
    if (val === 'false') return false;
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      return val.slice(1, -1);
    }
    if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);
    return val;
  }

  function parseBlock(minIndent) {
    if (i >= lines.length) return null;

    while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('#'))) i++;
    if (i >= lines.length) return null;

    const firstLine = lines[i];
    const firstIndent = currentIndent(firstLine);
    if (firstIndent < minIndent) return null;

    if (firstLine.trim().startsWith('- ')) {
      return parseSequence(firstIndent);
    }
    return parseMapping(firstIndent);
  }

  function parseSequence(baseIndent) {
    const result = [];
    while (i < lines.length) {
      while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('#'))) i++;
      if (i >= lines.length) break;

      const indent = currentIndent(lines[i]);
      if (indent < baseIndent) break;
      if (indent !== baseIndent || !lines[i].trim().startsWith('- ')) break;

      const val = lines[i].trim().slice(2).trim();
      i++;
      if (val.includes(':') && !val.startsWith('"') && !val.startsWith("'")) {
        i--;
        const saved = lines[i];
        lines[i] = ' '.repeat(baseIndent + 2) + val;
        const mapped = parseMapping(baseIndent + 2);
        lines[i] = saved;
        result.push(mapped);
      } else {
        result.push(parseValue(val));
      }
    }
    return result;
  }

  function parseMapping(baseIndent) {
    const result = {};
    while (i < lines.length) {
      while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('#'))) i++;
      if (i >= lines.length) break;

      const indent = currentIndent(lines[i]);
      if (indent < baseIndent) break;
      if (indent > baseIndent) break;

      const line = lines[i].trim();
      if (line.startsWith('- ')) break;

      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) { i++; continue; }

      const key = line.slice(0, colonIdx).trim();
      const rest = line.slice(colonIdx + 1).trim();
      i++;

      if (rest === '' || rest === '|' || rest === '>') {
        const nested = parseBlock(baseIndent + 1);
        result[key] = nested !== null ? nested : '';
      } else {
        result[key] = parseValue(rest);
      }
    }
    return result;
  }

  return parseBlock(0) || {};
}
