// Turn user repo input into a codeload tarball URL.
//
// Accepted forms:
//   owner/repo
//   owner/repo@ref
//   https://github.com/owner/repo
//   https://github.com/owner/repo/tree/<ref>
// Dev mode only:
//   any http(s) URL that ends with .tar.gz

const NAME = "[A-Za-z0-9_.-]+";
const SHORT_RE = new RegExp(`^(${NAME})/(${NAME})(?:@(.+))?$`);

export function resolveTarballUrl(input: string, devMode: boolean): { url: string; display: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: "Repo is required." };

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { error: "That is not a valid URL." };
    }

    if (devMode && url.pathname.endsWith(".tar.gz")) {
      return { url: url.toString(), display: url.toString() };
    }

    if (url.hostname.toLowerCase() !== "github.com") {
      return { error: "Only github.com repository URLs are accepted." };
    }
    const parts = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
    if (parts.length < 2) return { error: "Use the form https://github.com/owner/repo" };
    const [owner, repo] = parts;
    let ref = "HEAD";
    if (parts[2] === "tree" && parts.length > 3) {
      ref = parts.slice(3).join("/");
    }
    return {
      url: `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`,
      display: `${owner}/${repo}${ref === "HEAD" ? "" : `@${ref}`}`,
    };
  }

  const m = SHORT_RE.exec(trimmed);
  if (!m) return { error: "Use owner/repo, owner/repo@ref, or a github.com URL." };
  const [, owner, repo, ref] = m;
  return {
    url: `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref ?? "HEAD")}`,
    display: `${owner}/${repo}${ref ? `@${ref}` : ""}`,
  };
}
