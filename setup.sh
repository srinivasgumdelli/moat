#!/bin/bash
# Moat — setup (redirects to install.sh)
exec "$(cd "$(dirname "$0")" && pwd)/install.sh" "$@"
