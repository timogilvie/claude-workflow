#!/bin/bash
# sync-claude.sh - Bidirectional sync between repo and ~/.claude
# Usage: ./sync-claude.sh [to-claude|from-claude|status]

set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

show_status() {
    echo -e "${YELLOW}=== Sync Status ===${NC}\n"

    echo "Checking files that might differ..."

    # Check shared lib (canonical in repo, optionally synced to ~/.claude)
    if [ -d "$CLAUDE_DIR/shared/lib" ]; then
        for file in linear.js git.js github.js; do
            if [ -f "$REPO_DIR/shared/lib/$file" ]; then
                if [ -f "$CLAUDE_DIR/shared/lib/$file" ]; then
                    if ! diff -q "$CLAUDE_DIR/shared/lib/$file" "$REPO_DIR/shared/lib/$file" > /dev/null 2>&1; then
                        echo -e "${RED}✗${NC} shared/lib/$file - DIFFERS"
                        CLAUDE_DATE=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$CLAUDE_DIR/shared/lib/$file")
                        REPO_DATE=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$REPO_DIR/shared/lib/$file")
                        echo "  ~/.claude: $CLAUDE_DATE"
                        echo "  repo:      $REPO_DATE"
                    else
                        echo -e "${GREEN}✓${NC} shared/lib/$file - in sync"
                    fi
                else
                    echo -e "${YELLOW}⚠${NC}  shared/lib/$file - exists in repo only"
                fi
            fi
        done
    fi

    # Check tools
    for file in get-backlog.ts linear-tasks.ts git.ts github.ts; do
        if [ -f "$CLAUDE_DIR/tools/$file" ] && [ -f "$REPO_DIR/tools/$file" ]; then
            if ! diff -q "$CLAUDE_DIR/tools/$file" "$REPO_DIR/tools/$file" > /dev/null 2>&1; then
                echo -e "${RED}✗${NC} tools/$file - DIFFERS"
                CLAUDE_DATE=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$CLAUDE_DIR/tools/$file")
                REPO_DATE=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$REPO_DIR/tools/$file")
                echo "  ~/.claude: $CLAUDE_DATE"
                echo "  repo:      $REPO_DATE"
            else
                echo -e "${GREEN}✓${NC} tools/$file - in sync"
            fi
        fi
    done

    # Check commands
    for file in workflow.md bugfix.md plan.md create-plan.md implement-plan.md validate-plan.md; do
        if [ -f "$CLAUDE_DIR/commands/$file" ] && [ -f "$REPO_DIR/commands/$file" ]; then
            if ! diff -q "$CLAUDE_DIR/commands/$file" "$REPO_DIR/commands/$file" > /dev/null 2>&1; then
                echo -e "${RED}✗${NC} commands/$file - DIFFERS"
                CLAUDE_DATE=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$CLAUDE_DIR/commands/$file")
                REPO_DATE=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$REPO_DIR/commands/$file")
                echo "  ~/.claude: $CLAUDE_DATE"
                echo "  repo:      $REPO_DATE"
            else
                echo -e "${GREEN}✓${NC} commands/$file - in sync"
            fi
        fi
    done

    # Check if get-backlog.ts exists at repo root
    if [ -f "$REPO_DIR/get-backlog.ts" ]; then
        if ! diff -q "$CLAUDE_DIR/tools/get-backlog.ts" "$REPO_DIR/get-backlog.ts" > /dev/null 2>&1; then
            echo -e "${YELLOW}⚠${NC}  get-backlog.ts exists in both tools/ and repo root (differs)"
        fi
    fi
}

sync_to_claude() {
    echo -e "${GREEN}=== Syncing TO ~/.claude ===${NC}\n"

    # Sync shared lib (repo → ~/.claude)
    echo "Copying shared lib..."
    mkdir -p "$CLAUDE_DIR/shared/lib"
    cp -v "$REPO_DIR/shared/lib/"*.js "$CLAUDE_DIR/shared/lib/"

    # Sync tools (repo → ~/.claude)
    echo -e "\nCopying tools..."
    cp -v "$REPO_DIR/get-backlog.ts" "$CLAUDE_DIR/tools/"
    cp -v "$REPO_DIR/tools/linear-tasks.ts" "$CLAUDE_DIR/tools/"
    cp -v "$REPO_DIR/tools/git.ts" "$CLAUDE_DIR/tools/"
    cp -v "$REPO_DIR/tools/github.ts" "$CLAUDE_DIR/tools/"

    # Sync commands (repo → ~/.claude)
    echo -e "\nCopying commands..."
    cp -v "$REPO_DIR/commands/"*.md "$CLAUDE_DIR/commands/"

    # Sync templates (repo → ~/.claude)
    if [ -d "$REPO_DIR/tools/prompts" ]; then
        echo -e "\nCopying templates..."
        mkdir -p "$CLAUDE_DIR/tools/prompts"
        rsync -av "$REPO_DIR/tools/prompts/" "$CLAUDE_DIR/tools/prompts/"
    fi

    echo -e "\n${GREEN}✓ Sync to ~/.claude complete${NC}"
}

sync_from_claude() {
    echo -e "${GREEN}=== Syncing FROM ~/.claude ===${NC}\n"

    # Sync shared lib (only if ~/.claude version is newer)
    if [ -d "$CLAUDE_DIR/shared/lib" ]; then
        echo "Checking shared lib for newer versions in ~/.claude..."
        for file in linear.js git.js github.js; do
            if [ -f "$CLAUDE_DIR/shared/lib/$file" ] && [ "$CLAUDE_DIR/shared/lib/$file" -nt "$REPO_DIR/shared/lib/$file" ]; then
                echo "  Copying newer shared/lib/$file from ~/.claude"
                cp -v "$CLAUDE_DIR/shared/lib/$file" "$REPO_DIR/shared/lib/"
            fi
        done
    fi

    # Sync tools (only if ~/.claude version is newer)
    echo -e "\nChecking tools for newer versions in ~/.claude..."
    for file in get-backlog.ts; do
        if [ "$CLAUDE_DIR/tools/$file" -nt "$REPO_DIR/$file" ]; then
            echo "  Copying newer $file from ~/.claude"
            cp -v "$CLAUDE_DIR/tools/$file" "$REPO_DIR/"
        fi
    done

    for file in linear-tasks.ts git.ts github.ts; do
        if [ "$CLAUDE_DIR/tools/$file" -nt "$REPO_DIR/tools/$file" ]; then
            echo "  Copying newer tools/$file from ~/.claude"
            cp -v "$CLAUDE_DIR/tools/$file" "$REPO_DIR/tools/"
        fi
    done

    # Sync commands (only if ~/.claude version is newer)
    echo -e "\nChecking commands for newer versions in ~/.claude..."
    for file in "$CLAUDE_DIR/commands/"*.md; do
        filename=$(basename "$file")
        if [ "$file" -nt "$REPO_DIR/commands/$filename" ]; then
            echo "  Copying newer $filename from ~/.claude"
            cp -v "$file" "$REPO_DIR/commands/"
        fi
    done

    echo -e "\n${GREEN}✓ Sync from ~/.claude complete${NC}"
}

case "${1:-status}" in
    to-claude)
        sync_to_claude
        ;;
    from-claude)
        sync_from_claude
        ;;
    status)
        show_status
        ;;
    *)
        echo "Usage: $0 [to-claude|from-claude|status]"
        echo ""
        echo "  status       - Show sync status (default)"
        echo "  to-claude    - Copy repo files to ~/.claude"
        echo "  from-claude  - Copy newer ~/.claude files to repo"
        exit 1
        ;;
esac
