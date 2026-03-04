#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const packageJsonPath = path.join(repoRoot, "package.json");

const HELP_TEXT = `
Usage:
  npm run brew:formula -- [options]

Options:
  --url <value>            Source tarball URL for the formula.
  --sha256 <value>         SHA256 for the source tarball.
  --tarball <path>         Local tarball path to hash (useful before release asset exists).
  --output <path>          Formula output path (default: Formula/<name>.rb).
  --class-name <value>     Ruby formula class name (default: inferred from package name).
  --binary-name <value>    Installed command name (default: first package.bin key).
  --node-formula <value>   Homebrew node formula (default: inferred from engines.node).
  --help                   Show this help.
`;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const raw = token.slice(2);
    const equalIndex = raw.indexOf("=");
    if (equalIndex !== -1) {
      const key = raw.slice(0, equalIndex).trim();
      const value = raw.slice(equalIndex + 1).trim();
      if (!key || !value) {
        throw new Error(`Invalid argument: ${token}`);
      }
      args[key] = value;
      continue;
    }

    const key = raw.trim();
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function stripDotGitSuffix(url) {
  return url.endsWith(".git") ? url.slice(0, -4) : url;
}

function stripFragment(url) {
  const hashIndex = url.indexOf("#");
  return hashIndex === -1 ? url : url.slice(0, hashIndex);
}

function resolveHomepage(packageJson) {
  if (typeof packageJson.homepage === "string" && packageJson.homepage.trim().length > 0) {
    return stripFragment(packageJson.homepage.trim());
  }

  const repository = packageJson.repository;
  if (typeof repository === "string" && repository.trim().length > 0) {
    const normalized = repository.trim().replace(/^git\+/, "");
    if (normalized.startsWith("git@github.com:")) {
      return stripFragment(stripDotGitSuffix(`https://github.com/${normalized.slice("git@github.com:".length)}`));
    }
    return stripFragment(stripDotGitSuffix(normalized));
  }
  if (repository && typeof repository.url === "string" && repository.url.trim().length > 0) {
    const normalized = repository.url.trim().replace(/^git\+/, "");
    if (normalized.startsWith("git@github.com:")) {
      return stripFragment(stripDotGitSuffix(`https://github.com/${normalized.slice("git@github.com:".length)}`));
    }
    return stripFragment(stripDotGitSuffix(normalized));
  }

  throw new Error("Cannot infer homepage URL from package.json. Set `homepage` first.");
}

function inferBinaryName(packageJson, fallbackName) {
  if (typeof packageJson.bin === "string" && packageJson.bin.trim().length > 0) {
    return fallbackName;
  }
  if (packageJson.bin && typeof packageJson.bin === "object") {
    const [first] = Object.keys(packageJson.bin);
    if (first && first.trim().length > 0) {
      return first.trim();
    }
  }
  return fallbackName;
}

function inferNodeFormula(packageJson) {
  const range = packageJson.engines?.node;
  if (typeof range !== "string" || range.trim().length === 0) {
    return "node";
  }
  const versionMatch = range.match(/(\d{2,})/);
  if (!versionMatch) {
    return "node";
  }
  return `node@${versionMatch[1]}`;
}

function toFormulaFileName(packageName) {
  const normalized = packageName.startsWith("@") ? packageName.split("/")[1] : packageName;
  return `${normalized}.rb`;
}

