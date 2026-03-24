# Create a Pull Request

## description:
Stage, commit, push, and open a pull request for current changes. Automates the full PR workflow so you can stay in flow.

## Arguments
$ARGUMENTS (optional: commit message hint or scope)

---

Follow these steps exactly. Do NOT ask for confirmation before each step — just do it.

### 1. Check branch
Run `git branch --show-current`. If it returns `main` or `master`, **stop and tell the user** to switch to a feature branch first.

### 2. Understand the changes
Run these in parallel:
- `git status` — see what's staged and unstaged
- `git diff HEAD` — see all changes
- `git log main..HEAD --oneline` — see commits not yet on main (may be empty)

### 3. Decide on commits
Group changes logically. One commit per logical change. If there are multiple unrelated changes, stage and commit them separately.

For each logical group:
- Stage relevant files by name (avoid `git add .` unless everything belongs together)
- Write a commit message that explains **why**, not just what. Keep it under 72 chars.
- If $ARGUMENTS was provided, treat it as a hint for the commit message topic.
- Commit using a HEREDOC. First resolve the co-author identity:
  ```bash
  GIT_USER="$(git config user.name)"
  GIT_EMAIL="$(git config user.email)"
  ```
  Then commit:
  ```
  git commit -m "$(cat <<'EOF'
  <message>

  Co-Authored-By: $GIT_USER <$GIT_EMAIL>
  EOF
  )"
  ```

### 4. Push
```bash
git push -u origin HEAD
```

### 5. Create the PR
Use `gh pr create` with a HEREDOC body:
```bash
gh pr create --title "<short title under 70 chars>" --body "$(cat <<'EOF'
## Summary
- <bullet points of what changed and why>

## Test plan
- [ ] <what to verify and how>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

The PR title should summarise the change in plain English. The summary should explain **why** the change was made, not just list the files touched. The test plan should be specific enough that a reviewer can follow it.

### 6. Return the PR URL
Print the PR URL so the user can open it.

## Notes
- Never skip hooks (`--no-verify`)
- Never push directly to main/master
- If the push fails (e.g. remote doesn't exist yet), tell the user what happened — don't silently retry
