/** Filesystem ownership for the Electron-managed desktop installation. */

import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Stable desktop installation paths under the shared Harness home. */
export interface DesktopPaths {
  readonly profile: string
  readonly lock: string
}

/**
 * Resolve every Electron-owned path without changing the shared data roots.
 * `DSH_DESKTOP_PROFILE` selects an application-owned profile, so an unpackaged
 * shell beside the packaged desktop owns its own bundle set instead of editing
 * the profile the packaged application boots.
 * @param dshHome - Harness home shared with npm-installed dsh.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(dshHome: string = resolveDshHome()): DesktopPaths {
  const profile = process.env.DSH_DESKTOP_PROFILE?.trim() || 'desktop'
  return {
    profile: join(dshHome, 'profiles', profile),
    lock: join(dshHome, 'profiles', profile, 'lock'),
  }
}
