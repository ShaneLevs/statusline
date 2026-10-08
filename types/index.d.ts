/**
 * The status the line shows, one named value in `$.state` under the plugin's
 * name (`statusline`) and key (`stat`).
 */

/** The working copy's state, from one `git status` and one `git diff HEAD`. */
export type GitInfo = {
  /** The checked-out branch, or `detached@<short oid>` on a detached HEAD. */
  branch: string
  /** Commits to push: how far the branch is ahead of its upstream; 0 without one. */
  ahead: number
  /** Lines added in the working copy against HEAD. */
  added: number
  /** Lines deleted in the working copy against HEAD. */
  deleted: number
}

/** Everything the line shows. Nullable fields drop out of the line. */
export type StatusStat = {
  /** The main loop's model, as `/model` shows it. */
  model: string
  /** The effort the last model request asked for (`low` … `max`), or null. */
  effort: string | null
  /** Share of the live window's last response served from the prompt cache. */
  cachePercent: number | null
  /** The live context window's fill, 0–100. */
  contextPercent: number | null
  /** The live context window's size in tokens. */
  contextWindow: number | null
  /** The session's project root, its last path segment. */
  project: string
  /** The git working copy, or null outside a repository. */
  git: GitInfo | null
}

declare module 'claude-code' {
  interface PluginState {
    statusline: { stat: StatusStat }
  }
}
