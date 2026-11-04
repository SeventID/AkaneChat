# Changelog

## 0.1.5-beta.3 [BETA] - 2026-11-04

- Normalize the npm executable entry point to the package-name string form and add a regression test for the published CLI binary mapping.

## 0.1.5-beta.2 [BETA] - 2026-11-04

- Keep model-catalogue browsing responsive: load model IDs first and health-check only the selected model.
- Preserve the currently active model when a selected model fails its health check; allow retry without losing the previous selection.
- Scope the package test script to AkaneChat own tests suite so unrelated, untracked workspace directories are never executed.
- Refresh release and Android validation notes; desktop checks pass, but real-device Termux rendering remains an explicit beta validation item.

## 0.1.5-beta.0 [BETA] - 2026-11-03

- Preview release of bounded autonomous execution, persistent job records and checkpoints, read-only parallel agents, and verification/replanning stages.
- Known limitations: the job runner runs inside the TUI process; closing AkaneChat stops active work. Interrupted jobs require manual resume, and resume restarts the goal rather than continuing from an exact checkpoint. Workspace changes remain subject to the existing approval flow.
- This is a beta preview; validate behavior in a disposable workspace before relying on autonomous actions.

## 0.1.4 - 2026-11-03

- Add bounded autonomous execution loop with explicit verification and feedback-driven replanning.
- Persist background job state and checkpoints; recover interrupted jobs for manual resume.
- Add independent parallel read-only specialist agents (`/agents`).
- Add `/jobs`, `/job add`, and `/job resume` commands.
- Limit the shared-workspace background queue to one active job to prevent concurrent write conflicts.
- Document current lifecycle limitations: worker is TUI-bound, restart recovery is manual, and detached daemon execution is not yet available.

## 0.1.2

- Previous development baseline.
