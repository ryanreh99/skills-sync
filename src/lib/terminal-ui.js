const ANSI = {
  reset: "\u001B[0m",
  boldCyan: "\u001B[1;36m",
  boldBlue: "\u001B[1;34m",
  boldGreen: "\u001B[1;32m",
  boldYellow: "\u001B[1;33m",
  boldRed: "\u001B[1;31m",
  cyan: "\u001B[36m",
  dim: "\u001B[2m",
  gray: "\u001B[90m"
};

function readForceColor() {
  if (process.env.FORCE_COLOR === undefined) {
    return null;
  }
  const normalized = String(process.env.FORCE_COLOR).trim().toLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  return true;
}

export function supportsColor(stream = process.stdout) {
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }

  const forceColor = readForceColor();
  if (forceColor !== null) {
    return forceColor;
  }

  if (!stream || stream.isTTY !== true) {
    return false;
  }
  if (String(process.env.TERM || "").toLowerCase() === "dumb") {
    return false;
  }
  return true;
}

function paint(text, code, stream = process.stdout) {
  const normalizedText = String(text);
  if (!supportsColor(stream)) {
    return normalizedText;
  }
  return `${code}${normalizedText}${ANSI.reset}`;
}

function alignVisible(text, width, align = "left") {
  const normalized = String(text ?? "");
  const padding = Math.max(0, width - visibleLength(normalized));
  if (align === "right") {
    return `${" ".repeat(padding)}${normalized}`;
  }
  return `${normalized}${" ".repeat(padding)}`;
}

function normalizeTableCell(cell) {
  if (cell && typeof cell === "object" && !Array.isArray(cell)) {
    return {
      text: String(cell.text ?? ""),
      align: cell.align === "right" ? "right" : "left"
    };
  }
  return {
    text: String(cell ?? ""),
    align: "left"
  };
}

export function brand(text, stream = process.stdout) {
  return paint(text, ANSI.boldCyan, stream);
}

export function heading(text, stream = process.stdout) {
  return paint(text, ANSI.boldBlue, stream);
}

export function success(text, stream = process.stdout) {
  return paint(text, ANSI.boldGreen, stream);
}

export function warning(text, stream = process.stdout) {
  return paint(text, ANSI.boldYellow, stream);
}

export function danger(text, stream = process.stdout) {
  return paint(text, ANSI.boldRed, stream);
}

export function accent(text, stream = process.stdout) {
  return paint(text, ANSI.cyan, stream);
}

export function dim(text, stream = process.stdout) {
  return paint(text, ANSI.dim, stream);
}

export function muted(text, stream = process.stdout) {
  return paint(text, ANSI.gray, stream);
}

export function stripAnsi(text) {
  const input = String(text ?? "");
  let output = "";

  for (let index = 0; index < input.length; index += 1) {
    if (input.charCodeAt(index) === 27 && input[index + 1] === "[") {
      let cursor = index + 2;
      while (cursor < input.length) {
        const code = input.charCodeAt(cursor);
        if ((code >= 48 && code <= 57) || code === 59) {
          cursor += 1;
          continue;
        }
        break;
      }
      if (cursor < input.length && input[cursor] === "m") {
        index = cursor;
        continue;
      }
    }
    output += input[index];
  }

  return output;
}

export function visibleLength(text) {
  return stripAnsi(text).length;
}

export function padEndVisible(text, width) {
  return alignVisible(text, width, "left");
}

export function toneText(text, tone = "muted", stream = process.stdout) {
  switch (tone) {
    case "brand":
      return brand(text, stream);
    case "heading":
      return heading(text, stream);
    case "success":
      return success(text, stream);
    case "warning":
      return warning(text, stream);
    case "danger":
      return danger(text, stream);
    case "accent":
      return accent(text, stream);
    case "dim":
      return dim(text, stream);
    case "muted":
    default:
      return muted(text, stream);
  }
}

export function formatBadge(text, tone = "muted", stream = process.stdout) {
  return toneText(`[${String(text ?? "")}]`, tone, stream);
}