function toFormulaClassName(packageName) {
  const normalized = packageName.startsWith("@") ? packageName.split("/")[1] : packageName;
  return normalized
    .split(/[^a-zA-Z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join("");
}

function escapeRubyString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function npmRegistryTarballUrl(packageName, version) {
  const encodedName = encodeURIComponent(packageName);
  const tarballBase = packageName.startsWith("@") ? packageName.split("/")[1] : packageName;
  return `https://registry.npmjs.org/${encodedName}/-/${tarballBase}-${version}.tgz`;
}

function sha256FromBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function computeShaFromLocalTarball(tarballPath) {
  const absoluteTarballPath = path.resolve(repoRoot, tarballPath);
  const tarballBuffer = await fs.readFile(absoluteTarballPath);
  return sha256FromBuffer(tarballBuffer);
}

async function computeShaFromUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download tarball from ${url} (HTTP ${response.status}).`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return sha256FromBuffer(Buffer.from(arrayBuffer));
}

function validateSha(shaValue) {
  if (!/^[a-f0-9]{64}$/i.test(shaValue)) {
    throw new Error("Invalid sha256. Expected a 64-character hex string.");
  }
}

function renderFormula({
  className,
  description,
  homepage,
  url,
  sha256,
  license,
  nodeFormula,
  binaryName
}) {
  const safeDescription = escapeRubyString(description.replace(/\s+/g, " ").trim());
  const safeHomepage = escapeRubyString(homepage.trim());
  const safeUrl = escapeRubyString(url.trim());
  const safeSha256 = escapeRubyString(sha256.trim().toLowerCase());
  const safeLicense = escapeRubyString(license.trim());
  const safeNodeFormula = escapeRubyString(nodeFormula.trim());
  const safeBinaryName = escapeRubyString(binaryName.trim());

  return `class ${className} < Formula
  desc "${safeDescription}"
  homepage "${safeHomepage}"
  url "${safeUrl}"
  sha256 "${safeSha256}"
  license "${safeLicense}"

  depends_on "${safeNodeFormula}"

  def install
    staged_root = (buildpath/"package").exist? ? buildpath/"package" : buildpath
    libexec.install staged_root.children

    (bin/"${safeBinaryName}").write <<~EOS
      #!/bin/bash
      exec "#{Formula["${safeNodeFormula}"].opt_bin}/node" "#{libexec}/dist/index.js" "$@"
    EOS
    chmod 0555, bin/"${safeBinaryName}"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/${safeBinaryName} --version")
  end
end
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    process.stdout.write(HELP_TEXT.trimStart());
    return;
  }

  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  const packageName = packageJson.name;
  const packageVersion = packageJson.version;
  if (typeof packageName !== "string" || packageName.trim().length === 0) {
    throw new Error("package.json is missing a valid `name`.");
  }
  if (typeof packageVersion !== "string" || packageVersion.trim().length === 0) {
    throw new Error("package.json is missing a valid `version`.");
  }

  const formulaFileName = toFormulaFileName(packageName);
  const outputPath = path.resolve(repoRoot, typeof args.output === "string" ? args.output : `Formula/${formulaFileName}`);
  const className = typeof args["class-name"] === "string" ? args["class-name"] : toFormulaClassName(packageName);
  const binaryName =
    typeof args["binary-name"] === "string" ? args["binary-name"] : inferBinaryName(packageJson, packageName);
  const nodeFormula = typeof args["node-formula"] === "string" ? args["node-formula"] : inferNodeFormula(packageJson);

  const url = typeof args.url === "string" ? args.url : npmRegistryTarballUrl(packageName, packageVersion);
  const sha256 = typeof args.sha256 === "string"
    ? args.sha256
    : typeof args.tarball === "string"
      ? await computeShaFromLocalTarball(args.tarball)
      : await computeShaFromUrl(url);

  validateSha(sha256);
  const description =
    typeof packageJson.description === "string" && packageJson.description.trim().length > 0
      ? packageJson.description
      : "CLI package";
  const homepage = resolveHomepage(packageJson);
  const formulaText = renderFormula({
    className,
    description,
    homepage,
    url,
    sha256,
    license: packageJson.license || "MIT",
    nodeFormula,
    binaryName
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, formulaText, "utf8");

  process.stdout.write(`Wrote ${path.relative(repoRoot, outputPath)}\n`);
  process.stdout.write(`version: ${packageVersion}\n`);
  process.stdout.write(`url: ${url}\n`);
  process.stdout.write(`sha256: ${sha256}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
