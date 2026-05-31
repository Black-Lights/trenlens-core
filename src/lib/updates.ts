/**
 * Lightweight update check against the GitHub Releases API.
 *
 * This is the honest alpha-stage updater: it compares the running version against
 * the newest published release and tells the user whether they're current or an
 * update is available (with a direct link to the installer asset). It does NOT
 * auto-download/install — that's the `tauri-plugin-updater` path (needs a signing
 * key), which can be layered on later without changing this surface.
 */
import { APP_VERSION, LATEST_RELEASE_URL, RELEASES_API_URL } from './appInfo';

export interface UpdateInfo {
  status: 'latest' | 'available' | 'error';
  current: string;
  latest?: string;
  /** Direct installer asset URL when available, else the release page. */
  url?: string;
  error?: string;
}

/**
 * Compare two semver strings. Returns >0 if `a` is newer than `b`, 0 if equal,
 * <0 if older. Handles pre-release ordering (a release ranks above its
 * pre-releases; `alpha.1 < alpha.2 < beta`). Build metadata is ignored.
 */
export function cmpSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const clean = v.replace(/^v/, '').split('+')[0];
    const [core, pre] = clean.split('-');
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
    return { nums, pre: pre ? pre.split('.') : null };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (A.nums[i] ?? 0) - (B.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  // Equal core: a version without a pre-release tag outranks one with.
  if (!A.pre && !B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  const len = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < len; i++) {
    const x = A.pre[i];
    const y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = parseInt(x, 10) - parseInt(y, 10);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (nx !== ny) {
      return nx ? -1 : 1; // numeric identifiers rank lower than alphanumeric
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

interface GhAsset {
  name: string;
  browser_download_url: string;
}
interface GhRelease {
  tag_name?: string;
  html_url?: string;
  assets?: GhAsset[];
}

/** Query the newest release and decide whether an update is available. */
export async function checkForUpdate(): Promise<UpdateInfo> {
  try {
    const res = await fetch(RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      return { status: 'error', current: APP_VERSION, error: `GitHub API ${res.status}` };
    }
    const body = (await res.json()) as GhRelease[] | GhRelease;
    const rel = Array.isArray(body) ? body[0] : body;
    if (!rel || !rel.tag_name) {
      return { status: 'error', current: APP_VERSION, error: 'No releases published yet.' };
    }
    const latest = rel.tag_name.replace(/^v/, '');
    // Prefer a direct Windows installer asset; fall back to the release page.
    const asset = rel.assets?.find((a) => /\.(exe|msi)$/i.test(a.name));
    const url = asset?.browser_download_url ?? rel.html_url ?? LATEST_RELEASE_URL;
    return cmpSemver(latest, APP_VERSION) > 0
      ? { status: 'available', current: APP_VERSION, latest, url }
      : { status: 'latest', current: APP_VERSION, latest, url };
  } catch (e) {
    return {
      status: 'error',
      current: APP_VERSION,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
