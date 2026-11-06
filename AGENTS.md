# Repository workflow

- After completing each requested source or documentation change, commit the task-related files and push the current branch to `origin`, unless the user explicitly asks not to push or the remote is unavailable.
- Never commit generated installers, executable files, release directories, build output, logs, credentials, or local account data.
- The project owner performs real platform login, search, playback, and UI acceptance testing. Automated work should be limited to static checks, type checks, builds, and packaging unless the user explicitly requests otherwise.
