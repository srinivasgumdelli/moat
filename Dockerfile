FROM node:22

ARG TZ
ENV TZ="$TZ"

ARG CLAUDE_CODE_VERSION=2.1.42

# Install basic development tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    less \
    git \
    procps \
    sudo \
    fzf \
    zsh \
    unzip \
    gnupg2 \
    jq \
    nano \
    vim \
    wget \
    curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

ARG USERNAME=node

# Persist bash history
RUN SNIPPET="export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
    && mkdir -p /commandhistory \
    && touch /commandhistory/.bash_history \
    && chown -R $USERNAME /commandhistory \
    && echo "$SNIPPET" >> "/home/$USERNAME/.bashrc" \
    && echo "$SNIPPET" >> "/home/$USERNAME/.zshrc"

# Set DEVCONTAINER environment variable
ENV DEVCONTAINER=true

# Create workspace and config directories
RUN mkdir -p /workspace /home/node/.claude && \
    chown -R node:node /workspace /home/node/.claude

WORKDIR /workspace

# Install git-delta
ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
    wget -q "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
    dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
    rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# Install IaC tools
# Terraform (direct binary download)
ARG TERRAFORM_VERSION=1.10.5
RUN ARCH=$(dpkg --print-architecture) && \
    curl -sL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${ARCH}.zip" -o terraform.zip && \
    unzip -q terraform.zip && mv terraform /usr/bin/terraform && \
    rm terraform.zip

# kubectl
RUN ARCH=$(dpkg --print-architecture) && \
    curl -sLO "https://dl.k8s.io/release/$(curl -sL https://dl.k8s.io/release/stable.txt)/bin/linux/${ARCH}/kubectl" && \
    chmod +x kubectl && mv kubectl /usr/local/bin/kubectl.real

# AWS CLI v2
RUN ARCH=$(uname -m) && \
    curl -s "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o awscliv2.zip && \
    unzip -q awscliv2.zip && ./aws/install --bin-dir /usr/local/bin/aws-real && \
    rm -rf awscliv2.zip aws/

# Beads task tracker (bd CLI)
ARG BEADS_VERSION=0.49.6
RUN ARCH=$(dpkg --print-architecture) && \
    curl -sL "https://github.com/steveyegge/beads/releases/download/v${BEADS_VERSION}/beads_${BEADS_VERSION}_linux_${ARCH}.tar.gz" -o beads.tar.gz && \
    tar xzf beads.tar.gz bd && mv bd /usr/local/bin/bd && \
    rm beads.tar.gz

# Python 3 + linters
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv && \
    pip3 install --break-system-packages ruff pyright && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Go runtime + tools
ARG GO_VERSION=1.23.6
RUN ARCH=$(dpkg --print-architecture) && \
    curl -sL "https://go.dev/dl/go${GO_VERSION}.linux_${ARCH}.tar.gz" | tar -C /usr/local -xz
ENV PATH=$PATH:/usr/local/go/bin:/home/node/go/bin

# Install Claude Code as non-root
RUN mkdir -p /usr/local/share/npm-global && \
    chown -R node:node /usr/local/share/npm-global

USER node
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Install TypeScript/Go language tools and MCP dependencies
RUN npm install -g typescript typescript-language-server @modelcontextprotocol/sdk vscode-languageserver-protocol vscode-jsonrpc && \
    GOPATH=/home/node/go go install golang.org/x/tools/gopls@latest && \
    curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | \
      sh -s -- -b /home/node/go/bin

# Force git to use HTTPS instead of SSH (SSH can't traverse HTTP proxy)
RUN git config --global url."https://github.com/".insteadOf "git@github.com:" && \
    git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

# Configure Beads hooks, commands, IDE tools, and MCP servers for Claude Code
RUN bd setup claude && \
    mkdir -p /home/node/.claude/commands /home/node/.claude/hooks /home/node/.claude/mcp && \
    curl -sL "https://raw.githubusercontent.com/steveyegge/beads/main/integrations/claude-code/commands/plan-to-beads.md" \
      -o /home/node/.claude/commands/plan-to-beads.md && \
    jq '. + {
      "permissions": {"allow": ((.permissions.allow // []) + ["Bash(bd:*)"])},
      "hooks": {
        "PostToolUse": [{
          "matcher": "Edit|Write",
          "hooks": [{
            "type": "command",
            "command": "/home/node/.claude/hooks/auto-diagnostics.sh",
            "timeout": 30
          }]
        }]
      },
      "mcpServers": {
        "ide-tools": {
          "command": "node",
          "args": ["/home/node/.claude/mcp/ide-tools.mjs"]
        },
        "ide-lsp": {
          "command": "node",
          "args": ["/home/node/.claude/mcp/ide-lsp.mjs"]
        }
      }
    }' /home/node/.claude/settings.json > /tmp/settings.json && \
    mv /tmp/settings.json /home/node/.claude/settings.json

# Install tool proxy wrapper scripts and static token
USER root
COPY .proxy-token /etc/tool-proxy-token
COPY git-proxy-wrapper.sh /usr/local/bin/git
COPY gh-proxy-wrapper.sh /usr/local/bin/gh
COPY terraform-proxy-wrapper.sh /usr/local/bin/terraform
COPY kubectl-proxy-wrapper.sh /usr/local/bin/kubectl
COPY aws-proxy-wrapper.sh /usr/local/bin/aws
RUN chmod 644 /etc/tool-proxy-token && \
    chmod +x /usr/local/bin/git /usr/local/bin/gh \
             /usr/local/bin/terraform /usr/local/bin/kubectl /usr/local/bin/aws

# Copy verification script
COPY verify.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/verify.sh

# Copy IDE hook and MCP server files
COPY --chown=node:node auto-diagnostics.sh /home/node/.claude/hooks/
COPY --chown=node:node ide-tools.mjs /home/node/.claude/mcp/
COPY --chown=node:node ide-lsp.mjs /home/node/.claude/mcp/
RUN chmod +x /home/node/.claude/hooks/auto-diagnostics.sh

USER node
