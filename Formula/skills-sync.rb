class SkillsSync < Formula
  desc "AI skills and MCP configuration management for development environments."
  homepage "https://github.com/ryanreh99/skills-sync"
  url "https://github.com/ryanreh99/skills-sync/releases/download/v1.0.0/skills-sync-1.0.0.tgz"
  sha256 "1ed0dbe9a67197f3c82921203900a0869e550dd79556f95ed3ccf33f8d1ff1a3"
  license "MIT"

  depends_on "node@20"

  def install
    staged_root = (buildpath/"package").exist? ? buildpath/"package" : buildpath
    libexec.install staged_root.children

    (bin/"skills-sync").write <<~EOS
      #!/bin/bash
      exec "#{Formula["node@20"].opt_bin}/node" "#{libexec}/dist/index.js" "$@"
    EOS
    chmod 0555, bin/"skills-sync"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/skills-sync --version")
  end
end
