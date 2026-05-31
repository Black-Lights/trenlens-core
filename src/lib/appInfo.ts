/**
 * App metadata — single source of truth for the About dialog and anywhere else
 * the build needs to name/version itself. Keep `APP_VERSION` in step with the
 * GitHub release tag; the installer/binary version lives in tauri.conf.json.
 */
export const APP_NAME = 'TrenLens Core';
export const APP_TAGLINE =
  'A local-first desktop AI assistant that orchestrates any tool, web app, or CLI over the Model Context Protocol (MCP).';

/** Semantic version incl. pre-release channel (matches the GitHub release tag). */
export const APP_VERSION = '0.1.0-alpha.3';
export const APP_CHANNEL = 'alpha' as const;

export const DEVELOPER = {
  name: 'Mohammad Ammar Mughees',
  handle: 'Black-Lights',
  github: 'https://github.com/Black-Lights',
  email: 'mohammadammarmughees@gmail.com',
};

export const REPO_URL = 'https://github.com/Black-Lights/trenlens-core';
/** `owner/repo` for the GitHub API. */
export const GITHUB_REPO = 'Black-Lights/trenlens-core';
/** The latest GitHub release page (fallback download target). */
export const LATEST_RELEASE_URL = `${REPO_URL}/releases/latest`;
/**
 * Most-recent release via the API. We list (not `/latest`) because `/latest`
 * excludes pre-releases — and our alpha releases are all pre-releases.
 */
export const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=1`;
export const LICENSE = 'Apache-2.0';
export const BUILT_WITH = ['Tauri v2', 'Rust', 'Next.js', 'TypeScript', 'Drizzle ORM'];
