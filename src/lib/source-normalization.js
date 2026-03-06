import fs from "fs-extra";
import path from "node:path";

function sanitizeIdFragment(value) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || "source";
}

function expandUserPath(rawPath) {
  if (typeof rawPath !== "string") {
    return rawPath;
  }
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (rawPath === "~") {
    return home;
  }
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return path.join(home, rawPath.slice(2));
  }
  return rawPath
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME/g, home)
    .replace(/%USERPROFILE%/gi, home);
}

export function normalizeSelectionPath(rawPath, label = "path") {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  const normalized = rawPath.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (normalized === ".") {
    return ".";
  }
  if (normalized.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  const parts = normalized.split("/");
  for (const part of parts) {
    if (part.length === 0 || part === "." || part === "..") {
      throw new Error(`Invalid ${label} '${rawPath}'.`);
    }
  }
  return parts.join("/");
}

export function normalizeOptionalRoot(rawRoot) {
  if (typeof rawRoot !== "string" || rawRoot.trim().length === 0) {
    return null;
  }
  return normalizeSelectionPath(rawRoot, "root");
}

function looksLikeFilesystemPath(source) {
  if (typeof source !== "string") {
    return false;
  }
  return (
    source.startsWith(".") ||
    source.startsWith("~") ||
    source.startsWith("/") ||
    source.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(source)
  );
}

function looksLikeGitHubShorthand(source) {
  if (typeof source !== "string") {
    return false;
  }
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.trim());
}

function parseScpLikeGitSource(source) {
  const match = String(source ?? "").match(/^[^@]+@([^:]+):(.+)$/);
  if (!match) {
    return null;
  }
  return {
    host: match[1].toLowerCase(),
    repoPath: match[2].replace(/\.git$/i, ""),
    repo: source.trim(),
    root: null,
    defaultRef: null
  };
}

function parseGitHostUrl(source) {
  const text = String(source ?? "").trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return null;
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  const host = (url.hostname || "").toLowerCase();
  const pathname = url.pathname.replace(/^\/+/, "");
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    return {
      host,
      repo: text,
      repoPath: pathname.replace(/\.git$/i, ""),
      root: null,
      defaultRef: null
    };
  }

  if (host === "github.com") {
    const [owner, repoName, marker, ref, ...rest] = segments;
    if (marker === "tree" || marker === "blob") {
      return {
        host,
        repo: `${url.protocol}//${host}/${owner}/${repoName.replace(/\.git$/i, "")}.git`,
        repoPath: `${owner}/${repoName.replace(/\.git$/i, "")}`,
        root: rest.length > 0 ? normalizeSelectionPath(rest.join("/"), "root") : null,
        defaultRef: typeof ref === "string" && ref.length > 0 ? ref : null
      };
    }
    return {
      host,
      repo: `${url.protocol}//${host}/${owner}/${repoName.replace(/\.git$/i, "")}.git`,
      repoPath: `${owner}/${repoName.replace(/\.git$/i, "")}`,
      root: null,
      defaultRef: null
    };
  }

  if (host === "gitlab.com") {
    const treeIndex = segments.findIndex((item) => item === "-");
    if (treeIndex >= 2 && segments[treeIndex + 1] === "tree") {
      const repoSegments = segments.slice(0, treeIndex);
      const ref = segments[treeIndex + 2] ?? null;
      const rootSegments = segments.slice(treeIndex + 3);
      return {
        host,
        repo: `${url.protocol}//${host}/${repoSegments.join("/")}.git`,
        repoPath: repoSegments.join("/"),
        root: rootSegments.length > 0 ? normalizeSelectionPath(rootSegments.join("/"), "root") : null,
        defaultRef: ref
      };
    }
  }

  return {
    host,
    repo: text,
    repoPath: pathname.replace(/\.git$/i, ""),
    root: null,
    defaultRef: null
  };
}

function parseGitSource(source) {
  if (looksLikeGitHubShorthand(source)) {
    const [owner, repo] = source.trim().split("/");
    return {
      host: "github.com",
      repo: `https://github.com/${owner}/${repo}.git`,
      repoPath: `${owner}/${repo}`,
      root: null,
      defaultRef: null
    };
  }

  return parseGitHostUrl(source) ?? parseScpLikeGitSource(source) ?? null;
}

export function inferUpstreamIdFromSourceDescriptor(descriptor) {
  if (descriptor.provider === "local-path") {
    return sanitizeIdFragment(path.basename(descriptor.path || "local-skill"));
  }

  const repoPath = String(descriptor.repoPath || "").replace(/\.git$/i, "");
  const segments = repoPath.split("/").filter(Boolean);
  if (descriptor.host === "github.com" && segments.length >= 2) {
    return `${sanitizeIdFragment(segments[segments.length - 2])}_${sanitizeIdFragment(segments[segments.length - 1])}`;
  }
  return sanitizeIdFragment(segments[segments.length - 1] || "upstream");
}

export async function normalizeSourceInput(source, options = {}) {
  const originalInput = String(source ?? "").trim();
  if (originalInput.length === 0) {
    throw new Error("Source locator is required.");
  }

  const requestedProvider = String(options.provider || "auto").trim().toLowerCase();
  const requestedRoot = normalizeOptionalRoot(options.root);

  if (!["auto", "git", "local-path"].includes(requestedProvider)) {
    throw new Error(`Unsupported provider '${requestedProvider}'.`);
  }

  const absolutePath = path.resolve(expandUserPath(originalInput));
  const pathExists = await fs.pathExists(absolutePath);
  if (requestedProvider === "git" && pathExists) {
    return {
      provider: "git",
      type: "git",
      originalInput,
      repo: absolutePath,
      repoPath: path.basename(absolutePath),
      root: requestedRoot,
      defaultRef: options.defaultRef ?? null,
      displayName: path.basename(absolutePath),
      host: "local"
    };
  }
  if (requestedProvider === "local-path" || (requestedProvider === "auto" && (looksLikeFilesystemPath(originalInput) || pathExists))) {
    if (!pathExists) {
      throw new Error(`Local source path '${originalInput}' was not found.`);
    }
    return {
      provider: "local-path",
      type: "local-path",
      originalInput,
      path: absolutePath,
      root: requestedRoot,
      defaultRef: null,
      displayName: path.basename(absolutePath),
      host: null,
      repoPath: null
    };
  }

  const parsedGit = parseGitSource(originalInput);
  if (!parsedGit) {
    throw new Error(`Could not normalize source '${originalInput}'.`);
  }

  return {
    provider: "git",
    type: "git",
    originalInput,
    repo: parsedGit.repo,
    repoPath: parsedGit.repoPath,
    root: requestedRoot ?? parsedGit.root,
    defaultRef: options.defaultRef ?? parsedGit.defaultRef ?? null,
    displayName: parsedGit.repoPath?.split("/").filter(Boolean).at(-1) ?? originalInput,
    host: parsedGit.host
  };
}