export function renderSection(title, { count = null, stream = process.stdout } = {}) {
  const suffix = count === null ? "" : ` (${count})`;
  return heading(`${String(title ?? "")}${suffix}`, stream);
}

export function renderKeyValueRows(rows, {
  indent = "  ",
  stream = process.stdout,
  gap = 2
} = {}) {
  const normalizedRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      key: String(row.key ?? ""),
      value: String(row.value ?? "")
    }));
  if (normalizedRows.length === 0) {
    return "";
  }

  const keyWidth = normalizedRows.reduce(
    (width, row) => Math.max(width, visibleLength(row.key)),
    0
  );
  const separator = " ".repeat(Math.max(1, gap));
  return normalizedRows
    .map((row) => `${indent}${muted(alignVisible(row.key, keyWidth), stream)}${separator}${row.value}`)
    .join("\n");
}

export function renderTable(headers, rows, {
  indent = "  ",
  gap = 2,
  uppercaseHeaders = true,
  stream = process.stdout
} = {}) {
  const normalizedHeaders = (Array.isArray(headers) ? headers : []).map((header) => String(header ?? ""));
  const normalizedRows = (Array.isArray(rows) ? rows : []).map((row) =>
    normalizedHeaders.map((_, index) => normalizeTableCell(Array.isArray(row) ? row[index] : ""))
  );

  if (normalizedHeaders.length === 0) {
    return "";
  }

  const widths = normalizedHeaders.map((header, index) => {
    const rowWidth = normalizedRows.reduce(
      (width, row) => Math.max(width, visibleLength(row[index]?.text ?? "")),
      0
    );
    return Math.max(visibleLength(header), rowWidth);
  });

  const separator = " ".repeat(Math.max(1, gap));
  const headerLine = `${indent}${normalizedHeaders.map((header, index) =>
    muted(
      alignVisible(uppercaseHeaders ? header.toUpperCase() : header, widths[index]),
      stream
    )
  ).join(separator)}`;
  const bodyLines = normalizedRows.map((row) =>
    `${indent}${row.map((cell, index) => alignVisible(cell.text, widths[index], cell.align)).join(separator)}`
  );

  return [headerLine, ...bodyLines].join("\n");
}

export function renderSimpleList(items, {
  indent = "  ",
  empty = "(none)"
} = {}) {
  const normalizedItems = Array.isArray(items) ? items.map((item) => String(item ?? "")) : [];
  if (normalizedItems.length === 0) {
    return `${indent}${empty}`;
  }
  return normalizedItems.map((item) => `${indent}${item}`).join("\n");
}

export function formatSkillsSyncTag(stream = process.stdout) {
  return brand("[skills-sync]", stream);
}

export function styleHelpOutput(rawHelpText, stream = process.stdout) {
  const text = String(rawHelpText);
  if (!supportsColor(stream)) {
    return text;
  }

  return text
    .replace(/^Usage:/gm, heading("Usage:", stream))
    .replace(/^Options:/gm, heading("Options:", stream))
    .replace(/^Commands:/gm, heading("Commands:", stream));
}

export function highlightMatch(rawText, query, stream = process.stdout) {
  const text = String(rawText);
  const normalizedQuery = String(query || "").trim();
  if (!supportsColor(stream) || normalizedQuery.length === 0) {
    return text;
  }
  const lowerText = text.toLowerCase();
  const lowerQuery = normalizedQuery.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);
  if (index < 0) {
    return text;
  }
  const before = text.slice(0, index);
  const match = text.slice(index, index + normalizedQuery.length);
  const after = text.slice(index + normalizedQuery.length);
  return `${before}${accent(match, stream)}${after}`;
}

export function formatPrompt({ profile } = {}, stream = process.stdout) {
  const profilePart = profile ? `(${profile})` : "";
  const label = profilePart ? `skills-sync${profilePart}` : "skills-sync";
  return `${brand(label, stream)}${muted(" >", stream)} `;
}
