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
